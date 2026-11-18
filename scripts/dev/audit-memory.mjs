import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('extension/dist');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-audit-memory-'));
const passphrase = 'memory-audit-passphrase-2026';
let context;
let timer;
let runPeak = 0;
let phasePeak = 0;

function chromeRssMb() {
  try {
    const output = execFileSync('ps', ['-Ao', 'rss=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    let totalKb = 0;
    for (const line of output.split('\n')) {
      if (!line.includes(userDataDir)) continue;
      const match = line.trim().match(/^(\d+)/);
      if (match) totalKb += Number(match[1]);
    }
    return totalKb > 0 ? Math.round(totalKb / 1024) : null;
  } catch {
    return null;
  }
}

function sample() {
  const value = chromeRssMb();
  if (value === null) return;
  runPeak = Math.max(runPeak, value);
  phasePeak = Math.max(phasePeak, value);
}

function mark(label) {
  sample();
  const value = chromeRssMb();
  console.log(`MEMORY ${label}: current ${value ?? 'unavailable'} MB; phase peak ${phasePeak} MB; run peak ${runPeak} MB`);
  phasePeak = value ?? 0;
}

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

try {
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? { channel: 'chromium' } : {}),
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
  timer = setInterval(sample, 500);
  mark('after-browser-start');
  await page.goto(`chrome-extension://${id}/dashboard.html#/setup`, { waitUntil: 'load' });
  await page.waitForSelector('input[placeholder="e.g. Personal applications"]');
  await page.fill('input[placeholder="e.g. Personal applications"]', 'Memory audit vault');
  await page.locator('input[type=password]').nth(0).fill(passphrase);
  await page.locator('input[type=password]').nth(1).fill(passphrase);
  await page.click('button:has-text("Create encrypted vault")');
  await page.waitForURL(/#\/dashboard$/);
  mark('after-vault-creation');

  const text = `Memory audit document\n${'The quick brown fox jumps over the lazy dog. '.repeat(95_000)}`;
  const bytes = Buffer.from(text, 'utf8');
  console.log(`Document size: ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MiB`);
  const imported = await message(page, 'memory_import', 'IMPORT_DOCUMENT', {
    name: 'memory-large.txt',
    mimeType: 'text/plain',
    dataBase64: bytes.toString('base64'),
    importId: 'memory_import',
  });
  console.log(`IMPORT ${imported?.ok ? 'ok' : `failed: ${imported?.error}`}`);
  mark('after-large-text-import');

  const exported = await message(page, 'memory_export', 'EXPORT_VAULT', { passphrase: 'memory-backup-passphrase-2026' }, 300_000);
  console.log(`EXPORT ${exported?.ok ? `ok (${(exported.data.sizeBytes / 1024).toFixed(1)} KiB)` : `failed: ${exported?.error}`}`);
  mark('after-backup-export');

  for (let index = 0; index < 3; index += 1) {
    const lock = await message(page, `memory_lock_${index}`, 'VAULT_LOCK');
    const unlock = await message(page, `memory_unlock_${index}`, 'VAULT_UNLOCK', { passphrase }, 120_000);
    if (!lock?.ok || !unlock?.ok) console.log(`LOCK/UNLOCK ${index} failed`, lock, unlock);
  }
  mark('after-three-lock-unlock-cycles');

  await message(page, 'memory_lock_final', 'VAULT_LOCK');
  const locked = await message(page, 'memory_document_list_locked', 'LIST_DOCUMENTS');
  console.log(`LOCKED READ ${locked?.ok === false ? 'correctly rejected' : 'unexpectedly succeeded'}`);
  console.log(`MEMORY overall peak: ${runPeak} MB (sum of Chrome processes for this profile; JS heap and worker heap are not isolated)`);
} finally {
  if (timer) clearInterval(timer);
  await context?.close().catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true });
}
