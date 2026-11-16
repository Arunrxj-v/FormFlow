import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('extension/dist');
const executablePath = process.env.CHROME_PATH;
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-migration-crash-'));
const passphrase = 'migration-crash-passphrase-2026';
let context;
let failures = 0;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 260)}` : ''}`);
  if (!condition) failures += 1;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch() {
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-proxy-server',
      '--no-first-run',
    ],
  });
  let worker = ctx.serviceWorkers()[0];
  if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  return { ctx, extensionId: new URL(worker.url()).host, worker };
}

const message = (page, requestId, operation, payload = {}, timeout = 300_000) =>
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

function killChromeForProfile(profileDir) {
  const lines = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
  const main = lines.find((line) => line.includes(`--user-data-dir=${profileDir}`) && !line.includes('--type='));
  if (!main) return null;
  const pid = Number(main.trim().split(/\s+/)[0]);
  if (!Number.isInteger(pid)) return null;
  process.kill(pid, 'SIGKILL');
  return pid;
}

async function readState(page) {
  return page.evaluate(async () => {
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
    return {
      meta: await readAll('vaultMeta'),
      vaults: await readAll('vaults'),
      profile: await readAll('vaultProfile'),
      documents: await readAll('documents'),
      files: await readAll('documentFiles'),
      values: await readAll('extractedValues'),
      collections: await readAll('collections'),
      profileRecords: await readAll('profileRecords'),
      history: await readAll('formHistory'),
      activity: await readAll('activity'),
      settings: await readAll('settings'),
    };
  });
}

