import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocx,
  buildDocxWithEmbeddedFont,
  buildDocxWithHeaderFooterImage,
  buildDocxWithImage,
  buildDocxWithSections,
  buildDocxWithTableImage,
  buildPdf,
  toArrayBuffer,
} from '../helpers/document-fixtures';
import { validateDocumentStructure } from '../../shared/document-structure';
import { buildOcrPageStructure } from '../../core/documents/ocr-structure';
import { structureToPlainText } from '../../shared/document-structure';

const { parseDocument } = await import('../../core/documents/parsers');

function parse(bytes: Uint8Array, format: 'pdf' | 'docx', fileName: string) {
  return parseDocument({ format, bytes: toArrayBuffer(bytes), fileName });
}

function blockById(structure: ReturnType<typeof validateDocumentStructure>, blockId: string) {
  return structure.blocks.find((block) => block.blockId === blockId);
}

test('PDF structure preserves headings, paragraphs, lists, and a positioned table', async () => {
  const bytes = buildPdf({
    pages: [{
      textItems: [
        { text: 'Professional Summary', x: 72, y: 720, fontSize: 22, bold: true },
        { text: 'A deterministic paragraph line one.', x: 72, y: 680, fontSize: 12 },
        { text: 'A deterministic paragraph line two.', x: 72, y: 664, fontSize: 12 },
        { text: '1. First numbered item', x: 72, y: 628, fontSize: 12 },
        { text: '2. Second numbered item', x: 72, y: 612, fontSize: 12 },
        { text: 'Field', x: 72, y: 560, fontSize: 12, bold: true },
        { text: 'Value', x: 220, y: 560, fontSize: 12, bold: true },
        { text: 'Degree', x: 72, y: 540, fontSize: 12 },
        { text: 'B.Tech', x: 220, y: 540, fontSize: 12 },
        { text: 'Year', x: 72, y: 520, fontSize: 12 },
        { text: '2026', x: 220, y: 520, fontSize: 12 },
      ],
    }],
  });
  const result = await parse(bytes, 'pdf', 'structured.pdf');
  assert.ok(result.structure);
  const structure = validateDocumentStructure(result.structure);
  assert.equal(structure.documentFormat, 'pdf');
  assert.equal(structure.pageSemantics, 'physical');
  assert.equal(structure.pages[0]!.pageKind, 'physical');
  assert.ok(structure.pages[0]!.pageBounds?.width);
  assert.ok(structure.blocks.some((block) => block.type === 'heading' && block.text.includes('Professional Summary')));
  assert.ok(structure.blocks.some((block) => block.type === 'paragraph' && block.text.includes('deterministic paragraph')));
  assert.ok(structure.blocks.some((block) => block.type === 'list'));
  assert.equal(structure.blocks.filter((block) => block.type === 'list_item').length, 2);
  assert.equal(structure.tables.length, 1);
  assert.ok(structure.tables[0]!.rowCount >= 3);
  assert.ok(structure.tables[0]!.columnCount >= 2);
  assert.ok(structure.blocks.some((block) => block.type === 'table_cell' && block.text === 'B.Tech'));
  assert.ok(structure.blocks.every((block) => block.boundingBox?.coordinateSpace === 'pdf_page_points' || block.type === 'table'));
  assert.match(structureToPlainText(structure), /Professional Summary/);
});

test('PDF reading order puts a two-column page left column before right column', async () => {
  const left = [
    'LEFT HEADING', 'LEFT one', 'LEFT two', 'LEFT three', 'LEFT four', 'LEFT five',
  ];
  const right = [
    'RIGHT HEADING', 'RIGHT one', 'RIGHT two', 'RIGHT three', 'RIGHT four', 'RIGHT five',
  ];
  const textItems = [];
  for (let index = 0; index < left.length; index += 1) {
    textItems.push({
      text: left[index]!,
      x: 72,
      y: 720 - index * 24,
      fontSize: index === 0 ? 18 : 11,
      bold: index === 0,
    });
    textItems.push({
      text: right[index]!,
      x: 330,
      y: 720 - index * 24,
      fontSize: index === 0 ? 18 : 11,
      bold: index === 0,
    });
  }
  const result = await parse(buildPdf({ pages: [{ textItems }] }), 'pdf', 'two-column.pdf');
  const structure = validateDocumentStructure(result.structure);
  const orderedText = structure.readingOrder
    .map((blockId) => blockById(structure, blockId)?.text ?? '')
    .join('\n');
  assert.ok(orderedText.indexOf('LEFT one') < orderedText.indexOf('RIGHT one'));
  assert.ok(orderedText.indexOf('LEFT five') < orderedText.indexOf('RIGHT one'));
  assert.ok(structure.blocks.some((block) => block.type === 'paragraph' && block.text.includes('LEFT one')));
});

test('PDF nested lists preserve item order and indentation levels', async () => {
  const result = await parse(buildPdf({
    pages: [{
      textItems: [
        { text: '1. Parent item', x: 72, y: 700, fontSize: 12 },
        { text: 'a. Nested child item', x: 100, y: 682, fontSize: 12 },
        { text: '2. Second parent item', x: 72, y: 664, fontSize: 12 },
      ],
    }],
  }), 'pdf', 'nested-list.pdf');
  const structure = validateDocumentStructure(result.structure);
  const items = structure.blocks.filter((block) => block.type === 'list_item');
  assert.deepEqual(items.map((block) => block.level), [1, 2, 1]);
  assert.deepEqual(items.map((block) => block.text), ['Parent item', 'Nested child item', 'Second parent item']);
});

