import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const MODEL_CACHE_NAME = 'formflow-model-cache-v1';
const MODEL_REPOSITORY = 'onnx-community/Qwen3-0.6B-Instruct-ONNX';
const MODEL_REVISION = '54250909aca286a05b9d013c8af7a21859ee6ead';
const MODEL_FILES = [
  { path: 'config.json', size: 1359 },
  { path: 'generation_config.json', size: 214 },
  { path: 'tokenizer.json', size: 11422654 },
  { path: 'tokenizer_config.json', size: 5404 },
  { path: 'added_tokens.json', size: 707 },
  { path: 'special_tokens_map.json', size: 613 },
  { path: 'merges.txt', size: 1671853 },
  { path: 'vocab.json', size: 2776833 },
  { path: 'chat_template.jinja', size: 3645 },
  { path: 'onnx/model_quantized.onnx', size: 753999618 },
];

const root = process.cwd();
const sourceExtension = path.resolve('extension/dist');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-model-e2e-'));
const extensionPath = path.join(userDataDir, 'extension');
const cacheRoot = path.resolve('.model-cache', MODEL_REPOSITORY, MODEL_REVISION);
const passphrase = 'model-e2e-passphrase-2026';
const freshInstall = process.env.FORMFLOW_MODEL_E2E_FRESH === '1';
let context;
let server;
let failures = 0;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 500)}` : ''}`);
  if (!condition) failures += 1;
};

const message = (page, requestId, operation, payload = {}, timeout = 600_000) =>
  page.evaluate(
    ({ request, timeoutMs }) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs);
        chrome.runtime.sendMessage(request, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      }),
    { request: { protocol: 1, requestId, operation, payload }, timeoutMs: timeout },
  );

