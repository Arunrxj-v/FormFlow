import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('extension/dist');
const executablePath = process.env.CHROME_PATH;
const tempDir = await mkdtemp(path.join(tmpdir(), 'ff-content-isolation-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-content-profile-'));
const keyPath = path.join(tempDir, 'key.pem');
const certPath = path.join(tempDir, 'cert.pem');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', certPath, '-days', '1',
  '-subj', '/CN=127.0.0.1',
], { stdio: 'ignore' });

const html = `<!doctype html><html><head><title>Probe page</title></head><body>
<h1>Probe page</h1>
<script>
  window.__probe = {
    runtime: typeof chrome !== 'undefined' && typeof chrome.runtime !== 'undefined',
    storage: typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined',
    pong: false
  };
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'FORMFLOW_EXTENSION_PONG') window.__probe.pong = true;
  });
  window.postMessage({ type: 'FORMFLOW_EXTENSION_PING' }, '*');
<\/script>
</body></html>`;

const googleHtml = `<!doctype html><html><head><title>Test Google Form</title></head><body>
<form>
  <div role="listitem">
    <div class="freebirdFormviewerComponentsQuestionTextTitle">Full name</div>
    <input type="text" name="name" aria-label="Full name" />
  </div>
  <div role="listitem">
    <div class="freebirdFormviewerComponentsQuestionTextTitle">Email address</div>
    <input type="email" name="email" aria-label="Email address" />
  </div>
</form>
<script>
  window.__probe = {
    runtime: typeof chrome !== 'undefined' && typeof chrome.runtime !== 'undefined',
    storage: typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined',
    pong: false
  };
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'FORMFLOW_EXTENSION_PONG') window.__probe.pong = true;
  });
  window.postMessage({ type: 'FORMFLOW_EXTENSION_PING' }, '*');
<\/script>
</body></html>`;

const httpServer = createHttpServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(html);
});
const httpsServer = createHttpsServer({
  key: await readFile(keyPath),
  cert: await readFile(certPath),
}, (_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(html);
});
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
const httpPort = httpServer.address().port;
const httpsPort = httpsServer.address().port;
let failures = 0;
let context;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 240)}` : ''}`);
  if (!condition) failures += 1;
};

const message = (page, requestId, operation, payload = {}) =>
  page.evaluate(
    (request) => chrome.runtime.sendMessage(request),
    { protocol: 1, requestId, operation, payload },
  );

async function inspect(page, label) {
  const state = await page.evaluate(async () => {
    const databases = typeof indexedDB.databases === 'function'
      ? await indexedDB.databases()
      : [];
    return {
      probe: window.__probe,
      marker: document.documentElement.getAttribute('data-formflow-extension'),
      databases: databases.map((database) => database.name).filter(Boolean),
    };
  });
  check(`${label}: extension APIs are unavailable to the page`, state.probe?.runtime === false && state.probe?.storage === false, JSON.stringify(state.probe));
  check(`${label}: no page-world bridge responds`, state.probe?.pong === false, JSON.stringify(state.probe));
  check(`${label}: extension vault IndexedDB is not visible`, !state.databases.includes('formflow-local'), JSON.stringify(state.databases));
  return state;
}

try {
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.FF_HEADED !== '1',
    ...(executablePath ? { executablePath } : process.env.CI ? { channel: 'chromium' } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--ignore-certificate-errors',
      '--no-proxy-server',
      '--no-first-run',
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html#/setup`, { waitUntil: 'load' });
  await dashboard.waitForSelector('input[placeholder="e.g. Personal applications"]');
  await dashboard.fill('input[placeholder="e.g. Personal applications"]', 'Content isolation vault');
  await dashboard.locator('input[type=password]').nth(0).fill('content-isolation-passphrase-2026');
  await dashboard.locator('input[type=password]').nth(1).fill('content-isolation-passphrase-2026');
  await dashboard.click('button:has-text("Create encrypted vault")');
  await dashboard.waitForURL(/#\/dashboard$/);
  await dashboard.waitForTimeout(700);

  const httpPage = await context.newPage();
  await httpPage.goto(`http://127.0.0.1:${httpPort}/`, { waitUntil: 'load' });
  await httpPage.waitForTimeout(800);
  const httpState = await inspect(httpPage, 'HTTP');
  check('HTTP page: content script did not run', httpState.marker === null, httpState.marker);

  const httpsPage = await context.newPage();
  await httpsPage.goto(`https://127.0.0.1:${httpsPort}/`, { waitUntil: 'load' });
  await httpsPage.waitForTimeout(800);
  const httpsState = await inspect(httpsPage, 'HTTPS');
  check('HTTPS page: content script did not run', httpsState.marker === null, httpsState.marker);

  // Serve a realistic Google Forms-origin document through route interception.
  await context.route('https://docs.google.com/forms/**', async (route) => {
    if (route.request().resourceType() === 'document') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: googleHtml });
    } else {
      await route.fulfill({ status: 204, body: '' });
    }
  });
  const googlePage = await context.newPage();
  await googlePage.goto('https://docs.google.com/forms/d/e/test/viewform', { waitUntil: 'load' });
  await googlePage.waitForTimeout(1200);
  const googleState = await inspect(googlePage, 'Google Forms');
  check('Google Forms: content script was injected', googleState.marker === 'installed', googleState.marker);
  check('Google Forms: extension APIs remain unavailable to the page', googleState.probe?.runtime === false && googleState.probe?.storage === false);

  await googlePage.bringToFront();
  const scan = await message(dashboard, 'content_scan', 'SCAN_ACTIVE_TAB');
  check('Google Forms: background can invoke the content script', scan?.ok === true, scan?.error);
  check('Google Forms: scan reports the real Google Forms tab', scan?.ok === true && scan.data?.tab?.url?.includes('docs.google.com/forms/'), JSON.stringify(scan?.data?.tab));

  // The page cannot send a privileged runtime request; chrome.runtime is absent.
  const pageCannotMessage = await googlePage.evaluate(() => typeof chrome === 'undefined' || typeof chrome.runtime === 'undefined');
  check('Google Forms: page cannot send privileged extension messages', pageCannotMessage);

  console.log('BROWSER_VERSION:', await context.browser()?.version());
  console.log(`FAILURES: ${failures}`);
  process.exitCode = failures ? 1 : 0;
} finally {
  if (context) {
    try {
      await context.close();
    } catch {
      // Browser already gone.
    }
  }
  await new Promise((resolve) => httpServer.close(resolve));
  await new Promise((resolve) => httpsServer.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
