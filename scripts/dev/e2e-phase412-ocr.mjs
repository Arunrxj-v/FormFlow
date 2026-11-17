import { chromium } from 'playwright';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const baseExtensionPath = path.resolve('extension/dist');
const executablePath = process.env.CHROME_PATH;
const passphrase = 'phase412-ocr-suite-passphrase';
const backupPassphrase = 'phase412-ocr-backup-passphrase';
let failures = 0;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 400)}` : ''}`);
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

function buildPdf(pages) {
  const objects = [];
  const add = (body) => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'binary'));
    return objects.length;
  };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldFontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageIds = [];
  for (const page of pages) {
    let content;
    const resources = [];
    if (page.textItems?.length) {
      content = page.textItems.map((item) => {
        const font = item.bold ? 'F2' : 'F1';
        const size = item.fontSize ?? 12;
        return `BT /${font} ${size} Tf ${item.x} ${item.y} Td (${escapePdf(item.text)}) Tj ET`;
      }).join('\n');
      resources.push(`/Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R >>`);
    } else if (page.text !== undefined) {
      content = `BT /F1 18 Tf 72 720 Td (${escapePdf(page.text)}) Tj ET`;
      resources.push(`/Font << /F1 ${fontId} 0 R >>`);
    } else {
      const width = page.width;
      const height = page.height;
      const fit = Math.min(612 / width, 792 / height);
      const drawWidth = width * fit;
      const drawHeight = height * fit;
      const x = (612 - drawWidth) / 2;
      const y = (792 - drawHeight) / 2;
      const imageId = add(Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
          'binary',
        ),
        page.jpeg,
        Buffer.from('\nendstream', 'binary'),
      ]));
      content = `q ${drawWidth.toFixed(3)} 0 0 ${drawHeight.toFixed(3)} ${x.toFixed(3)} ${y.toFixed(3)} cm /Im0 Do Q`;
      resources.push(`/XObject << /Im0 ${imageId} 0 R >>`);
    }
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'binary')} >>\nstream\n${content}\nendstream`);
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << ${resources.join(' ')} >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }
  objects[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  const chunks = [Buffer.from('%PDF-1.4\n', 'binary')];
  let offset = chunks[0].length;
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'binary'), objects[index], Buffer.from('\nendobj\n', 'binary')]);
    chunks.push(chunk);
    offset += chunk.length;
  }
  const xref = offset;
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) trailer += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer, 'binary'));
  return Buffer.concat(chunks);
}

async function makeImage(page, draw) {
  const base64 = await page.evaluate((source) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 900;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    new Function('ctx', 'canvas', source)(ctx, canvas);
    return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, draw);
  return Buffer.from(base64, 'base64');
}

async function launchContext(extensionPath, userDataDir) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-proxy-server',
      '--no-first-run',
      '--enable-precise-memory-info',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  context.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('chrome-extension://') && !url.startsWith('data:') && !url.startsWith('blob:')) {
      globalThis.__externalRequests = [...(globalThis.__externalRequests ?? []), url];
    }
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/dashboard.html#/setup`, { waitUntil: 'load' });
  await page.waitForSelector('input[placeholder="e.g. Personal applications"]');
  await page.fill('input[placeholder="e.g. Personal applications"]', 'OCR suite vault');
  await page.locator('input[type=password]').nth(0).fill(passphrase);
  await page.locator('input[type=password]').nth(1).fill(passphrase);
  await page.click('button:has-text("Create encrypted vault")');
  await page.waitForURL(/#\/dashboard$/);
  await page.waitForTimeout(400);
  return { context, worker, page, id };
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
    const documents = await readAll('documents');
    const files = await readAll('documentFiles');
    const text = await readAll('documentText');
    return {
      documents: documents.map((row) => ({
        id: row.id,
        status: row.status,
        ocrUsed: row.ocrUsed,
        ocrRequired: row.ocrRequired,
        ocrStatus: row.ocrStatus,
        ocrLanguage: row.ocrLanguage,
        ocrConfidence: row.ocrConfidence,
        ocrPagesTotal: row.ocrPagesTotal,
        ocrPagesCompleted: row.ocrPagesCompleted,
        extractedTextStatus: row.extractedTextStatus,
        pageCount: row.pageCount,
      })),
      fileCount: files.length,
      text: text.map((row) => ({
        documentId: row.documentId,
        method: row.method,
        pageCount: row.pageCount,
        textEnc: row.textEnc,
        pageTextsEnc: row.pageTextsEnc,
        extractionEnc: row.extractionEnc,
      })),
    };
  });
}

async function watchProgress(page, importId) {
  await page.evaluate((id) => new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'formflow-document-progress' });
    window.__ffProgress = { events: [], port, id };
    port.onMessage.addListener((event) => {
      if (event?.type === 'ready' && event.importId === id) {
        resolve();
        return;
      }
      if (event?.type === 'FORMFLOW_DOCUMENT_PROGRESS' && event.importId === id) {
        window.__ffProgress.events.push(event);
      }
    });
    port.postMessage({ type: 'watch', importId: id });
  }), importId);
}

