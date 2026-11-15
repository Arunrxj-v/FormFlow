import { chromium } from 'playwright';
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Manual end-to-end verification against a real Chromium build.
// Run with: CHROME_PATH="/path/to/Chrome for Testing" node scripts/dev/e2e-phase3.mjs
// Omit CHROME_PATH to let Playwright use its bundled Chromium.
const extensionPath = path.resolve('extension/dist');
const executablePath = process.env.CHROME_PATH;
const realPdf = path.resolve(
  'server/storage/documents/usr_02c68862-5f98-44ab-8476-1362f9715545/doc_c10bac3f-5805-4bcd-90da-79fc4fe1fc8e/Maya_Lin_Degree_2025.pdf',
);

const tempDir = await mkdtemp(path.join(tmpdir(), 'ff-p3-e2e-'));
const testPdf = path.join(tempDir, 'phase3-real.pdf');
try {
  await access(realPdf);
  await copyFile(realPdf, testPdf);
} catch {
  await writeFile(
    testPdf,
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
  );
}
const backupPath = path.join(tempDir, 'phase3-backup.json');
const sourcePass = 'phase3-source-passphrase-2026';
const backupPass = 'phase3-backup-passphrase-2026';
const targetPass = 'phase3-target-passphrase-2026';
const profileDirA = await mkdtemp(path.join(tmpdir(), 'ff-p3-a-'));
const profileDirB = await mkdtemp(path.join(tmpdir(), 'ff-p3-b-'));
const profileDirC = await mkdtemp(path.join(tmpdir(), 'ff-p3-c-'));

const errors = [];
let failures = 0;
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 260)}` : ''}`);
  if (!condition) failures += 1;
};

async function launch(userDataDir) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-proxy-server',
      '--no-first-run',
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return { context, extensionId: new URL(worker.url()).host };
}

function wire(page, label) {
  page.on('pageerror', (error) => errors.push(`${label} pageerror: ${error}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${label} console: ${message.text()}`);
  });
}

const message = (page, requestId, operation, payload = {}) =>
  page.evaluate(
    (request) => chrome.runtime.sendMessage(request),
    { protocol: 1, requestId, operation, payload },
  );

async function createVault(page, dashboardUrl, name, passphrase) {
  await page.goto(`${dashboardUrl}#/setup`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('input[placeholder="e.g. Personal applications"]', { timeout: 20000 });
  await page.fill('input[placeholder="e.g. Personal applications"]', name);
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill(passphrase);
  await passwords.nth(1).fill(passphrase);
  await page.click('button:has-text("Create encrypted vault")');
  await page.waitForURL(/#\/dashboard$/, { timeout: 30000 });
  await page.waitForTimeout(800);
}

async function readVaultDb(page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('formflow-local');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readAll = (store) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    return {
      meta: await readAll('vaultMeta'),
      documents: await readAll('documents'),
      files: await readAll('documentFiles'),
      values: await readAll('extractedValues'),
      profile: await readAll('vaultProfile'),
    };
  });
}

