import { build } from 'esbuild';
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension', 'src');
const out = path.join(root, 'extension', 'dist');
const buildRoot = path.join(root, 'extension', '.build');
const tempOut = path.join(buildRoot, `dist-${process.pid}-${Date.now()}`);
const backupOut = path.join(buildRoot, `dist-backup-${process.pid}`);

const TARGET = ['chrome109'];
const testHooks = process.env.FORMFLOW_TEST_HOOKS === '1';
const DOCX_LAYOUT_FONTS = [
  ['Carlito-Regular.ttf', 'f6418f708baede9789daef5d458c0f53d2a888af9820e8062934e504fedc6595', 'Carlito', 400, 'normal'],
  ['Carlito-Bold.ttf', 'bb5d20f79b82599ec72983597437373a80f2d2085fa91fc144fd74e876a594db', 'Carlito', 700, 'normal'],
  ['Carlito-Italic.ttf', '0b019225e58d702bfedcbd35c21696769f8ee115cb6343f84c2f240312450d1c', 'Carlito', 400, 'italic'],
  ['Carlito-BoldItalic.ttf', 'b32928186c119599e03ca6a1ffc680fdcb7fac95772f4b95d989cf6cd3861517', 'Carlito', 700, 'italic'],
  ['LiberationSans-Regular.ttf', '76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8', 'Liberation Sans', 400, 'normal'],
  ['LiberationSans-Bold.ttf', '788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173', 'Liberation Sans', 700, 'normal'],
  ['LiberationSans-Italic.ttf', 'e5bae5c4cde31f22142753855f4f8fb86da6ff39955ed3c0a11248b0d16948b0', 'Liberation Sans', 400, 'italic'],
  ['LiberationSans-BoldItalic.ttf', '698da70fc191cc5f33ad4d6d3fe830fe4624b898ea2e3169955928b7c491f1ee', 'Liberation Sans', 700, 'italic'],
  ['LiberationSerif-Regular.ttf', '058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74', 'Liberation Serif', 400, 'normal'],
  ['LiberationSerif-Bold.ttf', 'd754ba427cfe0bca54ae052384baa8f842da5bd6550ad4da024ac441e7a7d5ce', 'Liberation Serif', 700, 'normal'],
  ['LiberationSerif-Italic.ttf', '0e3dea9f8d613e006ccfa62201f33e265d19167bd0907725c3e145368b04fc2e', 'Liberation Serif', 400, 'italic'],
  ['LiberationSerif-BoldItalic.ttf', 'f17db8af71e24d2066b587546021d4f0b296be389512b658dec3c09affeb11a7', 'Liberation Serif', 700, 'italic'],
];
const HARFBUZZ_WASM_SHA256 = '6eeed8e1bc9ad7773038e48ff8f9e07e0ad228572c594b45e5357e9c2f7a0b2e';
const TRANSFORMERS_SHA256 = '8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb';
const ORT_ASYNCIFY_MJS_SHA256 = '0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611';
const ORT_ASYNCIFY_WASM_SHA256 = '49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082';
const NODE_ONLY_LAYOUT_IMPORTS = ['fs', 'url', 'path', 'fs/promises', 'node:fs', 'node:url', 'node:path', 'node:fs/promises'];

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

async function sha256File(target) {
  const data = await readFile(target);
  return createHash('sha256').update(data).digest('hex');
}

