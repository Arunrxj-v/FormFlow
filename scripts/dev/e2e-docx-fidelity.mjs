import { chromium } from 'playwright';
import { strToU8, zipSync } from 'fflate';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('extension/dist');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'ff-docx-fidelity-'));
const executablePath = process.env.CHROME_PATH;
const passphrase = 'docx-fidelity-passphrase';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);
let context;
let failures = 0;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${String(detail).slice(0, 500)}` : ''}`);
  if (!condition) failures += 1;
};

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function paragraph(text, options = {}) {
  const runs = options.runs
    ? options.runs.map((run) => `<w:r><w:rPr><w:rFonts w:ascii="${run.font}" w:hAnsi="${run.font}"/><w:sz w:val="${run.size * 2}"/><w:szCs w:val="${run.size * 2}"/>${run.bold ? '<w:b/>' : ''}${run.italic ? '<w:i/>' : ''}</w:rPr><w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`).join('')
    : `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="${(options.size ?? 11) * 2}"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>${runs}</w:p>`;
}

function picture(relationshipId, index, alt = '') {
  return `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="1828800" cy="1371600"/><wp:docPr id="${index}" name="image${index}" descr="${escapeXml(alt)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${index}" name="image${index}.png" descr="${escapeXml(alt)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

function packageDocx({ documentXml, relationships = '', media = {}, headers = {}, footers = {}, contentOverrides = '' }) {
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${contentOverrides}</Types>`),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${relationships}</Relationships>`),
    'word/styles.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/></w:style></w:styles>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${documentXml}</w:body></w:document>`),
  };
  for (const [name, bytes] of Object.entries(media)) files[`word/media/${name}`] = bytes;
  for (const [name, entry] of Object.entries(headers)) {
    files[`word/${name}`] = strToU8(entry.xml);
    files[`word/_rels/${name}.rels`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entry.relationships}</Relationships>`);
  }
  for (const [name, entry] of Object.entries(footers)) {
    files[`word/${name}`] = strToU8(entry.xml);
    files[`word/_rels/${name}.rels`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entry.relationships}</Relationships>`);
  }
  return zipSync(files);
}

