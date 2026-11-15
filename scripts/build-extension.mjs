import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension', 'src');
const out = path.join(root, 'extension', 'dist');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [path.join(src, 'popup', 'main.tsx')],
  outfile: path.join(out, 'popup.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome102'],
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

await build({
  entryPoints: [path.join(src, 'background.ts')],
  outfile: path.join(out, 'background.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome102'],
  minify: true,
  logLevel: 'info',
});

await build({
  entryPoints: [path.join(src, 'content.ts')],
  outfile: path.join(out, 'content.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome102'],
  minify: true,
  logLevel: 'info',
});

await cp(path.join(root, 'extension', 'manifest.json'), path.join(out, 'manifest.json'));
await cp(path.join(src, 'popup', 'popup.html'), path.join(out, 'popup.html'));
await cp(path.join(src, 'popup', 'popup.css'), path.join(out, 'popup.css'));
await cp(path.join(root, 'extension', 'icons'), path.join(out, 'icons'), { recursive: true });

const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Extension manifest must be MV3.');
await writeFile(path.join(out, 'BUILD.txt'), `FormFlow extension build\nManifest: ${manifest.version}\nGenerated: ${new Date().toISOString()}\nLoad this folder from chrome://extensions with Developer mode enabled.\n`, 'utf8');

console.log(`\nFormFlow extension built → ${out}`);
console.log('Load extension/dist as an unpacked extension in chrome://extensions.\n');
