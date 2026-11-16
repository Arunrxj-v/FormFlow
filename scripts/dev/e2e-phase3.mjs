import { chromium } from 'playwright';
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;

function lengthPrefixed(parts) {
  return Buffer.from(parts.map((part) => `${Buffer.byteLength(part)}:${part}`).join('|'));
}

function v3HeaderAad(header) {
  return lengthPrefixed([
    'formflow', 'backup-header', '3',
    'application', header.application,
    'backupFormat', String(header.backupFormat),
    'cipher', header.cipher,
    'kdf', header.kdf,
    'iterations', String(header.iterations),
    'salt', header.salt,
    'nonce', header.nonce,
    'encryptionFormat', String(header.encryptionFormat),
    'schemaVersion', String(header.schemaVersion),
    'manifestVersion', String(header.manifestVersion),
    'documentCount', String(header.documentCount),
    'valueCount', String(header.valueCount),
    'collectionCount', String(header.collectionCount),
    'conflictCount', String(header.conflictCount),
    'profileRecordCount', String(header.profileRecordCount),
    'activityCount', String(header.activityCount),
    'historyCount', String(header.historyCount),
    'textCount', String(header.textCount),
    'totalBytes', String(header.totalBytes),
    'payloadBytes', String(header.payloadBytes),
    'createdAt', header.createdAt,
  ]);
}

const V2_BACKUP_AAD = lengthPrefixed(['formflow', 'record', '2', '3', 'formflow-backup', 'backup', 'archive', 'payload']);
const V1_BACKUP_AAD = Buffer.from('formflow:vault:v1', 'utf8');

async function deriveBackupKey(passphrase, salt, iterations) {
  const material = await subtle.importKey('raw', Buffer.from(passphrase, 'utf8'), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function writeLegacyArchives(v3Path, outputDir, passphrase) {
  const envelope = JSON.parse(await readFile(v3Path, 'utf8'));
  const header = envelope.header;
  const key = await deriveBackupKey(
    passphrase,
    Buffer.from(header.salt, 'base64'),
    header.iterations,
  );
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(header.nonce, 'base64'), additionalData: v3HeaderAad(header), tagLength: 128 },
    key,
    Buffer.from(envelope.payload, 'base64'),
  );
  const manifest = {
    schemaVersion: 3,
    documentCount: header.documentCount,
    valueCount: header.valueCount,
    collectionCount: header.collectionCount,
    conflictCount: header.conflictCount,
    totalBytes: header.totalBytes,
  };
  for (const [version, aad] of [[2, V2_BACKUP_AAD], [1, V1_BACKUP_AAD]]) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext);
    const legacy = {
      format: 'formflow-encrypted-backup',
      version,
      createdAt: header.createdAt,
      kdf: { name: 'PBKDF2-SHA256', iterations: header.iterations, salt: header.salt },
      cipher: { name: 'AES-GCM', iv: Buffer.from(iv).toString('base64') },
      manifest,
      payload: Buffer.from(ciphertext).toString('base64'),
    };
    await writeFile(path.join(outputDir, `legacy-v${version}.json`), JSON.stringify(legacy, null, 2));
  }
}

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
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj\n4 0 obj << /Length 45 >>\nstream\nBT /F1 18 Tf 72 720 Td (Phase 3 fixture) Tj ET\nendstream\nendobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
  );
}
const backupPath = path.join(tempDir, 'phase3-backup.json');
const sourcePass = 'phase3-source-passphrase-2026';
const backupPass = 'phase3-backup-passphrase-2026';
const targetPass = 'phase3-target-passphrase-2026';
const profileDirA = await mkdtemp(path.join(tmpdir(), 'ff-p3-a-'));
const profileDirB = await mkdtemp(path.join(tmpdir(), 'ff-p3-b-'));
const profileDirC = await mkdtemp(path.join(tmpdir(), 'ff-p3-c-'));
const profileDirD = await mkdtemp(path.join(tmpdir(), 'ff-p3-d-'));
const profileDirE = await mkdtemp(path.join(tmpdir(), 'ff-p3-e-'));

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
      vaults: await readAll('vaults'),
      documents: await readAll('documents'),
      files: await readAll('documentFiles'),
      values: await readAll('extractedValues'),
      profile: await readAll('vaultProfile'),
      collections: await readAll('collections'),
      activity: await readAll('activity'),
      settings: await readAll('settings'),
    };
  });
}