test('PDF reading order supports a three-column report', async () => {
  const columns = [
    { x: 72, prefix: 'LEFT' },
    { x: 250, prefix: 'MID' },
    { x: 430, prefix: 'RIGHT' },
  ];
  const textItems = [];
  for (const column of columns) {
    for (let index = 1; index <= 5; index += 1) {
      textItems.push({
        text: `${column.prefix}-${index} report line`,
        x: column.x,
        y: 720 - index * 22,
        fontSize: 11,
      });
    }
  }
  const result = await parse(buildPdf({ pages: [{ textItems }] }), 'pdf', 'three-column.pdf');
  const structure = validateDocumentStructure(result.structure);
  const orderedText = structure.readingOrder
    .map((blockId) => blockById(structure, blockId)?.text ?? '')
    .join('\n');
  assert.ok(orderedText.indexOf('LEFT-5') < orderedText.indexOf('MID-1'));
  assert.ok(orderedText.indexOf('MID-5') < orderedText.indexOf('RIGHT-1'));
});

test('PDF structure remains bounded on a representative multi-page report', async () => {
  const pages = Array.from({ length: 40 }, (_, pageIndex) => ({
    textItems: [
      { text: `Report section ${pageIndex + 1}`, x: 72, y: 720, fontSize: 18, bold: true },
      { text: 'Representative paragraph line one for layout measurement.', x: 72, y: 680, fontSize: 11 },
      { text: 'Representative paragraph line two for layout measurement.', x: 72, y: 664, fontSize: 11 },
      { text: '1. First list item', x: 72, y: 628, fontSize: 11 },
      { text: '2. Second list item', x: 72, y: 612, fontSize: 11 },
      { text: 'Field', x: 72, y: 560, fontSize: 11, bold: true },
      { text: 'Value', x: 220, y: 560, fontSize: 11, bold: true },
      { text: 'Example', x: 72, y: 540, fontSize: 11 },
      { text: 'Bounded', x: 220, y: 540, fontSize: 11 },
    ],
  }));
  const bytes = buildPdf({ pages });
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = await parse(bytes, 'pdf', 'representative.pdf');
  const durationMs = Math.round(performance.now() - started);
  const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - before);
  const structure = validateDocumentStructure(result.structure);
  console.log('STRUCTURE_PERF', JSON.stringify({ pages: structure.pages.length, blocks: structure.blocks.length, durationMs, heapDeltaBytes }));
  assert.equal(structure.pages.length, 40);
  assert.ok(structure.blocks.length > 0);
  assert.ok(structure.metadata.blockCount === structure.blocks.length);
});

test('PDF repeated headers and footers are marked as margin blocks', async () => {
  const page = (marker: string) => ({
    textItems: [
      { text: 'Repeated Confidential Header', x: 72, y: 760, fontSize: 10 },
      { text: `${marker} body line one`, x: 72, y: 700, fontSize: 12 },
      { text: `${marker} body line two`, x: 72, y: 684, fontSize: 12 },
      { text: 'Repeated Footer 1', x: 72, y: 40, fontSize: 10 },
    ],
  });
  const result = await parse(buildPdf({ pages: [page('PAGE ONE'), page('PAGE TWO')] }), 'pdf', 'margins.pdf');
  const structure = validateDocumentStructure(result.structure);
  assert.equal(structure.pages.length, 2);
  assert.ok(structure.blocks.some((block) => block.type === 'header' && block.text.includes('Repeated Confidential Header')));
  assert.ok(structure.blocks.some((block) => block.type === 'footer' && block.text.includes('Repeated Footer')));
  assert.ok(structure.pages.every((pageItem) => pageItem.blockIds.length > 0));
});

test('PDF page breaks and rotated pages retain physical page references', async () => {
  const result = await parse(buildPdf({
    pages: [
      { textItems: [{ text: 'First physical page marker', x: 72, y: 720, fontSize: 14 }] },
      { textItems: [{ text: 'Rotated page marker', x: 72, y: 720, fontSize: 14 }], rotate: 90 },
    ],
  }), 'pdf', 'pages.pdf');
  const structure = validateDocumentStructure(result.structure);
  assert.equal(structure.pages.length, 2);
  assert.deepEqual(structure.pages.map((page) => page.pageNumber), [1, 2]);
  for (const block of structure.blocks) {
    assert.ok(block.pageNumber >= 1 && block.pageNumber <= 2);
  }
  assert.ok(structure.blocks.some((block) => block.pageNumber === 2 && block.text.includes('Rotated page marker')));
});

test('PDF uncertain multi-column reading order reports a warning instead of a confident sequence', async () => {
  const textItems = [
    { text: 'Left column first', x: 72, y: 720, fontSize: 11 },
    { text: 'Right column first', x: 330, y: 720, fontSize: 11 },
    { text: 'Left column second', x: 72, y: 700, fontSize: 11 },
    { text: 'Right column second', x: 330, y: 700, fontSize: 11 },
    { text: 'Left column third', x: 72, y: 680, fontSize: 11 },
    { text: 'Right column third', x: 330, y: 680, fontSize: 11 },
    { text: 'A full-width section heading in the middle of columns', x: 72, y: 640, fontSize: 16, bold: true },
    { text: 'Left column fourth', x: 72, y: 600, fontSize: 11 },
    { text: 'Right column fourth', x: 330, y: 600, fontSize: 11 },
    { text: 'Left column fifth', x: 72, y: 580, fontSize: 11 },
    { text: 'Right column fifth', x: 330, y: 580, fontSize: 11 },
  ];
  const result = await parse(buildPdf({ pages: [{ textItems }] }), 'pdf', 'uncertain.pdf');
  const structure = validateDocumentStructure(result.structure);
  assert.ok(structure.warnings.some((warning) => warning.code === 'READING_ORDER_UNCERTAIN'));
});