function nestedTableDocx() {
  const inner = (row) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc>${paragraph(`Inner ${row}A`, { size: 10 })}</w:tc><w:tc>${paragraph(`Inner ${row}B`, { size: 10 })}</w:tc></w:tr><w:tr><w:tc>${paragraph(`Inner ${row}C`, { size: 10 })}</w:tc><w:tc>${paragraph(`Inner ${row}D`, { size: 10 })}</w:tc></w:tr></w:tbl>`;
  const rows = Array.from({ length: 18 }, (_, row) => `<w:tr><w:tc>${paragraph(`Outer ${row + 1}.1`, { size: 10 })}${inner(row + 1)}</w:tc><w:tc>${paragraph(`Outer ${row + 1}.2`, { size: 10 })}</w:tc></w:tr>`).join('');
  const documentXml = `${paragraph('Nested table introduction')}<w:tbl>${rows}</w:tbl>${paragraph('Nested table conclusion')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;
  return packageDocx({ documentXml });
}

function mixedFontDocx() {
  const body = Array.from({ length: 40 }, (_, index) => paragraph('', {
    runs: [
      { text: `Calibri ${index + 1} `, font: 'Calibri', size: 11 },
      { text: 'Arial segment ', font: 'Arial', size: 10, bold: true },
      { text: 'Times segment with deterministic text.', font: 'Times New Roman', size: 13, italic: true },
    ],
  })).join('');
  return packageDocx({ documentXml: `${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` });
}

function tableImageDocx() {
  const nested = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc><w:p><w:r>${picture('rIdCell3', 3, 'Nested image')}</w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Nested text</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/>`;
  const table = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4320"/><w:gridCol w:w="4320"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Cell one</w:t></w:r></w:p><w:p><w:r>${picture('rIdCell1', 1, 'Table cell one image')}</w:r></w:p><w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>Figure 5. Table image caption</w:t></w:r></w:p>${nested}</w:tc><w:tc><w:p><w:r><w:t>Cell two</w:t></w:r></w:p><w:p><w:r>${picture('rIdCell2', 2, 'Table cell two image')}</w:r></w:p></w:tc></w:tr></w:tbl>`;
  return packageDocx({
    documentXml: `${paragraph('Table image introduction')}${table}${paragraph('Table image conclusion')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`,
    relationships: '<Relationship Id="rIdCell1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/cell1.png"/><Relationship Id="rIdCell2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/cell2.png"/><Relationship Id="rIdCell3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/cell3.png"/>',
    media: { 'cell1.png': PNG, 'cell2.png': PNG, 'cell3.png': PNG },
  });
}

function headerFooterImageDocx(options = {}) {
  const variant = options.variant ?? 'default';
  const body = Array.from({ length: 80 }, (_, index) => paragraph(`Header/footer body paragraph ${index + 1} with deterministic text.`)).join('');
  const header = `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p><w:r><w:t>Header text</w:t></w:r></w:p><w:p><w:r>${picture('rIdHeaderImage', 1, 'Header logo')}</w:r></w:p></w:hdr>`;
  const footer = `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p><w:r><w:t>Footer text</w:t></w:r></w:p><w:p><w:r>${picture('rIdFooterImage', 2, 'Footer logo')}</w:r></w:p></w:ftr>`;
  const section = (extra = '') => `<w:sectPr>${extra}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;
  const furnitureReference = `<w:headerReference w:type="${variant}" r:id="rIdHeader"/><w:footerReference w:type="${variant}" r:id="rIdFooter"/>${variant === 'first' ? '<w:titlePg/>' : ''}`;
  return packageDocx({
    documentXml: `${body}${section(furnitureReference)}<w:p><w:r><w:t>Inherited section</w:t></w:r></w:p>${section()}`, 
    relationships: '<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
    headers: {
      'header1.xml': {
        xml: header,
        relationships: '<Relationship Id="rIdHeaderImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/header.png"/>',
      },
    },
    footers: {
      'footer1.xml': {
        xml: footer,
        relationships: '<Relationship Id="rIdFooterImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/footer.png"/>',
      },
    },
    media: { 'header.png': PNG, 'footer.png': PNG },
    contentOverrides: '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>',
  });
}

const message = (page, requestId, operation, payload = {}) => page.evaluate(({ request }) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 120000);
  chrome.runtime.sendMessage(request, (response) => { clearTimeout(timer); resolve(response); });
}), { request: { protocol: 1, requestId, operation, payload } });

async function importDocx(page, id, name, bytes) {
  const imported = await message(page, id, 'IMPORT_DOCUMENT', {
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: Buffer.from(bytes).toString('base64'),
    importId: id,
  });
  if (!imported?.ok) return { imported, structure: null };
  const text = await message(page, `${id}_text`, 'GET_DOCUMENT_TEXT', { documentId: imported.data.document.id });
  return { imported, structure: text?.data?.structure };
}

try {
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-proxy-server', '--no-first-run'],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`chrome-extension://${extensionId}/dashboard.html#/setup`, { waitUntil: 'load' });
  await page.waitForSelector('input[placeholder="e.g. Personal applications"]');
  await page.fill('input[placeholder="e.g. Personal applications"]', 'DOCX fidelity vault');
  await page.locator('input[type=password]').nth(0).fill(passphrase);
  await page.locator('input[type=password]').nth(1).fill(passphrase);
  await page.click('button:has-text("Create encrypted vault")');
  await page.waitForURL(/#\/dashboard$/);
  await page.waitForTimeout(400);

  const nested = await importDocx(page, 'fidelity_nested', 'fidelity-nested.docx', nestedTableDocx());
  check('nested-table DOCX imports with renderer-derived physical pages', nested.imported?.ok === true
    && nested.structure?.pagination?.status === 'renderer_derived_physical', JSON.stringify(nested.imported));
  const nestedTable = nested.structure?.blocks.find((block) => block.type === 'table');
  const nestedMapping = nested.structure?.pagination?.blockPages.find((entry) => entry.blockId === nestedTable?.blockId);
  check('nested-table fixture resolves to two physical pages with a spanning table', nested.structure?.pagination?.pageCount === 2
    && nestedMapping?.startPageNumber === 1
    && nestedMapping?.endPageNumber === 2
    && (nested.structure?.pagination?.geometry?.cellCount ?? 0) > 0, JSON.stringify({ pages: nested.structure?.pagination?.pageCount, mapping: nestedMapping, geometry: nested.structure?.pagination?.geometry }));

  const mixed = await importDocx(page, 'fidelity_mixed', 'fidelity-mixed.docx', mixedFontDocx());
  const mixedBlocks = mixed.structure?.blocks.filter((block) => block.type === 'paragraph') ?? [];
  const mixedPage2 = mixed.structure?.pagination?.pages.find((entry) => entry.pageNumber === 2);
  check('mixed-font fixture resolves to two physical pages with run-level line metrics', mixed.structure?.pagination?.pageCount === 2
    && mixedBlocks.length === 40
    && (mixedPage2?.blockIds.length ?? 0) === 2, JSON.stringify({ pages: mixed.structure?.pagination?.pageCount, blocks: mixedBlocks.length, page2: mixedPage2?.blockIds.length }));
  check('mixed-font pagination does not claim verified physical output', mixed.structure?.pagination?.status === 'renderer_derived_physical');

  const tableImages = await importDocx(page, 'fidelity_table_images', 'fidelity-table-images.docx', tableImageDocx());
  const tableImageBlocks = tableImages.structure?.blocks.filter((block) => block.type === 'image') ?? [];
  check('table images import as three child image placements with exact page boxes', tableImages.imported?.ok === true
    && tableImageBlocks.length === 3
    && tableImageBlocks.every((block) => block.image?.parentCellBlockId && block.image?.parentTableBlockId && block.image?.parentRowBlockId)
    && tableImageBlocks.every((block) => block.image?.appearances?.length === 1)
    && tableImageBlocks.every((block) => tableImages.structure?.pagination?.blockPages.some((entry) => entry.blockId === block.blockId && entry.geometryConfidence === 'exact')), JSON.stringify(tableImageBlocks.map((block) => ({ id: block.blockId, image: block.image }))));
  const nestedImage = tableImageBlocks.find((block) => block.image?.nestedTableDepth === 1);
  check('nested-table cell image retains its nested depth without a duplicate source block', Boolean(nestedImage)
    && tableImageBlocks.filter((block) => block.image?.mediaPart === nestedImage?.image?.mediaPart).length === 1, JSON.stringify(nestedImage?.image));
  check('table-cell image caption is linked without a plaintext image payload', tableImageBlocks.some((block) => block.image?.captionText === 'Figure 5. Table image caption')
    && !JSON.stringify(tableImages.structure).includes('iVBORw0KGgo'));

  const furniture = await importDocx(page, 'fidelity_furniture', 'fidelity-header-footer.docx', headerFooterImageDocx());
  const furnitureImages = furniture.structure?.blocks.filter((block) => block.type === 'image') ?? [];
  const headerImage = furnitureImages.find((block) => block.image?.headerFooter?.kind === 'header');
  const footerImage = furnitureImages.find((block) => block.image?.headerFooter?.kind === 'footer');
  check('header/footer images are two source placements, not one block per page', furnitureImages.length === 2
    && Boolean(headerImage) && Boolean(footerImage), JSON.stringify(furnitureImages.map((block) => ({ id: block.blockId, headerFooter: block.image?.headerFooter, appearances: block.image?.appearances?.length }))));
  check('header/footer source placements retain defining and inherited sections', headerImage?.image?.headerFooter?.definingSectionIndex === 0
    && (headerImage?.image?.headerFooter?.inheritedSectionIndexes ?? []).includes(1)
    && footerImage?.image?.headerFooter?.definingSectionIndex === 0
    && (footerImage?.image?.headerFooter?.inheritedSectionIndexes ?? []).includes(1));
  check('inherited header/footer images repeat as physical-page appearances', (headerImage?.image?.appearances?.length ?? 0) >= 2
    && (footerImage?.image?.appearances?.length ?? 0) >= 2
    && (headerImage?.image?.appearances?.length ?? 0) === furniture.structure?.pagination?.pageCount, JSON.stringify({ pages: furniture.structure?.pagination?.pageCount, header: headerImage?.image?.appearances?.length, footer: footerImage?.image?.appearances?.length }));
  check('header/footer image boxes use page coordinates', headerImage?.image?.appearances?.every((appearance) => appearance.box?.coordinateSpace === 'renderer_page_points') === true);

  const firstPage = await importDocx(page, 'fidelity_first_header', 'fidelity-first-header.docx', headerFooterImageDocx({ variant: 'first' }));
  const firstPageImages = firstPage.structure?.blocks.filter((block) => block.type === 'image') ?? [];
  check('first-page header/footer images keep the first variant and only first-page appearances', firstPageImages.length === 2
    && firstPageImages.every((block) => block.image?.headerFooter?.variant === 'first')
    && firstPageImages.every((block) => block.image?.appearances?.length === 1 && block.image.appearances[0]?.pageNumber === 1), JSON.stringify(firstPageImages.map((block) => ({ variant: block.image?.headerFooter?.variant, appearances: block.image?.appearances }))));

  const uiPage = await context.newPage();
  await uiPage.goto(`chrome-extension://${extensionId}/dashboard.html#/documents`, { waitUntil: 'load' });
  await uiPage.waitForSelector('button:has-text("Upload document")');
  await uiPage.waitForSelector('tr:has-text("fidelity-table-images.docx")', { timeout: 30000 });
  await uiPage.locator('tr', { hasText: 'fidelity-table-images.docx' }).click();
  await uiPage.click('button:has-text("Structure")');
  await uiPage.waitForSelector('text=Table cell · row 1, column 1', { timeout: 30000 });
  const tableUi = await uiPage.locator('body').innerText();
  check('structure inspector shows table-cell image dimensions, alt text, caption, and page', tableUi.includes('Table cell · row 1, column 1')
    && tableUi.includes('144×108 pt')
    && tableUi.includes('Table cell one image')
    && tableUi.includes('Figure 5. Table image caption')
    && tableUi.includes('Physical page 1'));

  await uiPage.locator('tr', { hasText: 'fidelity-header-footer.docx' }).click();
  await uiPage.click('button:has-text("Structure")');
  await uiPage.waitForSelector('text=Header · default variant', { timeout: 30000 });
  const furnitureUi = await uiPage.locator('body').innerText();
  check('structure inspector shows header/footer type, defining section, inheritance, and appearances', furnitureUi.includes('Header · default variant · defined by section 0')
    && furnitureUi.includes('inherited by section 1')
    && furnitureUi.includes('Footer · default variant · defined by section 0')
    && furnitureUi.includes('appearances'));
  check('inherited header images are not duplicated in the outline', (furnitureUi.match(/Header · default variant/g) ?? []).length === 1);
  check('no page errors during DOCX fidelity suite', errors.length === 0, JSON.stringify(errors));

  console.log(`FAILURES: ${failures}`);
  process.exitCode = failures ? 1 : 0;
} finally {
  if (context) await context.close().catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true });
}