function sha256Bytes(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Normalize the vertical metrics the renderer reads for line boxes.
 *
 * The renderer combines each face's ascent with another face's descent on a
 * mixed-font line. Its packaged Carlito face stores the same total line height as
 * Word's own Carlito, but splits it as win-ascent/win-descent/zero-leading rather
 * than the typo metrics LibreOffice and Word use. Moving the leading below the
 * baseline keeps every single-face line height unchanged while making mixed runs
 * use the same maximum ascent + maximum descent rule as the reference renderer.
 */
function normalizeFontVerticalMetrics(input) {
  const bytes = new Uint8Array(input);
  if (bytes.byteLength < 12) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) === 0x74746366) return bytes; // TTC: leave collections untouched.
  const numTables = view.getUint16(4);
  if (numTables < 3 || numTables > 256 || bytes.byteLength < 12 + numTables * 16) return bytes;
  const tables = new Map();
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(...bytes.slice(record, record + 4));
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset + length > bytes.byteLength) return bytes;
    tables.set(tag, { offset, length });
  }
  const head = tables.get('head');
  const hhea = tables.get('hhea');
  const os2 = tables.get('OS/2');
  if (!head || !hhea || !os2 || head.length < 54 || hhea.length < 36 || os2.length < 78) return bytes;
  const unitsPerEm = view.getUint16(head.offset + 18);
  const hheaAscender = view.getInt16(hhea.offset + 4);
  const hheaDescender = view.getInt16(hhea.offset + 6);
  const hheaLineGap = view.getInt16(hhea.offset + 8);
  const typoAscender = view.getInt16(os2.offset + 68);
  const typoDescender = view.getInt16(os2.offset + 70);
  const typoLineGap = view.getInt16(os2.offset + 72);
  if (unitsPerEm <= 0 || unitsPerEm > 16_384) return bytes;
  if (hheaAscender <= 0 || hheaDescender >= 0 || hheaLineGap < 0) return bytes;
  const hheaTotal = hheaAscender - hheaDescender + hheaLineGap;
  const typoValid = typoAscender > 0 && typoDescender < 0 && typoLineGap >= 0;
  const typoTotal = typoAscender - typoDescender + typoLineGap;
  const useTypo = typoValid && Math.abs(typoTotal - hheaTotal) <= 1;
  const ascender = useTypo ? typoAscender : hheaAscender;
  const descender = useTypo ? typoDescender : hheaDescender;
  const lineGap = useTypo ? typoLineGap : hheaLineGap;
  const total = ascender - descender + lineGap;
  if (total <= 0 || total > unitsPerEm * 2) return bytes;
  view.setInt16(hhea.offset + 4, ascender);
  view.setInt16(hhea.offset + 6, descender - lineGap);
  view.setInt16(hhea.offset + 8, 0);
  return bytes;
}

async function copyVerified(source, target, expectedSha256) {
  await cp(source, target);
  const actual = await sha256File(target);
  if (actual !== expectedSha256) {
    throw new Error(`OCR asset integrity mismatch for ${path.basename(target)}: ${actual}`);
  }
}

