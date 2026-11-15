import { build } from 'esbuild';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(root, 'tests');
const outDir = path.join(testsDir, '.build');
const aliasArgs = ['--alias:@shared=' + path.join(root, 'shared'), '--alias:@ext=' + path.join(root, 'extension/src')];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const entries = (await readdir(testsDir, { recursive: true }))
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => path.join(testsDir, file));

if (entries.length === 0) {
  console.error('No tests found under tests/.');
  process.exit(1);
}

for (const entry of entries) {
  await build({
    entryPoints: [entry],
    outfile: path.join(outDir, `${path.basename(entry, '.test.ts')}.test.mjs`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    logLevel: 'warning',
    alias: { '@shared': path.join(root, 'shared'), '@ext': path.join(root, 'extension/src') },
  });
}

const builtFiles = await readdir(outDir);
for (const file of builtFiles) {
  const info = await stat(path.join(outDir, file));
  if (!info.isFile()) continue;
  const result = spawnSync(process.execPath, [path.join(outDir, file)], {
    stdio: 'inherit',
    cwd: root,
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