test('DOCX structure preserves heading hierarchy, nested lists, tables, merges, hyperlinks, and margins', async () => {
  const bytes = buildDocx({
    paragraphs: [
      { text: 'Resume', heading: 1 },
      { text: 'Education', heading: 2 },
      { text: 'Degree paragraph' },
      { text: 'First nested list item', list: { level: 0, ordered: true } },
      { text: 'Nested child item', list: { level: 1 } },
      { text: 'Hyperlink text', hyperlink: true },
    ],
    tables: [[
      [{ text: 'Merged heading', colSpan: 2 }],
      [{ text: 'Field' }, { text: 'Value' }],
      [{ text: 'Degree', vMerge: 'restart' }, { text: 'B.Tech' }],
      [{ text: '', vMerge: 'continue' }, { text: '2026' }],
    ]],
    headers: ['Document header'],
    footers: ['Document footer'],
  });
  const result = await parse(bytes, 'docx', 'structured.docx');
  assert.ok(result.structure);
  const structure = validateDocumentStructure(result.structure);
  assert.equal(structure.pageSemantics, 'logical');
  assert.equal(structure.pages[0]!.pageKind, 'logical');
  assert.equal(structure.pages[0]!.extractionMethod, 'docx_xml');
  assert.ok(structure.sections.some((section) => section.title === 'Resume' && section.level === 1));
  assert.ok(structure.sections.some((section) => section.title === 'Education' && section.level === 2));
  assert.equal(structure.blocks.filter((block) => block.type === 'list_item').length, 2);
  assert.ok(structure.blocks.some((block) => block.type === 'list_item' && block.level === 2));
  assert.ok(structure.blocks.some((block) => block.type === 'table_cell' && block.columnSpan === 2));
  assert.ok(structure.blocks.some((block) => block.type === 'table_cell' && block.rowSpan === 2));
  assert.ok(structure.blocks.some((block) => block.style?.hyperlink === true));
  assert.ok(structure.blocks.some((block) => block.type === 'header'));
  assert.ok(structure.blocks.some((block) => block.type === 'footer'));
  assert.ok(structure.warnings.some((warning) => warning.code === 'DOCX_MERGED_CELLS_RECONSTRUCTED'));
  assert.ok(structure.warnings.some((warning) => warning.code === 'DOCX_HEADERS_FOOTERS_APPROXIMATE'));
});

test('DOCX section metadata records explicit, first-page, even, and inherited headers without duplicating content', async () => {
  const bytes = buildDocxWithSections({
    evenAndOddHeaders: true,
    sections: [
      {
        titlePage: true,
        pageNumberStart: 1,
        headers: {
          default: ['Section one header'],
          first: ['First page header'],
          even: ['Even page header'],
        },
        footers: { default: ['Section one footer'] },
        paragraphs: [{ text: 'Section one body' }],
      },
      {
        breakType: 'nextPage',
        pageSize: { widthTwips: 15840, heightTwips: 12240, orientation: 'landscape' },
        margins: { top: 720, right: 720, bottom: 720, left: 1080 },
        pageNumberStart: 5,
        pageNumberFormat: 'lowerRoman',
        columns: 2,
        paragraphs: [{ text: 'Section two body' }],
      },
      {
        headers: { default: ['Section three header'] },
        paragraphs: [{ text: 'Section three body' }],
      },
    ],
  });
  const result = await parse(bytes, 'docx', 'sectioned.docx');
  assert.ok(result.structure);
  const structure = validateDocumentStructure(result.structure);
  const layout = structure.docxLayout;
  assert.ok(layout);
  assert.equal(layout.evenAndOddHeaders, true);
  assert.equal(layout.sections.length, 3);

  const first = layout.sections[0]!;
  assert.equal(first.headers.length, 3);
  assert.deepEqual(first.headers.map((reference) => reference.variant), ['default', 'first', 'even']);
  assert.ok(first.headers.every((reference) => reference.inherited === false && reference.definingSectionIndex === 0));
  assert.ok(first.headers.every((reference) => reference.partName && reference.blockIds.length === 1));
  assert.equal(first.titlePage, true);
  assert.equal(first.footers.length, 1);

  const second = layout.sections[1]!;
  assert.equal(second.orientation, 'landscape');
  assert.equal(second.pageWidthPt, 792);
  assert.equal(second.pageHeightPt, 612);
  assert.equal(second.margins.topPt, 36);
  assert.equal(second.margins.leftPt, 54);
  assert.equal(second.pageNumberStart, 5);
  assert.equal(second.pageNumberFormat, 'lowerRoman');
  assert.equal(second.columnCount, 2);
  assert.equal(second.columns?.count, 2);
  assert.equal(second.columns?.equalWidth, true);
  assert.equal(second.columns?.separator, false);
  assert.equal(second.columns?.gapPt, 36);
  assert.equal(second.headers.length, 3);
  assert.ok(second.headers.every((reference) => reference.inherited === true && reference.definingSectionIndex === 0));
  assert.ok(second.headers.every((reference) => reference.blockIds.length === 1));
  assert.deepEqual(
    second.headers.map((reference) => reference.blockIds[0]),
    first.headers.map((reference) => reference.blockIds[0]),
  );

  const third = layout.sections[2]!;
  assert.equal(third.headers.length, 3);
  assert.equal(third.headers.find((reference) => reference.variant === 'default')?.inherited, false);
  assert.equal(third.headers.find((reference) => reference.variant === 'default')?.definingSectionIndex, 2);
  assert.equal(third.headers.find((reference) => reference.variant === 'first')?.inherited, true);
  assert.equal(third.headers.find((reference) => reference.variant === 'first')?.definingSectionIndex, 0);

  const headerBlocks = structure.blocks.filter((block) => block.type === 'header');
  assert.deepEqual(headerBlocks.map((block) => block.text).sort(), [
    'Even page header',
    'First page header',
    'Section one header',
    'Section three header',
  ]);
  assert.ok(headerBlocks.every((block) => block.sourceRef?.startsWith('docx:header:header')));
  assert.equal(structure.blocks.filter((block) => block.type === 'footer').length, 1);
  assert.ok(structure.warnings.some((warning) => warning.code === 'DOCX_HEADERS_FOOTERS_SECTION_AWARE'));
  assert.ok(!structure.warnings.some((warning) => warning.code === 'DOCX_HEADERS_FOOTERS_APPROXIMATE'));
});

