import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const formflow = path.resolve('extension/dist');
const helper = path.resolve('scripts/dev/fixtures/reload-helper');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-extension-reload-'));
const executablePath = process.env.CHROME_PATH;
const passphrase = 'extension-reload-passphrase-2026';
let context;
let failures = 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 240)}` : ''}`);
  if (!condition) failures += 1;
};

const message = (page, requestId, operation, payload = {}, timeout = 120_000) =>
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

async function openDashboard(extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dashboard.html#/dashboard`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(800);
  return page;
}

try {
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      `--disable-extensions-except=${formflow},${helper}`,
      `--load-extension=${formflow},${helper}`,
      '--no-proxy-server',
      '--no-first-run',
    ],
  });
  await wait(1500);
  let formflowId = null;
  let helperId = null;
  for (const worker of context.serviceWorkers()) {
    const id = new URL(worker.url()).host;
    if (!formflowId) formflowId = id;
    else helperId = id;
  }
  check('FormFlow and helper extensions loaded', Boolean(formflowId && helperId), JSON.stringify({ formflowId, helperId }));

  const dashboard = await openDashboard(formflowId);
  await dashboard.goto(`chrome-extension://${formflowId}/dashboard.html#/setup`, { waitUntil: 'load' });
  await dashboard.waitForSelector('input[placeholder="e.g. Personal applications"]');
  await dashboard.fill('input[placeholder="e.g. Personal applications"]', 'Reload lifecycle vault');
  const passwords = dashboard.locator('input[type=password]');
  await passwords.nth(0).fill(passphrase);
  await passwords.nth(1).fill(passphrase);
  await dashboard.click('button:has-text("Create encrypted vault")');
  await dashboard.waitForURL(/#\/dashboard$/);
  await dashboard.waitForTimeout(900);

  const bytes = Buffer.alloc(1024, 7);
  const imported = await message(dashboard, 'reload_import', 'IMPORT_DOCUMENT', {
    name: 'reload-document.pdf',
    mimeType: 'application/pdf',
    dataBase64: bytes.toString('base64'),
  });
  check('document imported before reload', imported?.ok === true, imported?.error);
  const field = await message(dashboard, 'reload_field', 'ADD_FIELD', {
    field: {
      key: 'contact.reloadTest',
      label: 'Reload value',
      value: 'persisted-across-reload@example.com',
      category: 'contact',
      source: { documentId: imported.data.document.id, documentName: 'reload-document.pdf' },
      confidence: 100,
      verificationStatus: 'user_verified',
      extractionMethod: 'manual',
      userModified: true,
    },
  });
  check('profile value added before reload', field?.ok === true, field?.error);
  await dashboard.reload({ waitUntil: 'load' });
  await dashboard.goto(`chrome-extension://${formflowId}/dashboard.html#/documents`, { waitUntil: 'load' });
  await dashboard.waitForTimeout(1800);
  const beforeReloadText = await dashboard.locator('body').innerText();
  check('dashboard displays decrypted content before reload', beforeReloadText.includes('reload-document.pdf'), beforeReloadText.replace(/\s+/g, ' ').slice(0, 260));

  const helperPage = await context.newPage();
  await helperPage.goto(`chrome-extension://${helperId}/control.html`, { waitUntil: 'load' });
  const all = await helperPage.evaluate(() => chrome.management.getAll());
  const target = all.find((entry) => entry.name.includes('FormFlow —'))?.id;
  check('helper identifies FormFlow extension', target === formflowId, target);

  await helperPage.evaluate((id) => chrome.management.setEnabled(id, false), target);
  await wait(1200);
  check('reload disabled FormFlow and closed its pages', !context.pages().some((page) => page.url().startsWith(`chrome-extension://${formflowId}/`)) && !context.serviceWorkers().some((worker) => worker.url().startsWith(`chrome-extension://${formflowId}/`)));
  await helperPage.evaluate((id) => chrome.management.setEnabled(id, true), target);
  await wait(2200);
  check('reload restarted the FormFlow service worker', context.serviceWorkers().some((worker) => worker.url().startsWith(`chrome-extension://${formflowId}/`)));

  const lockedDashboard = await openDashboard(formflowId);
  const lockedText = (await lockedDashboard.locator('body').innerText()).replace(/\s+/g, ' ');
  check('dashboard requires unlock after reload', lockedText.includes('Unlock your vault') && lockedDashboard.url().includes('#/unlock'), lockedText.slice(0, 200));
  const session = await lockedDashboard.evaluate(async () => chrome.storage.session.get(null));
  check('reload leaves no DEK in extension storage', !('formflow.vault.session_key' in session) && session['formflow.vault.state']?.state === 'locked', JSON.stringify(session));
  const lockedStatus = await message(lockedDashboard, 'reload_locked_status', 'VAULT_STATUS');
  check('vault status is locked after reload', lockedStatus?.ok === true && lockedStatus.data?.unlocked === false);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${formflowId}/popup.html`, { waitUntil: 'load' });
  await popup.waitForTimeout(1800);
  let popupLocked = (await popup.locator('body').innerText()).replace(/\s+/g, ' ');
  if (popupLocked.includes('No local vault')) {
    await popup.reload({ waitUntil: 'load' });
    await popup.waitForTimeout(1500);
    popupLocked = (await popup.locator('body').innerText()).replace(/\s+/g, ' ');
  }
  const popupRuntime = await popup.evaluate(() => ({ id: chrome.runtime.id, url: location.href }));
  const popupState = await popup.evaluate(() => chrome.runtime.sendMessage({ protocol: 1, requestId: 'reload_popup_state', operation: 'GET_STATE', payload: {} }));
  console.log('POPUP_RUNTIME', JSON.stringify(popupRuntime));
  console.log('POPUP_STATE', JSON.stringify(popupState));
  const dashboardState = await lockedDashboard.evaluate(() => chrome.runtime.sendMessage({ protocol: 1, requestId: 'reload_dashboard_state', operation: 'GET_STATE', payload: {} }));
  console.log('DASHBOARD_STATE', JSON.stringify(dashboardState));
  check('popup clears sensitive UI after reload', /locked/i.test(popupLocked) && !popupLocked.includes('persisted-across-reload@example.com'), popupLocked.slice(0, 220));
  check('popup status agrees with the locked canonical vault', popupState?.ok === true && popupState.data?.vaultStatus?.exists === true && popupState.data?.vaultStatus?.unlocked === false, JSON.stringify(popupState?.data?.vaultStatus));
  const popupSession = await popup.evaluate(async () => chrome.storage.session.get(null));
  check('popup cannot read a DEK', !('formflow.vault.session_key' in popupSession));

  const unlocked = await message(lockedDashboard, 'reload_unlock', 'VAULT_UNLOCK', { passphrase });
  check('vault unlocks after reload', unlocked?.ok === true && unlocked.data?.unlocked === true, unlocked?.error);
  await lockedDashboard.waitForTimeout(700);
  const docs = await message(lockedDashboard, 'reload_docs', 'LIST_DOCUMENTS');
  const profile = await message(lockedDashboard, 'reload_profile', 'GET_PROFILE');
  check('documents persist across extension reload', docs?.ok === true && docs.data?.count === 1 && docs.data.documents[0].name === 'reload-document.pdf');
  check('profile data persists across extension reload', profile?.ok === true && profile.data?.name.length > 0);
  const fields = await message(lockedDashboard, 'reload_fields', 'LIST_FIELDS');
  check('profile values persist across extension reload', fields?.ok === true && fields.data.some((item) => item.value === 'persisted-across-reload@example.com'));

  // Reload during an active document mutation.
  const mutationPage = await openDashboard(formflowId);
  await mutationPage.goto(`chrome-extension://${formflowId}/dashboard.html#/dashboard`, { waitUntil: 'load' });
  await mutationPage.waitForTimeout(500);
  const large = Buffer.alloc(20 * 1024 * 1024, 11);
  const pending = mutationPage.evaluate(
    ({ request }) => new Promise((resolve) => chrome.runtime.sendMessage(request, (response) => resolve(response))),
    {
      request: {
        protocol: 1,
        requestId: 'reload_active_mutation',
        operation: 'IMPORT_DOCUMENT',
        payload: { name: 'reload-active.pdf', mimeType: 'application/pdf', dataBase64: large.toString('base64') },
      },
    },
  ).catch(() => null);
  await wait(10);
  await helperPage.evaluate((id) => chrome.management.setEnabled(id, false), target);
  await wait(900);
  const mutationResult = await pending;
  check('active mutation did not report a false success during reload', mutationResult == null || mutationResult.ok !== true, JSON.stringify(mutationResult));
  await helperPage.evaluate((id) => chrome.management.setEnabled(id, true), target);
  await wait(2200);

  const recovered = await openDashboard(formflowId);
  const recoveredUnlock = await message(recovered, 'reload_recovered_unlock', 'VAULT_UNLOCK', { passphrase });
  check('vault unlocks after reload during mutation', recoveredUnlock?.ok === true && recoveredUnlock.data?.unlocked === true, recoveredUnlock?.error);
  await recovered.waitForTimeout(600);
  const state = await recovered.evaluate(async () => {
    const request = indexedDB.open('formflow-local');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readAll = (store) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return { documents: await readAll('documents'), files: await readAll('documentFiles') };
  });
  check(
    'reload during mutation leaves no partial document/file pair',
    state.documents.length === state.files.length,
    JSON.stringify({ documents: state.documents.length, files: state.files.length }),
  );
  check(
    'reload during mutation preserves the original document',
    state.documents.some((document) => document.nameEnc) && state.documents.length <= 2,
    JSON.stringify({ documents: state.documents.length }),
  );

  console.log('BROWSER_VERSION:', await context.browser()?.version());
  console.log(`FAILURES: ${failures}`);
  process.exitCode = failures ? 1 : 0;
} finally {
  if (context) {
    try {
      await context.close();
    } catch {
      // Browser already closed.
    }
  }
  await rm(userDataDir, { recursive: true, force: true });
}
