import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('extension/dist');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-audit-autofill-'));
const passphrase = 'audit-autofill-passphrase-2026';
let context;
let failures = 0;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 400)}` : ''}`);
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

const formHtml = (marker) => `<!doctype html>
<html><head><title>${marker}</title></head>
<body>
  <div role="list" aria-label="Questions">
    <div role="listitem">
      <div role="heading" aria-level="3">Full name</div>
      <input type="text" aria-label="Full name" id="full-name" />
    </div>
    <div role="listitem">
      <div role="heading" aria-level="3">Email address</div>
      <input type="email" aria-label="Email address" id="email" />
    </div>
    <button type="submit" id="submit" onclick="window.__auditSubmitted = true; return false;">Submit</button>
  </div>
</body></html>`;

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
  await context.route('https://docs.google.com/forms/**', async (route) => {
    const url = route.request().url();
    if (route.request().resourceType() === 'document') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: formHtml(url) });
    } else {
      await route.fulfill({ status: 204, body: '' });
    }
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${id}/dashboard.html#/setup`, { waitUntil: 'load' });
  await dashboard.waitForSelector('input[placeholder="e.g. Personal applications"]');
  await dashboard.fill('input[placeholder="e.g. Personal applications"]', 'Audit vault');
  await dashboard.locator('input[type=password]').nth(0).fill(passphrase);
  await dashboard.locator('input[type=password]').nth(1).fill(passphrase);
  await dashboard.click('button:has-text("Create encrypted vault")');
  await dashboard.waitForURL(/#\/dashboard$/);

  for (const field of [
    { key: 'personal.fullName', label: 'Full name', value: 'Audit Person', category: 'personal' },
    { key: 'contact.email', label: 'Email address', value: 'audit@example.com', category: 'contact' },
  ]) {
    const result = await message(dashboard, `audit_add_${field.key}`, 'ADD_FIELD', {
      field: {
        ...field,
        confidence: 100,
        verificationStatus: 'user_verified',
        extractionMethod: 'manual',
        source: { documentId: 'manual', documentName: 'User entered' },
      },
    });
    check(`vault field added: ${field.key}`, result?.ok === true, result?.error);
  }

  const firstUrl = 'https://docs.google.com/forms/d/e/audit-one/viewform';
  const form = await context.newPage();
  await form.goto(firstUrl, { waitUntil: 'load' });
  await form.waitForTimeout(800);
  await form.bringToFront();

  const scan = await message(dashboard, 'audit_scan_one', 'GET_FORM_SUGGESTIONS', {});
  check('Google Forms scan returns suggestions', scan?.ok === true && scan.data?.matches?.length >= 2, scan?.error ?? JSON.stringify(scan?.data?.matches));
  const token = scan?.data?.approvalToken;
  check('scan returns a tab-bound approval token', typeof token === 'string' && token.startsWith('approval_'), token);
  check('scan returns a content scan token', typeof scan?.data?.scan?.scanToken === 'string' && scan.data.scan.scanToken.length >= 8, scan?.data?.scan?.scanToken);

  const noToken = await message(dashboard, 'audit_fill_no_token', 'FILL_ACTIVE_TAB', {
    fills: [{ index: 0, value: 'Audit Person' }],
  });
  check('fill without approval is rejected', noToken?.ok === false && /approval|rescan/i.test(noToken.error ?? ''), noToken);

  const fakeContentToken = await dashboard.evaluate(async ({ fill }) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'FORMFLOW_FILL', fills: fill, scanToken: 'forged-token', requestId: 'audit_forged' }, (response) => resolve(response));
    });
  }, { fill: [{ index: 0, value: 'Forged Person' }] });
  check('content script rejects a forged scan token', fakeContentToken?.ok === false && /rescan|changed/i.test(fakeContentToken.error ?? ''), fakeContentToken);

  const secondUrl = 'https://docs.google.com/forms/d/e/audit-two/viewform';
  await form.goto(secondUrl, { waitUntil: 'load' });
  await form.waitForTimeout(500);
  await form.bringToFront();
  const staleFill = await message(dashboard, 'audit_fill_stale_tab', 'FILL_ACTIVE_TAB', {
    approvalToken: token,
    fills: [{ index: 0, value: 'Audit Person' }, { index: 1, value: 'audit@example.com' }],
  });
  check('approval cannot be reused after page navigation', staleFill?.ok === false && /changed|rescan|approval/i.test(staleFill.error ?? ''), staleFill);
  const secondValues = await form.evaluate(() => ({
    name: document.querySelector('#full-name')?.value ?? '',
    email: document.querySelector('#email')?.value ?? '',
    submitted: Boolean(window.__auditSubmitted),
  }));
  check('stale approval did not fill the new page', secondValues.name === '' && secondValues.email === '' && secondValues.submitted === false, JSON.stringify(secondValues));

  const rescan = await message(dashboard, 'audit_rescan', 'GET_FORM_SUGGESTIONS', {});
  const freshToken = rescan?.data?.approvalToken;
  check('rescan issues a new approval token', typeof freshToken === 'string' && freshToken !== token, freshToken);
  const freshFill = await message(dashboard, 'audit_fill_fresh', 'FILL_ACTIVE_TAB', {
    approvalToken: freshToken,
    fills: [{ index: 0, value: 'Audit Person' }, { index: 1, value: 'audit@example.com' }],
  });
  check('approved fill is accepted on the scanned page', freshFill?.ok === true && freshFill.data?.result?.filled === 2, freshFill?.error ?? JSON.stringify(freshFill?.data?.result));
  const filledValues = await form.evaluate(() => ({
    name: document.querySelector('#full-name')?.value ?? '',
    email: document.querySelector('#email')?.value ?? '',
    submitted: Boolean(window.__auditSubmitted),
  }));
  check('approved values are present in the page', filledValues.name === 'Audit Person' && filledValues.email === 'audit@example.com', JSON.stringify(filledValues));
  check('autofill never submits the form', filledValues.submitted === false);

  const reuse = await message(dashboard, 'audit_fill_reuse', 'FILL_ACTIVE_TAB', {
    approvalToken: freshToken,
    fills: [{ index: 0, value: 'Another Person' }],
  });
  check('approval token is single-use', reuse?.ok === false && /approval|used|rescan/i.test(reuse.error ?? ''), reuse);

  const afterReuse = await form.evaluate(() => document.querySelector('#full-name')?.value ?? '');
  check('reused approval cannot overwrite the page', afterReuse === 'Audit Person', afterReuse);
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await context?.close().catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAUTOFILL BINDING AUDIT PASSED' : `\nAUTOFILL BINDING AUDIT FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
