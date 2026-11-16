import { chromium } from 'playwright';
import { strToU8, zipSync } from 'fflate';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('extension/dist');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-offscreen-security-'));
const executablePath = process.env.CHROME_PATH;
const passphrase = 'phase411-offscreen-passphrase';
const MAX_TEXT = 10_000_000;
let context;
let failures = 0;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 300)}` : ''}`);
  if (!condition) failures += 1;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function escapePdf(value) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildPdf({ pages }) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  for (const page of pages) {
    const content = `BT /F1 18 Tf 72 720 Td (${escapePdf(page)}) Tj ET`;
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

function largePdf(marker, pages = 800) {
  return buildPdf({ pages: Array.from({ length: pages }, (_, index) => `${marker} page ${index + 1}`) });
}

function buildDocx(marker) {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${marker} Heading</w:t></w:r></w:p>
<w:p><w:r><w:t>${marker} paragraph with line one</w:t><w:br/><w:t>line two</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Field</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`;
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'word/document.xml': strToU8(documentXml),
    'word/styles.xml': strToU8(stylesXml),
  });
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
  await page.fill('input[placeholder="e.g. Personal applications"]', 'Offscreen security vault');
  await page.locator('input[type=password]').nth(0).fill(passphrase);
  await page.locator('input[type=password]').nth(1).fill(passphrase);
  await page.click('button:has-text("Create encrypted vault")');
  await page.waitForURL(/#\/dashboard$/);
  await page.waitForTimeout(500);

  const diagnostics = () => worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.diagnostics?.() ?? null);
  const jobIds = () => worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.jobIds?.() ?? []);
  const injectMessage = (value) => worker.evaluate((message) => globalThis.__formflowTestHooks?.offscreen?.injectMessage?.(message) ?? false, value);
  const injectWorkerResponse = (requestId, value) => worker.evaluate(
    ({ requestId, message }) => globalThis.__formflowTestHooks?.offscreen?.injectWorkerResponse?.(requestId, message) ?? false,
    { requestId, message: value },
  );
  const closeOffscreen = () => worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.close?.());

  const importPdf = (name, marker, importId, extra = {}, pages = 2) => message(page, importId, 'IMPORT_DOCUMENT', {
    name,
    mimeType: 'application/pdf',
    dataBase64: (pages > 2 ? largePdf(marker, pages) : buildPdf({ pages: [`${marker} page 1`, `${marker} page 2`] })).toString('base64'),
    importId,
    ...extra,
  });
  const importTxt = (name, value, importId) => message(page, importId, 'IMPORT_DOCUMENT', {
    name,
    mimeType: 'text/plain',
    dataBase64: Buffer.from(value, 'utf8').toString('base64'),
    importId,
  });

  const firstPdf = await importPdf('offscreen-one.pdf', 'OFFSCREEN_PDF_MARKER', 'offscreen_pdf_one');
  check('PDF parses through the offscreen document', firstPdf?.ok === true && firstPdf.data.document.pageCount === 2, firstPdf?.error);
  const contexts = await page.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  check('offscreen parser document exists', contexts.some((context) => context.documentUrl?.endsWith('/offscreen-parser.html')), JSON.stringify(contexts));

  const docx = await message(page, 'offscreen_docx', 'IMPORT_DOCUMENT', {
    name: 'offscreen.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: Buffer.from(buildDocx('OFFSCREEN_DOCX_MARKER')).toString('base64'),
    importId: 'offscreen_docx',
  });
  check('DOCX parses through the offscreen document', docx?.ok === true && docx.data.document.pageCount === 1, docx?.error);
  const txt = await importTxt('offscreen.txt', 'OFFSCREEN_TXT_MARKER paragraph one\n\nparagraph two', 'offscreen_txt');
  check('TXT parses through the offscreen document', txt?.ok === true && txt.data.document.pageCount === 1, txt?.error);

  const diag = await diagnostics();
  check('offscreen parser handled all three formats', diag?.started >= 3 && diag?.completed >= 3 && diag?.lastFormat === 'txt', JSON.stringify(diag));
  check('offscreen parser has no vault IndexedDB access', diag?.indexedDbBlocked === true, JSON.stringify(diag));
  check('offscreen request fields contain no key material', JSON.stringify(diag?.lastRequestKeys ?? []).toLowerCase().indexOf('key') < 0 && !String(diag?.lastRequestKeys ?? '').includes('passphrase') && !String(diag?.lastRequestKeys ?? '').includes('aad'), JSON.stringify(diag?.lastRequestKeys));
  check('offscreen result fields contain no key material', !String(diag?.lastResultKeys ?? '').includes('dek') && !String(diag?.lastResultKeys ?? '').includes('key') && !String(diag?.lastResultKeys ?? '').includes('aad'), JSON.stringify(diag?.lastResultKeys));

  await injectMessage({ type: '__TEST_RUNTIME_RPC' });
  await wait(300);
  const rpcDiag = await diagnostics();
  check('offscreen document cannot invoke arbitrary background vault operations', rpcDiag?.runtimeRpcResult === 'UNAUTHORIZED', JSON.stringify(rpcDiag?.runtimeRpcResult));

  const malformedBefore = (await diagnostics())?.malformedRequests ?? 0;
  await injectMessage({
    type: 'PARSE_DOCUMENT',
    protocol: 1,
    requestId: 'parse_malformed_1234',
    parserVersion: 1,
    format: 'pdf',
    fileName: 'malformed.pdf',
    sizeBytes: 5,
    dataBase64: 'aGVsbG8=',
    dek: 'not allowed',
  });
  await wait(100);
  const malformedAfter = await diagnostics();
  check('malformed parser request is rejected', (malformedAfter?.malformedRequests ?? 0) > malformedBefore, JSON.stringify(malformedAfter));

  await injectMessage({ type: '__TEST_SET_PARSE_DELAY', delayMs: 500 });

  // Start a long parse, then inject a malformed worker result for its request.
  let pending = importPdf('malformed-response.pdf', 'OFFSCREEN_MALFORMED', 'offscreen_malformed', {}, 800);
  let ids = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    ids = await jobIds();
    if (ids.length) break;
    await wait(10);
  }
  check('concurrent parser worker is active before malformed-response injection', ids.length > 0, JSON.stringify(ids));
  if (ids[0]) {
    await injectWorkerResponse(ids[0], {
      type: 'PARSE_RESULT',
      protocol: 1,
      requestId: ids[0],
      result: { text: 'x', pageTexts: ['x'], pageCount: 1, method: 'pdf-text', version: 1, ocrRequired: false, pagesNeedingOcr: [], warnings: [], metadata: {}, unexpected: true },
    });
  }
  const malformedResponse = await pending;
  check('malformed parser response is rejected', malformedResponse?.ok === false && malformedResponse.code === 'PARSER_PROTOCOL_ERROR', JSON.stringify(malformedResponse));
  const malformedDiag = await diagnostics();
  check('offscreen records the malformed response', (malformedDiag?.malformedResponses ?? 0) >= 1, JSON.stringify(malformedDiag));

  pending = importPdf('oversized-response.pdf', 'OFFSCREEN_OVERSIZED', 'offscreen_oversized', {}, 800);
  ids = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    ids = await jobIds();
    if (ids.length) break;
    await wait(10);
  }
  if (ids[0]) {
    await injectWorkerResponse(ids[0], {
      type: 'PARSE_RESULT',
      protocol: 1,
      requestId: ids[0],
      result: { text: 'x'.repeat(MAX_TEXT + 1), pageTexts: ['x'], pageCount: 1, method: 'pdf-text', version: 1, ocrRequired: false, pagesNeedingOcr: [], warnings: [], metadata: {} },
    });
  }
  const oversized = await pending;
  check('oversized parser result is rejected', oversized?.ok === false && oversized.code === 'PARSER_PROTOCOL_ERROR', JSON.stringify(oversized));
  const oversizedDiag = await diagnostics();
  check('offscreen records the oversized response', (oversizedDiag?.malformedResponses ?? 0) >= 2, JSON.stringify(oversizedDiag));

  const timeout = await importPdf('timeout.pdf', 'OFFSCREEN_TIMEOUT', 'offscreen_timeout', { testParserTimeoutMs: 200 }, 800);
  check('parser timeout is rejected without a record', timeout?.ok === false && timeout.code === 'EXTRACTION_TIMEOUT', JSON.stringify(timeout));

  const beforeFailure = await readState(page);
  pending = importPdf('offscreen-failure.pdf', 'OFFSCREEN_FAILURE', 'offscreen_failure', {}, 800);
  ids = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    ids = await jobIds();
    if (ids.length) break;
    await wait(10);
  }
  await closeOffscreen();
  const failed = await pending;
  const afterFailure = await readState(page);
  check('offscreen document failure rejects the import', failed?.ok === false && failed.code === 'PARSER_UNAVAILABLE', JSON.stringify(failed));
  check('offscreen failure leaves no partial document/file/text records', afterFailure.documents.length === beforeFailure.documents.length && afterFailure.files.length === beforeFailure.files.length && afterFailure.text.length === beforeFailure.text.length);
  const recovery = await importTxt('recovery.txt', 'Recovery after offscreen failure marker', 'offscreen_recovery');
  check('offscreen document is recreated after failure', recovery?.ok === true, recovery?.error);

  const concurrent = await Promise.all([
    importPdf('concurrent-a.pdf', 'OFFSCREEN_CONCURRENT_A', 'offscreen_concurrent_a', {}, 120),
    importPdf('concurrent-b.pdf', 'OFFSCREEN_CONCURRENT_B', 'offscreen_concurrent_b', {}, 120),
  ]);
  check('concurrent imports through separate workers both succeed', concurrent.every((result) => result?.ok === true), JSON.stringify(concurrent.map((result) => result?.error ?? 'ok')));

  const cancelA = importPdf('cancel-a.pdf', 'OFFSCREEN_CANCEL_A', 'offscreen_cancel_a', {}, 800);
  const cancelB = importPdf('cancel-b.pdf', 'OFFSCREEN_CANCEL_B', 'offscreen_cancel_b', {}, 800);
  ids = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    ids = await jobIds();
    if (ids.length >= 2) break;
    await wait(10);
  }
  check('two parser workers are active before cancellation', ids.length >= 2, JSON.stringify(ids));
  await message(page, 'offscreen_cancel_request', 'CANCEL_DOCUMENT_IMPORT', { importId: 'offscreen_cancel_a' });
  const [canceledResult, survivorResult] = await Promise.all([cancelA, cancelB]);
  check('one cancellation does not terminate the other parse', survivorResult?.ok === true, survivorResult?.error);
  check('cancelled import reports cancellation', canceledResult?.ok === false && canceledResult.code === 'CANCELLED', JSON.stringify(canceledResult));

  const lockImport = importPdf('lock.pdf', 'OFFSCREEN_LOCK', 'offscreen_lock', {}, 800);
  ids = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    ids = await jobIds();
    if (ids.length) break;
    await wait(10);
  }
  const lockResult = await message(page, 'offscreen_lock_request', 'VAULT_LOCK');
  const lockedImportResult = await lockImport;
  check('vault lock drains the offscreen parse and import commits atomically', lockedImportResult?.ok === true, lockedImportResult?.error);
  check('vault lock succeeds after draining the offscreen parse', lockResult?.ok === true && lockResult.data?.unlocked === false, lockResult?.error);
  const unlock = await message(page, 'offscreen_unlock', 'VAULT_UNLOCK', { passphrase });
  check('vault unlocks after offscreen lock test', unlock?.ok === true && unlock.data?.unlocked === true, unlock?.error);

  const duplicateFirst = await importTxt('duplicate.txt', 'OFFSCREEN_DUPLICATE marker', 'offscreen_duplicate_first');
  const duplicateSecond = await importTxt('duplicate-copy.txt', 'OFFSCREEN_DUPLICATE marker', 'offscreen_duplicate_second');
  check('duplicate detection still works through the offscreen parser', duplicateFirst?.ok === true && duplicateSecond?.ok === true && duplicateSecond.data.duplicate === true, JSON.stringify(duplicateSecond?.data));

  const state = await readState(page);
  check('all successful ingestions have matching document/file/text rows', state.documents.length === state.files.length && state.documents.length === state.text.length, JSON.stringify({ documents: state.documents.length, files: state.files.length, text: state.text.length }));
  check('all text rows remain v2 authenticated envelopes', state.text.every((row) => row.textEnc.includes('"v":2') && row.pageTextsEnc.includes('"v":2') && row.extractionEnc?.includes('"v":2')));
  const raw = JSON.stringify(state);
  check('no extracted text is plaintext at rest', !raw.includes('OFFSCREEN_PDF_MARKER') && !raw.includes('OFFSCREEN_DOCX_MARKER') && !raw.includes('OFFSCREEN_TXT_MARKER'));

  const finalDiag = await diagnostics();
  check('offscreen diagnostics contain no key-like fields', !/dek|kek|passphrase|aad|vaultKey/i.test(JSON.stringify(finalDiag)), JSON.stringify(finalDiag));

  await wait(16_000);
  const idleContexts = await page.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  check('offscreen document shuts down when idle', idleContexts.length === 0, JSON.stringify(idleContexts));
  const idleRecovery = await importTxt('idle-recovery.txt', 'Recovery after idle offscreen shutdown', 'offscreen_idle_recovery');
  check('offscreen document is recreated after idle shutdown', idleRecovery?.ok === true, idleRecovery?.error);

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
