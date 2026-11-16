import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const formflow = path.resolve('extension/dist');
const helper = path.resolve('scripts/dev/fixtures/reload-helper');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-phase4-interrupt-'));
const executablePath = process.env.CHROME_PATH;
const passphrase = 'phase4-interruption-passphrase-2026';
let context;
let failures = 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


function escapePdf(value) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildLargePdf(pages = 1_000) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  for (let index = 0; index < pages; index += 1) {
    const content = `BT /F1 18 Tf 72 720 Td (Interrupted offscreen page ${index + 1}) Tj ET`;
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'binary')} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
}

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 260)}` : ''}`);
  if (!condition) failures += 1;
};

function message(page, requestId, operation, payload = {}, timeout = 300_000) {
  return page.evaluate(
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
      documents: await readAll('documents'),
      files: await readAll('documentFiles'),
      text: await readAll('documentText'),
    };
  });
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
    if (worker.url().endsWith('/background.js')) {
      if (!formflowId) formflowId = id;
      else helperId = id;
    }
  }
  check('FormFlow and helper loaded', Boolean(formflowId && helperId), JSON.stringify({ formflowId, helperId }));

  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${formflowId}/dashboard.html#/setup`, { waitUntil: 'load' });
  await dashboard.waitForSelector('input[placeholder="e.g. Personal applications"]');
  await dashboard.fill('input[placeholder="e.g. Personal applications"]', 'Interrupted ingestion vault');
  await dashboard.locator('input[type=password]').nth(0).fill(passphrase);
  await dashboard.locator('input[type=password]').nth(1).fill(passphrase);
  await dashboard.click('button:has-text("Create encrypted vault")');
  await dashboard.waitForURL(/#\/dashboard$/);
  await dashboard.waitForTimeout(600);
  check('vault created', true);

  const helperPage = await context.newPage();
  await helperPage.goto(`chrome-extension://${helperId}/control.html`, { waitUntil: 'load' });
  const all = await helperPage.evaluate(() => chrome.management.getAll());
  const target = all.find((entry) => entry.name.includes('FormFlow —'))?.id;
  check('helper identifies FormFlow', target === formflowId, target);

  // 20 MB of valid UTF-8 text; the base64 message is larger than the storage
  // limit for a document record, so validation rejects it before persistence.
  // Use 18 MB of content to stay under the 20 MB document limit while keeping
  // decoding/parsing long enough to interrupt the service worker.
  const pending = message(dashboard, 'phase4_interrupt_import', 'IMPORT_DOCUMENT', {
    name: 'interrupted-large.pdf',
    mimeType: 'application/pdf',
    dataBase64: buildLargePdf().toString('base64'),
    importId: 'phase4_interrupt_import',
  }).catch(() => null);
  let offscreenSeen = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const contexts = await dashboard.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).catch(() => []);
    if (contexts.some((context) => context.documentUrl?.endsWith('/offscreen-parser.html'))) {
      offscreenSeen = true;
      break;
    }
    await wait(10);
  }
  check('ingestion reached the offscreen parser before extension termination', offscreenSeen);
  await helperPage.evaluate((id) => chrome.management.setEnabled(id, false), target);
  await wait(1200);
  const workerGone = !context.serviceWorkers().some((worker) => worker.url().startsWith(`chrome-extension://${formflowId}/`));
  const result = await Promise.race([pending, wait(5000).then(() => null)]);
  check('FormFlow service worker was terminated during ingestion', workerGone, JSON.stringify(context.serviceWorkers().map((worker) => worker.url())));
  check('interrupted import did not return a false success', result == null || result.ok !== true, JSON.stringify(result));

  await helperPage.evaluate((id) => chrome.management.setEnabled(id, true), target);
  await wait(2200);
  const resumed = await context.newPage();
  await resumed.goto(`chrome-extension://${formflowId}/dashboard.html#/unlock`, { waitUntil: 'load' });
  const unlocked = await message(resumed, 'phase4_interrupt_unlock', 'VAULT_UNLOCK', { passphrase });
  check('vault unlocks after interrupted ingestion', unlocked?.ok === true && unlocked.data.unlocked === true, unlocked?.error);
  await resumed.waitForTimeout(500);

  const state = await readState(resumed);
  check(
    'interrupted ingestion left no partial document/file/text triple',
    state.documents.length === state.files.length && state.documents.length === state.text.length,
    JSON.stringify({ documents: state.documents.length, files: state.files.length, text: state.text.length }),
  );
  const docsWithText = state.documents.every((document) => (
    document.extractedTextStatus !== 'extracted' || state.text.some((text) => text.documentId === document.id)
  ));
  check('every committed document has its encrypted text row', docsWithText);

  const recovery = await message(resumed, 'phase4_recovery_import', 'IMPORT_DOCUMENT', {
    name: 'recovery.txt',
    mimeType: 'text/plain',
    dataBase64: Buffer.from('Recovery import after worker termination', 'utf8').toString('base64'),
    importId: 'phase4_recovery_import',
  });
  check('normal ingestion succeeds after recovery', recovery?.ok === true && recovery.data.document.extractedTextStatus === 'extracted', recovery?.error);
  const afterRecovery = await readState(resumed);
  check(
    'recovery import is atomically complete',
    afterRecovery.documents.length === afterRecovery.files.length && afterRecovery.documents.length === afterRecovery.text.length,
    JSON.stringify({ documents: afterRecovery.documents.length, files: afterRecovery.files.length, text: afterRecovery.text.length }),
  );

  console.log('BROWSER_VERSION:', await context.browser()?.version());
  console.log(`FAILURES: ${failures}`);
  process.exitCode = failures ? 1 : 0;
} finally {
  if (context) {
    try {
      await context.close();
    } catch {
      // Already closed by management disable.
    }
  }
  await rm(userDataDir, { recursive: true, force: true });
}
