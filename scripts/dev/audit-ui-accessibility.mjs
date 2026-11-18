import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('extension/dist');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-ui-audit-'));
const passphrase = 'ui-audit-passphrase-2026';
let context;
let failures = 0;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 300)}` : ''}`);
  if (!condition) failures += 1;
};

const message = (page, requestId, operation, payload = {}, timeout = 60_000) =>
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
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${id}/dashboard.html#/setup`, { waitUntil: 'load' });
  await page.waitForSelector('input[placeholder="e.g. Personal applications"]');
  await page.fill('input[placeholder="e.g. Personal applications"]', 'UI audit vault');
  await page.locator('input[type=password]').nth(0).fill(passphrase);
  await page.locator('input[type=password]').nth(1).fill(passphrase);
  await page.click('button:has-text("Create encrypted vault")');
  await page.waitForURL(/#\/dashboard$/);

  for (const field of [
    { key: 'personal.fullName', label: 'Full name', value: 'UI Audit Person', category: 'personal' },
    { key: 'contact.email', label: 'Email address', value: 'ui@example.com', category: 'contact' },
    { key: 'personal.dateOfBirth', label: 'Date of birth', value: '1990-01-01', category: 'personal' },
  ]) {
    const result = await message(page, `ui_add_${field.key}`, 'ADD_FIELD', {
      field: {
        ...field,
        confidence: 100,
        verificationStatus: field.key === 'contact.email' ? 'user_verified' : 'extracted',
        extractionMethod: 'manual',
        source: { documentId: 'manual', documentName: 'User entered' },
      },
    });
    check(`seed field ${field.key}`, result?.ok === true, result?.error);
  }

  const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('dashboard has no horizontal overflow at 1280px', (await overflow()) <= 1, await overflow());

  await page.setViewportSize({ width: 768, height: 900 });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=Recent vault documents');
  check('dashboard has no horizontal overflow at 768px', (await overflow()) <= 1, await overflow());
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto(`chrome-extension://${id}/dashboard.html#/documents`, { waitUntil: 'load' });
  await page.waitForSelector('text=Document Vault');
  check('document file-type filter exists', (await page.locator('select[aria-label="Filter by file type"]').count()) === 1);
  check('document status filter exists', (await page.locator('select[aria-label="Filter by status"]').count()) === 1);
  await page.fill('input[placeholder*="Search documents"]', 'no-such-document-xyz');
  await page.waitForSelector('text=No documents match this view');
  check('empty document search has a clear empty state', await page.locator('text=No documents match this view').isVisible());
  await page.click('button:has-text("Reset filters")');
  await page.fill('input[placeholder*="Search documents"]', '');
  check('document search can be reset', (await page.locator('input[placeholder*="Search documents"]').inputValue()) === '');

  await page.goto(`chrome-extension://${id}/dashboard.html#/records/personal`, { waitUntil: 'load' });
  await page.waitForSelector('text=Personal Profile');
  const profileSearch = page.locator('input[aria-label="Search profile values"]');
  await profileSearch.fill('email');
  await page.waitForSelector('text=ui@example.com');
  check('profile search matches values', await page.locator('text=ui@example.com').first().isVisible());
  await profileSearch.fill('nothing-matches-this');
  await page.waitForSelector('text=matching value');
  check('profile search reports zero matches instead of silently hiding data', (await page.locator('text=0 matching values').count()) > 0);
  await page.click('button:has-text("Reset filters")');
  check('profile filters can be reset', (await profileSearch.inputValue()) === '');

  await page.selectOption('select[aria-label="Filter by verification status"]', 'verified');
  await page.waitForSelector('text=1 matching value');
  check('verification filter limits results to verified fields', (await page.locator('text=ui@example.com').count()) > 0);
  await page.selectOption('select[aria-label="Filter by verification status"]', 'all');

  await page.click('button:has-text("Add value")');
  await page.waitForSelector('[role="dialog"]');
  check('modal exposes role=dialog and aria-modal', (await page.locator('[role="dialog"][aria-modal="true"]').count()) === 1);
  const focusInside = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return Boolean(dialog && document.activeElement && dialog.contains(document.activeElement));
  });
  check('opening a modal moves focus inside it', focusInside);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape closes the modal', (await page.locator('[role="dialog"]').count()) === 0);

  await page.keyboard.press('Tab');
  const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
  check('keyboard focus reaches an interactive element', ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(focusedTag), focusedTag);
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await context?.close().catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nUI ACCESSIBILITY AUDIT PASSED' : `\nUI ACCESSIBILITY AUDIT FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
