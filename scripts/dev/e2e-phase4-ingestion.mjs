import { chromium } from 'playwright';
import { strToU8, zipSync } from 'fflate';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('extension/dist');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-phase4-ingestion-'));
const executablePath = process.env.CHROME_PATH;
const passphrase = 'phase4-ingestion-passphrase-2026';
let context;
let failures = 0;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 300)}` : ''}`);
  if (!condition) failures += 1;
};

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

function buildPdf({ pages, password = false }) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  for (const page of pages) {
    let xObject = '';
    if (page.image) {
      const imageId = add('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\u0000\nendstream');
      xObject = `/XObject << /Im1 ${imageId} 0 R >>`;
    }
    const content = page.text
      ? `BT /F1 18 Tf 72 720 Td (${escapePdf(page.text)}) Tj ET`
      : page.image ? 'q 100 0 0 100 72 600 cm /Im1 Do Q' : '';
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'binary')} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> ${xObject} >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  let encryptId = null;
  if (password) {
    encryptId = add('<< /Filter /Standard /V 1 /R 2 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>');
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
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R`;
  if (encryptId) pdf += ` /Encrypt ${encryptId} 0 R /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]`;
  pdf += ` >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
}

function buildDocx(pageBreak = true) {
  const explicitBreak = pageBreak ? '<w:br w:type="page"/>' : '';
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Admissions Heading</w:t></w:r></w:p>
<w:p><w:r><w:t>DOCX paragraph one with useful text.</w:t><w:br/><w:t>DOCX line two.</w:t>${explicitBreak}</w:r></w:p>
<w:p><w:r><w:t>DOCX explicit page two paragraph.</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Field</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Degree</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B.Tech</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`;
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'word/document.xml': strToU8(documentXml),
    'word/styles.xml': strToU8(stylesXml),
  });
}

function buildPaginationDocx() {
  const paragraph = (text) => `<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
  const text = 'A deterministic paragraph that must wrap across several physical pages when the renderer measures the local Calibri font metrics. '.repeat(8);
  const paragraphs = Array.from({ length: 40 }, (_, index) => paragraph(`Pagination paragraph ${index + 1}. ${text}`)).join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/document.xml': strToU8(documentXml),
  });
}

function buildImageDocx(withCaption = true) {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const drawing = `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="1828800" cy="1371600"/><wp:docPr id="1" name="image1" descr="E2E image alt"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="image1.png" descr="E2E image alt"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  const caption = withCaption ? '<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>Figure 1. E2E caption</w:t></w:r></w:p>' : '';
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r>${drawing}</w:r></w:p>${caption}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>'),
    'word/styles.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/></w:style></w:styles>'),
    'word/media/image1.png': png,
    'word/document.xml': strToU8(documentXml),
  });
}

function buildManyParagraphDocx(count) {
  const paragraph = (text) => `<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
  const paragraphs = Array.from({ length: count }, (_, index) => paragraph(`Large document paragraph ${index + 1} with deterministic text for the local pagination geometry budget.`)).join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
  });
}

function buildLongTableDocx() {
  const cell = (text) => `<w:tc><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="20"/></w:rPr><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const row = (index) => `<w:tr>${[1, 2, 3].map((column) => cell(`Row ${index} column ${column}`)).join('')}</w:tr>`;
  const rows = Array.from({ length: 50 }, (_, index) => row(index + 1)).join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Long table introduction</w:t></w:r></w:p><w:tbl>${rows}</w:tbl><w:p><w:r><w:t>Long table conclusion</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/document.xml': strToU8(documentXml),
  });
}

async function makeTextPdf(context, marker) {
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><body style="font-family:Helvetica;padding:40px">
    <h1>${marker}</h1>
    <p>This is a real Chromium-generated PDF with extractable text.</p>
    <div style="page-break-before:always;padding-top:40px">
      <h2>Second page</h2>
      <p>Second page transcript content for ${marker}.</p>
    </div>
  </body></html>`);
  const bytes = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' } });
  await page.close();
  return bytes;
}

