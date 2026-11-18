/**
 * Repeated-operation memory growth audit.
 *
 * Supported instrumentation only:
 *  - process-sum RSS of all Chrome processes belonging to the disposable
 *    profile (via `ps`), sampled continuously;
 *  - `performance.memory` JS heap in the dashboard renderer where Chrome
 *    exposes it (non-standard, renderer-only — NOT a per-worker heap);
 *  - `navigator.storage.estimate()` for storage usage.
 *
 * No per-worker heap value is invented. A positive slope is a signal to
 * investigate, not proof of a leak; GC pressure and IndexedDB caching can also
 * grow RSS. The report explicitly labels measurements as indirect.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('extension/dist');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-audit-growth-'));
const passphrase = 'memory-growth-passphrase-2026';
const cycles = Number(process.env.MEMORY_CYCLES ?? 8);
let context;
let timer;
let runPeak = 0;

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
  if (value !== null) runPeak = Math.max(runPeak, value);
}

const message = (page, requestId, operation, payload = {}, timeout = 600_000) =>
  page.evaluate(
    ({ request, timeoutMs }) => new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs);
      chrome.runtime.sendMessage(request, (response) => { clearTimeout(t); resolve(response); });
    }),
    { request: { protocol: 1, requestId, operation, payload }, timeoutMs: timeout },
  );

function slope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

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
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  timer = setInterval(sample, 500);

  await page.goto(`chrome-extension://${id}/dashboard.html#/setup`, { waitUntil: 'load' });
  await page.waitForSelector('input[placeholder="e.g. Personal applications"]');
  await page.fill('input[placeholder="e.g. Personal applications"]', 'Memory growth audit');
  await page.locator('input[type=password]').nth(0).fill(passphrase);
  await page.locator('input[type=password]').nth(1).fill(passphrase);
  await page.click('button:has-text("Create encrypted vault")');
  await page.waitForURL(/#\/dashboard$/);
  sample();
  const initial = chromeRssMb();

  const samples = [];
  const heapSamples = [];
  const storageSamples = [];
  const docText = `Memory growth fixture ${'deterministic text. '.repeat(12_000)}`;
  const docBase64 = Buffer.from(docText, 'utf8').toString('base64');

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    // Lock/unlock (session generation + crypto re-derivation)
    await message(page, `g_lock_${cycle}`, 'VAULT_LOCK');
    await message(page, `g_unlock_${cycle}`, 'VAULT_UNLOCK', { passphrase }, 120_000);
    // Small document import then delete (parser worker + IndexedDB churn)
    const imported = await message(page, `g_import_${cycle}`, 'IMPORT_DOCUMENT', {
      name: `growth-${cycle}.txt`, mimeType: 'text/plain', dataBase64: docBase64, importId: `growth_${cycle}`,
    }, 120_000);
    if (imported?.ok && imported.data?.document?.id) {
      await message(page, `g_delete_${cycle}`, 'DELETE_DOCUMENT', { id: imported.data.document.id });
    }
    // Worker termination / recovery path and status polling
    await message(page, `g_cancel_${cycle}`, 'INFER_CANCEL');
    await message(page, `g_status_${cycle}`, 'MODEL_STATUS');
    // Backup processing
    await message(page, `g_export_${cycle}`, 'EXPORT_VAULT', { passphrase: 'growth-backup-passphrase-2026' }, 300_000);

    await page.waitForTimeout(250);
    const rss = chromeRssMb();
    samples.push(rss ?? 0);
    const heap = await page.evaluate(() => {
      const perf = performance;
      const memory = (perf).memory;
      return memory && typeof memory.usedJSHeapSize === 'number' ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : null;
    });
    heapSamples.push(heap);
    const storage = await message(page, `g_storage_${cycle}`, 'GET_STORAGE_STATUS');
    storageSamples.push(storage?.ok === true);
  }

  // Settle and sample post-cleanup memory.
  await page.waitForTimeout(2000);
  const postCleanup = chromeRssMb();

  const report = {
    generatedAt: new Date().toISOString(),
    cycles,
    instrumentation: {
      rss: 'process-sum RSS of Chrome processes for the disposable profile (indirect, includes browser UI/GPU/renderers/workers)',
      jsHeap: 'performance.memory.usedJSHeapSize in the dashboard renderer (non-standard, renderer-only; not a worker heap)',
      perWorkerHeap: 'unavailable — not reported',
    },
    initialRssMb: initial,
    perCycleRssMb: samples,
    perCycleRendererHeapMb: heapSamples,
    postCleanupRssMb: postCleanup,
    runPeakRssMb: runPeak,
    rssGrowthPerCycleMb: Number(slope(samples).toFixed(2)),
    storageStatusChecksPassed: storageSamples.filter(Boolean).length,
    note: 'A positive slope can reflect GC timing or IndexedDB caching, not necessarily a leak. Confirm sustained growth with more cycles before classifying as a leak.',
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (timer) clearInterval(timer);
  await context?.close().catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true });
}
