import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('extension/dist');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-onboarding-e2e-'));
const passphrase = 'onboarding-e2e-passphrase-2026';
let context;
let failures = 0;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 300)}` : ''}`);
  if (!condition) failures += 1;
};

try {
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.FF_HEADED !== '1',
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
  await page.goto(`chrome-extension://${id}/dashboard.html#/setup`, { waitUntil: 'load' });
  await page.waitForSelector('input[placeholder="e.g. Personal applications"]');
  await page.fill('input[placeholder="e.g. Personal applications"]', 'Onboarding audit vault');
  await page.locator('input[type=password]').nth(0).fill(passphrase);
  await page.locator('input[type=password]').nth(1).fill(passphrase);
  await page.click('button:has-text("Create encrypted vault")');
  await page.waitForURL(/#\/dashboard$/);

  await page.waitForSelector('text=Finish setting up FormFlow');
  check('fresh vault shows the first-run setup card', await page.locator('text=Finish setting up FormFlow').isVisible());
  await page.click('button:has-text("Continue setup")');
  await page.waitForURL(/#\/onboarding$/);
  await page.waitForSelector('text=Your vault is ready');
  check('setup guide opens at the welcome step', await page.locator('text=Your vault is ready').isVisible());
  check('setup progress exposes an accessible label', (await page.locator('[aria-label*="Setup step"]').count()) > 0);

  await page.click('button:has-text("Continue")');
  await page.waitForSelector('text=Optional: install the local AI model');
  check('step 2 explains the local model and temporary storage', (await page.locator('text=roughly twice that space').count()) > 0);

  // Reload must resume at the persisted step rather than restarting setup.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=Optional: install the local AI model');
  check('interrupted onboarding resumes at the saved step', await page.locator('text=Optional: install the local AI model').isVisible());

  await page.click('button:has-text("Skip AI for now")');
  await page.waitForSelector('text=Add documents when you are ready');
  check('documents step does not force an upload', (await page.locator('button:has-text("Continue without documents")').count()) > 0);
  await page.click('button:has-text("Continue without documents")');
  await page.waitForSelector('text=Review what FormFlow found');
  await page.click('button:has-text("Continue")');
  await page.waitForSelector('text=Setup complete');
  check('completion step summarizes vault state', (await page.locator('text=Encrypted vault').count()) > 0);
  await page.click('button:has-text("Go to dashboard")');
  await page.waitForURL(/#\/dashboard$/);
  check('finishing setup returns to the dashboard', page.url().endsWith('#/dashboard'));

  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=Recent vault documents');
  check('completed setup card no longer appears', (await page.locator('text=Finish setting up FormFlow').count()) === 0);

  await page.goto(`chrome-extension://${id}/dashboard.html#/onboarding`, { waitUntil: 'load' });
  await page.waitForURL(/#\/dashboard$/);
  check('completed setup guide redirects returning users to the dashboard', page.url().endsWith('#/dashboard'));

  await page.goto(`chrome-extension://${id}/dashboard.html#/onboarding?restart=1`, { waitUntil: 'load' });
  await page.waitForSelector('text=Your vault is ready');
  check('setup guide can be reopened explicitly', await page.locator('text=Your vault is ready').isVisible());
  await page.click('button:has-text("Skip setup")');
  await page.waitForURL(/#\/dashboard$/);
  check('skip setup exits without deleting vault data', page.url().endsWith('#/dashboard'));
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await context?.close().catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nONBOARDING E2E PASSED' : `\nONBOARDING E2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
