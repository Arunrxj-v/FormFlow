import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('extension/dist');
const executablePath = process.env.CHROME_PATH;
const sourceDir = await mkdtemp(path.join(tmpdir(), 'ff-crash-source-'));
const targetDir = await mkdtemp(path.join(tmpdir(), 'ff-crash-target-'));
const tempDir = await mkdtemp(path.join(tmpdir(), 'ff-crash-data-'));
const backupPath = path.join(tempDir, 'crash-backup.json');
const sourcePass = 'crash-source-passphrase-2026';
const targetPass = 'crash-target-passphrase-2026';
const backupPass = 'crash-backup-passphrase-2026';
let failures = 0;
let context;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 220)}` : ''}`);
  if (!condition) failures += 1;
};

async function launch(userDataDir) {
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
  return { ctx, extensionId: new URL(worker.url()).host };
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

function killChromeForProfile(userDataDir) {
  const lines = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
  const main = lines.find((line) => line.includes(`--user-data-dir=${userDataDir}`) && !line.includes('--type='));
  if (!main) return null;
  const pid = Number(main.trim().split(/\s+/)[0]);
  if (!Number.isInteger(pid)) return null;
  process.kill(pid, 'SIGKILL');
  return pid;
}

async function createVault(page, dashboard, name, passphrase) {
  await page.goto(`${dashboard}#/setup`, { waitUntil: 'load' });
  const created = await message(page, `create_${Date.now()}`, 'VAULT_CREATE', { name, passphrase });
  if (!created?.ok) throw new Error(created?.error ?? 'Vault creation failed');
  await page.waitForTimeout(500);
}

try {
  // Source vault with an 8 MB document so the restore has a meaningful window.
  const source = await launch(sourceDir);
  context = source.ctx;
  const sourceDashboard = `chrome-extension://${source.extensionId}/dashboard.html`;
  const sourcePage = await context.newPage();
  await createVault(sourcePage, sourceDashboard, 'Crash source vault', sourcePass);
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0x61);
  const imported = await message(sourcePage, 'crash_source_import', 'IMPORT_DOCUMENT', {
    name: 'crash-large.txt',
    mimeType: 'text/plain',
    dataBase64: bytes.toString('base64'),
  });
  check('source large document imported', imported?.ok === true, imported?.error);
  const exported = await message(sourcePage, 'crash_source_export', 'EXPORT_VAULT', { passphrase: backupPass });
  check('source backup exported', exported?.ok === true && exported.data?.sizeBytes > 8 * 1024 * 1024);
  await writeFile(backupPath, Buffer.from(exported.data.dataBase64, 'base64'));
  await context.close();
  context = undefined;

  // Target starts a restore, then the Chromium process is killed mid-operation.
  const target = await launch(targetDir);
  context = target.ctx;
  const targetDashboard = `chrome-extension://${target.extensionId}/dashboard.html`;
  const targetPage = await context.newPage();
  await createVault(targetPage, targetDashboard, 'Crash target vault', targetPass);
  const payload = (await readFile(backupPath)).toString('base64');
  const pending = targetPage.evaluate(
    ({ request }) =>
      new Promise((resolve) => {
        chrome.runtime.sendMessage(request, (response) => resolve(response));
      }),
    {
      request: {
        protocol: 1,
        requestId: 'crash_restore',
        operation: 'IMPORT_VAULT',
        payload: { passphrase: backupPass, dataBase64: payload },
      },
    },
  ).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const killed = killChromeForProfile(targetDir);
  check('Chromium process was killed during restore', Boolean(killed), killed ?? 'no process');
  await pending;
  try {
    await context.close();
  } catch {
    // The process is already gone.
  }
  context = undefined;
  await new Promise((resolve) => setTimeout(resolve, 800));

  const recovered = await launch(targetDir);
  context = recovered.ctx;
  const recoveredDashboard = `chrome-extension://${recovered.extensionId}/dashboard.html`;
  const recoveredPage = await context.newPage();
  await recoveredPage.goto(`${recoveredDashboard}#/unlock`, { waitUntil: 'load' });
  const unlocked = await message(recoveredPage, 'crash_unlock', 'VAULT_UNLOCK', { passphrase: targetPass });
  check('target vault unlocks after the process crash', unlocked?.ok === true && unlocked.data?.unlocked === true, unlocked?.error);
  await recoveredPage.waitForTimeout(1200);

  const state = await recoveredPage.evaluate(async () => {
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
      documents: await readAll('documents'),
      files: await readAll('documentFiles'),
      settings: await readAll('settings'),
    };
  });
  const journal = state.settings.find((entry) => entry.key === 'vaultRestoreJournal')?.value;
  const activation = state.settings.find((entry) => entry.key === 'vaultRestoreActivation')?.value;
  const documentCount = state.documents.length;
  const fileCount = state.files.length;
  check(
    'crash leaves either an empty target or a complete restore, never a partial one',
    documentCount === fileCount,
    JSON.stringify({ documentCount, fileCount, journal: journal?.status }),
  );
  check(
    'restore journal reflects actual activation state',
    documentCount === 0
      ? journal?.status !== 'complete'
      : journal?.status === 'complete' && activation?.restoreId === journal?.restoreId,
    journal?.status,
  );

  if (documentCount === 0) {
    const retried = await message(recoveredPage, 'crash_retry', 'IMPORT_VAULT', {
      passphrase: backupPass,
      dataBase64: payload,
    });
    check('restore can be retried after the crash', retried?.ok === true && retried.data?.documents === 1, retried?.error);
    const finalState = await recoveredPage.evaluate(async () => {
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
        documents: await readAll('documents'),
        files: await readAll('documentFiles'),
        settings: await readAll('settings'),
      };
    });
    const finalJournal = finalState.settings.find((entry) => entry.key === 'vaultRestoreJournal')?.value;
    check('retried restore has a complete journal and one intact file', finalJournal?.status === 'complete' && finalState.documents.length === 1 && finalState.files.length === 1);
  }

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
  await rm(sourceDir, { recursive: true, force: true });
  await rm(targetDir, { recursive: true, force: true });
  await rm(tempDir, { recursive: true, force: true });
}