async function progressEvents(page) {
  return page.evaluate(() => window.__ffProgress?.events ?? []);
}

async function waitForOffscreenOcr(worker, minimum = 1, timeout = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await worker.evaluate(() => {
      const diag = globalThis.__formflowTestHooks?.offscreen?.diagnostics?.() ?? null;
      return diag?.ocrStarted ?? 0;
    });
    if (value >= minimum) return true;
    await wait(50);
  }
  return false;
}

const temporaryPaths = [];
let primary;
try {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-ocr-suite-'));
  temporaryPaths.push(userDataDir);
  primary = await launchContext(baseExtensionPath, userDataDir);
  const { context, worker, page } = primary;

  const importPdf = (name, pdf, importId, extra = {}) => message(page, importId, 'IMPORT_DOCUMENT', {
    name,
    mimeType: 'application/pdf',
    dataBase64: pdf.toString('base64'),
    importId,
    ...extra,
  });
  const getText = (documentId) => message(page, `text_${documentId}`, 'GET_DOCUMENT_TEXT', { documentId });
  const documentCount = async () => (await message(page, `list_${Date.now()}`, 'LIST_DOCUMENTS')).data?.count ?? -1;

  const preferences = await message(page, 'ocr_preferences', 'GET_PREFERENCES');
  const rejectedLanguage = await message(page, 'ocr_preferences_bad', 'UPDATE_PREFERENCES', { ocrLanguage: 'eng+hin' });
  check('only bundled OCR languages are accepted by preferences', preferences?.ok === true
    && preferences.data.ocrLanguage === 'eng'
    && rejectedLanguage?.ok === false
    && rejectedLanguage.code === 'VALIDATION_FAILED', JSON.stringify({ current: preferences?.data?.ocrLanguage, rejected: rejectedLanguage?.code }));

  const formImage = await makeImage(page, `
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 64px Arial';
    ctx.fillText('FORMFLOW OCR TEST', 120, 230);
    ctx.font = '44px Arial';
    ctx.fillText('42 Example Street, Bengaluru', 120, 360);
    ctx.fillText('Account number: 9988776655', 120, 460);
    ctx.fillText('Scanned page generated locally', 120, 560);
  `);
  const imageOnlyPdf = buildPdf([{ jpeg: formImage, width: 1600, height: 900 }]);

  // 1. Genuine image-only OCR with real progress and confidence.
  await watchProgress(page, 'ocr_image_only');
  const imageStarted = Date.now();
  const imageOnly = await importPdf('ocr-image-only.pdf', imageOnlyPdf, 'ocr_image_only');
  const imageDurationMs = Date.now() - imageStarted;
  const imageOnlyText = imageOnly?.ok ? await getText(imageOnly.data.document.id) : null;
  const events = await progressEvents(page);
  check('image-only PDF import succeeds', imageOnly?.ok === true, imageOnly?.error);
  check(
    'image-only PDF text is genuinely recognized',
    imageOnlyText?.data?.text?.includes('FORMFLOW OCR TEST')
      && imageOnlyText.data.text.includes('42 Example Street')
      && imageOnlyText.data.text.includes('9988776655'),
    imageOnlyText?.data?.text,
  );
  check('OCR method and status are recorded', imageOnlyText?.data?.method === 'ocr' && imageOnlyText?.data?.ocr?.status === 'completed', JSON.stringify({ method: imageOnlyText?.data?.method, ocr: imageOnlyText?.data?.ocr?.status }));
  check(
    'OCR confidence and page counts are real',
    typeof imageOnlyText?.data?.ocr?.averageConfidence === 'number'
      && imageOnlyText.data.ocr.averageConfidence > 50
      && imageOnlyText.data.ocr.pagesCompleted === 1
      && imageOnlyText.data.ocr.pagesAttempted === 1,
    JSON.stringify({ confidence: imageOnlyText?.data?.ocr?.averageConfidence, attempted: imageOnlyText?.data?.ocr?.pagesAttempted, completed: imageOnlyText?.data?.ocr?.pagesCompleted }),
  );
  check(
    'OCR lines and word boxes are preserved',
    Array.isArray(imageOnlyText?.data?.ocr?.pages?.[0]?.lines)
      && imageOnlyText.data.ocr.pages[0].lines.length >= 3
      && imageOnlyText.data.ocr.pages[0].lines.some((line) => line.words?.length > 0 && line.bbox),
    JSON.stringify(imageOnlyText?.data?.ocr?.pages?.[0]?.lines?.length),
  );
  check(
    'OCR progress reports real page work',
    events.some((event) => event.stage === 'running_ocr' && event.page === 1 && event.totalPages === 1)
      && events.some((event) => event.stage === 'running_ocr' && event.progress > 60),
    JSON.stringify(events.filter((event) => event.stage === 'running_ocr')),
  );
  check('stale OCR-required warnings are removed after completion', !(imageOnlyText?.data?.warnings ?? []).some((warning) => warning.code === 'OCR_REQUIRED' || warning.code === 'PAGE_REQUIRES_OCR'), JSON.stringify(imageOnlyText?.data?.warnings));
  check('document record exposes OCR status and confidence', imageOnly?.data?.document?.ocrStatus === 'completed' && typeof imageOnly?.data?.document?.ocrConfidence === 'number', JSON.stringify({ status: imageOnly?.data?.document?.ocrStatus, confidence: imageOnly?.data?.document?.ocrConfidence }));
  const imageStructure = imageOnlyText?.data?.structure;
  const imageStructureBlock = imageStructure?.blocks?.find((block) => block.text?.includes('FORMFLOW OCR TEST'));
  check('OCR contributes a validated physical-page structure', imageStructure?.documentFormat === 'pdf'
    && imageStructure?.pageSemantics === 'physical'
    && imageStructure.pages?.[0]?.extractionMethod === 'ocr'
    && imageStructure.metadata?.ocrPageCount === 1, JSON.stringify({ format: imageStructure?.documentFormat, page: imageStructure?.pages?.[0]?.extractionMethod, metadata: imageStructure?.metadata }));
  check('OCR structure preserves explicit image coordinates and conversion metadata', imageStructureBlock?.boundingBox?.coordinateSpace === 'ocr_render_pixels'
    && imageStructure?.pages?.[0]?.conversion?.to === 'pdf_page_points'
    && Boolean(imageStructure?.pages?.[0]?.conversion?.scaleX), JSON.stringify({ box: imageStructureBlock?.boundingBox, conversion: imageStructure?.pages?.[0]?.conversion }));
  check('OCR structure retains source provenance and confidence', imageStructureBlock?.provenance === 'ocr' && typeof imageStructureBlock?.confidence === 'number', JSON.stringify({ provenance: imageStructureBlock?.provenance, confidence: imageStructureBlock?.confidence }));
  check('completed OCR structure removes stale OCR-required warnings', !(imageStructure?.warnings ?? []).some((warning) => warning.code === 'OCR_REQUIRED' || warning.code === 'PAGE_REQUIRES_OCR'), JSON.stringify(imageStructure?.warnings));
  const ocrDiag = await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.diagnostics?.() ?? null);
  const pendingOcrJobs = await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.jobIds?.() ?? []);
  check('OCR releases its worker, renderer, and job after completion', pendingOcrJobs.length === 0 && ocrDiag?.active === 0 && ocrDiag?.lastOcrStage === 'page_complete:1', JSON.stringify({ jobs: pendingOcrJobs, active: ocrDiag?.active, stage: ocrDiag?.lastOcrStage }));
  console.log('OCR_PERF', JSON.stringify({ imageDurationMs, peakOcrHeapBytes: ocrDiag?.peakOcrMemoryBytes ?? null, lastOcrHeapBytes: ocrDiag?.memoryUsedBytes ?? null }));
  check('OCR heap usage stays bounded', typeof ocrDiag?.peakOcrMemoryBytes === 'number' && ocrDiag.peakOcrMemoryBytes < 512 * 1024 * 1024, JSON.stringify({ peak: ocrDiag?.peakOcrMemoryBytes }));
  check('OCR runtime receives no vault key material', !/(dek|kek|passphrase|vaultkey|aad)/i.test(JSON.stringify(ocrDiag?.lastRequestKeys ?? []) + JSON.stringify(ocrDiag?.lastResultKeys ?? [])), JSON.stringify({ request: ocrDiag?.lastRequestKeys, result: ocrDiag?.lastResultKeys }));

  // 2. Encrypted at rest and AAD binding.
  const rawAfterOcr = await readState(page);
  const rawText = rawAfterOcr.text.find((row) => row.documentId === imageOnly.data.document.id);
  const rawDocument = rawAfterOcr.documents.find((row) => row.id === imageOnly.data.document.id);
  check('OCR text is encrypted at rest', Boolean(rawText)
    && !rawText.textEnc.includes('FORMFLOW OCR TEST')
    && !rawText.pageTextsEnc.includes('FORMFLOW OCR TEST')
    && !rawText.extractionEnc.includes('FORMFLOW OCR TEST'), JSON.stringify({ textEnc: rawText?.textEnc?.slice(0, 20), extractionEnc: rawText?.extractionEnc?.slice(0, 20) }));
  check('plaintext document metadata contains no recognized OCR text', rawDocument?.ocrStatus === 'completed' && !JSON.stringify(rawDocument).includes('FORMFLOW OCR TEST'), JSON.stringify(rawDocument));

  const nativeText = await importPdf('ocr-native.pdf', buildPdf([{ text: 'NATIVE PDF TEXT MARKER' }]), 'ocr_native');
  check('native text PDF still parses without OCR', nativeText?.ok === true && nativeText.data.document.ocrStatus === 'not_required', JSON.stringify(nativeText?.data?.document));

  const structuredPdf = buildPdf([{
    textItems: [
      { text: 'Chromium Structured Heading', x: 72, y: 720, fontSize: 22, bold: true },
      { text: 'Chromium paragraph line one.', x: 72, y: 680, fontSize: 12 },
      { text: 'Chromium paragraph line two.', x: 72, y: 664, fontSize: 12 },
      { text: '1. Chromium list item', x: 72, y: 628, fontSize: 12 },
      { text: '2. Second Chromium list item', x: 72, y: 612, fontSize: 12 },
      { text: 'Field', x: 72, y: 560, fontSize: 12, bold: true },
      { text: 'Value', x: 220, y: 560, fontSize: 12, bold: true },
      { text: 'Degree', x: 72, y: 540, fontSize: 12 },
      { text: 'B.Tech', x: 220, y: 540, fontSize: 12 },
      { text: 'Year', x: 72, y: 520, fontSize: 12 },
      { text: '2026', x: 220, y: 520, fontSize: 12 },
    ],
  }]);
  const structured = await importPdf('ocr-structured-layout.pdf', structuredPdf, 'ocr_structured_layout');
  const structuredText = structured?.ok ? await getText(structured.data.document.id) : null;
  check('real Chromium PDF extraction produces structured headings, lists, and tables', structured?.ok === true
    && structuredText?.data?.structure?.blocks?.some((block) => block.type === 'heading' && block.text.includes('Chromium Structured Heading'))
    && structuredText?.data?.structure?.blocks?.some((block) => block.type === 'list')
    && structuredText?.data?.structure?.tables?.length === 1
    && structuredText.data.structure.tables[0].rowCount >= 3, JSON.stringify({ blocks: structuredText?.data?.structure?.blocks?.map((block) => block.type), tables: structuredText?.data?.structure?.tables }));

  const columnPdf = buildPdf([{
    textItems: [1, 2, 3, 4, 5].flatMap((index) => [
      { text: `CHROMIUM LEFT ${index}`, x: 72, y: 720 - index * 24, fontSize: 11 },
      { text: `CHROMIUM RIGHT ${index}`, x: 330, y: 720 - index * 24, fontSize: 11 },
    ]),
  }]);
  const columnImport = await importPdf('ocr-two-column.pdf', columnPdf, 'ocr_two_column');
  const columnText = columnImport?.ok ? await getText(columnImport.data.document.id) : null;
  const columnOrder = (columnText?.data?.structure?.readingOrder ?? [])
    .map((blockId) => columnText.data.structure.blocks.find((block) => block.blockId === blockId)?.text ?? '')
    .join('\n');
  check('real Chromium two-column PDF preserves left-to-right reading order', columnImport?.ok === true
    && columnOrder.indexOf('CHROMIUM LEFT 5') < columnOrder.indexOf('CHROMIUM RIGHT 1'), JSON.stringify({ order: columnOrder, structure: Boolean(columnText?.data?.structure) }));

  const originalExtraction = rawText.extractionEnc;
  const tampered = await page.evaluate(async ({ documentId, replacement }) => {
    const request = indexedDB.open('formflow-local');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('documentText', 'readwrite');
    const store = tx.objectStore('documentText');
    const row = await new Promise((resolve, reject) => {
      const get = store.get(documentId);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    const envelope = JSON.parse(row.extractionEnc);
    envelope.data = replacement;
    store.put({ ...row, extractionEnc: JSON.stringify(envelope) });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  }, { documentId: imageOnly.data.document.id, replacement: 'AAAA' });
  const tamperedRead = await getText(imageOnly.data.document.id);
  check('AAD-bound OCR extraction rejects tampering', tampered === true && tamperedRead?.ok === false, JSON.stringify(tamperedRead));
  await page.evaluate(async ({ documentId, value }) => {
    const request = indexedDB.open('formflow-local');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('documentText', 'readwrite');
    const store = tx.objectStore('documentText');
    const row = await new Promise((resolve, reject) => {
      const get = store.get(documentId);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    store.put({ ...row, extractionEnc: value });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }, { documentId: imageOnly.data.document.id, value: originalExtraction });
  const restored = await getText(imageOnly.data.document.id);
  check('restored encrypted OCR extraction decrypts again', restored?.ok === true && restored.data.text.includes('FORMFLOW OCR TEST'), restored?.error);

  // 3. Multi-page scanned PDF.
  const pageTwoImage = await makeImage(page, `
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 52px Arial';
    ctx.fillText('SECOND SCANNED PAGE', 120, 260);
    ctx.font = '40px Arial';
    ctx.fillText('Reference: FF-OCR-2026', 120, 380);
  `);
  const multiPagePdf = buildPdf([
    { jpeg: formImage, width: 1600, height: 900 },
    { jpeg: pageTwoImage, width: 1600, height: 900 },
  ]);
  const multi = await importPdf('ocr-multipage.pdf', multiPagePdf, 'ocr_multipage');
  const multiText = multi?.ok ? await getText(multi.data.document.id) : null;
  const multiDiag = await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.diagnostics?.() ?? null);
  console.log('OCR_MULTI_PERF', JSON.stringify({ peakOcrHeapBytes: multiDiag?.peakOcrMemoryBytes ?? null, lastOcrHeapBytes: multiDiag?.memoryUsedBytes ?? null }));
  check('multi-page scanned PDF is OCR-processed', multi?.ok === true && multiText?.data?.ocr?.pagesCompleted === 2, JSON.stringify({ ocr: multiText?.data?.ocr?.status, pages: multiText?.data?.pageTexts?.length }));
  check('multi-page OCR text preserves page boundaries', multiText?.data?.pageTexts?.[0]?.includes('FORMFLOW OCR TEST') && multiText?.data?.pageTexts?.[1]?.includes('SECOND SCANNED PAGE'), JSON.stringify(multiText?.data?.pageTexts));

  // 4. Mixed text and image PDF.
  const mixed = await importPdf('ocr-mixed.pdf', buildPdf([
    { text: 'MIXED NATIVE PAGE MARKER' },
    { jpeg: pageTwoImage, width: 1600, height: 900 },
  ]), 'ocr_mixed');
  const mixedText = mixed?.ok ? await getText(mixed.data.document.id) : null;
  check('mixed PDF keeps native page text and OCRs only the image page', mixed?.ok === true
    && mixedText?.data?.method === 'mixed'
    && mixedText.data.pageTexts[0].includes('MIXED NATIVE PAGE MARKER')
    && mixedText.data.pageTexts[1].includes('SECOND SCANNED PAGE')
    && mixedText.data.ocr.pages.length === 1
    && mixedText.data.ocr.pages[0].page === 2, JSON.stringify({
      ok: mixed?.ok,
      error: mixed?.error,
      method: mixedText?.data?.method,
      pages: mixedText?.data?.pageTexts,
      ocrPages: mixedText?.data?.ocr?.pages?.map((p) => p.page),
      status: mixedText?.data?.ocr?.status,
      required: mixedText?.data?.ocrRequired,
    }));
  check('mixed PDF structure preserves per-page provenance', mixedText?.data?.structure?.pages?.[0]?.extractionMethod === 'pdf_native'
    && mixedText?.data?.structure?.pages?.[1]?.extractionMethod === 'ocr'
    && mixedText?.data?.structure?.blocks?.some((block) => block.pageNumber === 2 && block.provenance === 'ocr'), JSON.stringify(mixedText?.data?.structure?.pages));

  // 5. Rotated text.
  const rotatedImage = await makeImage(page, `
    ctx.save();
    ctx.translate(1340, 140);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 58px Arial';
    ctx.fillText('ROTATED OCR PAGE', 0, 0);
    ctx.font = '40px Arial';
    ctx.fillText('Rotated line 42B', 0, 90);
    ctx.restore();
  `);
  const rotated = await importPdf('ocr-rotated.pdf', buildPdf([{ jpeg: rotatedImage, width: 1600, height: 900 }]), 'ocr_rotated');
  const rotatedText = rotated?.ok ? await getText(rotated.data.document.id) : null;
  check('rotated page is processed without crashing', rotated?.ok === true && rotatedText?.data?.ocr?.status === 'completed', JSON.stringify({ status: rotatedText?.data?.ocr?.status, text: rotatedText?.data?.text }));
  check('rotated OCR text is recognized', rotatedText?.data?.text?.toUpperCase().includes('ROTATED OCR'), JSON.stringify(rotatedText?.data?.text));

  // 6. Low-quality/unreadable page remains retryable.
  const unreadableImage = await makeImage(page, `
    ctx.fillStyle = 'rgba(30,30,30,0.35)';
    ctx.font = '9px Arial';
    ctx.fillText('illegible low quality mark', 210, 302);
    ctx.filter = 'blur(5px)';
    ctx.fillText('illegible low quality mark', 210, 330);
    ctx.filter = 'none';
    for (let index = 0; index < 3000; index += 1) {
      ctx.fillStyle = index % 2 ? 'rgba(170,170,170,0.35)' : 'rgba(60,60,60,0.25)';
      ctx.fillRect((index * 97) % 1600, (index * 53) % 900, 3, 3);
    }
  `);
  const unreadable = await importPdf('ocr-unreadable.pdf', buildPdf([{ jpeg: unreadableImage, width: 1600, height: 900 }]), 'ocr_unreadable');
  const unreadableText = unreadable?.ok ? await getText(unreadable.data.document.id) : null;
  check('unreadable page is stored without losing the original', unreadable?.ok === true, JSON.stringify(unreadable?.error ?? unreadable?.data?.document));
  check('low-quality OCR completes or fails with an explicit status', ['failed', 'partial', 'completed'].includes(unreadableText?.data?.ocr?.status)
    && (unreadableText?.data?.ocr?.status === 'completed' || Array.isArray(unreadableText?.data?.ocr?.warnings)), JSON.stringify(unreadableText?.data?.ocr));

  // 7. Partial OCR success.
  const blankImage = await makeImage(page, '');
  const partial = await importPdf('ocr-partial.pdf', buildPdf([
    { jpeg: formImage, width: 1600, height: 900 },
    { jpeg: blankImage, width: 1600, height: 900 },
  ]), 'ocr_partial');
  const partialText = partial?.ok ? await getText(partial.data.document.id) : null;
  check('partial OCR status is not reported as complete', partial?.ok === true
    && partialText?.data?.ocr?.status === 'partial'
    && partialText.data.ocr.pagesCompleted === 1
    && partialText.data.ocr.pagesFailed === 1
    && partialText.data.ocrRequired === true, JSON.stringify(partialText?.data?.ocr));
  check('partial OCR keeps the page requiring OCR', partialText?.data?.pagesNeedingOcr?.includes(2), JSON.stringify(partialText?.data?.pagesNeedingOcr));

  // 8. Missing language data fails safely while preserving the original.
  const missingLanguageDir = await mkdtemp(path.join(tmpdir(), 'ff-ocr-no-lang-'));
  temporaryPaths.push(missingLanguageDir);
  const missingLanguageExtension = path.join(missingLanguageDir, 'extension');
  await cp(baseExtensionPath, missingLanguageExtension, { recursive: true });
  await rm(path.join(missingLanguageExtension, 'tessdata'), { recursive: true, force: true });
  const missingRoot = await mkdtemp(path.join(tmpdir(), 'ff-ocr-no-lang-vault-'));
  temporaryPaths.push(missingRoot);
  const missing = await launchContext(missingLanguageExtension, missingRoot);
  const missingImport = await message(missing.page, 'ocr_missing_language', 'IMPORT_DOCUMENT', {
    name: 'ocr-missing-language.pdf',
    mimeType: 'application/pdf',
    dataBase64: imageOnlyPdf.toString('base64'),
    importId: 'ocr_missing_language',
  });
  const missingText = missingImport?.ok ? await message(missing.page, 'ocr_missing_text', 'GET_DOCUMENT_TEXT', { documentId: missingImport.data.document.id }) : null;
  check('missing OCR language data preserves the original document', missingImport?.ok === true && missingText?.data?.text === '', JSON.stringify(missingImport?.error ?? missingImport?.data?.document?.ocrStatus));
  check('missing language reports a retryable OCR failure', missingText?.data?.ocr?.status === 'failed'
    && (missingText.data.warnings ?? []).some((warning) => warning.code === 'OCR_LANGUAGE_UNAVAILABLE'), JSON.stringify(missingText?.data?.warnings));
  await missing.context.close();

  // 9. Cancellation during real OCR.
  await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.injectMessage?.({ type: '__TEST_SET_OCR_DELAY', delayMs: 2_000 }));
  await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.injectMessage?.({ type: '__TEST_SET_OCR_TIMEOUT', timeoutMs: 15_000 }));
  const beforeCancel = await documentCount();
  const cancelPromise = importPdf('ocr-cancel.pdf', imageOnlyPdf, 'ocr_cancel');
  check('OCR start is observable before cancellation', await waitForOffscreenOcr(worker, 1, 15_000));
  await message(page, 'ocr_cancel_request', 'CANCEL_DOCUMENT_IMPORT', { importId: 'ocr_cancel' });
  const cancelled = await cancelPromise;
  const afterCancel = await documentCount();
  check('OCR cancellation is reported', cancelled?.ok === false && cancelled.code === 'CANCELLED', JSON.stringify(cancelled));
  check('OCR cancellation leaves no partial document', beforeCancel === afterCancel, JSON.stringify({ beforeCancel, afterCancel }));

  // 10. OCR page timeout leaves the document and marks OCR failed.
  const timeoutImage = await makeImage(page, `
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 58px Arial';
    ctx.fillText('OCR TIMEOUT PAGE', 120, 260);
    ctx.font = '40px Arial';
    ctx.fillText('Timeout marker 7731', 120, 380);
  `);
  const timeoutPdf = buildPdf([{ jpeg: timeoutImage, width: 1600, height: 900 }]);
  await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.injectMessage?.({ type: '__TEST_SET_OCR_DELAY', delayMs: 2_000 }));
  await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.injectMessage?.({ type: '__TEST_SET_OCR_TIMEOUT', timeoutMs: 300 }));
  const timeoutStarted = Date.now();
  const timedOut = await importPdf('ocr-timeout.pdf', timeoutPdf, 'ocr_timeout');
  const timedOutText = timedOut?.ok ? await getText(timedOut.data.document.id) : null;
  check('OCR timeout completes without hanging', timedOut?.ok === true && Date.now() - timeoutStarted < 15_000, JSON.stringify({ error: timedOut?.error, ms: Date.now() - timeoutStarted }));
  check('OCR timeout is recorded as a failed retryable attempt', timedOutText?.data?.ocr?.status === 'failed'
    && (timedOutText.data.warnings ?? []).some((warning) => warning.code === 'OCR_PAGE_TIMEOUT')
    && timedOut.data.document.ocrRequired === true, JSON.stringify(timedOutText?.data?.warnings));
  await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.injectMessage?.({ type: '__TEST_SET_OCR_DELAY', delayMs: 0 }));
  await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.injectMessage?.({ type: '__TEST_SET_OCR_TIMEOUT', timeoutMs: 30_000 }));

  // 11. Duplicate OCR prevention.
  const ocrStartedBeforeDuplicate = await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.diagnostics?.().ocrStarted ?? 0);
  const duplicate = await importPdf('ocr-image-only-copy.pdf', imageOnlyPdf, 'ocr_duplicate');
  const ocrStartedAfterDuplicate = await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.diagnostics?.().ocrStarted ?? 0);
  check('duplicate document does not run OCR again', duplicate?.ok === true && duplicate.data.duplicate === true && ocrStartedAfterDuplicate === ocrStartedBeforeDuplicate, JSON.stringify({ duplicate: duplicate?.data?.duplicate, before: ocrStartedBeforeDuplicate, after: ocrStartedAfterDuplicate }));

  // 11b. Encrypted backup round-trip preserves OCR details.
  const exported = await message(page, 'ocr_backup_export', 'EXPORT_VAULT', { passphrase: backupPassphrase });
  check('vault backup exports with OCR details encrypted', exported?.ok === true && typeof exported.data?.dataBase64 === 'string', exported?.error);
  const backupTargetDir = await mkdtemp(path.join(tmpdir(), 'ff-ocr-backup-target-'));
  temporaryPaths.push(backupTargetDir);
  const target = await launchContext(baseExtensionPath, backupTargetDir);
  const importedBackup = await message(target.page, 'ocr_backup_import', 'IMPORT_VAULT', {
    passphrase: backupPassphrase,
    dataBase64: exported.data.dataBase64,
  });
  const targetDocuments = importedBackup?.ok ? await message(target.page, 'ocr_backup_list', 'LIST_DOCUMENTS') : null;
  const restoredDocument = targetDocuments?.data?.documents?.find((item) => item.name === 'ocr-image-only.pdf');
  const restoredText = restoredDocument
    ? await message(target.page, 'ocr_backup_text', 'GET_DOCUMENT_TEXT', { documentId: restoredDocument.id })
    : null;
  check('backup import restores OCR documents', importedBackup?.ok === true && Boolean(restoredDocument), JSON.stringify(importedBackup?.error ?? targetDocuments?.data?.count));
  check('backup round-trip preserves recognized OCR text and confidence', restoredText?.ok === true
    && restoredText.data.text.includes('FORMFLOW OCR TEST')
    && restoredText.data.ocr?.status === 'completed'
    && restoredText.data.ocr?.language === 'eng'
    && restoredText.data.ocr?.averageConfidence === 95, JSON.stringify({ text: restoredText?.data?.text, ocr: restoredText?.data?.ocr?.status, confidence: restoredText?.data?.ocr?.averageConfidence }));
  check('backup round-trip preserves the encrypted structured layout', restoredText?.data?.structure?.pages?.[0]?.extractionMethod === 'ocr'
    && restoredText.data.structure.blocks?.some((block) => block.text?.includes('FORMFLOW OCR TEST') && block.boundingBox?.coordinateSpace === 'ocr_render_pixels')
    && restoredText.data.structure.metadata?.ocrPageCount === 1, JSON.stringify(restoredText?.data?.structure?.metadata));
  await target.context.close();

  // 12. Offscreen worker crash during OCR and recovery.
  const crashImage = await makeImage(page, `
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 58px Arial';
    ctx.fillText('OCR CRASH PAGE', 120, 260);
    ctx.font = '40px Arial';
    ctx.fillText('Crash marker 8822', 120, 380);
  `);
  const crashPdf = buildPdf([{ jpeg: crashImage, width: 1600, height: 900 }]);
  await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.injectMessage?.({ type: '__TEST_SET_OCR_DELAY', delayMs: 2_000 }));
  const beforeCrash = await documentCount();
  const crashPromise = importPdf('ocr-crash.pdf', crashPdf, 'ocr_crash');
  check('OCR running before simulated worker crash', await waitForOffscreenOcr(worker, ocrStartedAfterDuplicate + 1, 15_000));
  await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.close?.());
  const crashed = await crashPromise;
  const afterCrash = await documentCount();
  check('offscreen crash during OCR fails the import', crashed?.ok === false && ['PARSER_UNAVAILABLE', 'EXTRACTION_FAILED', 'CANCELLED'].includes(crashed.code), JSON.stringify(crashed));
  check('offscreen crash leaves no partial document', beforeCrash === afterCrash, JSON.stringify({ beforeCrash, afterCrash }));
  await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.injectMessage?.({ type: '__TEST_SET_OCR_DELAY', delayMs: 0 }));
  const recovery = await importPdf('ocr-recovery.pdf', crashPdf, 'ocr_recovery');
  const recoveryText = recovery?.ok ? await getText(recovery.data.document.id) : null;
  check('OCR recovers after an offscreen crash', recovery?.ok === true && recoveryText?.data?.text?.includes('OCR CRASH PAGE'), recovery?.error);

  // 13. Extension restart during OCR.
  const restartImage = await makeImage(page, `
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 58px Arial';
    ctx.fillText('OCR RESTART PAGE', 120, 260);
    ctx.font = '40px Arial';
    ctx.fillText('Restart marker 9933', 120, 380);
  `);
  const restartPdf = buildPdf([{ jpeg: restartImage, width: 1600, height: 900 }]);
  await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.injectMessage?.({ type: '__TEST_SET_OCR_DELAY', delayMs: 2_000 }));
  const beforeRestart = await documentCount();
  const restartBaseline = await worker.evaluate(() => globalThis.__formflowTestHooks?.offscreen?.diagnostics?.().ocrStarted ?? 0);
  const restartPromise = importPdf('ocr-restart.pdf', restartPdf, 'ocr_restart').catch(() => ({ ok: false, error: 'context closed' }));
  check('OCR running before extension restart', await waitForOffscreenOcr(worker, restartBaseline + 1, 15_000));
  await context.close();
  const reopenedDir = userDataDir;
  const reopened = await launchPersistentOnly(reopenedDir);
  const { context: context2, worker: worker2, page: page2 } = reopened;
  await wait(500);
  const preUnlockState = await message(page2, 'ocr_restart_state', 'GET_STATE');
  const unlock = preUnlockState?.data?.vaultStatus?.unlocked
    ? { ok: true }
    : await message(page2, 'ocr_restart_unlock', 'VAULT_UNLOCK', { passphrase });
  check('vault unlocks after extension restart', unlock?.ok === true, unlock?.error);
  const afterRestart = (await message(page2, 'ocr_restart_list', 'LIST_DOCUMENTS')).data?.count ?? -1;
  check('extension restart during OCR leaves no partial document', beforeRestart === afterRestart, JSON.stringify({ beforeRestart, afterRestart }));
  const restartRecovery = await message(page2, 'ocr_restart_recovery', 'IMPORT_DOCUMENT', {
    name: 'ocr-restart-recovery.pdf',
    mimeType: 'application/pdf',
    dataBase64: restartPdf.toString('base64'),
    importId: 'ocr_restart_recovery',
  });
  check('OCR works after extension restart', restartRecovery?.ok === true, restartRecovery?.error);
  void worker2;
  void restartPromise;
  primary = { context: context2, worker: worker2, page: page2, id: reopened.id };
} catch (error) {
  console.log('SUITE_ERROR', error instanceof Error ? error.stack : String(error));
  failures += 1;
} finally {
  await primary?.context?.close().catch(() => undefined);
  for (const target of temporaryPaths) await rm(target, { recursive: true, force: true }).catch(() => undefined);
}

const externalRequests = globalThis.__externalRequests ?? [];
check('no external network requests were attempted during OCR', externalRequests.length === 0, JSON.stringify(externalRequests));
console.log(`\nOCR suite ${failures === 0 ? 'PASSED' : 'FAILED'} (${failures} failure${failures === 1 ? '' : 's'})`);
process.exit(failures === 0 ? 0 : 1);

async function launchPersistentOnly(userDataDir) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      `--disable-extensions-except=${baseExtensionPath}`,
      `--load-extension=${baseExtensionPath}`,
      '--no-proxy-server',
      '--no-first-run',
      '--enable-precise-memory-info',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  context.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('chrome-extension://') && !url.startsWith('data:') && !url.startsWith('blob:')) {
      globalThis.__externalRequests = [...(globalThis.__externalRequests ?? []), url];
    }
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/dashboard.html`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  return { context, worker, page, id };
}