try {
  let launched = await launch();
  context = launched.ctx;
  const dashboard = `chrome-extension://${launched.extensionId}/dashboard.html`;
  const page = await context.newPage();
  await page.goto(`${dashboard}#/setup`, { waitUntil: 'load' });
  await page.waitForSelector('input[placeholder="e.g. Personal applications"]');
  const created = await message(page, 'mc_create', 'VAULT_CREATE', { name: 'Migration crash vault', passphrase });
  check('vault created with test build', created?.ok === true, created?.error);
  await page.waitForTimeout(700);

  // Populate multiple record types and real document blobs.
  const documents = [];
  for (let index = 0; index < 25; index += 1) {
    const size = index === 0 ? 8 * 1024 * 1024 : 1024 + index;
    const bytes = Buffer.alloc(size);
    for (let offset = 0; offset < size; offset += 1) bytes[offset] = (offset + index) & 0xff;
    const imported = await message(page, `mc_import_${index}`, 'IMPORT_DOCUMENT', {
      name: `migration-doc-${index}.pdf`,
      mimeType: 'application/pdf',
      dataBase64: bytes.toString('base64'),
    });
    if (!imported?.ok) throw new Error(imported?.error ?? `import ${index} failed`);
    documents.push(imported.data.document);
  }
  check('25 documents imported for migration fixture', documents.length === 25);

  await message(page, 'mc_collection', 'CREATE_COLLECTION', {
    name: 'Migration collection',
    description: 'fixture collection',
    documentIds: documents.slice(0, 3).map((document) => document.id),
  });
  await message(page, 'mc_field_email', 'ADD_FIELD', {
    field: {
      key: 'contact.email',
      label: 'Email address',
      value: 'migration-crash@example.com',
      category: 'contact',
      source: { documentId: documents[0].id, documentName: documents[0].name },
      confidence: 100,
      verificationStatus: 'user_verified',
      extractionMethod: 'manual',
      userModified: true,
    },
  });
  await message(page, 'mc_field_phone', 'ADD_FIELD', {
    field: {
      key: 'contact.phone',
      label: 'Phone number',
      value: '+1 555 0142',
      category: 'contact',
      source: { documentId: documents[1].id, documentName: documents[1].name },
      confidence: 90,
      verificationStatus: 'user_verified',
      extractionMethod: 'manual',
      userModified: true,
    },
  });
  await message(page, 'mc_education', 'SAVE_PROFILE_RECORD', {
    type: 'education',
    record: {
      id: 'edu_migration_crash',
      level: 'Degree',
      degree: 'B.Tech',
      institution: 'Crash University',
      university: 'Crash University',
      period: '2018 - 2022',
      status: 'Completed',
      metrics: [],
      registrationNo: 'CRASH-1',
      gpa: '8.5',
      specialization: 'Computer Science',
      autofillTag: 'education.degree',
      createdAt: new Date().toISOString(),
      lastSynced: new Date().toISOString(),
      sourceNote: 'fixture',
    },
    documentId: documents[0].id,
  });
  await message(page, 'mc_history', 'RECORD_HISTORY', {
    website: 'migration.example.com',
    url: 'https://migration.example.com/form',
    detected: 4,
    filled: 3,
    skipped: 1,
    status: 'Partially completed',
  });

  const workerForSeed = context.serviceWorkers()[0];
  if (!workerForSeed) throw new Error('Test service worker unavailable for bulk fixture.');
  const seeded = await workerForSeed.evaluate(() => globalThis.__formflowTestHooks?.seedDocuments(250, 2048));
  check('bulk migration fixture seeded', seeded === 250, String(seeded));

  const sourceState = await readState(page);
  const sourceCounts = {
    documents: sourceState.documents.length,
    files: sourceState.files.length,
    values: sourceState.values.length,
    collections: sourceState.collections.length,
    profileRecords: sourceState.profileRecords.length,
    history: sourceState.history.length,
    activity: sourceState.activity.length,
  };
  check('source fixture has all record categories', sourceCounts.documents === 275 && sourceCounts.values === 2 && sourceCounts.collections === 1 && sourceCounts.profileRecords === 1 && sourceCounts.history === 1, JSON.stringify(sourceCounts));

  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('Test service worker is unavailable.');
  const downgraded = await worker.evaluate(() => globalThis.__formflowTestHooks?.downgradeVaultToV1());
  check('test fixture downgraded to encryption format v1', downgraded?.documents === 275, JSON.stringify(downgraded));
  const downgradedState = await readState(page);
  check('fixture metadata is v1 and vault name is plaintext', downgradedState.meta[0]?.encryptionFormat === 1 && downgradedState.meta[0]?.nameFormat === 1 && downgradedState.vaults[0]?.name === 'Migration crash vault');
  check('fixture records are legacy envelopes', downgradedState.values[0]?.valueEnc?.includes('"v":1') && downgradedState.values[0]?.labelEnc === undefined);

  // Start migration in the service worker and wait for the first committed batch.
  const migrationPromise = worker.evaluate(() => globalThis.__formflowTestHooks?.runMigration()).catch(() => null);
  let progress = null;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    progress = await page.evaluate(async () => (await chrome.storage.session.get('formflow-test-migration-progress'))['formflow-test-migration-progress'] ?? null);
    if (progress?.point === 'after_journal' && progress?.store) break;
    if (progress?.point === 'after_marker') break;
    await wait(10);
  }
  check('a migration batch reached the journal before interruption', Boolean(progress?.store), JSON.stringify(progress));
  const killed = killChromeForProfile(userDataDir);
  check('Chromium was SIGKILLed during migration', Boolean(killed), killed ?? 'no process');
  await migrationPromise;
  try {
    await context.close();
  } catch {
    // Process already terminated.
  }
  context = undefined;
  await wait(800);

  // Relaunch the same profile and resume.
  launched = await launch();
  context = launched.ctx;
  const resumedDashboard = `chrome-extension://${launched.extensionId}/dashboard.html`;
  const resumed = await context.newPage();
  await resumed.goto(`${resumedDashboard}#/unlock`, { waitUntil: 'load' });
  const unlocked = await message(resumed, 'mc_unlock', 'VAULT_UNLOCK', { passphrase });
  check('vault requires and accepts unlock after crash', unlocked?.ok === true && unlocked.data?.unlocked === true, unlocked?.error);
  await resumed.waitForTimeout(700);

  let status = await message(resumed, 'mc_status', 'GET_ENCRYPTION_STATUS');
  if (status?.data?.needsMigration) {
    const migrated = await message(resumed, 'mc_migrate', 'MIGRATE_ENCRYPTION');
    check('migration resumed after crash', migrated?.ok === true && migrated.data?.needsMigration === false, migrated?.error);
    status = migrated;
  }
  check('encryption format marker is complete', status?.data?.encryptionFormat === 2 && status?.data?.needsMigration === false, JSON.stringify(status?.data));

  const integrity = await message(resumed, 'mc_integrity', 'CHECK_VAULT_INTEGRITY');
  check('full vault integrity passes after recovery', integrity?.ok === true && integrity.data?.ok === true, JSON.stringify(integrity?.data?.issues));

  const recoveredState = await readState(resumed);
  const migratedJournal = recoveredState.settings.find((entry) => entry.key === 'encryptionMigrationV2')?.value;
  check('migration journal is complete', migratedJournal?.status === 'complete', JSON.stringify(migratedJournal));
  check('all source records survived', JSON.stringify({
    documents: recoveredState.documents.length,
    files: recoveredState.files.length,
    values: recoveredState.values.length,
    collections: recoveredState.collections.length,
    profileRecords: recoveredState.profileRecords.length,
    history: recoveredState.history.length,
    activity: recoveredState.activity.length,
  }) === JSON.stringify(sourceCounts), JSON.stringify({ sourceCounts, recovered: recoveredState }));
  check('no duplicate document IDs', new Set(recoveredState.documents.map((document) => document.id)).size === recoveredState.documents.length);
  check('all document files survived', recoveredState.files.length === recoveredState.documents.length);
  check('v2 encryption metadata is complete', recoveredState.meta[0]?.encryptionFormat === 2 && recoveredState.meta[0]?.nameFormat === 2 && recoveredState.vaults[0]?.name === '' && recoveredState.vaults[0]?.nameEnc?.includes('"v":2'));
  check('all document names and files use v2 AAD', recoveredState.documents.every((document) => document.nameEnc?.includes('"v":2')) && recoveredState.files.every((file) => file.aadVersion === 2 && file.version === 2));
  check('labels and values use v2 AAD', recoveredState.values.every((value) => value.label === '' && value.labelEnc?.includes('"v":2') && value.valueEnc?.includes('"v":2')));
  check(
    'no plaintext fixture values remain at rest',
    !JSON.stringify(recoveredState).includes('migration-crash@example.com') &&
      !JSON.stringify(recoveredState).includes('migration-doc-0.pdf') &&
      !JSON.stringify(recoveredState).includes('Crash University') &&
      !JSON.stringify(recoveredState).includes('Migration crash vault'),
  );

  const documentsAfter = await message(resumed, 'mc_list', 'LIST_DOCUMENTS');
  check('vault operation client still lists all documents', documentsAfter?.ok === true && documentsAfter.data?.count === 275);
  const blob = await message(resumed, 'mc_blob', 'GET_DOCUMENT_BLOB', { documentId: documentsAfter.data.documents[0].id });
  check('encrypted document blob decrypts after recovery', blob?.ok === true && blob.data?.sizeBytes > 0);

  console.log('INTERRUPTION_POINT:', JSON.stringify(progress));
  console.log(`FAILURES: ${failures}`);
  process.exitCode = failures ? 1 : 0;
} finally {
  if (context) {
    try {
      await context.close();
    } catch {
      // Browser may already be gone.
    }
  }
  await rm(userDataDir, { recursive: true, force: true });
}
