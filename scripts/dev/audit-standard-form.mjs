import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const sourceExtension = path.resolve('extension/dist');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-audit-standard-'));
const extensionPath = path.join(userDataDir, 'extension');
const passphrase = 'audit-standard-passphrase-2026';
let context;
let server;
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

const formHtml = `<!doctype html><html><head><title>Audit Standard Form</title></head><body>
  <form id="application">
    <label for="full-name">Full name</label>
    <input id="full-name" name="fullName" type="text" placeholder="Your full name" />
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" aria-label="Email address" />
    <label for="phone">Phone number</label>
    <input id="phone" name="phone" type="tel" aria-label="Phone number" />
    <label for="country">Country</label>
    <select id="country" name="country"><option value="">Choose</option><option>India</option><option>Canada</option></select>
    <label for="notes">Describe your academic background</label>
    <textarea id="notes" name="notes"></textarea>
    <fieldset>
      <legend>Gender</legend>
      <label><input type="radio" name="gender" value="Male" /> Male</label>
      <label><input type="radio" name="gender" value="Female" /> Female</label>
    </fieldset>
    <fieldset>
      <legend>Technical skills</legend>
      <label><input type="checkbox" name="skills" value="Python" /> Python</label>
      <label><input type="checkbox" name="skills" value="TypeScript" /> TypeScript</label>
    </fieldset>
    <button type="submit" id="submit" onclick="window.__auditSubmitted = true; return false;">Submit</button>
  </form>
  <script>
    document.querySelector('#phone').addEventListener('input', (event) => {
      event.target.value = event.target.value.replace(/\\d/g, '').slice(0, 3);
    });
  </script>
</body></html>`;

