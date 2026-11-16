import { build } from 'esbuild';
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension', 'src');
const out = path.join(root, 'extension', 'dist');
const buildRoot = path.join(root, 'extension', '.build');
const tempOut = path.join(buildRoot, `dist-${process.pid}-${Date.now()}`);
const backupOut = path.join(buildRoot, `dist-backup-${process.pid}`);

const TARGET = ['chrome102'];

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function requireFile(target, label = path.relative(tempOut, target)) {
  if (!(await exists(target))) {
    throw new Error(`Extension build is missing required file: ${label}`);
  }
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`Extension entry point is not a file: ${label}`);
  if (info.size <= 0) throw new Error(`Extension entry point is empty: ${label}`);
}

async function bundle(entryPoint, outfile, options = {}) {
  assertInside(tempOut, outfile);
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'browser',
    target: TARGET,
    minify: true,
    sourcemap: false,
    logLevel: 'info',
    ...options,
  });
  await requireFile(outfile);
}

function assertInside(parent, target) {
  const relative = path.relative(parent, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside the temporary extension directory: ${target}`);
  }
}

async function validateManifest(distDir) {
  const manifestPath = path.join(distDir, 'manifest.json');
  const raw = await readFile(manifestPath, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Generated manifest.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (manifest.manifest_version !== 3) {
    throw new Error('Extension manifest must use Manifest V3.');
  }
  if (!manifest.name || !manifest.version) {
    throw new Error('Extension manifest is missing its name or version.');
  }

  const referenced = new Set();
  if (manifest.background?.service_worker) referenced.add(manifest.background.service_worker);
  if (manifest.action?.default_popup) referenced.add(manifest.action.default_popup);
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) referenced.add(icon);
  for (const icon of Object.values(manifest.icons ?? {})) referenced.add(icon);
  for (const script of manifest.content_scripts ?? []) {
    for (const file of script.js ?? []) referenced.add(file);
    for (const file of script.css ?? []) referenced.add(file);
  }

  for (const entry of referenced) {
    if (typeof entry !== 'string' || entry.includes('\0')) {
      throw new Error(`Manifest contains an invalid asset reference: ${String(entry)}`);
    }
    const resolved = path.resolve(distDir, entry);
    const relative = path.relative(distDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Manifest asset escapes the extension directory: ${entry}`);
    }
    await requireFile(resolved, entry);
  }

  return { manifest, referenced: Array.from(referenced).sort() };
}