test('DOCX inline image blocks preserve relationship, MIME, dimensions, alt text, and captions', async () => {
  const result = await parse(buildDocxWithImage({
    alt: 'A sample chart',
    title: 'Chart title',
    caption: 'Figure 1. Sample chart caption',
  }), 'docx', 'image-inline.docx');
  const structure = validateDocumentStructure(result.structure);
  const image = structure.blocks.find((block) => block.type === 'image');
  assert.ok(image?.image);
  assert.equal(image.image.relationshipId, 'rIdImg1');
  assert.equal(image.image.sourcePart, 'word/document.xml');
  assert.equal(image.image.mediaPart, 'word/media/image1.png');
  assert.equal(image.image.mimeType, 'image/png');
  assert.equal(image.image.originalWidthPx, 1);
  assert.equal(image.image.originalHeightPx, 1);
  assert.equal(image.image.displayWidthPt, 144);
  assert.equal(image.image.displayHeightPt, 108);
  assert.equal(image.image.positioning, 'inline');
  assert.equal(image.image.wrap, 'inline');
  assert.equal(image.image.alternativeText, 'A sample chart');
  assert.equal(image.image.title, 'Chart title');
  assert.equal(image.image.captionText, 'Figure 1. Sample chart caption');
  assert.ok(image.image!.captionBlockId);
  assert.ok(structure.pages[0]!.blockIds.includes(image.blockId));
  assert.equal(structure.blocks.find((block) => block.blockId === image.image!.captionBlockId)?.text, 'Figure 1. Sample chart caption');
});

test('DOCX anchored images preserve positioning and wrap metadata', async () => {
  const result = await parse(buildDocxWithImage({ anchored: true, wrap: 'square', alt: 'Floating logo' }), 'docx', 'image-anchored.docx');
  const structure = validateDocumentStructure(result.structure);
  const image = structure.blocks.find((block) => block.type === 'image');
  assert.equal(image?.image?.positioning, 'anchored');
  assert.equal(image?.image?.wrap, 'square');
});

test('DOCX image failures are preserved as explicit warnings without failing ingestion', async () => {
  const cases = [
    { options: { missingRelationship: true }, code: 'DOCX_IMAGE_RELATIONSHIP_MISSING' },
    { options: { missingMedia: true }, code: 'DOCX_IMAGE_MISSING' },
    { options: { external: true }, code: 'DOCX_IMAGE_EXTERNAL_LINK' },
    { options: { invalidSignature: true }, code: 'DOCX_IMAGE_INVALID_SIGNATURE' },
    { options: { oversizedDimensions: true }, code: 'DOCX_IMAGE_DIMENSIONS_REJECTED' },
  ];
  for (const item of cases) {
    const result = await parse(buildDocxWithImage(item.options), 'docx', `image-${item.code}.docx`);
    const structure = validateDocumentStructure(result.structure);
    const image = structure.blocks.find((block) => block.type === 'image');
    assert.ok(image, item.code);
    assert.ok(image.image?.warnings.some((warning) => warning.code === item.code), `${item.code}: ${JSON.stringify(image.image?.warnings)}`);
    assert.ok(!result.text.includes('image'), 'image content must not be fabricated as text');
  }
});

test('image-only DOCX keeps an image structure with an empty text body', async () => {
  const result = await parse(buildDocxWithImage({ alt: 'Image-only alt' }), 'docx', 'image-only.docx');
  assert.equal(result.text, '');
  assert.equal(result.pageCount, 1);
  const structure = validateDocumentStructure(result.structure);
  const image = structure.blocks.find((block) => block.type === 'image');
  assert.ok(image);
  assert.equal(image.image?.alternativeText, 'Image-only alt');
  assert.equal(structure.readingOrder[0], image.blockId);
});

test('DOCX multiple images produce distinct stable image blocks', async () => {
  const result = await parse(buildDocxWithImage({ images: 3, alt: 'Repeated image', caption: 'Figure caption' }), 'docx', 'images-three.docx');
  const structure = validateDocumentStructure(result.structure);
  const images = structure.blocks.filter((block) => block.type === 'image');
  assert.equal(images.length, 3);
  assert.equal(new Set(images.map((block) => block.blockId)).size, 3);
  assert.ok(images.every((block) => block.image?.mediaPart));
});

test('DOCX embedded font and theme declarations are recorded with source evidence', async () => {
  const result = await parse(buildDocxWithEmbeddedFont({
    family: 'FormFlow Embedded Test',
    themeMajor: 'Calibri Light',
    themeMinor: 'FormFlow Embedded Test',
  }), 'docx', 'embedded-font.docx');
  const structure = validateDocumentStructure(result.structure);
  assert.equal(structure.docxLayout?.themeFonts?.major, 'Calibri Light');
  assert.equal(structure.docxLayout?.themeFonts?.minor, 'FormFlow Embedded Test');
  const embedded = structure.docxLayout?.embeddedFonts?.find((font) => font.family === 'FormFlow Embedded Test');
  assert.ok(embedded);
  assert.equal(embedded.style, 'regular');
  assert.equal(embedded.partName, 'word/fonts/font1.odttf');
  assert.equal(embedded.relationshipId, 'rIdFont1');
  assert.equal(embedded.status, 'declared');
});

test('DOCX theme fonts are recorded even when no embedded part is present', async () => {
  const result = await parse(buildDocxWithEmbeddedFont({
    embedded: false,
    useTheme: true,
    themeMajor: 'Arial',
    themeMinor: 'Times New Roman',
  }), 'docx', 'theme-fonts.docx');
  const structure = validateDocumentStructure(result.structure);
  assert.equal(structure.docxLayout?.themeFonts?.major, 'Arial');
  assert.equal(structure.docxLayout?.themeFonts?.minor, 'Times New Roman');
  assert.equal(structure.docxLayout?.embeddedFonts, undefined);
});