let launchA;
let context;
try {
  // ---------- A: extension-owned source vault ----------
  launchA = await launch(profileDirA);
  context = launchA.context;
  const dashboardA = `chrome-extension://${launchA.extensionId}/dashboard.html`;
  const page = await context.newPage();
  wire(page, 'dashboard-A');

  await createVault(page, dashboardA, 'Phase 3 source vault', sourcePass);
  const created = await message(page, 'e2e_created', 'VAULT_STATUS');
  check('dashboard creates an encrypted vault', created?.ok === true && created.data?.unlocked === true && created.data?.encrypted === true);

  await page.goto(`${dashboardA}#/documents`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.click('button:has-text("Upload document")');
  await page.setInputFiles('input[type=file]', testPdf);
  await page.waitForTimeout(300);
  await page.click('.ff-modal button:has-text("Upload and extract")');
  await page.waitForTimeout(2500);
  check('real PDF uploaded', (await page.locator('body').innerText()).includes('phase3-real.pdf'));

  await page.goto(`${dashboardA}#/records/personal`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.click('button:has-text("Add Information")');
  await page.fill('input[placeholder="e.g. Full Name, Date of Birth"]', 'Email address');
  await page.fill('input[placeholder="e.g. John Doe"]', 'phase3-private@example.com');
  await page.click('button:has-text("Save value")');
  await page.waitForTimeout(1200);

  await page.goto(`${dashboardA}#/collections`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.click('button:has-text("New collection")');
  await page.fill('input[placeholder="e.g. Visa application"]', 'Phase 3 collection');
  await page.click('button.ff-check-row >> nth=0');
  await page.click('.ff-modal button:has-text("Create collection")');
  await page.waitForTimeout(1200);
  check('collection created', (await page.locator('body').innerText()).includes('Phase 3 collection'));

  const raw = await readVaultDb(page);
  check('vault metadata is PBKDF2 + wrapped key', raw.meta.length === 1 && raw.meta[0].kdf === 'PBKDF2-SHA256' && raw.meta[0].wrappedDataKey.includes('AES-GCM'));
  check('no passphrase written to IndexedDB', !JSON.stringify(raw.meta).includes(sourcePass));
  check('document name and filename encrypted', raw.documents[0]?.nameEnc?.includes('"alg":"AES-GCM"') && raw.documents[0]?.originalFilenameEnc?.includes('"alg":"AES-GCM"') && !JSON.stringify(raw.documents).includes('phase3-real.pdf'));
  check('document bytes are ciphertext with an IV', raw.files[0]?.ciphertext != null && raw.files[0].version === 2 && typeof raw.files[0].iv === 'string' && raw.files[0].iv.length > 8);
  check('profile encrypted at rest', raw.profile[0]?.profileEnc?.includes('"alg":"AES-GCM"'));
  check('vault value encrypted at rest', raw.values.some((value) => value.valueEnc?.includes('"alg":"AES-GCM"')) && !JSON.stringify(raw.values).includes('phase3-private@example.com'));

  const documents = await message(page, 'e2e_documents', 'LIST_DOCUMENTS');
  check('protocol LIST_DOCUMENTS', documents?.ok === true && documents.data?.count === 1);
  const documentId = documents?.data?.documents?.[0]?.id;
  const metadata = await message(page, 'e2e_metadata', 'GET_DOCUMENT_METADATA', { documentId });
  check('protocol GET_DOCUMENT_METADATA', metadata?.ok === true && metadata.data?.name === 'phase3-real.pdf');
  const stats = await message(page, 'e2e_stats', 'GET_DASHBOARD_STATS');
  check('protocol GET_DASHBOARD_STATS', stats?.ok === true);
  const storage = await message(page, 'e2e_storage', 'GET_STORAGE_STATUS');
  check('protocol GET_STORAGE_STATUS', storage?.ok === true);
  const updated = await message(page, 'e2e_profile_update', 'UPDATE_PROFILE', { name: 'Phase 3 Verified User', email: 'phase3-verified@example.com' });
  check('protocol UPDATE_PROFILE', updated?.ok === true);
  const collection = await message(page, 'e2e_collection', 'CREATE_COLLECTION', { name: 'Protocol collection', description: 'router test' });
  check('protocol CREATE_COLLECTION', collection?.ok === true && Boolean(collection.data?.id));
  const assigned = await message(page, 'e2e_assign', 'ASSIGN_DOCUMENT', { collectionId: collection.data.id, documentId });
  check('protocol ASSIGN_DOCUMENT', assigned?.ok === true && assigned.data.documentIds.includes(documentId));
  const removed = await message(page, 'e2e_remove_doc', 'REMOVE_DOCUMENT', { collectionId: collection.data.id, documentId });
  check('protocol REMOVE_DOCUMENT', removed?.ok === true && !removed.data.documentIds.includes(documentId));
  const deleted = await message(page, 'e2e_delete_collection', 'DELETE_COLLECTION', { collectionId: collection.data.id });
  check('protocol DELETE_COLLECTION', deleted?.ok === true);

  const unknown = await message(page, 'e2e_unknown_op', 'READ_ANY_DATABASE');
  check('unknown operation rejected', unknown?.ok === false);
  const badVersion = await page.evaluate(() => chrome.runtime.sendMessage({ protocol: 99, requestId: 'e2e_bad_version', operation: 'GET_PROFILE', payload: {} }));
  check('unsupported protocol rejected', badVersion?.ok === false);
  const missingId = await page.evaluate(() => chrome.runtime.sendMessage({ protocol: 1, operation: 'GET_PROFILE', payload: {} }));
  check('missing request ID rejected', missingId?.ok === false);

  // Service-worker termination must not lose the session key or wedge requests.
  const cdp = await context.newCDPSession(page);
  const workerStatuses = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (event) => {
    for (const version of event.versions) {
      if (version.scriptURL?.endsWith('/background.js')) workerStatuses.push(version.runningStatus);
    }
  });
  await cdp.send('ServiceWorker.enable');
  await page.waitForTimeout(400);
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.waitForTimeout(1200);
  const stopped = workerStatuses.includes('stopped');
  const afterWorkerRestart = await message(page, 'e2e_sw_restart', 'VAULT_STATUS');
  await page.waitForTimeout(800);
  check(
    'service worker termination and restart preserves the unlocked session',
    stopped && afterWorkerRestart?.ok === true && afterWorkerRestart.data?.unlocked === true && workerStatuses.at(-1) === 'running',
    JSON.stringify(workerStatuses.slice(-3)),
  );

  const exported = await message(page, 'e2e_export', 'EXPORT_VAULT', { passphrase: backupPass });
  check('protocol EXPORT_VAULT', exported?.ok === true && exported.data?.sizeBytes > 0);
  const exportedText = exported?.ok ? Buffer.from(exported.data.dataBase64, 'base64').toString('utf8') : '';
  check(
    'encrypted export contains no plaintext data',
    exportedText.includes('formflow-encrypted-backup') &&
      !exportedText.includes('phase3-private@example.com') &&
      !exportedText.includes('phase3-real.pdf') &&
      !exportedText.includes(sourcePass) &&
      !exportedText.includes(backupPass) &&
      !exportedText.includes('Phase 3 Verified User'),
  );
  await writeFile(backupPath, Buffer.from(exported.data.dataBase64, 'base64'));

  const importNonEmpty = await message(page, 'e2e_import_nonempty', 'IMPORT_VAULT', {
    passphrase: backupPass,
    dataBase64: exported.data.dataBase64,
  });
  check('import refuses non-empty vault', importNonEmpty?.ok === false && /already contains data/i.test(importNonEmpty.error ?? ''));

  const popup = await context.newPage();
  wire(popup, 'popup');
  await popup.goto(`chrome-extension://${launchA.extensionId}/popup.html`, { waitUntil: 'load' });
  await popup.waitForTimeout(1200);
  const popupText = (await popup.locator('body').innerText()).replace(/\s+/g, ' ');
  check('popup shows the same unlocked vault', popupText.includes('Unlocked') && !popupText.includes('No local vault'));
  check('popup lists the canonical collection', popupText.includes('Phase 3 collection'));
  const legacy = await page.evaluate(async () => chrome.storage.local.get(null));
  check('old popup vault keys are absent', !('formflow.vault' in legacy) && !('formflow.collections' in legacy) && !('formflow.user' in legacy));

  await popup.click('.ffp-nav-btn:has-text("Profile")');
  await popup.waitForTimeout(500);
  check('popup displays the shared profile value', (await popup.locator('body').innerText()).includes('phase3-private@example.com'));

  await message(page, 'e2e_lock_remote', 'VAULT_LOCK');
  await popup.waitForTimeout(1200);
  const popupAfterRemoteLock = (await popup.locator('body').innerText()).replace(/\s+/g, ' ');
  check(
    'dashboard lock clears the open popup',
    !popupAfterRemoteLock.includes('phase3-private@example.com') && /locked/i.test(popupAfterRemoteLock),
    popupAfterRemoteLock.slice(0, 220),
  );

  await popup.click('.ffp-nav-btn:has-text("Autofill")');
  await popup.fill('input[type="password"]', sourcePass);
  await popup.click('button:has-text("Unlock vault")');
  await popup.waitForTimeout(1500);
  check('popup can unlock the shared vault', (await popup.locator('body').innerText()).includes('Unlocked'));

  await popup.click('button[title="Lock vault"]');
  await popup.waitForTimeout(1200);
  const lockedFill = await message(page, 'e2e_locked_fill', 'FILL_ACTIVE_TAB', { fills: [{ index: 0, value: 'x' }] });
  check('autofill rejected while locked', lockedFill?.ok === false);
  const lockedProfile = await message(page, 'e2e_locked_profile', 'GET_PROFILE');
  check('profile access rejected while locked', lockedProfile?.ok === false);
  await page.waitForTimeout(1000);
  const lockedDashboard = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  check('dashboard blocked after popup lock', lockedDashboard.includes('Unlock your vault') && !lockedDashboard.includes('phase3-real.pdf'));

  await page.goto(`${dashboardA}#/unlock`, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.fill('input[type="password"]', 'definitely-wrong');
  await page.click('button:has-text("Unlock vault")');
  await page.waitForTimeout(1200);
  check('wrong passphrase rejected', (await page.locator('body').innerText()).toLowerCase().includes('incorrect'));
  await page.fill('input[type="password"]', sourcePass);
  await page.click('button:has-text("Unlock vault")');
  await page.waitForURL(/#\/dashboard$/, { timeout: 30000 });
  await page.waitForTimeout(500);
  const unlocked = await message(page, 'e2e_unlocked', 'VAULT_STATUS');
  check('correct passphrase unlocks', unlocked?.ok === true && unlocked.data?.unlocked === true);
  await page.goto(`${dashboardA}#/documents`, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  check('document accessible after unlock', (await page.locator('body').innerText()).includes('phase3-real.pdf'));

  await context.close();
  launchA = await launch(profileDirA);
  context = launchA.context;
  const restarted = await context.newPage();
  wire(restarted, 'restart');
  await restarted.goto(`chrome-extension://${launchA.extensionId}/dashboard.html#/dashboard`, { waitUntil: 'load' });
  await restarted.waitForTimeout(1200);
  check('browser restart requires unlock', (await restarted.locator('body').innerText()).includes('Unlock your vault'));
  await restarted.fill('input[type="password"]', sourcePass);
  await restarted.click('button:has-text("Unlock vault")');
  await restarted.waitForURL(/#\/dashboard$/, { timeout: 30000 });
  await restarted.waitForTimeout(500);
  await restarted.goto(`chrome-extension://${launchA.extensionId}/dashboard.html#/documents`, { waitUntil: 'load' });
  await restarted.waitForTimeout(1200);
  check('documents persist across restart', (await restarted.locator('body').innerText()).includes('phase3-real.pdf'));
  await context.close();

  // ---------- B: cross-origin-style encrypted import into a fresh vault ----------
  const launchB = await launch(profileDirB);
  context = launchB.context;
  const dashboardB = `chrome-extension://${launchB.extensionId}/dashboard.html`;
  const target = await context.newPage();
  wire(target, 'dashboard-B');
  await createVault(target, dashboardB, 'Phase 3 import target', targetPass);
  await target.goto(`${dashboardB}#/vault/migration`, { waitUntil: 'load' });
  await target.waitForTimeout(900);
  const importPasswords = target.locator('input[type="password"]');
  await importPasswords.last().fill(backupPass);
  await target.setInputFiles('input[type=file]', backupPath);
  await target.waitForTimeout(3000);
  const importReport = (await target.locator('body').innerText()).replace(/\s+/g, ' ');
  check('encrypted import into fresh vault completes', importReport.includes('Documents 1') && importReport.includes('Values 1'), importReport.slice(-220));
  await target.goto(`${dashboardB}#/documents`, { waitUntil: 'load' });
  await target.waitForTimeout(1200);
  check('imported PDF present in target vault', (await target.locator('body').innerText()).includes('phase3-real.pdf'));
  await target.goto(`${dashboardB}#/records/personal`, { waitUntil: 'load' });
  await target.waitForTimeout(1200);
  check('imported profile value present in target vault', (await target.locator('body').innerText()).includes('phase3-private@example.com'));
  const targetRaw = await readVaultDb(target);
  check('imported records encrypted at rest', targetRaw.documents[0]?.nameEnc?.includes('"alg":"AES-GCM"') && !JSON.stringify(targetRaw.documents).includes('phase3-real.pdf'));
  check('imported file decrypted only on access', targetRaw.files[0]?.ciphertext != null && targetRaw.files[0].version === 2);
  await context.close();

  // ---------- C: customized profile is treated as existing data ----------
  const launchC = await launch(profileDirC);
  context = launchC.context;
  const dashboardC = `chrome-extension://${launchC.extensionId}/dashboard.html`;
  const customized = await context.newPage();
  wire(customized, 'dashboard-C');
  await createVault(customized, dashboardC, 'Phase 3 customized target', targetPass);
  const profileUpdate = await message(customized, 'e2e_custom_profile', 'UPDATE_PROFILE', {
    name: 'Customized Person',
    email: 'customized@example.com',
  });
  check('custom profile saved before import attempt', profileUpdate?.ok === true);
  const importRejected = await message(customized, 'e2e_import_custom', 'IMPORT_VAULT', {
    passphrase: backupPass,
    dataBase64: exported.data.dataBase64,
  });
  check(
    'import refuses a vault with a customized profile',
    importRejected?.ok === false && /already contains data/i.test(importRejected.error ?? ''),
    importRejected?.error,
  );
  await context.close();
  context = undefined;

  const unexpected = errors.filter((error) => !error.includes('favicon'));
  check('no dashboard/popup console or page errors', unexpected.length === 0, JSON.stringify(unexpected.slice(0, 4)));

  console.log(`FAILURES: ${failures}`);
  process.exitCode = failures ? 1 : 0;
} finally {
  if (context) await context.close();
  await rm(tempDir, { recursive: true, force: true });
  await rm(profileDirA, { recursive: true, force: true });
  await rm(profileDirB, { recursive: true, force: true });
  await rm(profileDirC, { recursive: true, force: true });
}