async function verifyBuild(distDir) {
  await requireFile(path.join(distDir, 'manifest.json'), 'manifest.json');
  await requireFile(path.join(distDir, 'background.js'), 'background.js');
  await requireFile(path.join(distDir, 'content.js'), 'content.js');
  await requireFile(path.join(distDir, 'popup.js'), 'popup.js');
  await requireFile(path.join(distDir, 'popup.html'), 'popup.html');
  await requireFile(path.join(distDir, 'popup.css'), 'popup.css');
  await requireFile(path.join(distDir, 'dashboard.html'), 'dashboard.html');
  await requireFile(path.join(distDir, 'BUILD.txt'), 'BUILD.txt');

  const dashboardHtml = await readFile(path.join(distDir, 'dashboard.html'), 'utf8');
  const assetReferences = [...dashboardHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  for (const reference of assetReferences) {
    if (/^(?:https?:|data:|#)/i.test(reference)) continue;
    const clean = reference.replace(/^\.\//, '').split('?')[0];
    await requireFile(path.join(distDir, clean), `dashboard asset ${clean}`);
  }

  const { manifest, referenced } = await validateManifest(distDir);
  const files = await listFiles(distDir);
  const totalBytes = (
    await Promise.all(files.map(async (file) => (await stat(path.join(distDir, file))).size))
  ).reduce((sum, size) => sum + size, 0);

  return { manifest, referenced, files, totalBytes };
}

async function listFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(dir, entry.name), relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

async function main() {
  await rm(tempOut, { recursive: true, force: true });
  await rm(backupOut, { recursive: true, force: true });
  await mkdir(tempOut, { recursive: true });

  try {
    await bundle(path.join(src, 'popup', 'main.tsx'), path.join(tempOut, 'popup.js'), {
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    });

    await bundle(path.join(src, 'background.ts'), path.join(tempOut, 'background.js'), {
      format: 'esm',
    });

    await bundle(path.join(src, 'content.ts'), path.join(tempOut, 'content.js'), {
      format: 'iife',
    });

    const dashboardOut = path.join(buildRoot, `dashboard-${process.pid}-${Date.now()}`);
    await viteBuild({
      configFile: false,
      root,
      base: './',
      plugins: [react()],
      resolve: {
        alias: [
          { find: '@/services/vaultClient', replacement: path.join(root, 'src', 'services', 'vaultClient.ts') },
          { find: '@', replacement: path.join(root, 'src') },
          { find: '@shared', replacement: path.join(root, 'shared') },
          { find: '@ext', replacement: path.join(root, 'extension', 'src') },
        ],
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: dashboardOut,
        emptyOutDir: true,
        target: 'chrome102',
        sourcemap: false,
        copyPublicDir: false,
        rollupOptions: {
          input: { dashboard: path.join(root, 'index.html') },
        },
      },
      logLevel: 'warn',
    });
    await requireFile(path.join(dashboardOut, 'index.html'), 'dashboard.html');
    await rename(path.join(dashboardOut, 'index.html'), path.join(dashboardOut, 'dashboard.html'));
    for (const entry of await readdir(dashboardOut)) {
      await cp(path.join(dashboardOut, entry), path.join(tempOut, entry), { recursive: true });
    }
    await rm(dashboardOut, { recursive: true, force: true });

    await cp(path.join(root, 'extension', 'manifest.json'), path.join(tempOut, 'manifest.json'));
    await cp(path.join(src, 'popup', 'popup.html'), path.join(tempOut, 'popup.html'));
    await cp(path.join(src, 'popup', 'popup.css'), path.join(tempOut, 'popup.css'));
    await cp(path.join(root, 'extension', 'icons'), path.join(tempOut, 'icons'), { recursive: true });

    const manifest = JSON.parse(await readFile(path.join(tempOut, 'manifest.json'), 'utf8'));
    await writeFile(
      path.join(tempOut, 'BUILD.txt'),
      `FormFlow extension build\nManifest: ${manifest.version}\nGenerated: ${new Date().toISOString()}\nLoad this folder from chrome://extensions with Developer mode enabled.\n`,
      'utf8',
    );

    const verification = await verifyBuild(tempOut);

    // Only replace the live distribution after every required asset has been verified.
    await mkdir(buildRoot, { recursive: true });
    const hadPreviousBuild = await exists(out);
    if (hadPreviousBuild) await rename(out, backupOut);
    try {
      await rename(tempOut, out);
    } catch (error) {
      if (hadPreviousBuild && !(await exists(out)) && (await exists(backupOut))) {
        await rename(backupOut, out);
      }
      throw error;
    }
    if (hadPreviousBuild) await rm(backupOut, { recursive: true, force: true });
    await rm(buildRoot, { recursive: true, force: true });

    console.log(`\nFormFlow extension built → ${out}`);
    console.log(`Manifest ${verification.manifest.version}; ${verification.files.length} files; ${(verification.totalBytes / 1024).toFixed(1)} KB`);
    console.log('Manifest references verified:');
    for (const reference of verification.referenced) console.log(`  ✓ ${reference}`);
    console.log('\nLoad extension/dist as an unpacked extension in chrome://extensions.\n');
  } catch (error) {
    await rm(tempOut, { recursive: true, force: true });
    if (!(await exists(out)) && (await exists(backupOut))) {
      await rename(backupOut, out);
    }
    console.error('\nFormFlow extension build failed. The previous extension/dist was preserved (or restored).');
    throw error;
  }
}

await main();