test('DOCX table-cell images become child image blocks with table, row, and cell references', async () => {
  const result = await parse(buildDocxWithTableImage({
    caption: 'Figure 2. Cell caption',
    nested: true,
    alt: 'Cell image alt',
  }), 'docx', 'table-image.docx');
  const structure = validateDocumentStructure(result.structure);
  const table = structure.blocks.find((block) => block.type === 'table');
  assert.ok(table);
  const rows = (table.children ?? []).map((id) => structure.blocks.find((block) => block.blockId === id)).filter(Boolean);
  assert.ok(rows.length >= 1);
  const cells = (rows[0]!.children ?? []).map((id) => structure.blocks.find((block) => block.blockId === id)).filter(Boolean);
  assert.ok(cells.length >= 2);
  const images = structure.blocks.filter((block) => block.type === 'image');
  assert.equal(images.length, 3);
  assert.equal(new Set(images.map((block) => block.image?.placementId)).size, 3);
  for (const image of images) {
    assert.equal(image.parentId, image.image?.parentCellBlockId);
    assert.equal(image.image?.parentTableBlockId, table.blockId);
    assert.ok(image.image?.parentRowBlockId);
    assert.ok(image.image?.parentCellBlockId);
    assert.equal(image.image?.tableId, table.tableId);
    assert.ok((image.image?.rowIndex ?? -1) >= 0);
    assert.ok((image.image?.columnIndex ?? -1) >= 0);
    const cell = structure.blocks.find((block) => block.blockId === image.image?.parentCellBlockId);
    assert.equal(cell?.type, 'table_cell');
    assert.ok((cell?.children ?? []).includes(image.blockId));
  }
  const outer = images.filter((image) => image.image?.nestedTableDepth === 0);
  const nested = images.filter((image) => image.image?.nestedTableDepth === 1);
  assert.equal(outer.length, 2);
  assert.equal(nested.length, 1);
  assert.ok(outer[0]?.image?.captionText === 'Figure 2. Cell caption'
    || outer[1]?.image?.captionText === 'Figure 2. Cell caption');
  assert.equal(nested[0]?.image?.alternativeText, 'Cell image alt');
});

test('DOCX header and footer images are source placements with inheritance metadata', async () => {
  const result = await parse(buildDocxWithHeaderFooterImage({
    header: true,
    footer: true,
    images: 2,
    inheritedSections: true,
    alt: 'Header logo',
    caption: 'Figure 3. Header caption',
  }), 'docx', 'header-footer-image.docx');
  const structure = validateDocumentStructure(result.structure);
  const images = structure.blocks.filter((block) => block.type === 'image');
  assert.equal(images.length, 4);
  assert.equal(new Set(images.map((block) => block.image?.placementId)).size, 4);
  const headers = images.filter((block) => block.image?.headerFooter?.kind === 'header');
  const footers = images.filter((block) => block.image?.headerFooter?.kind === 'footer');
  assert.equal(headers.length, 2);
  assert.equal(footers.length, 2);
  for (const image of images) {
    assert.equal(image.parentId, undefined);
    assert.equal(image.image?.headerFooter?.variant, 'default');
    assert.equal(image.image?.headerFooter?.definingSectionIndex, 0);
    assert.deepEqual(image.image?.headerFooter?.inheritedSectionIndexes, [1]);
    assert.equal(image.image?.alternativeText, 'Header logo');
  }
  assert.ok(headers[0]?.image?.headerFooter?.partName.startsWith('word/header'));
  assert.ok(footers[0]?.image?.headerFooter?.partName.startsWith('word/footer'));
  assert.ok(headers.some((image) => image.image?.captionText === 'Figure 3. Header caption'));
  const section = structure.docxLayout?.sections[0];
  const headerReference = section?.headers.find((reference) => reference.kind === 'header');
  assert.ok(headerReference?.blockIds.includes(headers[0]!.blockId));
});

test('DOCX first-page and even-page header/footer image variants retain their variant metadata', async () => {
  const first = await parse(buildDocxWithHeaderFooterImage({
    header: true,
    footer: true,
    variant: 'first',
    images: 2,
    alt: 'First-page logo',
  }), 'docx', 'first-page-image.docx');
  const firstStructure = validateDocumentStructure(first.structure);
  const firstImages = firstStructure.blocks.filter((block) => block.type === 'image');
  assert.equal(firstImages.length, 4);
  assert.ok(firstImages.every((block) => block.image?.headerFooter?.variant === 'first'));
  assert.ok(firstStructure.docxLayout?.sections[0]?.titlePage);

  const even = await parse(buildDocxWithHeaderFooterImage({
    header: true,
    variant: 'even',
    images: 1,
  }), 'docx', 'even-page-image.docx');
  const evenStructure = validateDocumentStructure(even.structure);
  const evenImage = evenStructure.blocks.find((block) => block.type === 'image');
  assert.equal(evenImage?.image?.headerFooter?.variant, 'even');
});

test('table-cell image failures are preserved with explicit warnings', async () => {
  for (const options of [{ missingRelationship: true }, { external: true }, { invalidSignature: true }]) {
    const result = await parse(buildDocxWithTableImage(options), 'docx', 'table-image-failure.docx');
    const structure = validateDocumentStructure(result.structure);
    const images = structure.blocks.filter((block) => block.type === 'image');
    assert.ok(images.length > 0);
    assert.ok(images.some((block) => block.image?.warnings.length));
  }
});

