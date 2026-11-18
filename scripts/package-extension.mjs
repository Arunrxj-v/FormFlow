import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'extension', 'dist');
const releaseDir = path.join(root, 'release');

const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Packaging requires a Manifest V3 extension.');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Extension version is not semver.');

const required = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'dashboard.html'];
for (const file of required) {
  await stat(path.join(dist, file)).catch(() => { throw new Error(`Missing required extension file: ${file}`); });
}

const forbidden = [
  /(^|\/)\.model-cache(\/|$)/,
  /\.onnx$/,
  /\.safetensors$/,
  /\.map$/,
  /\.ts$/,
  /(^|\/)src(\/|$)/,
  /(^|\/)test(\/|$)/,
];
const hookPatterns = [/__FORMFLOW_TEST_HOOKS__/, /__TEST_INJECT_/, /__TEST_DELAY_/];
const secretPatterns = [
  /AIza[0-9A-Za-z_-]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/,
  /AUTH_SECRET\s*=\s*['"][^'"]{8,}/,
  /client_secret\s*[:=]\s*['"][^'"]{8,}/i,
];

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

const files = await walk(dist);
const archive = {};
let totalBytes = 0;
for (const file of files) {
  const relative = path.relative(dist, file).split(path.sep).join('/');
  if (forbidden.some((pattern) => pattern.test(relative))) {
    throw new Error(`Forbidden release file: ${relative}`);
  }
  const bytes = await readFile(file);
  totalBytes += bytes.byteLength;
  if (/\.(js|mjs|html|json|css|txt)$/.test(relative)) {
    const text = bytes.toString('utf8');
    if (hookPatterns.some((pattern) => pattern.test(text))) {
      throw new Error(`Test hooks detected in release file: ${relative}`);
    }
    if (secretPatterns.some((pattern) => pattern.test(text))) {
      throw new Error(`Possible secret detected in release file: ${relative}`);
    }
  }
  archive[relative] = new Uint8Array(bytes);
}

if (archive['manifest.json'].byteLength < 100) throw new Error('manifest.json is unexpectedly small.');
await mkdir(releaseDir, { recursive: true });
const zip = zipSync(archive, { level: 9 });
const version = manifest.version;
const fileName = `formflow-extension-${version}.zip`;
const zipPath = path.join(releaseDir, fileName);
await writeFile(zipPath, zip);
const digest = createHash('sha256').update(zip).digest('hex');
await writeFile(`${zipPath}.sha256`, `${digest}  ${fileName}\n`);
await writeFile(path.join(releaseDir, 'release-manifest.json'), JSON.stringify({
  name: manifest.name,
  version,
  manifestVersion: manifest.manifest_version,
  minimumChromeVersion: manifest.minimum_chrome_version,
  file: fileName,
  sha256: digest,
  uncompressedBytes: totalBytes,
  compressedBytes: zip.byteLength,
  fileCount: files.length,
  createdAt: new Date().toISOString(),
  note: 'Local production build. Store signing and submission are not automated.',
}, null, 2));

console.log(`Packaged ${files.length} files (${(totalBytes / 1024).toFixed(1)} KiB) -> ${path.relative(root, zipPath)}`);
console.log(`SHA-256 ${digest}`);