async function readDatabase(page) {
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
  await page.fill('input[placeholder="e.g. Personal applications"]', 'Phase 4 ingestion vault');
  await page.locator('input[type=password]').nth(0).fill(passphrase);
  await page.locator('input[type=password]').nth(1).fill(passphrase);
  await page.click('button:has-text("Create encrypted vault")');
  await page.waitForURL(/#\/dashboard$/);
  await page.waitForTimeout(700);
  check('vault created', true);

  const marker = 'FORMPHASE4REALPDF';
  const pdf = await makeTextPdf(context, marker);
  const pdfImport = await message(page, 'p4_pdf', 'IMPORT_DOCUMENT', {
    name: 'phase4-real.pdf',
    mimeType: 'application/pdf',
    dataBase64: pdf.toString('base64'),
    importId: 'p4_pdf',
    fileIndex: 0,
    fileCount: 1,
  });
  check('real Chromium PDF imported', pdfImport?.ok === true, pdfImport?.error);
  check('real PDF page boundaries extracted', pdfImport?.data?.document?.pageCount >= 2, pdfImport?.data?.document?.pageCount);
  check('real PDF status is stored with extracted text', pdfImport?.data?.document?.status === 'stored' && pdfImport?.data?.document?.extractedTextStatus === 'extracted', JSON.stringify(pdfImport?.data?.document));
  const offscreenContexts = await page.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  check('production ingestion created the isolated offscreen parser document', offscreenContexts.some((context) => context.documentUrl?.endsWith('/offscreen-parser.html')), JSON.stringify(offscreenContexts));

  const pdfText = await message(page, 'p4_pdf_text', 'GET_DOCUMENT_TEXT', { documentId: pdfImport.data.document.id, maxChars: 1_000_000 });
  check('real PDF text is readable after encrypted storage', pdfText?.ok === true && pdfText.data.text.includes(marker), pdfText?.error);
  check('real PDF page text count matches page count', pdfText?.ok === true && pdfText.data.pageTexts.length === pdfImport.data.document.pageCount, JSON.stringify({ pages: pdfText?.data?.pageTexts?.length, count: pdfImport?.data?.document?.pageCount }));

  const docxBytes = buildDocx();
  const docxImport = await message(page, 'p4_docx', 'IMPORT_DOCUMENT', {
    name: 'phase4-fixture.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: Buffer.from(docxBytes).toString('base64'),
    importId: 'p4_docx',
  });
  check('DOCX imported with extracted text', docxImport?.ok === true && docxImport.data.document.pageCount === 1, docxImport?.error);
  const docxText = await message(page, 'p4_docx_text', 'GET_DOCUMENT_TEXT', { documentId: docxImport.data.document.id });
  check('DOCX headings, line breaks, and table cells survive', docxText?.ok === true && /Admissions Heading/.test(docxText.data.text) && /DOCX line two/.test(docxText.data.text) && /Degree\tB\.Tech/.test(docxText.data.text), docxText?.data?.text?.slice(0, 200));
  check('real Chromium DOCX extraction preserves logical-page structure and table cells', docxText?.data?.structure?.pageSemantics === 'logical'
    && docxText.data.structure.blocks.some((block) => block.type === 'heading' && block.text.includes('Admissions Heading'))
    && docxText.data.structure.tables.length === 1
    && docxText.data.structure.blocks.some((block) => block.type === 'table_cell' && block.text === 'B.Tech'), JSON.stringify({ pages: docxText?.data?.structure?.pages, tables: docxText?.data?.structure?.tables }));
  check('real Chromium DOCX pagination uses the local font-backed renderer rather than explicit-break metadata alone', docxText?.data?.structure?.pagination?.status === 'renderer_derived_physical'
    && docxText.data.structure.pagination.mechanism === 'local_renderer'
    && /@docx-editor\.dev\/core/.test(docxText.data.structure.pagination.renderer ?? '')
    && docxText.data.structure.pagination.pageCount === 2
    && docxText.data.structure.pagination.blockPages.length > 0
    && docxText.data.structure.pagination.blockPages.some((entry) => entry.fragmentPages?.length || entry.lines?.length || entry.tableRows?.length)
    && docxText.data.structure.pagination.status !== 'verified_physical', JSON.stringify(docxText?.data?.structure?.pagination));
  check('automatic DOCX pagination supersedes stale break-only warnings', !docxText?.data?.structure?.warnings?.some((warning) => warning.code === 'DOCX_EXPLICIT_BREAK_PAGINATION' || warning.code === 'DOCX_PAGE_COUNT_UNAVAILABLE'), JSON.stringify(docxText?.data?.structure?.warnings));

  const logicalDocxImport = await message(page, 'p4_docx_logical', 'IMPORT_DOCUMENT', {
    name: 'phase4-logical.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: Buffer.from(buildDocx(false)).toString('base64'),
    importId: 'p4_docx_logical',
  });
  const logicalDocxText = logicalDocxImport?.ok
    ? await message(page, 'p4_docx_logical_text', 'GET_DOCUMENT_TEXT', { documentId: logicalDocxImport.data.document.id })
    : null;
  check('real Chromium DOCX without break evidence receives automatic physical pages', logicalDocxImport?.ok === true
    && logicalDocxText?.data?.structure?.pagination?.status === 'renderer_derived_physical'
    && logicalDocxText.data.structure.pagination.pageCount >= 1
    && logicalDocxText.data.structure.pagination.pages.length === logicalDocxText.data.structure.pagination.pageCount, JSON.stringify(logicalDocxText?.data?.structure?.pagination));

  const overflowImport = await message(page, 'p4_docx_overflow', 'IMPORT_DOCUMENT', {
    name: 'phase4-overflow.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: Buffer.from(buildPaginationDocx()).toString('base64'),
    importId: 'p4_docx_overflow',
  });
  const overflowText = overflowImport?.ok
    ? await message(page, 'p4_docx_overflow_text', 'GET_DOCUMENT_TEXT', { documentId: overflowImport.data.document.id })
    : null;
  const overflowPagination = overflowText?.data?.structure?.pagination;
  check('automatic pagination splits a long paragraph across physical pages with fragment mappings', overflowImport?.ok === true
    && overflowPagination?.pageCount > 1
    && overflowPagination.blockPages.some((entry) => (entry.endPageNumber ?? entry.startPageNumber) > entry.startPageNumber && (entry.fragmentPages?.length ?? 0) > 1), JSON.stringify({ pages: overflowPagination?.pageCount, sample: overflowPagination?.blockPages?.find((entry) => (entry.endPageNumber ?? entry.startPageNumber) > entry.startPageNumber) }));

  const tableImport = await message(page, 'p4_docx_table', 'IMPORT_DOCUMENT', {
    name: 'phase4-long-table.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: Buffer.from(buildLongTableDocx()).toString('base64'),
    importId: 'p4_docx_table',
  });
  const tableText = tableImport?.ok
    ? await message(page, 'p4_docx_table_text', 'GET_DOCUMENT_TEXT', { documentId: tableImport.data.document.id })
    : null;
  const tableStructure = tableText?.data?.structure;
  const tablePagination = tableStructure?.pagination;
  const tableBlock = tableStructure?.blocks.find((block) => block.type === 'table');
  const tableMapping = tablePagination?.blockPages.find((entry) => entry.blockId === tableBlock?.blockId);
  const mappedRow = tableBlock?.children?.length
    ? tablePagination?.blockPages.find((entry) => entry.blockId === tableBlock.children[0])
    : undefined;
  check('automatic pagination maps a table and its rows across physical pages', tableImport?.ok === true
    && tablePagination?.status === 'renderer_derived_physical'
    && (tableMapping?.endPageNumber ?? 0) > (tableMapping?.startPageNumber ?? 0)
    && (tableMapping?.fragmentPages?.length ?? 0) > 1
    && mappedRow?.startPageNumber === tableMapping?.startPageNumber, JSON.stringify({ table: tableMapping, row: mappedRow }));

  const imageImport = await message(page, 'p4_docx_image', 'IMPORT_DOCUMENT', {
    name: 'phase4-image.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: Buffer.from(buildImageDocx()).toString('base64'),
    importId: 'p4_docx_image',
  });
  const imageText = imageImport?.ok
    ? await message(page, 'p4_docx_image_text', 'GET_DOCUMENT_TEXT', { documentId: imageImport.data.document.id })
    : null;
  const imageStructure = imageText?.data?.structure;
  const imageBlock = imageStructure?.blocks.find((block) => block.type === 'image');
  const imageMapping = imageStructure?.pagination?.blockPages.find((entry) => entry.blockId === imageBlock?.blockId);
  check('real Chromium DOCX exposes a structured image block with caption and page association', imageImport?.ok === true
    && imageBlock?.image?.mimeType === 'image/png'
    && imageBlock.image.displayWidthPt === 144
    && imageBlock.image.displayHeightPt === 108
    && imageBlock.image.alternativeText === 'E2E image alt'
    && imageBlock.image.captionText === 'Figure 1. E2E caption'
    && imageMapping?.geometryConfidence === 'exact'
    && imageMapping?.boundingBox?.width === 144, JSON.stringify({ image: imageBlock?.image, mapping: imageMapping }));
  check('image line/cell/column geometry is present in the encrypted structure', (imageStructure?.pagination?.geometry?.lineCount ?? 0) > 0
    && (imageStructure?.pagination?.pages?.[0]?.columns?.length ?? 0) > 0, JSON.stringify(imageStructure?.pagination?.geometry));

  const imageOnlyImport = await message(page, 'p4_docx_image_only', 'IMPORT_DOCUMENT', {
    name: 'phase4-image-only.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: Buffer.from(buildImageDocx(false)).toString('base64'),
    importId: 'p4_docx_image_only',
  });
  const imageOnlyText = imageOnlyImport?.ok
    ? await message(page, 'p4_docx_image_only_text', 'GET_DOCUMENT_TEXT', { documentId: imageOnlyImport.data.document.id })
    : null;
  check('image-only DOCX imports with an empty text body and a structured image block', imageOnlyImport?.ok === true
    && imageOnlyImport.data.document.extractedTextStatus === 'extracted'
    && imageOnlyText?.data?.text === ''
    && imageOnlyText.data.structure.blocks.some((block) => block.type === 'image'), JSON.stringify({ error: imageOnlyImport?.error, text: imageOnlyText?.data?.text, blocks: imageOnlyText?.data?.structure?.blocks?.map((block) => block.type) }));

  const largeDocxStarted = Date.now();
  const largeDocxImport = await message(page, 'p4_docx_large', 'IMPORT_DOCUMENT', {
    name: 'phase4-large-pagination.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: Buffer.from(buildManyParagraphDocx(5000)).toString('base64'),
    importId: 'p4_docx_large',
  });
  const largeDocxText = largeDocxImport?.ok
    ? await message(page, 'p4_docx_large_text', 'GET_DOCUMENT_TEXT', { documentId: largeDocxImport.data.document.id, maxChars: 1_000_000 })
    : null;
  const largePagination = largeDocxText?.data?.structure?.pagination;
  check('large 5,000-paragraph DOCX imports through the bounded pagination protocol', largeDocxImport?.ok === true
    && largePagination?.status === 'renderer_derived_physical'
    && largePagination.blockPages.length === 5000
    && largePagination.geometry?.truncated === true
    && Date.now() - largeDocxStarted < 60_000, JSON.stringify({ error: largeDocxImport?.error, pages: largePagination?.pageCount, mapped: largePagination?.blockPages?.length, geometry: largePagination?.geometry, ms: Date.now() - largeDocxStarted }));

  const txt = Buffer.from('\uFEFFTXT paragraph one\r\n\r\nTXT paragraph two', 'utf8');
  const txtImport = await message(page, 'p4_txt', 'IMPORT_DOCUMENT', {
    name: 'phase4-notes.txt',
    mimeType: 'text/plain',
    dataBase64: txt.toString('base64'),
    importId: 'p4_txt',
  });
  check('BOM/CRLF TXT imported', txtImport?.ok === true && txtImport.data.document.pageCount === 1, txtImport?.error);
  const txtText = await message(page, 'p4_txt_text', 'GET_DOCUMENT_TEXT', { documentId: txtImport.data.document.id });
  check('TXT paragraphs preserved', txtText?.ok === true && txtText.data.text === 'TXT paragraph one\n\nTXT paragraph two', txtText?.data?.text);

  const duplicate = await message(page, 'p4_dup', 'IMPORT_DOCUMENT', {
    name: 'phase4-notes-copy.txt',
    mimeType: 'text/plain',
    dataBase64: txt.toString('base64'),
    importId: 'p4_dup',
  });
  check('duplicate detected by SHA-256 and existing record kept', duplicate?.ok === true && duplicate.data.duplicate === true && duplicate.data.document.id === txtImport.data.document.id, JSON.stringify(duplicate?.data));

  const scanPdf = buildPdf({ pages: [{ image: true }, { image: true }] });
  const scanImport = await message(page, 'p4_scan', 'IMPORT_DOCUMENT', {
    name: 'phase4-scanned.pdf',
    mimeType: 'application/pdf',
    dataBase64: scanPdf.toString('base64'),
    importId: 'p4_scan',
  });
  check('image-only PDF imported as OCR-required', scanImport?.ok === true && scanImport.data.document.ocrRequired === true && scanImport.data.document.status === 'review_required', scanImport?.error);
  const scanText = await message(page, 'p4_scan_text', 'GET_DOCUMENT_TEXT', { documentId: scanImport.data.document.id });
  check(
    'scanned PDF OCR does not fabricate text',
    scanText?.ok === true
      && scanText.data.text === ''
      && scanText.data.warnings.some((warning) => ['OCR_REQUIRED', 'OCR_FAILED', 'OCR_PARTIAL'].includes(warning.code)),
    JSON.stringify(scanText?.data?.warnings),
  );

  const corrupt = await message(page, 'p4_corrupt', 'IMPORT_DOCUMENT', {
    name: 'phase4-corrupt.pdf',
    mimeType: 'application/pdf',
    dataBase64: Buffer.from('%PDF-1.4\nbroken\n%%EOF\n').toString('base64'),
    importId: 'p4_corrupt',
  });
  check('corrupted PDF rejected with a clear code', corrupt?.ok === false && corrupt.code === 'CORRUPTED_DOCUMENT', JSON.stringify(corrupt));

  const passwordPdf = buildPdf({ pages: [{ text: 'Protected' }], password: true });
  const locked = await message(page, 'p4_password', 'IMPORT_DOCUMENT', {
    name: 'phase4-protected.pdf',
    mimeType: 'application/pdf',
    dataBase64: passwordPdf.toString('base64'),
    importId: 'p4_password',
  });
  check('password-protected PDF rejected', locked?.ok === false && locked.code === 'PASSWORD_PROTECTED', JSON.stringify(locked));

  const state = await readDatabase(page);
  check('all successful records have encrypted originals and text', state.documents.length === state.files.length && state.documents.length === state.text.length, JSON.stringify({ documents: state.documents.length, files: state.files.length, text: state.text.length }));
  const serialized = JSON.stringify(state);
  check('extracted text is not present in plaintext at rest', !serialized.includes(marker) && !serialized.includes('TXT paragraph one') && !serialized.includes('DOCX paragraph one'));
  check('filenames are not present in plaintext metadata', !serialized.includes('phase4-real.pdf') && !serialized.includes('phase4-notes.txt'));
  check('all document text rows use authenticated v2 envelopes', state.text.every((row) => row.textEnc.includes('"v":2') && row.pageTextsEnc.includes('"v":2') && row.extractionEnc?.includes('"v":2')));
  check('all original files use v2 blob AAD', state.files.every((file) => file.aadVersion === 2 && file.version === 2));

  const list = await message(page, 'p4_list', 'LIST_DOCUMENTS');
  check('document list reports extraction status and OCR state', list?.ok === true && list.data.documents.some((doc) => doc.extractedTextStatus === 'extracted') && list.data.documents.some((doc) => doc.ocrRequired === true), JSON.stringify(list?.data?.count));

  const retry = await message(page, 'p4_retry', 'RETRY_DOCUMENT_EXTRACTION', { documentId: txtImport.data.document.id, importId: 'p4_retry' });
  check('retry extracts from the encrypted original without a second record', retry?.ok === true && retry.data.document.id === txtImport.data.document.id, retry?.error);
  const afterRetry = await readDatabase(page);
  check('retry kept one document, file, and text row', afterRetry.documents.length === state.documents.length && afterRetry.text.length === state.text.length);

  // Exercise the actual dashboard upload dialog, including duplicate feedback.
  const uiPage = await context.newPage();
  await uiPage.goto(`chrome-extension://${id}/dashboard.html#/documents`, { waitUntil: 'load' });
  await uiPage.waitForSelector('button:has-text("Upload document")');
  await uiPage.click('button:has-text("Upload document")');
  await uiPage.waitForSelector('.ff-dropzone');
  const uiFile = {
    name: 'ui-upload.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('UI upload paragraph one\n\nUI upload paragraph two', 'utf8'),
  };
  await uiPage.locator('input[type=file]').setInputFiles(uiFile);
  await uiPage.click('button:has-text("Upload and extract")');
  await uiPage.waitForSelector('text=ui-upload.txt', { timeout: 120000 });
  check('dashboard upload dialog completes a real import', (await uiPage.locator('body').innerText()).includes('ui-upload.txt'));
  const progressPdf = buildPdf({
    pages: Array.from({ length: 250 }, (_, index) => ({ text: `Progress fixture page ${index + 1} with enough text.` })),
  });
  await uiPage.click('button:has-text("Upload document")');
  await uiPage.waitForSelector('.ff-dropzone');
  await uiPage.locator('input[type=file]').setInputFiles({
    name: 'ui-progress.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(progressPdf),
  });
  await uiPage.click('button:has-text("Upload and extract")');
  let progressObserved = false;
  try {
    await uiPage.waitForFunction(() => document.body.innerText.includes('Extracting text locally'), { timeout: 30000 });
    progressObserved = true;
  } catch {
    progressObserved = false;
  }
  await uiPage.waitForSelector('text=ui-progress.pdf', { timeout: 120000 });
  check('dashboard shows real per-page extraction progress', progressObserved);

  await uiPage.locator('tr', { hasText: 'ui-upload.txt' }).click();
  await uiPage.waitForSelector('text=UI upload paragraph one', { timeout: 30000 });
  check('inspector shows the decrypted extracted-text preview', (await uiPage.locator('body').innerText()).includes('UI upload paragraph one'));
  await uiPage.click('button:has-text("Structure")');
  await uiPage.waitForSelector('text=Deterministic local layout:', { timeout: 30000 });
  const structureView = await uiPage.locator('body').innerText();
  check('inspector shows the deterministic structured view', structureView.includes('Deterministic local layout:')
    && structureView.includes('UI upload paragraph one')
    && structureView.includes('Plain text'));
  await uiPage.locator('tr', { hasText: 'phase4-fixture.docx' }).click();
  await uiPage.click('button:has-text("Structure")');
  await uiPage.waitForSelector('text=Renderer-derived physical pages:', { timeout: 30000 });
  const docxStructureView = await uiPage.locator('body').innerText();
  check('inspector labels renderer-derived physical pages without claiming Word verification', docxStructureView.includes('Renderer-derived physical pages: 2')
    && docxStructureView.includes('not verified against Microsoft Word')
    && docxStructureView.includes('Physical page'));

  await uiPage.locator('tr', { hasText: 'phase4-image.docx' }).click();
  await uiPage.click('button:has-text("Structure")');
  await uiPage.waitForSelector('text=Alt: E2E image alt', { timeout: 30000 });
  const imageStructureView = await uiPage.locator('body').innerText();
  check('inspector shows image count, dimensions, alt text, caption, and page association', imageStructureView.includes('1 image')
    && imageStructureView.includes('144×108 pt')
    && imageStructureView.includes('Alt: E2E image alt')
    && imageStructureView.includes('Caption: Figure 1. E2E caption')
    && imageStructureView.includes('Physical page 1'));

  await uiPage.locator('tr', { hasText: 'ui-progress.pdf' }).click();
  await uiPage.click('button:has-text("Preview")');
  await uiPage.waitForSelector('text=Page 1 of 250', { timeout: 30000 });
  check('inspector shows the extracted page count', (await uiPage.locator('body').innerText()).includes('Page 1 of 250'));

  await uiPage.locator('tr', { hasText: 'phase4-scanned.pdf' }).click();
  await uiPage.waitForSelector('text=Retry local OCR', { timeout: 30000 });
  const scannedInspector = await uiPage.locator('body').innerText();
  check(
    'inspector shows the failed OCR state without fabricated text',
    scannedInspector.includes('OCR failed') && scannedInspector.includes('Retry local OCR'),
  );

  await uiPage.click('button:has-text("Upload document")');
  await uiPage.waitForSelector('.ff-dropzone');
  await uiPage.locator('input[type=file]').setInputFiles(uiFile);
  await uiPage.click('button:has-text("Upload and extract")');
  await uiPage.waitForSelector('text=Duplicate · existing document kept', { timeout: 120000 });
  const duplicateDialog = await uiPage.locator('body').innerText();
  check('dashboard shows the existing document name for a duplicate', duplicateDialog.includes('Existing vault document: ui-upload.txt'));
  await uiPage.click('button:has-text("Close")');

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
