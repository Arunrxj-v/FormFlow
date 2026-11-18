import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('extension/dist');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-router-navigation-'));
const executablePath = process.env.CHROME_PATH;
const passphrase = 'router-navigation-passphrase';
let context;
let failures = 0;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 320)}` : ''}`);
  if (!condition) failures += 1;
};

async function hash(page) {
  return page.evaluate(() => window.location.hash);
}

async function waitForHash(page, expected) {
  await page.waitForFunction((value) => window.location.hash === value, expected, { timeout: 15_000 });
}

try {
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(executablePath ? { executablePath } : process.env.CI ? { channel: 'chromium' } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-proxy-server',
      '--no-first-run',
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`chrome-extension://${extensionId}/dashboard.html#/setup`, { waitUntil: 'load' });
  await page.waitForSelector('input[placeholder="e.g. Personal applications"]');
  await page.fill('input[placeholder="e.g. Personal applications"]', 'Router navigation vault');
  await page.locator('input[type=password]').nth(0).fill(passphrase);
  await page.locator('input[type=password]').nth(1).fill(passphrase);
  await page.click('button:has-text("Create encrypted vault")');
  await page.waitForURL(/#\/dashboard$/);
  await page.waitForTimeout(1500);
  await page.waitForSelector('.ff-nav__link', { timeout: 30000 }).catch(async () => { console.error('NAV_DEBUG', (await page.locator('body').innerText()).slice(0, 2000)); });
  check('HashRouter starts at the dashboard', (await hash(page)) === '#/dashboard', await hash(page));

  const navigate = async (label, expectedHash, text) => {
    await page.locator('.ff-nav__link', { hasText: label }).first().click();
    await waitForHash(page, expectedHash);
    if (text) await page.waitForFunction((value) => document.body.innerText.includes(value), text, { timeout: 15_000 });
    const body = await page.locator('body').innerText();
    check(`navigation: ${label}`, (await hash(page)) === expectedHash && (!text || body.includes(text)), JSON.stringify({ hash: await hash(page), textFound: !text || body.includes(text) }));
  };

  await navigate('Document Vault', '#/documents', 'Document Vault');
  await navigate('Personal Profile', '#/records/personal', 'Review the identity and contact values');
  await navigate('Collections', '#/collections', 'Collections');
  await navigate('Form history', '#/history', 'Form history');
  await navigate('Extension setup', '#/extension', 'Chrome extension');
  await navigate('Backup & migration', '#/vault/migration', 'Backup');

  await page.locator('.ff-nav__link', { hasText: 'Security' }).first().click();
  await waitForHash(page, '#/settings?tab=security');
  check('useSearchParams navigation keeps the security tab', (await page.locator('body').innerText()).includes('Security'), await hash(page));

  await page.goBack();
  await page.waitForTimeout(250);
  check('browser back updates the HashRouter location', (await hash(page)).startsWith('#/'), await hash(page));
  await page.goForward();
  await page.waitForTimeout(250);
  check('browser forward updates the HashRouter location', (await hash(page)) === '#/settings?tab=security', await hash(page));

  await page.evaluate(() => { window.location.hash = '#/route-that-does-not-exist'; });
  await waitForHash(page, '#/dashboard');
  check('unknown routes redirect to the dashboard', (await hash(page)) === '#/dashboard', await hash(page));

  await page.goto(`chrome-extension://${extensionId}/dashboard.html#/documents?upload=1`, { waitUntil: 'load' });
  await page.waitForSelector('.ff-dropzone', { timeout: 15_000 });
  check('query-string route opens the upload dialog', (await hash(page)).startsWith('#/documents') && (await page.locator('.ff-dropzone').count()) === 1, await hash(page));

  check('no page errors during navigation regression', errors.length === 0, JSON.stringify(errors));
  console.log(`FAILURES: ${failures}`);
  process.exitCode = failures ? 1 : 0;
} finally {
  if (context) await context.close().catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true });
}
