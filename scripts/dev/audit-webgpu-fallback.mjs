import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('extension/dist');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-webgpu-audit-'));
let context;
let failures = 0;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 300)}` : ''}`);
  if (!condition) failures += 1;
};

try {
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? { channel: 'chromium' } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-proxy-server',
      '--no-first-run',
      '--disable-webgpu',
      '--disable-gpu',
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/dashboard.html#/setup`, { waitUntil: 'load' });
  const status = await page.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ protocol: 1, requestId: 'webgpu_probe', operation: 'MODEL_STATUS', payload: {} }, resolve);
  }));
  check('model status remains available without WebGPU', status?.ok === true, status?.error);
  check('WASM fallback is reported', status?.data?.capabilities?.wasm === true, JSON.stringify(status?.data?.capabilities));
  check('WebGPU-disabled environment is reported truthfully', status?.data?.capabilities?.webgpu === false, JSON.stringify(status?.data?.capabilities));
  check('model is not falsely marked ready', status?.data?.ready === false && status?.data?.status !== 'ready', JSON.stringify(status?.data));
} finally {
  await context?.close().catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nWEBGPU FALLBACK AUDIT PASSED' : `\nWEBGPU FALLBACK AUDIT FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