async function bundle(entryPoint, outfile, options = {}) {
  assertInside(tempOut, outfile);
  const result = await build({
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
  return result;
}

function bundledInputs(result) {
  return Object.keys(result.metafile?.inputs ?? {});
}

function assertNoInputs(label, inputs, patterns) {
  for (const input of inputs) {
    if (patterns.some((pattern) => pattern.test(input))) {
      throw new Error(`${label} bundle includes forbidden module: ${input}`);
    }
  }
}

function assertHasInput(label, inputs, pattern) {
  if (!inputs.some((input) => pattern.test(input))) {
    throw new Error(`${label} bundle is missing required module: ${pattern}`);
  }
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
  if (Number(manifest.minimum_chrome_version) < 109) {
    throw new Error('The offscreen document requires minimum_chrome_version 109 or newer.');
  }
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes('offscreen')) {
    throw new Error('The extension manifest must declare the offscreen permission.');
  }
  const extensionCsp = String(manifest.content_security_policy?.extension_pages ?? '');
  if (!/script-src\s+'self'/.test(extensionCsp) || !/worker-src\s+'self'/.test(extensionCsp)) {
    throw new Error('The extension CSP must allow only local scripts and workers.');
  }
  if (!/script-src\s+[^;]*'wasm-unsafe-eval'/.test(extensionCsp)) {
    throw new Error('The extension CSP must allow packaged WebAssembly without enabling JavaScript eval.');
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
  await requireFile(path.join(distDir, 'offscreen-parser.html'), 'offscreen-parser.html');
  await requireFile(path.join(distDir, 'offscreen-parser.js'), 'offscreen-parser.js');
  await requireFile(path.join(distDir, 'document-parser.worker.js'), 'document-parser.worker.js');
  await requireFile(path.join(distDir, 'model.worker.js'), 'model.worker.js');
  await requireFile(path.join(distDir, 'transformers.min.js'), 'transformers.min.js');
  await requireFile(path.join(distDir, 'ort', 'ort-wasm-simd-threaded.asyncify.mjs'), 'ort/ort-wasm-simd-threaded.asyncify.mjs');
  await requireFile(path.join(distDir, 'ort', 'ort-wasm-simd-threaded.asyncify.wasm'), 'ort/ort-wasm-simd-threaded.asyncify.wasm');
  await requireFile(path.join(distDir, 'popup.js'), 'popup.js');
  await requireFile(path.join(distDir, 'popup.html'), 'popup.html');
  await requireFile(path.join(distDir, 'popup.css'), 'popup.css');
  await requireFile(path.join(distDir, 'dashboard.html'), 'dashboard.html');
  await requireFile(path.join(distDir, 'BUILD.txt'), 'BUILD.txt');
  await requireFile(path.join(distDir, 'fonts', 'harfbuzz.wasm'), 'fonts/harfbuzz.wasm');
  await requireFile(path.join(distDir, 'fonts', 'Carlito-Regular.ttf'), 'fonts/Carlito-Regular.ttf');
  await requireFile(path.join(distDir, 'fonts', 'LiberationSans-Regular.ttf'), 'fonts/LiberationSans-Regular.ttf');
  await requireFile(path.join(distDir, 'fonts', 'LiberationSerif-Regular.ttf'), 'fonts/LiberationSerif-Regular.ttf');
  await requireFile(path.join(distDir, 'fonts', 'font-metrics.json'), 'fonts/font-metrics.json');
  await requireFile(path.join(distDir, 'fonts', 'THIRD_PARTY_NOTICES.txt'), 'fonts/THIRD_PARTY_NOTICES.txt');

  const offscreenHtml = await readFile(path.join(distDir, 'offscreen-parser.html'), 'utf8');
  if (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(offscreenHtml)) {
    throw new Error('Offscreen parser HTML must not contain inline scripts.');
  }
  if (/<script\b[^>]*src=["'](?:https?:|data:)/i.test(offscreenHtml)) {
    throw new Error('Offscreen parser HTML must not load remote scripts.');
  }
  if (/\bon[a-z]+\s*=/i.test(offscreenHtml)) {
    throw new Error('Offscreen parser HTML must not contain inline event handlers.');
  }
  if (!/connect-src\s+'self'/.test(offscreenHtml) || !/font-src\s+'self'/.test(offscreenHtml)) {
    throw new Error('Offscreen parser HTML must restrict network and font sources to the extension origin.');
  }

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

    const backgroundResult = await bundle(path.join(src, testHooks ? 'background.test.ts' : 'background.ts'), path.join(tempOut, 'background.js'), {
      format: 'esm',
      metafile: true,
      define: { __FORMFLOW_TEST_HOOKS__: testHooks ? 'true' : 'false' },
    });

    await bundle(path.join(src, 'content.ts'), path.join(tempOut, 'content.js'), {
      format: 'iife',
    });

    const offscreenProductionStub = {
      name: 'offscreen-production-diagnostics-stub',
      setup(build) {
        if (testHooks) return;
        build.onResolve({ filter: /^\.\/diagnostics$/ }, () => ({
          path: path.join(src, 'offscreen', 'diagnostics.prod.ts'),
        }));
      },
    };
    const offscreenResult = await bundle(path.join(src, 'offscreen', 'main.ts'), path.join(tempOut, 'offscreen-parser.js'), {
      format: 'iife',
      metafile: true,
      define: { __FORMFLOW_TEST_HOOKS__: testHooks ? 'true' : 'false' },
      plugins: [offscreenProductionStub],
    });
    const parserWorkerResult = await bundle(path.join(src, 'offscreen', 'parser-worker.ts'), path.join(tempOut, 'document-parser.worker.js'), {
      format: 'esm',
      metafile: true,
      // The layout engine contains a dormant Node file-reader branch. It is never
      // invoked in the extension, but esbuild still has to leave the imports intact.
      external: NODE_ONLY_LAYOUT_IMPORTS,
      define: { __FORMFLOW_TEST_HOOKS__: testHooks ? 'true' : 'false' },
    });
    await cp(path.join(src, 'offscreen', 'parser.html'), path.join(tempOut, 'offscreen-parser.html'));

    const modelWorkerResult = await bundle(path.join(src, 'model', 'model-worker.ts'), path.join(tempOut, 'model.worker.js'), {
      format: 'esm',
      metafile: true,
    });
    await copyVerified(
      path.join(root, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.min.js'),
      path.join(tempOut, 'transformers.min.js'),
      TRANSFORMERS_SHA256,
    );
    await mkdir(path.join(tempOut, 'ort'), { recursive: true });
    await copyVerified(
      path.join(root, 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.asyncify.mjs'),
      path.join(tempOut, 'ort', 'ort-wasm-simd-threaded.asyncify.mjs'),
      ORT_ASYNCIFY_MJS_SHA256,
    );
    await copyVerified(
      path.join(root, 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.asyncify.wasm'),
      path.join(tempOut, 'ort', 'ort-wasm-simd-threaded.asyncify.wasm'),
      ORT_ASYNCIFY_WASM_SHA256,
    );
    await writeFile(
      path.join(tempOut, 'ort', 'THIRD_PARTY_NOTICES.txt'),
      'Transformers.js 4.3.2 — Apache-2.0\nONNX Runtime Web 1.31.0 — MIT\nTransformer.js and ORT runtime assets are bundled locally; model weights are downloaded only from the configured public Hugging Face repository after explicit user action.\n',
      'utf8',
    );

    const vaultAuthorityPatterns = [
      /core[\\/]vault[\\/]/,
      /core[\\/]database[\\/]/,
      /core[\\/]encryption[\\/]/,
      /core[\\/]storage[\\/]/,
      /core[\\/]application[\\/]/,
      /src[\\/]services[\\/]vaultClient/,
      /extension[\\/]src[\\/]background/,
    ];
    const parserPatterns = [
      /core[\\/]documents[\\/]parsers[\\/]/,
      /node_modules[\\/]pdfjs-dist/,
      /node_modules[\\/]mammoth/,
      /node_modules[\\/]fflate/,
      /node_modules[\\/]tesseract\.js/,
    ];
    const offscreenForbidden = [
      ...vaultAuthorityPatterns,
      /core[\\/]documents[\\/]parsers[\\/]/,
      /node_modules[\\/]mammoth/,
      /node_modules[\\/]fflate/,
      /node_modules[\\/]@docx-editor\.dev[\\/]core/,
      /node_modules[\\/]@docx-editor\.dev[\\/]fonts/,
    ];
    const backgroundInputs = bundledInputs(backgroundResult);
    const offscreenInputs = bundledInputs(offscreenResult);
    const parserInputs = bundledInputs(parserWorkerResult);
    const modelWorkerInputs = bundledInputs(modelWorkerResult);
    assertNoInputs('Service worker', backgroundInputs, parserPatterns);
    assertNoInputs('Service worker', backgroundInputs, [/node_modules[\\/]@huggingface[\\/]transformers/]);
    assertNoInputs('Model worker', modelWorkerInputs, vaultAuthorityPatterns);
    assertNoInputs('Model worker', modelWorkerInputs, parserPatterns);
    assertNoInputs('Offscreen document', offscreenInputs, offscreenForbidden);
    assertHasInput('Offscreen document', offscreenInputs, /node_modules[\\/]pdfjs-dist/);
    assertHasInput('Offscreen document', offscreenInputs, /node_modules[\\/]tesseract\.js/);
    assertNoInputs('Offscreen parser worker', parserInputs, vaultAuthorityPatterns);
    assertHasInput('Offscreen parser worker', parserInputs, /core[\\/]documents[\\/]parsers[\\/]index\.ts$/);
    assertHasInput('Offscreen parser worker', parserInputs, /node_modules[\\/]pdfjs-dist/);
    assertHasInput('Offscreen parser worker', parserInputs, /node_modules[\\/]mammoth/);
    assertHasInput('Offscreen parser worker', parserInputs, /node_modules[\\/]@docx-editor\.dev[\\/]core[\\/]dist[\\/]export\.js$/);
    assertHasInput('Offscreen parser worker', parserInputs, /node_modules[\\/]@docx-editor\.dev[\\/]fonts[\\/]dist[\\/]index\.js$/);

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
        target: 'chrome113',
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
    for (const file of await listFiles(dashboardOut)) {
      if (!file.endsWith('.js')) continue;
      const text = await readFile(path.join(dashboardOut, file), 'utf8');
      if (/pdfjs-dist|mammoth\/mammoth|tesseract\.js|document-parser\.worker\.js|offscreen-parser\.html/.test(text)) {
        throw new Error(`Dashboard bundle must not contain parser internals: ${file}`);
      }
    }
    for (const entry of await readdir(dashboardOut)) {
      await cp(path.join(dashboardOut, entry), path.join(tempOut, entry), { recursive: true });
    }
    await rm(dashboardOut, { recursive: true, force: true });

    await mkdir(path.join(tempOut, 'tesseract'), { recursive: true });
    await mkdir(path.join(tempOut, 'tessdata'), { recursive: true });
    await copyVerified(
      path.join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js'),
      path.join(tempOut, 'tesseract', 'worker.min.js'),
      '576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d',
    );
    await copyVerified(
      path.join(root, 'node_modules', 'tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js'),
      path.join(tempOut, 'tesseract', 'tesseract-core-simd-lstm.wasm.js'),
      'c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38',
    );
    await copyVerified(
      path.join(root, 'node_modules', 'tesseract.js-core', 'tesseract-core-simd-lstm.wasm'),
      path.join(tempOut, 'tesseract', 'tesseract-core-simd-lstm.wasm'),
      '34e8d50cac216427d86bf397d610fdd9f49492539bbcdfbfccc4eda20c810bea',
    );
    await copyVerified(
      path.join(root, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'),
      path.join(tempOut, 'tessdata', 'eng.traineddata.gz'),
      '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
    );
    await writeFile(
      path.join(tempOut, 'tesseract', 'THIRD_PARTY_NOTICES.txt'),
      'Tesseract.js 7.0.0 — Apache-2.0\ntesseract.js-core 7.0.0 — Apache-2.0\neng traineddata (@tesseract.js-data/eng 1.0.0) — MIT\nAll OCR assets are bundled locally; no runtime download is used.\n',
      'utf8',
    );

    const fontOut = path.join(tempOut, 'fonts');
    await mkdir(fontOut, { recursive: true });
    const fontManifest = [];
    for (const [font, expectedSha256, family, weight, style] of DOCX_LAYOUT_FONTS) {
      const sourcePath = path.join(root, 'node_modules', '@docx-editor.dev', 'fonts', 'assets', font);
      const sourceBytes = await readFile(sourcePath);
      const originalHash = sha256Bytes(sourceBytes);
      if (originalHash !== expectedSha256) {
        throw new Error(`Font asset integrity mismatch for ${font}: ${originalHash}`);
      }
      const patched = normalizeFontVerticalMetrics(sourceBytes);
      await writeFile(path.join(fontOut, font), patched);
      fontManifest.push({
        file: font,
        family,
        weight,
        style,
        byteLength: patched.byteLength,
        hash: `sha256:${sha256Bytes(patched)}`,
      });
    }
    await writeFile(
      path.join(fontOut, 'font-metrics.json'),
      `${JSON.stringify({ version: 1, fonts: fontManifest }, null, 2)}\n`,
      'utf8',
    );
    await copyVerified(
      path.join(root, 'node_modules', '@docx-editor.dev', 'core', 'dist', 'harfbuzz.wasm'),
      path.join(fontOut, 'harfbuzz.wasm'),
      HARFBUZZ_WASM_SHA256,
    );
    await cp(path.join(root, 'node_modules', '@docx-editor.dev', 'core', 'licenses'), path.join(fontOut, 'licenses', 'core'), { recursive: true });
    await cp(path.join(root, 'node_modules', '@docx-editor.dev', 'fonts', 'licenses'), path.join(fontOut, 'licenses', 'fonts'), { recursive: true });
    await cp(path.join(root, 'node_modules', '@docx-editor.dev', 'core', 'LICENSE'), path.join(fontOut, 'licenses', 'core', 'LICENSE.txt'));
    await cp(path.join(root, 'node_modules', '@docx-editor.dev', 'fonts', 'LICENSE'), path.join(fontOut, 'licenses', 'fonts', 'LICENSE.txt'));
    await cp(path.join(root, 'node_modules', '@docx-editor.dev', 'core', 'THIRD_PARTY_NOTICES.md'), path.join(fontOut, 'licenses', 'core', 'THIRD_PARTY_NOTICES.md'));
    await cp(path.join(root, 'node_modules', '@docx-editor.dev', 'fonts', 'THIRD_PARTY_NOTICES.md'), path.join(fontOut, 'licenses', 'fonts', 'THIRD_PARTY_NOTICES.md'));
    await writeFile(
      path.join(fontOut, 'THIRD_PARTY_NOTICES.txt'),
      [
        '@docx-editor.dev/core 2.38.0 — Apache-2.0',
        '@docx-editor.dev/fonts 2.38.0 — Apache-2.0 AND OFL-1.1 AND LicenseRef-GUST-Font-License',
        'HarfBuzz (harfbuzz.wasm) — MIT',
        'Carlito — OFL-1.1',
        'Liberation Sans/Serif — SIL Open Font License 1.1',
        'All layout, WASM, and font assets are bundled locally; no runtime download is used.',
        '',
      ].join('\n'),
      'utf8',
    );

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

    console.log(`\nFormFlow extension built${testHooks ? ' (TEST HOOKS)' : ''} → ${out}`);
    console.log(`Manifest ${verification.manifest.version}; ${verification.files.length} files; ${(verification.totalBytes / 1024).toFixed(1)} KB`);
    console.log('Bundle isolation verified: service worker has no parser runtime; offscreen document has no vault/DB/crypto authority.');
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