test('image placement validation rejects invalid parent, inheritance, appearance, MIME, and duplicate references', async () => {
  const table = validateDocumentStructure((await parse(buildDocxWithTableImage({ nested: true }), 'docx', 'table-image-validation.docx')).structure);
  const clone = (): typeof table => JSON.parse(JSON.stringify(table));
  const tableImage = table.blocks.find((block) => block.type === 'image' && block.image?.nestedTableDepth === 0);
  assert.ok(tableImage?.image);

  const badParent = clone();
  const badParentImage = badParent.blocks.find((block) => block.blockId === tableImage.blockId);
  badParentImage!.image!.parentCellBlockId = 'missing_cell';
  assert.throws(() => validateDocumentStructure(badParent), /parent cell|unknown/i);

  const badTableId = clone();
  const badTableImage = badTableId.blocks.find((block) => block.blockId === tableImage.blockId);
  badTableImage!.image!.tableId = 'p1_t999';
  assert.throws(() => validateDocumentStructure(badTableId), /table id is inconsistent/i);

  const badMime = clone();
  const badMimeImage = badMime.blocks.find((block) => block.blockId === tableImage.blockId);
  badMimeImage!.image!.mimeType = 'text/plain';
  assert.throws(() => validateDocumentStructure(badMime), /MIME type/i);

  const duplicatePlacement = clone();
  const images = duplicatePlacement.blocks.filter((block) => block.type === 'image');
  images[1]!.image!.placementId = images[0]!.image!.placementId;
  assert.throws(() => validateDocumentStructure(duplicatePlacement), /duplicate image placement/i);

  const furniture = validateDocumentStructure((await parse(buildDocxWithHeaderFooterImage({ header: true, footer: true, inheritedSections: true }), 'docx', 'furniture-image-validation.docx')).structure);
  const furnitureClone = (): typeof furniture => JSON.parse(JSON.stringify(furniture));
  const furnitureImage = furniture.blocks.find((block) => block.type === 'image' && block.image?.headerFooter?.kind === 'header');
  assert.ok(furnitureImage?.image?.headerFooter);

  const badSection = furnitureClone();
  const badSectionImage = badSection.blocks.find((block) => block.blockId === furnitureImage.blockId);
  badSectionImage!.image!.headerFooter!.definingSectionIndex = 5;
  assert.throws(() => validateDocumentStructure(badSection), /defining section/i);

  const badInheritance = furnitureClone();
  const badInheritanceImage = badInheritance.blocks.find((block) => block.blockId === furnitureImage.blockId);
  badInheritanceImage!.image!.headerFooter!.inheritedSectionIndexes = [0];
  assert.throws(() => validateDocumentStructure(badInheritance), /inherited sections include its defining section/i);

  const badAppearance = furnitureClone();
  const badAppearanceImage = badAppearance.blocks.find((block) => block.blockId === furnitureImage.blockId);
  badAppearanceImage!.image!.appearances = [{ pageNumber: 999, confidence: 'exact' }];
  assert.throws(() => validateDocumentStructure(badAppearance), /appearance references a page outside the pagination/i);

  const badHeaderParent = furnitureClone();
  const badHeaderParentImage = badHeaderParent.blocks.find((block) => block.blockId === furnitureImage.blockId);
  badHeaderParentImage!.parentId = tableImage.image?.parentCellBlockId;
  assert.throws(() => validateDocumentStructure(badHeaderParent), /child block|parent/i);

  const badNestedDepth = clone();
  const badNestedImage = badNestedDepth.blocks.find((block) => block.blockId === tableImage.blockId);
  delete badNestedImage!.image!.parentCellBlockId;
  assert.throws(() => validateDocumentStructure(badNestedDepth), /table image parents|nested depth requires|table parents are incomplete/i);
});

test('DOCX header references retain every block in a multi-paragraph source part', async () => {
  const result = await parse(buildDocxWithSections({
    sections: [{
      headers: { default: ['Header line one', 'Header line two', 'Header line three', 'Header line four'] },
      paragraphs: [{ text: 'Body under a four-line header' }],
    }],
  }), 'docx', 'multi-block-header.docx');
  assert.ok(result.structure?.docxLayout);
  const reference = result.structure.docxLayout.sections[0]?.headers[0];
  assert.equal(reference?.blockIds.length, 4);
  assert.equal(result.structure.blocks.filter((block) => block.type === 'header').length, 4);
  assert.doesNotThrow(() => validateDocumentStructure(result.structure));
});

test('DOCX explicit page breaks create break-derived pages without claiming automatic pagination', async () => {
  const result = await parse(buildDocx({
    paragraphs: [
      { text: 'First explicit page', heading: 1 },
      { text: 'Page break follows', explicitPageBreak: true },
      { text: 'Second explicit page' },
      { text: 'Page break before this paragraph', pageBreakBefore: true },
      { text: 'Third explicit page' },
    ],
  }), 'docx', 'explicit-breaks.docx');
  const structure = validateDocumentStructure(result.structure);
  assert.equal(structure.pagination?.status, 'explicit_breaks');
  assert.equal(structure.pagination?.pageCount, 3);
  assert.equal(structure.pagination?.pages.length, 3);
  assert.equal(structure.pagination?.pages[0]?.pageKind, 'explicit_break_segment');
  assert.equal(structure.pagination?.blockPages.length, 5);
  assert.ok(structure.warnings.some((warning) => warning.code === 'DOCX_EXPLICIT_BREAK_PAGINATION'));
});

test('DOCX last-rendered break markers are reported as renderer-reported, not verified physical pages', async () => {
  const result = await parse(buildDocx({
    paragraphs: [
      { text: 'Word saved page one', lastRenderedPageBreak: true },
      { text: 'Word saved page two' },
    ],
  }), 'docx', 'reported-breaks.docx');
  const structure = validateDocumentStructure(result.structure);
  assert.equal(structure.pagination?.status, 'renderer_reported_breaks');
  assert.equal(structure.pagination?.mechanism, 'wordprocessingml_last_rendered_breaks');
  assert.equal(structure.pagination?.pageCount, 2);
  assert.ok(structure.warnings.some((warning) => warning.code === 'DOCX_RENDERER_REPORTED_BREAKS'));
});

test('DOCX without automatic pagination retains a logical fallback', async () => {
  const result = await parse(buildDocx({
    paragraphs: [{ text: 'A single logical page with no page break metadata.' }],
  }), 'docx', 'logical-fallback.docx');
  const structure = validateDocumentStructure(result.structure);
  assert.equal(structure.pageSemantics, 'logical');
  assert.equal(structure.pagination?.status, 'logical_fallback');
  assert.equal(structure.pagination?.pageCount, 1);
  assert.equal(structure.pagination?.pages.length, 0);
  assert.ok(structure.warnings.some((warning) => warning.code === 'DOCX_PAGINATION_UNAVAILABLE'));
});