try {
  await cp(sourceExtension, extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'http://127.0.0.1/*'])];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(formHtml);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Audit server did not bind.');
  const formUrl = `http://127.0.0.1:${address.port}/apply`;

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
  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${id}/dashboard.html#/setup`, { waitUntil: 'load' });
  await dashboard.waitForSelector('input[placeholder="e.g. Personal applications"]');
  await dashboard.fill('input[placeholder="e.g. Personal applications"]', 'Standard form audit');
  await dashboard.locator('input[type=password]').nth(0).fill(passphrase);
  await dashboard.locator('input[type=password]').nth(1).fill(passphrase);
  await dashboard.click('button:has-text("Create encrypted vault")');
  await dashboard.waitForURL(/#\/dashboard$/);

  const fields = [
    { key: 'personal.fullName', label: 'Full name', value: 'Audit Person', category: 'personal' },
    { key: 'contact.email', label: 'Email address', value: 'audit@example.com', category: 'contact' },
    { key: 'contact.phone', label: 'Phone number', value: '9876543210', category: 'contact' },
    { key: 'contact.country', label: 'Country', value: 'India', category: 'contact' },
    { key: 'education.degree', label: 'Degree', value: 'B.Tech Computer Science', category: 'education' },
    { key: 'personal.gender', label: 'Gender', value: 'Male', category: 'personal' },
    { key: 'skills.technical', label: 'Technical skills', value: 'TypeScript', category: 'skills' },
  ];
  for (const field of fields) {
    const result = await message(dashboard, `standard_add_${field.key}`, 'ADD_FIELD', {
      field: {
        ...field,
        confidence: 100,
        verificationStatus: 'user_verified',
        extractionMethod: 'manual',
        source: { documentId: 'manual', documentName: 'User entered' },
      },
    });
    check(`field added: ${field.key}`, result?.ok === true, result?.error);
  }

  const form = await context.newPage();
  await form.goto(formUrl, { waitUntil: 'load' });
  await form.waitForTimeout(700);
  await form.bringToFront();

  const preLockScan = await message(dashboard, 'standard_scan_prelock', 'GET_FORM_SUGGESTIONS', {});
  const preLockToken = preLockScan?.data?.approvalToken;
  const lock = await message(dashboard, 'standard_lock', 'VAULT_LOCK');
  const unlock = await message(dashboard, 'standard_unlock', 'VAULT_UNLOCK', { passphrase });
  check('vault can lock and unlock during a pending autofill review', lock?.ok === true && unlock?.ok === true, JSON.stringify({ lock, unlock }));
  const afterLockFill = await message(dashboard, 'standard_fill_after_lock', 'FILL_ACTIVE_TAB', {
    approvalToken: preLockToken,
    fills: [{ index: 0, value: 'Post Unlock Person' }],
  });
  check('lock invalidates a pending scan approval', afterLockFill?.ok === false && /approval|rescan|missing/i.test(afterLockFill.error ?? ''), afterLockFill);

  const scan = await message(dashboard, 'standard_scan', 'GET_FORM_SUGGESTIONS', {});
  check('standard form scan succeeds', scan?.ok === true && scan.data?.matches?.length >= 4, scan?.error ?? JSON.stringify(scan?.data?.scan?.fields));
  const values = new Map((scan?.data?.matches ?? []).map((match) => [match.fieldLabel, match.value]));
  check('standard label/placeholder matching finds name', values.get('Full name') === 'Audit Person', JSON.stringify([...values.entries()]));
  check('standard email matching finds email', values.get('Email address') === 'audit@example.com', JSON.stringify([...values.entries()]));
  check('standard select matching finds country', values.get('Country') === 'India', JSON.stringify([...values.entries()]));
  check('standard long-answer generation is grounded', String(values.get('Describe your academic background') ?? '').includes('B.Tech'), JSON.stringify([...values.entries()]));

  const approvalToken = scan?.data?.approvalToken;
  check('standard scan issues approval token', typeof approvalToken === 'string' && approvalToken.startsWith('approval_'), approvalToken);
  const indexes = new Map((scan?.data?.matches ?? []).map((match) => [match.fieldLabel, match.index]));
  const fills = ['Full name', 'Email address', 'Phone number', 'Country', 'Male', 'Female', 'Python', 'TypeScript']
    .map((label) => ({ label, index: indexes.get(label), value: values.get(label) }))
    .filter((item) => Number.isInteger(item.index) && item.value);
  const fill = await message(dashboard, 'standard_fill', 'FILL_ACTIVE_TAB', { approvalToken, fills });
  check('standard fill reports successful fields and rejected phone/option mismatches', fill?.ok === true && fill.data?.result?.filled >= 5 && fill.data?.result?.failed >= 1, fill?.error ?? JSON.stringify(fill?.data?.result));
  const state = await form.evaluate(() => ({
    name: document.querySelector('#full-name')?.value ?? '',
    email: document.querySelector('#email')?.value ?? '',
    phone: document.querySelector('#phone')?.value ?? '',
    country: document.querySelector('#country')?.value ?? '',
    male: Boolean(document.querySelector('input[name="gender"][value="Male"]')?.checked),
    female: Boolean(document.querySelector('input[name="gender"][value="Female"]')?.checked),
    python: Boolean(document.querySelector('input[name="skills"][value="Python"]')?.checked),
    typescript: Boolean(document.querySelector('input[name="skills"][value="TypeScript"]')?.checked),
    submitted: Boolean(window.__auditSubmitted),
  }));
  check('standard text/email fields accepted values', state.name === 'Audit Person' && state.email === 'audit@example.com', JSON.stringify(state));
  check('standard select accepted the matched option', state.country === 'India', JSON.stringify(state));
  check('standard radio selected only the approved gender', state.male === true && state.female === false, JSON.stringify(state));
  check('standard checkbox selected only the approved skill', state.typescript === true && state.python === false, JSON.stringify(state));
  check('rejected/transformed phone is not reported as filled', state.phone !== '9876543210', JSON.stringify(state));
  check('standard autofill never submits', state.submitted === false, JSON.stringify(state));

  const beforeMutation = await message(dashboard, 'standard_scan_mutation', 'GET_FORM_SUGGESTIONS', {});
  const mutationToken = beforeMutation?.data?.approvalToken;
  await form.evaluate(() => {
    document.querySelector('#full-name')?.setAttribute('name', 'renamed-full-name');
  });
  const mutationFill = await message(dashboard, 'standard_fill_mutation', 'FILL_ACTIVE_TAB', {
    approvalToken: mutationToken,
    fills: [{ index: indexes.get('Full name'), value: 'Mutated Person' }],
  });
  check('form mutation after scan is rejected', mutationFill?.ok === false && /form changed|rescan/i.test(mutationFill.error ?? ''), mutationFill);
  const afterMutation = await form.evaluate(() => document.querySelector('#full-name')?.value ?? '');
  check('mutated form was not filled', afterMutation === 'Audit Person', afterMutation);

  const crossTabScan = await message(dashboard, 'standard_scan_cross_tab', 'GET_FORM_SUGGESTIONS', {});
  const crossTabToken = crossTabScan?.data?.approvalToken;
  const otherTab = await context.newPage();
  await otherTab.goto(formUrl, { waitUntil: 'load' });
  await otherTab.bringToFront();
  const crossTabFill = await message(dashboard, 'standard_fill_cross_tab', 'FILL_ACTIVE_TAB', {
    approvalToken: crossTabToken,
    fills: [{ index: 0, value: 'Wrong Tab' }],
  });
  check('approval cannot be used from a different tab', crossTabFill?.ok === false && /tab changed|rescan/i.test(crossTabFill.error ?? ''), crossTabFill);
  const otherValues = await otherTab.evaluate(() => ({ name: document.querySelector('#full-name')?.value ?? '', submitted: Boolean(window.__auditSubmitted) }));
  check('cross-tab approval did not fill the other tab', otherValues.name === '' && otherValues.submitted === false, JSON.stringify(otherValues));
  await otherTab.close();
  await form.bringToFront();

  const reuse = await message(dashboard, 'standard_reuse', 'FILL_ACTIVE_TAB', {
    approvalToken,
    fills: [{ index: indexes.get('Full name'), value: 'Overwrite' }],
  });
  check('standard approval token is single-use', reuse?.ok === false && /approval|used|rescan/i.test(reuse.error ?? ''), reuse);
  const afterReuse = await form.evaluate(() => document.querySelector('#full-name')?.value ?? '');
  check('standard reused approval cannot overwrite', afterReuse === 'Audit Person', afterReuse);
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await context?.close().catch(() => undefined);
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
  await rm(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nSTANDARD FORM AUDIT PASSED' : `\nSTANDARD FORM AUDIT FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
