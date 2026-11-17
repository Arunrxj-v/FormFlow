import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocx, buildPdf, toArrayBuffer } from '../helpers/document-fixtures';
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