test('DOCX page setup dimensions and orientation are preserved for break-derived pages', async () => {
  const result = await parse(buildDocx({
    paragraphs: [
      { text: 'Landscape page one', explicitPageBreak: true },
      { text: 'Landscape page two' },
    ],
    pageSize: { widthTwips: 15840, heightTwips: 12240, orientation: 'landscape' },
  }), 'docx', 'landscape.docx');
  const structure = validateDocumentStructure(result.structure);
  assert.equal(structure.pagination?.pageCount, 2);
  assert.equal(structure.pagination?.pages[0]?.orientation, 'landscape');
  assert.ok((structure.pagination?.pages[0]?.pageWidthPt ?? 0) > (structure.pagination?.pages[0]?.pageHeightPt ?? 0));
  assert.ok(structure.pagination?.pages[0]?.margins?.topPt);
});

test('DOCX section breaks preserve the following page setup and page boundary', async () => {
  const result = await parse(buildDocx({
    paragraphs: [
      {
        text: 'Portrait section page',
        sectionBreak: { widthTwips: 15840, heightTwips: 12240, orientation: 'landscape' },
      },
      { text: 'Landscape section page' },
    ],
  }), 'docx', 'section-break.docx');
  const structure = validateDocumentStructure(result.structure);
  assert.equal(structure.pagination?.status, 'explicit_breaks');
  assert.equal(structure.pagination?.mechanism, 'wordprocessingml_sections');
  assert.equal(structure.pagination?.pageCount, 2);
  assert.equal(structure.pagination?.pages[0]?.orientation, 'portrait');
  assert.equal(structure.pagination?.pages[1]?.orientation, 'landscape');
  assert.equal(structure.pagination?.pages[1]?.breakReason, 'section_break');
});

test('DOCX pagination metadata remains bounded for a large explicit-break document', async () => {
  const paragraphs = [];
  for (let page = 1; page <= 100; page += 1) {
    paragraphs.push({ text: `Large page ${page} paragraph`, ...(page < 100 ? { explicitPageBreak: true } : {}) });
    paragraphs.push({ text: `Large page ${page} second paragraph` });
  }
  const bytes = buildDocx({ paragraphs });
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = await parse(bytes, 'docx', 'large-pagination.docx');
  const durationMs = Math.round(performance.now() - started);
  const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - before);
  const structure = validateDocumentStructure(result.structure);
  console.log('DOCX_PAGINATION_PERF', JSON.stringify({ pages: structure.pagination?.pageCount, blocks: structure.blocks.length, durationMs, heapDeltaBytes }));
  assert.equal(structure.pagination?.pageCount, 100);
  assert.equal(structure.pagination?.pages.length, 100);
  assert.equal(structure.pagination?.status, 'explicit_breaks');
});

test('OCR structure preserves geometry, confidence, and paragraph order', () => {
  const built = buildOcrPageStructure({
    pageNumber: 1,
    renderWidth: 1000,
    renderHeight: 1400,
    pageWidthPoints: 612,
    pageHeightPoints: 792,
    text: 'OCR page',
    details: {
      page: 1,
      language: 'eng',
      confidence: 93,
      lines: [
        {
          text: 'Second line of paragraph',
          confidence: 90,
          bbox: { x0: 100, y0: 240, x1: 600, y1: 270 },
        },
        {
          text: 'First line of paragraph',
          confidence: 92,
          bbox: { x0: 100, y0: 200, x1: 650, y1: 230 },
        },
        {
          text: '1. OCR list item',
          confidence: 88,
          bbox: { x0: 100, y0: 330, x1: 500, y1: 360 },
        },
      ],
      warnings: [],
    },
  });
  const structure = validateDocumentStructure({
    schemaVersion: 1,
    extractionVersion: 1,
    documentFormat: 'pdf',
    pageSemantics: 'physical',
    pages: [built.page],
    blocks: built.blocks,
    sections: [],
    tables: [],
    readingOrder: built.page.blockIds,
    warnings: built.warnings,
    metadata: {
      pageCount: 1,
      blockCount: built.blocks.length,
      sectionCount: 0,
      tableCount: 0,
      ocrPageCount: 1,
      truncated: false,
    },
  });
  assert.equal(structure.pages[0]!.conversion?.from, 'ocr_render_pixels');
  assert.equal(structure.pages[0]!.conversion?.to, 'pdf_page_points');
  assert.ok(structure.blocks.every((block) => !block.boundingBox || block.boundingBox.coordinateSpace === 'ocr_render_pixels'));
  assert.ok(structure.blocks.some((block) => block.type === 'paragraph' && block.text.indexOf('First line') < block.text.indexOf('Second line')));
  assert.ok(structure.blocks.some((block) => block.type === 'list_item' && block.confidence === 88));
  assert.ok((structure.blocks.find((block) => block.type === 'paragraph')?.confidence ?? 0) > 0);
});

test('DOCX layout validation rejects duplicate variants, forward inheritance, unknown header blocks, and non-DOCX use', async () => {
  const result = await parse(buildDocxWithSections({
    sections: [{
      headers: { default: ['Validated header'] },
      footers: { default: ['Validated footer'] },
      paragraphs: [{ text: 'Validated body' }],
    }],
  }), 'docx', 'validated-layout.docx');
  assert.ok(result.structure?.docxLayout);
  assert.doesNotThrow(() => validateDocumentStructure(result.structure));
  const duplicateVariant = {
    ...result.structure!,
    docxLayout: {
      ...result.structure!.docxLayout!,
      sections: [{
        ...result.structure!.docxLayout!.sections[0]!,
        headers: [
          result.structure!.docxLayout!.sections[0]!.headers[0]!,
          result.structure!.docxLayout!.sections[0]!.headers[0]!,
        ],
      }],
    },
  };
  assert.throws(() => validateDocumentStructure(duplicateVariant), /duplicate header\/footer variants/);
  const forwardInheritance = {
    ...result.structure!,
    docxLayout: {
      ...result.structure!.docxLayout!,
      sections: [{
        ...result.structure!.docxLayout!.sections[0]!,
        headers: [{
          ...result.structure!.docxLayout!.sections[0]!.headers[0]!,
          inherited: true,
          definingSectionIndex: 1,
        }],
      }],
    },
  };
  assert.throws(() => validateDocumentStructure(forwardInheritance), /defining section/);
  const unknownHeaderBlock = {
    ...result.structure!,
    docxLayout: {
      ...result.structure!.docxLayout!,
      sections: [{
        ...result.structure!.docxLayout!.sections[0]!,
        footers: [{
          ...result.structure!.docxLayout!.sections[0]!.footers[0]!,
          blockIds: ['p1_missing'],
        }],
      }],
    },
  };
  assert.throws(() => validateDocumentStructure(unknownHeaderBlock), /unknown block/);
  assert.throws(() => validateDocumentStructure({
    ...result.structure!,
    documentFormat: 'pdf',
    pageSemantics: 'physical',
  }), /only valid for DOCX/);
});