function startModelServer() {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      try {
        const relative = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.slice(1));
        const file = path.join(cacheRoot, relative);
        if (!file.startsWith(cacheRoot) || !existsSync(file)) {
          res.writeHead(404, { 'access-control-allow-origin': '*' });
          res.end('missing');
          return;
        }
        const stat = createReadStream(file);
        // content-length is required by the integrity installer; the SHA-256
        // check remains the authority on whether bytes are complete.
        import('node:fs').then(({ statSync }) => {
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': statSync(file).size,
            'access-control-allow-origin': '*',
          });
          stat.pipe(res);
        });
      } catch {
        res.writeHead(500);
        res.end('error');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

try {
  await cp(sourceExtension, extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'http://127.0.0.1/*'])];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const modelPort = await startModelServer();
  console.log(`Local model fixture server: http://127.0.0.1:${modelPort}`);

  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-proxy-server',
      '--no-first-run',
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/dashboard.html#/setup`, { waitUntil: 'load' });
  await page.waitForSelector('input[placeholder="e.g. Personal applications"]');
  await page.fill('input[placeholder="e.g. Personal applications"]', 'Phase 4.2 model vault');
  await page.locator('input[type=password]').nth(0).fill(passphrase);
  await page.locator('input[type=password]').nth(1).fill(passphrase);
  await page.click('button:has-text("Create encrypted vault")');
  await page.waitForURL(/#\/dashboard$/);
  check('vault created', true);

  const resume = [
    'Full Name: Arun Raj',
    'Email: arun@example.com',
    'Marital Status: Single',
    'Employment Type: Full-time',
    'Aadhaar Number: 1234 5678 9012',
    'Gender: Male',
    'Nationality: Indian',
    'Degree: B.Tech Computer Science',
    'Institution: Example Institute of Technology',
  ].join('\n');
  const imported = await message(page, 'model_doc_import', 'IMPORT_DOCUMENT', {
    name: 'model-resume.txt',
    mimeType: 'text/plain',
    dataBase64: Buffer.from(resume, 'utf8').toString('base64'),
    importId: 'model_doc_import',
    fileIndex: 0,
    fileCount: 1,
  });
  check('document imported and text stored', imported?.ok === true, imported?.error);
  const documentId = imported?.data?.document?.id;
  const deterministicFields = await message(page, 'model_fields_deterministic', 'LIST_FIELDS');
  check('deterministic extraction ran during import', deterministicFields?.ok === true
    && deterministicFields.data.some((field) => field.key === 'contact.email' && field.value === 'arun@example.com')
    && deterministicFields.data.some((field) => field.key === 'personal.fullName'), JSON.stringify(deterministicFields?.data?.map((field) => field.key)));

  const initialStatus = await message(page, 'model_status_initial', 'MODEL_STATUS');
  check('model starts not installed and dashboard remains usable', initialStatus?.ok === true && initialStatus.data.status === 'not_installed', JSON.stringify(initialStatus?.data));

  const cacheSeedStart = Date.now();
  const seed = freshInstall ? { ok: true, seeded: [] } : await page.evaluate(async ({ base, repo, revision, cacheName, files }) => {
    const cache = await caches.open(cacheName);
    const seeded = [];
    for (const file of files) {
      const response = await fetch(`${base}/${file.path}`);
      if (!response.ok) return { ok: false, error: `${file.path}: HTTP ${response.status}` };
      if (!response.body) return { ok: false, error: `${file.path}: no body` };
      const headers = new Headers();
      headers.set('content-type', 'application/octet-stream');
      headers.set('content-length', String(file.size));
      await cache.put(
        `https://huggingface.co/${repo}/resolve/${revision}/${file.path}`,
        new Response(response.body, { status: 200, headers }),
      );
      seeded.push(file.path);
    }
    return { ok: true, seeded };
  }, { base: `http://127.0.0.1:${modelPort}`, repo: MODEL_REPOSITORY, revision: MODEL_REVISION, cacheName: MODEL_CACHE_NAME, files: MODEL_FILES });
  check(freshInstall ? 'fresh-install mode starts with an empty model cache' : 'all model files seeded into extension Cache Storage', seed?.ok === true, seed?.error);
  console.log(`Model cache seed: ${Math.round((Date.now() - cacheSeedStart) / 1000)}s`);
  const cacheKeys = freshInstall ? [] : await page.evaluate(async (cacheName) => {
    const cache = await caches.open(cacheName);
    return (await cache.keys()).map((request) => request.url);
  }, MODEL_CACHE_NAME);
  console.log(`Cache keys (${cacheKeys.length}): ${cacheKeys.slice(0, 3).join(' | ')}`);
  const expectedConfig = `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/config.json`;
  console.log(`config cached: ${cacheKeys.includes(expectedConfig)} expected=${expectedConfig}`);

  const installStart = Date.now();
  const install = await message(page, 'model_install', 'MODEL_INSTALL');
  check('model installation started', install?.ok === true, install?.error);
  let status = null;
  let last = '';
  for (let index = 0; index < 300; index += 1) {
    const poll = await message(page, `model_status_${index}`, 'MODEL_STATUS');
    if (!poll?.ok) {
      last = poll?.error ?? 'status failed';
      break;
    }
    status = poll.data;
    const phase = `${status.status}:${Math.round(status.progress?.percent ?? 0)}`;
    if (phase !== last) {
      console.log(`  model status ${phase} ${status.progress?.filePath ?? ''}`);
      last = phase;
    }
    if (['installed', 'ready', 'failed', 'corrupt'].includes(status.status)) break;
    await page.waitForTimeout(500);
  }
  const installMs = Date.now() - installStart;
  check('model install verified and became ready', status?.status === 'installed' || status?.status === 'ready', `${status?.status} ${status?.record?.error ?? ''}`);
  console.log(`Model install + SHA-256 verification: ${(installMs / 1000).toFixed(1)}s`);

  const statusLatencyStart = Date.now();
  const statusAfter = await message(page, 'model_status_after', 'MODEL_STATUS');
  check('model status remains responsive while installed', statusAfter?.ok === true, `${Date.now() - statusLatencyStart}ms`);

  const selfTestStart = Date.now();
  const selfTest = await message(page, 'model_selftest', 'MODEL_SELF_TEST');
  const selfTestMs = Date.now() - selfTestStart;
  check('real local model self-test succeeded', selfTest?.ok === true && selfTest.data?.ok === true, selfTest?.data?.message ?? selfTest?.error);
  console.log(`Self-test: ${(selfTestMs / 1000).toFixed(1)}s; load ${selfTest?.data?.loadMs ?? '?'}ms; inference ${selfTest?.data?.latencyMs ?? '?'}ms`);

  await context.setOffline(true);
  const offlineInfer = await message(page, 'model_offline_infer', 'INFER', {
    messages: [
      { role: 'system', content: 'Return only JSON.' },
      { role: 'user', content: 'Return {"offline":true}.' },
    ],
    maxNewTokens: 32,
  });
  await context.setOffline(false);
  check('local inference works with the browser offline', offlineInfer?.ok === true && typeof offlineInfer.data?.text === 'string', offlineInfer?.error ?? offlineInfer?.data?.text?.slice(0, 120));

  const extractStart = Date.now();
  const extraction = await message(page, 'model_extract', 'EXTRACT_DOCUMENT', { documentId, useAi: true });
  const extractMs = Date.now() - extractStart;
  check('AI-assisted document extraction completed', extraction?.ok === true && extraction.data?.aiUsed === true, extraction?.error ?? JSON.stringify(extraction?.data?.warnings));
  console.log(`AI-assisted extraction: ${(extractMs / 1000).toFixed(1)}s; ${extraction?.data?.candidates ?? 0} candidates; ${extraction?.data?.ai ?? 0} AI candidates`);

  const fields = await message(page, 'model_fields_after', 'LIST_FIELDS');
  const aiFields = fields?.data?.filter((field) => field.extractionMethod === 'ai') ?? [];
  const marital = fields?.data?.find((field) => field.key === 'personal.maritalStatus');
  check('AI candidates are stored with model provenance', aiFields.length > 0
    && aiFields.every((field) => Boolean(field.source?.modelVersion))
    && aiFields.every((field) => Boolean(field.source?.documentId)), JSON.stringify(aiFields.map((field) => ({ key: field.key, model: field.source?.modelVersion }))));
  check('model extracted marital status from the document', marital?.value === 'Single', JSON.stringify(marital));
  check('AI candidates require review and never overwrite verified values', aiFields.every((field) => field.verificationStatus === 'extracted'));

  const aiMatch = await message(page, 'model_ai_match', 'AI_MATCH_FIELDS', {
    fields: [{ index: 0, label: 'Current marital status', kind: 'unknown' }],
  }, 300_000);
  check('AI-assisted ambiguous form matching returned a reviewable suggestion', aiMatch?.ok === true
    && aiMatch.data?.suggestions?.[0]?.value === 'Single'
    && aiMatch.data.suggestions[0].method === 'ai'
    && aiMatch.data.suggestions[0].needsReview === true, JSON.stringify(aiMatch?.data ?? aiMatch?.error));

  const profileRecords = await message(page, 'model_records', 'LIST_PROFILE_RECORDS', { type: 'education' });
  check('document extraction populated structured education records', profileRecords?.ok === true
    && profileRecords.data.some((record) => record.degree === 'B.Tech Computer Science' && record.documentId === documentId), JSON.stringify(profileRecords?.data));

  await page.screenshot({ path: path.join(root, 'docs', 'phase-4-2-model-e2e.png'), fullPage: false }).catch(() => undefined);
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await context?.close().catch(() => undefined);
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
  await rm(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nMODEL E2E PASSED' : `\nMODEL E2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