async function swapDocumentCiphertexts(page, documentId) {
  return page.evaluate(async (id) => {
    const request = indexedDB.open('formflow-local');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('documents', 'readwrite');
    const store = tx.objectStore('documents');
    const rows = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const row = rows.find((item) => item.id === id) ?? (rows.length === 1 ? rows[0] : undefined);
    if (!row) throw new Error(`Document ${id} was not found for the tamper test.`);
    const original = { nameEnc: row.nameEnc, originalFilenameEnc: row.originalFilenameEnc };
    store.put({ ...row, nameEnc: original.originalFilenameEnc, originalFilenameEnc: original.nameEnc });
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return original;
  }, documentId);
}

async function restoreDocumentCiphertexts(page, documentId, original) {
  await page.evaluate(async ({ id, values }) => {
    const request = indexedDB.open('formflow-local');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('documents', 'readwrite');
    const store = tx.objectStore('documents');
    const rows = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const row = rows.find((item) => item.id === id) ?? (rows.length === 1 ? rows[0] : undefined);
    if (!row) throw new Error(`Document ${id} was not found for restore.`);
    store.put({ ...row, nameEnc: values.nameEnc, originalFilenameEnc: values.originalFilenameEnc });
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }, { id: documentId, values: original });
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

  const manifest = await page.evaluate(() => chrome.runtime.getManifest());
  const contentBundle = await readFile(path.resolve('extension/dist/content.js'), 'utf8');
  check(
    'content scripts are restricted to Google Forms only',
    manifest.content_scripts?.every((entry) => entry.matches?.every((match) => match === 'https://docs.google.com/forms/*')),
  );
  check(
    'content script bundle contains no vault, key, storage or page bridge',
    !/formflow-local|session_key|VAULT_SESSION|postMessage|chrome\.storage/i.test(contentBundle),
  );
  const csp = await page.evaluate(() => chrome.runtime.getManifest().content_security_policy?.extension_pages ?? '');
  check('extension CSP has no unsafe-eval or remote script source', !/unsafe-eval|https?:/i.test(csp) && /script-src 'self'/.test(csp) && /object-src 'none'/.test(csp), csp);
  const inlineBlocked = await page.evaluate(() => new Promise((resolve) => {
    window.__formflowCspInline = 0;
    const script = document.createElement('script');
    script.textContent = 'window.__formflowCspInline = 1';
    document.documentElement.appendChild(script);
    setTimeout(() => resolve(window.__formflowCspInline === 0), 50);
  }));
  check('extension CSP blocks inline script execution', inlineBlocked);

  await page.evaluate(() => { window.__formflowXss = 0; });
  const xssCollection = await message(page, 'e2e_xss_collection', 'CREATE_COLLECTION', {
    name: '<img src=x onerror="window.__formflowXss=1">',
    description: '<script>window.__formflowXss=2</script>',
  });
  check('malicious collection payload stored as data', xssCollection?.ok === true);
  const xssField = await message(page, 'e2e_xss_field', 'ADD_FIELD', {
    field: {
      key: 'contact.xssTest',
      label: '<b>Injected label</b>',
      value: '<img src=x onerror="window.__formflowXss=1">',
      category: 'other',
      source: { documentId: 'manual', documentName: 'Manual entry' },
      confidence: 100,
      verificationStatus: 'user_verified',
      extractionMethod: 'manual',
      userModified: true,
    },
  });
  check('malicious profile payload stored as data', xssField?.ok === true, xssField?.error);
  await page.goto(`${dashboardA}#/collections`, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  check(
    'malicious collection markup is escaped',
    await page.evaluate(() => window.__formflowXss === 0 && document.querySelectorAll('img[src="x"]').length === 0),
  );
  await page.goto(`${dashboardA}#/records/personal`, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  check(
    'malicious profile markup is escaped',
    await page.evaluate(() => window.__formflowXss === 0 && document.querySelectorAll('img[src="x"]').length === 0),
  );
  if (xssField?.data?.field?.id) {
    await message(page, 'e2e_xss_cleanup_field', 'DELETE_FIELD', { id: xssField.data.field.id });
  }
  if (xssCollection?.data?.id) {
    await message(page, 'e2e_xss_cleanup_collection', 'DELETE_COLLECTION', { collectionId: xssCollection.data.id });
  }

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
  check('vault uses encryption format 2', raw.meta[0]?.encryptionFormat === 2 && raw.meta[0]?.nameFormat === 2);
  check(
    'vault display name is encrypted at rest',
    raw.vaults[0]?.name === '' &&
      raw.vaults[0]?.nameEnc?.includes('"v":2') &&
      !JSON.stringify(raw.vaults).includes('Phase 3 source vault'),
  );
  const sessionStorage = await page.evaluate(async () => chrome.storage.session.get(null));
  check(
    'dashboard cannot read the raw DEK from session storage',
    !('formflow.vault.session_key' in sessionStorage) && !JSON.stringify(sessionStorage).toLowerCase().includes('session_key'),
  );
  check('non-secret vault state marker exists', sessionStorage['formflow.vault.state']?.state === 'unlocked');
  const sessionAccess = await page.evaluate(async () => chrome.storage.session.getAccessLevel?.());
  check('session storage is restricted from untrusted contexts', sessionAccess !== 'TRUSTED_AND_UNTRUSTED_CONTEXTS');
  check('document name and filename encrypted with v2 AAD', raw.documents[0]?.nameEnc?.includes('"v":2') && raw.documents[0]?.originalFilenameEnc?.includes('"v":2') && !JSON.stringify(raw.documents).includes('phase3-real.pdf'));
  check('document bytes are ciphertext with an IV and v2 AAD marker', raw.files[0]?.ciphertext != null && raw.files[0].version === 2 && raw.files[0].aadVersion === 2 && typeof raw.files[0].iv === 'string' && raw.files[0].iv.length > 8);
  check('profile encrypted at rest with v2 AAD', raw.profile[0]?.profileEnc?.includes('"v":2'));
  check('vault value and label encrypted at rest', raw.values.some((value) => value.valueEnc?.includes('"v":2') && value.labelEnc?.includes('"v":2') && value.label === '') && !JSON.stringify(raw.values).includes('phase3-private@example.com') && !JSON.stringify(raw.values).includes('Email address'));
  check('collection metadata encrypted at rest', raw.collections[0]?.nameEnc?.includes('"v":2') && !JSON.stringify(raw.collections).includes('Phase 3 collection'));

  const encryptionStatus = await message(page, 'e2e_encryption_status', 'GET_ENCRYPTION_STATUS');
  check(
    'protocol GET_ENCRYPTION_STATUS reports v2',
    encryptionStatus?.ok === true && encryptionStatus.data?.encryptionFormat === 2 && encryptionStatus.data?.needsMigration === false,
  );
  const migrations = await message(page, 'e2e_migration', 'MIGRATE_ENCRYPTION');
  check(
    'encryption migration is idempotent on a v2 vault',
    migrations?.ok === true && migrations.data?.encryptionFormat === 2 && migrations.data?.needsMigration === false,
  );

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
  for (const [operation, requestId] of [
    ['GET_DEK', 'e2e_get_dek'],
    ['EXPORT_KEY', 'e2e_export_key'],
    ['DECRYPT', 'e2e_decrypt'],
    ['ENCRYPT', 'e2e_encrypt'],
    ['READ_INDEXEDDB', 'e2e_read_db'],
  ]) {
    const response = await message(page, requestId, operation, { aad: 'attacker', store: 'documents' });
    check(`generic operation ${operation} rejected`, response?.ok === false);
  }
  const badVersion = await page.evaluate(() => chrome.runtime.sendMessage({ protocol: 99, requestId: 'e2e_bad_version', operation: 'GET_PROFILE', payload: {} }));
  check('unsupported protocol rejected', badVersion?.ok === false);
  const missingId = await page.evaluate(() => chrome.runtime.sendMessage({ protocol: 1, operation: 'GET_PROFILE', payload: {} }));
  check('missing request ID rejected', missingId?.ok === false);

  // Swapping ciphertexts between two authenticated fields must fail closed.
  const swapped = await swapDocumentCiphertexts(page, documentId);
  const swappedList = await message(page, 'e2e_swapped_list', 'LIST_DOCUMENTS');
  check('cross-field ciphertext swapping breaks document listing', swappedList?.ok === false);
  const swappedIntegrity = await message(page, 'e2e_swapped_integrity', 'CHECK_VAULT_INTEGRITY');
  check(
    'integrity check reports swapped ciphertext',
    swappedIntegrity?.ok === true && swappedIntegrity.data?.ok === false && swappedIntegrity.data.issues.some((issue) => issue.code === 'INVALID_DOCUMENT_NAME'),
  );
  await restoreDocumentCiphertexts(page, documentId, swapped);
  const restoredList = await message(page, 'e2e_restored_list', 'LIST_DOCUMENTS');
  check('document listing recovers after ciphertext restore', restoredList?.ok === true && restoredList.data?.count === 1);
  const cleanIntegrity = await message(page, 'e2e_clean_integrity', 'CHECK_VAULT_INTEGRITY');
  check('integrity check passes on the restored vault', cleanIntegrity?.ok === true && cleanIntegrity.data?.ok === true, JSON.stringify(cleanIntegrity?.data?.issues));

  // Start a large mutation, then lock. The lock must drain the mutation and no
  // later mutation may start while the vault is locked.
  const racePayload = Buffer.alloc(8 * 1024 * 1024, 0x61).toString('base64');
  const raceImport = message(page, 'e2e_race_import', 'IMPORT_DOCUMENT', {
    name: 'lock-race.txt',
    mimeType: 'text/plain',
    dataBase64: racePayload,
  });
  await page.waitForTimeout(5);
  const raceLock = message(page, 'e2e_race_lock', 'VAULT_LOCK');
  const [raceImportResult, raceLockResult] = await Promise.all([raceImport, raceLock]);
  check('upload mutation completes before lock acknowledges', raceImportResult?.ok === true, raceImportResult?.error);
  check('lock succeeds after draining the upload', raceLockResult?.ok === true && raceLockResult.data?.unlocked === false, raceLockResult?.error);
  const lateImport = await message(page, 'e2e_late_import', 'IMPORT_DOCUMENT', {
    name: 'late.pdf',
    mimeType: 'application/pdf',
    dataBase64: Buffer.from('late mutation').toString('base64'),
  });
  check('new mutation rejected while locked', lateImport?.ok === false);
  const raceUnlock = await message(page, 'e2e_race_unlock', 'VAULT_UNLOCK', { passphrase: sourcePass });
  check('vault unlocks after the drained upload', raceUnlock?.ok === true && raceUnlock.data?.unlocked === true, raceUnlock?.error);
  const raceDocuments = await message(page, 'e2e_race_docs', 'LIST_DOCUMENTS');
  const raceDocument = raceDocuments?.data?.documents?.find((document) => document.name === 'lock-race.txt');
  check('race upload committed exactly once', Boolean(raceDocument) && raceDocuments.data?.count === 2);
  if (raceDocument) await message(page, 'e2e_race_delete', 'DELETE_DOCUMENT', { documentId: raceDocument.id });

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
    'service worker termination invalidates the in-memory DEK and locks the vault',
    stopped && afterWorkerRestart?.ok === true && afterWorkerRestart.data?.unlocked === false && workerStatuses.at(-1) === 'running',
    JSON.stringify(workerStatuses.slice(-3)),
  );
  const afterRestartSession = await page.evaluate(async () => chrome.storage.session.get(null));
  check('raw DEK remains absent after service-worker restart', !('formflow.vault.session_key' in afterRestartSession));
  await page.goto(`${dashboardA}#/unlock`, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.fill('input[type="password"]', sourcePass);
  await page.click('button:has-text("Unlock vault")');
  await page.waitForURL(/#\/dashboard$/, { timeout: 30000 });
  await page.waitForTimeout(700);
  const afterRestartUnlock = await message(page, 'e2e_sw_reunlock', 'VAULT_STATUS');
  check('vault can be unlocked after service-worker restart', afterRestartUnlock?.data?.unlocked === true);

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
  await writeLegacyArchives(backupPath, tempDir, backupPass);

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
  const popupSession = await popup.evaluate(async () => chrome.storage.session.get(null));
  check('popup cannot read the raw DEK', !('formflow.vault.session_key' in popupSession));
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

  // Passphrase rotation: old passphrase must stop working, new one must open
  // the same data key and leave documents readable.
  const rotatedPass = 'phase3-source-rotated-passphrase-2026';
  const rotate = await message(page, 'e2e_rotate', 'CHANGE_PASSPHRASE', {
    currentPassphrase: sourcePass,
    newPassphrase: rotatedPass,
  });
  check('protocol CHANGE_PASSPHRASE', rotate?.ok === true, rotate?.error);
  await message(page, 'e2e_rotate_lock', 'VAULT_LOCK');
  await page.waitForTimeout(900);
  await page.goto(`${dashboardA}#/unlock`, { waitUntil: 'load' });
  await page.fill('input[type="password"]', sourcePass);
  await page.click('button:has-text("Unlock vault")');
  await page.waitForTimeout(1100);
  check('old passphrase fails after rotation', (await page.locator('body').innerText()).toLowerCase().includes('incorrect'));
  await page.fill('input[type="password"]', rotatedPass);
  await page.click('button:has-text("Unlock vault")');
  await page.waitForURL(/#\/dashboard$/, { timeout: 30000 });
  await page.waitForTimeout(700);
  check('rotated passphrase unlocks the vault', (await message(page, 'e2e_rotated_status', 'VAULT_STATUS'))?.data?.unlocked === true);
  await page.goto(`${dashboardA}#/documents`, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  check('documents remain readable after passphrase rotation', (await page.locator('body').innerText()).includes('phase3-real.pdf'));
  const restorePass = await message(page, 'e2e_restore_pass', 'CHANGE_PASSPHRASE', {
    currentPassphrase: rotatedPass,
    newPassphrase: sourcePass,
  });
  check('passphrase restored for restart tests', restorePass?.ok === true, restorePass?.error);

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
  const malformed = await message(target, 'e2e_malformed_backup', 'IMPORT_VAULT', {
    passphrase: backupPass,
    dataBase64: Buffer.from('not a valid backup').toString('base64'),
  });
  check('malformed backup rejected', malformed?.ok === false);
  const emptyAfterFailure = await message(target, 'e2e_empty_after_failure', 'LIST_DOCUMENTS');
  check('failed import leaves the active vault unchanged', emptyAfterFailure?.ok === true && emptyAfterFailure.data?.count === 0);

  const parsedBackup = JSON.parse(exportedText);
  check(
    'exported backup uses authenticated v3 header',
    parsedBackup.version === 3 &&
      parsedBackup.header?.application === 'FormFlow' &&
      parsedBackup.header?.backupFormat === 3 &&
      parsedBackup.header?.manifestVersion === 1,
  );
  const tamperedHeader = {
    ...parsedBackup,
    header: { ...parsedBackup.header, documentCount: parsedBackup.header.documentCount + 1 },
  };
  const tamperedImport = await message(target, 'e2e_tampered_header', 'IMPORT_VAULT', {
    passphrase: backupPass,
    dataBase64: Buffer.from(JSON.stringify(tamperedHeader)).toString('base64'),
  });
  check('tampered v3 header is rejected by authentication', tamperedImport?.ok === false);
  const stillEmpty = await message(target, 'e2e_still_empty', 'LIST_DOCUMENTS');
  check('tampered backup leaves the target unchanged', stillEmpty?.ok === true && stillEmpty.data?.count === 0);
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
  check('imported records use v2 encryption', targetRaw.meta[0]?.encryptionFormat === 2 && targetRaw.documents[0]?.nameEnc?.includes('"v":2') && !JSON.stringify(targetRaw.documents).includes('phase3-real.pdf'));
  check('imported value labels are encrypted', targetRaw.values[0]?.labelEnc?.includes('"v":2') && targetRaw.values[0]?.label === '' && !JSON.stringify(targetRaw.values).includes('Email address'));
  check('imported file decrypted only on access', targetRaw.files[0]?.ciphertext != null && targetRaw.files[0].version === 2 && targetRaw.files[0].aadVersion === 2);
  const restoreJournal = targetRaw.settings.find((entry) => entry.key === 'vaultRestoreJournal')?.value;
  const restoreActivation = targetRaw.settings.find((entry) => entry.key === 'vaultRestoreActivation')?.value;
  check('restore journal is complete and has an activation marker', restoreJournal?.status === 'complete' && restoreActivation?.restoreId === restoreJournal?.restoreId);
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

  // ---------- D/E: genuine legacy v2 and v1 archives ----------
  for (const [version, profileDir] of [[2, profileDirD], [1, profileDirE]]) {
    const launched = await launch(profileDir);
    context = launched.context;
    const legacyDashboard = `chrome-extension://${launched.extensionId}/dashboard.html`;
    const legacyPage = await context.newPage();
    wire(legacyPage, `dashboard-v${version}`);
    await legacyPage.goto(`${legacyDashboard}#/setup`, { waitUntil: 'load' });
    const created = await message(legacyPage, `e2e_v${version}_create`, 'VAULT_CREATE', {
      name: `Legacy v${version} target`,
      passphrase: targetPass,
    });
    check(`legacy v${version} target vault created`, created?.ok === true, created?.error);
    const legacyBytes = await readFile(path.join(tempDir, `legacy-v${version}.json`));
    const imported = await message(legacyPage, `e2e_v${version}_import`, 'IMPORT_VAULT', {
      passphrase: backupPass,
      dataBase64: legacyBytes.toString('base64'),
    });
    check(
      `genuine legacy v${version} backup imports in Chromium`,
      imported?.ok === true && imported.data?.documents === 1,
      imported?.error,
    );
    const importedDocs = await message(legacyPage, `e2e_v${version}_docs`, 'LIST_DOCUMENTS');
    check(`legacy v${version} document is readable`, importedDocs?.ok === true && importedDocs.data?.count === 1);
    await context.close();
  }
  context = undefined;

  const unexpected = errors.filter((error) => !error.includes('favicon') && !/Content Security Policy|Refused to execute inline script/i.test(error));
  check('no dashboard/popup console or page errors', unexpected.length === 0, JSON.stringify(unexpected.slice(0, 4)));

  console.log(`FAILURES: ${failures}`);
  process.exitCode = failures ? 1 : 0;
} finally {
  if (context) await context.close();
  await rm(tempDir, { recursive: true, force: true });
  await rm(profileDirA, { recursive: true, force: true });
  await rm(profileDirB, { recursive: true, force: true });
  await rm(profileDirC, { recursive: true, force: true });
  await rm(profileDirD, { recursive: true, force: true });
  await rm(profileDirE, { recursive: true, force: true });
}