test('pagination geometry validation accepts exact lines/columns and rejects inconsistent or unknown confidence', () => {
  const valid = {
    schemaVersion: 1,
    extractionVersion: 1,
    documentFormat: 'pdf',
    pageSemantics: 'physical',
    pages: [{ pageId: 'p1', pageNumber: 1, pageKind: 'physical', pageType: 'text', extractionMethod: 'pdf_native', blockIds: ['p1_b1'] }],
    blocks: [{ blockId: 'p1_b1', type: 'paragraph', text: 'Text', pageId: 'p1', pageNumber: 1, order: 0, provenance: 'pdf_native' }],
    sections: [],
    tables: [],
    readingOrder: ['p1_b1'],
    warnings: [],
    metadata: { pageCount: 1, blockCount: 1, sectionCount: 0, tableCount: 0, ocrPageCount: 0, truncated: false },
    pagination: {
      status: 'renderer_derived_physical',
      mechanism: 'local_renderer',
      pageCount: 1,
      pages: [{
        pageNumber: 1,
        pageKind: 'renderer_derived_physical',
        blockIds: ['p1_b1'],
        breakReason: 'renderer_generated',
        sectionIndex: 0,
        columnCount: 1,
        columns: [{
          pageNumber: 1,
          columnIndex: 0,
          sectionIndex: 0,
          box: { x: 0, y: 0, width: 468, height: 600, coordinateSpace: 'renderer_page_content_points' },
          widthPt: 468,
          heightPt: 600,
          confidence: 'renderer_approximate',
          source: 'mixed',
        }],
      }],
      blockPages: [{
        blockId: 'p1_b1',
        startPageNumber: 1,
        fragmentPages: [{ pageNumber: 1, fragmentIndex: 0 }],
        geometryConfidence: 'exact',
        boundingBox: { x: 0, y: 0, width: 468, height: 20, coordinateSpace: 'renderer_page_content_points' },
        lines: [{
          lineIndex: 0,
          pageNumber: 1,
          fragmentIndex: 0,
          box: { x: 0, y: 0, width: 468, height: 13, coordinateSpace: 'renderer_page_content_points' },
          columnIndex: 0,
          confidence: 'exact',
        }],
      }],
      geometry: { lineCount: 1, cellCount: 0, columnCount: 1, truncated: false },
      warnings: [],
    },
  };
  assert.doesNotThrow(() => validateDocumentStructure(valid));
  assert.throws(() => validateDocumentStructure({
    ...valid,
    pagination: { ...valid.pagination, geometry: { ...valid.pagination.geometry, lineCount: 2 } },
  }), /counts are inconsistent/);
  assert.throws(() => validateDocumentStructure({
    ...valid,
    pagination: {
      ...valid.pagination,
      blockPages: [{
        ...valid.pagination.blockPages[0],
        lines: [{ ...valid.pagination.blockPages[0]!.lines[0], confidence: 'guessed' }],
      }],
    },
  }), /confidence/);
  assert.throws(() => validateDocumentStructure({
    ...valid,
    pagination: {
      ...valid.pagination,
      pages: [{
        ...valid.pagination.pages[0],
        columns: [valid.pagination.pages[0]!.columns[0], valid.pagination.pages[0]!.columns[0]],
      }],
    },
  }), /duplicate column/);
});

test('structure validation rejects duplicate IDs, foreign pages, unknown references, and metadata mismatches', () => {
  const valid = {
    schemaVersion: 1,
    extractionVersion: 1,
    documentFormat: 'pdf',
    pageSemantics: 'physical',
    pages: [{ pageId: 'p1', pageNumber: 1, pageKind: 'physical', pageType: 'text', extractionMethod: 'pdf_native', blockIds: ['p1_b1'] }],
    blocks: [{
      blockId: 'p1_b1', type: 'paragraph', text: 'Text', pageId: 'p1', pageNumber: 1, order: 0, provenance: 'pdf_native',
    }],
    sections: [],
    tables: [],
    readingOrder: ['p1_b1'],
    warnings: [],
    metadata: { pageCount: 1, blockCount: 1, sectionCount: 0, tableCount: 0, ocrPageCount: 0, truncated: false },
  };
  assert.doesNotThrow(() => validateDocumentStructure(valid));
  assert.throws(() => validateDocumentStructure({ ...valid, blocks: [{ ...valid.blocks[0], blockId: 'p1_b1' }, valid.blocks[0]] }), /duplicate block/);
  assert.throws(() => validateDocumentStructure({ ...valid, readingOrder: ['missing'] }), /unknown block/);
  assert.throws(() => validateDocumentStructure({ ...valid, metadata: { ...valid.metadata, blockCount: 2 } }), /counts are inconsistent/);
  assert.throws(() => validateDocumentStructure({ ...valid, pages: [{ ...valid.pages[0], blockIds: ['p9'] }] }), /unknown or foreign/);
  assert.throws(() => validateDocumentStructure({ ...valid, pages: [{ ...valid.pages[0], blockIds: [] }], blocks: [{ ...valid.blocks[0], parentId: 'missing' }] }), /unknown parent/);
});
