import {
  DOCUMENT_STRUCTURE_SCHEMA_VERSION,
  MAX_EXTRACTION_WARNINGS,
  MAX_PDF_PAGES,
  MAX_STRUCTURE_BLOCKS,
  MAX_STRUCTURE_BLOCK_TEXT_CHARS,
  MAX_STRUCTURE_BOUNDING_BOXES,
  MAX_STRUCTURE_DEPTH,
  MAX_STRUCTURE_READING_ORDER,
  MAX_STRUCTURE_SECTIONS,
  MAX_STRUCTURE_TABLES,
  MAX_STRUCTURE_TABLE_CELLS,
  MAX_STRUCTURE_TABLE_ROWS,
  MAX_STRUCTURE_TEXT_CHARS,
} from './constants';
import type {
  DocumentBlockType,
  DocumentCoordinateSpace,
  DocumentExtractionProvenance,
  DocumentPageExtractionMethod,
  DocumentPageSemantics,
  DocumentPageType,
  DocumentStructure,
  DocumentStructureBlock,
  DocumentStructureBoundingBox,
  DocumentStructurePage,
  DocumentStructureSection,
  DocumentStructureTable,
  DocumentStructureTextStyle,
  ExtractionWarning,
} from './types';

export class DocumentStructureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentStructureValidationError';
  }
}

export interface StructureLimits {
  maxPages: number;
  maxBlocks: number;
  maxSections: number;
  maxTables: number;
  maxTableRows: number;
  maxTableCells: number;
  maxDepth: number;
  maxTextChars: number;
  maxBlockTextChars: number;
  maxBoundingBoxes: number;
  maxReadingOrder: number;
  maxWarnings: number;
}

export const STRUCTURE_LIMITS: StructureLimits = {
  maxPages: MAX_PDF_PAGES,
  maxBlocks: MAX_STRUCTURE_BLOCKS,
  maxSections: MAX_STRUCTURE_SECTIONS,
  maxTables: MAX_STRUCTURE_TABLES,
  maxTableRows: MAX_STRUCTURE_TABLE_ROWS,
  maxTableCells: MAX_STRUCTURE_TABLE_CELLS,
  maxDepth: MAX_STRUCTURE_DEPTH,
  maxTextChars: MAX_STRUCTURE_TEXT_CHARS,
  maxBlockTextChars: MAX_STRUCTURE_BLOCK_TEXT_CHARS,
  maxBoundingBoxes: MAX_STRUCTURE_BOUNDING_BOXES,
  maxReadingOrder: MAX_STRUCTURE_READING_ORDER,
  maxWarnings: MAX_EXTRACTION_WARNINGS,
};

const BLOCK_TYPES = new Set<DocumentBlockType>([
  'heading', 'paragraph', 'list', 'list_item', 'table', 'table_row',
  'table_cell', 'header', 'footer', 'caption', 'unknown',
]);
const PROVENANCES = new Set<DocumentExtractionProvenance>([
  'pdf_native', 'docx_xml', 'ocr', 'mixed', 'inferred_from_layout', 'txt_native',
]);
const PAGE_TYPES = new Set<DocumentPageType>(['text', 'image_only', 'blank', 'unknown']);
const PAGE_METHODS = new Set<DocumentPageExtractionMethod>([
  'pdf_native', 'docx_xml', 'ocr', 'mixed', 'txt_native',
]);
const PAGE_SEMANTICS = new Set<DocumentPageSemantics>(['physical', 'logical']);
const COORDINATE_SPACES = new Set<DocumentCoordinateSpace>(['pdf_page_points', 'ocr_render_pixels']);
const STRUCTURE_FORMATS = new Set(['pdf', 'docx', 'txt']);
const ALIGNMENTS = new Set(['left', 'center', 'right', 'justified', 'unknown']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function fail(message: string): never {
  throw new DocumentStructureValidationError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) fail(`${label} must be an object.`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${label} contains an unexpected property.`);
  }
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  if (value.length > max) fail(`${label} exceeds the supported limit.`);
  return value;
}

function text(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(`${label} is invalid.`);
  return value;
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return text(value, label, 0, max);
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${label} is outside the supported range.`);
  }
  return value;
}

function optionalInteger(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  return integer(value, label, min, max);
}

function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${label} is outside the supported range.`);
  }
  return value;
}

function optionalNumber(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  return number(value, label, min, max);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean.`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  return boolean(value, label);
}

function enumeration<T extends string>(value: unknown, label: string, allowed: Set<T>): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) fail(`${label} is unsupported.`);
  return value as T;
}

function id(value: unknown, label: string): string {
  const result = text(value, label, 1, 80);
  if (!ID_PATTERN.test(result)) fail(`${label} has an invalid format.`);
  return result;
}

function warningList(value: unknown, label: string, maxPage: number, max: number): ExtractionWarning[] {
  return array(value, label, max).map((entry, index) => {
    const item = object(entry, `${label} ${index}`);
    exactKeys(item, ['code', 'message', 'page'], `${label} ${index}`);
    return {
      code: text(item.code, `${label} ${index} code`, 1, 80),
      message: text(item.message, `${label} ${index} message`, 1, 500),
      ...(item.page === undefined
        ? {}
        : { page: integer(item.page, `${label} ${index} page`, 1, maxPage) }),
    };
  });
}

function boundingBox(value: unknown, label: string): DocumentStructureBoundingBox {
  const box = object(value, label);
  exactKeys(box, ['x0', 'y0', 'x1', 'y1', 'coordinateSpace', 'pageWidth', 'pageHeight'], label);
  const x0 = number(box.x0, `${label} x0`, 0, 10_000_000);
  const y0 = number(box.y0, `${label} y0`, 0, 10_000_000);
  const x1 = number(box.x1, `${label} x1`, 0, 10_000_000);
  const y1 = number(box.y1, `${label} y1`, 0, 10_000_000);
  if (x1 < x0 || y1 < y0) fail(`${label} coordinates are inverted.`);
  return {
    x0,
    y0,
    x1,
    y1,
    coordinateSpace: enumeration(box.coordinateSpace, `${label} coordinate space`, COORDINATE_SPACES),
    ...(box.pageWidth === undefined ? {} : { pageWidth: number(box.pageWidth, `${label} page width`, 1, 1_000_000) }),
    ...(box.pageHeight === undefined ? {} : { pageHeight: number(box.pageHeight, `${label} page height`, 1, 1_000_000) }),
  };
}

function style(value: unknown, label: string): DocumentStructureTextStyle {
  const item = object(value, label);
  exactKeys(item, ['fontFamily', 'fontSize', 'bold', 'italic', 'alignment', 'direction', 'hyperlink', 'styleId', 'styleName'], label);
  return {
    ...(optionalText(item.fontFamily, `${label} font family`, 200) !== undefined
      ? { fontFamily: optionalText(item.fontFamily, `${label} font family`, 200) }
      : {}),
    ...(item.fontSize === undefined ? {} : { fontSize: number(item.fontSize, `${label} font size`, 0.1, 10_000) }),
    ...(optionalBoolean(item.bold, `${label} bold`) !== undefined ? { bold: optionalBoolean(item.bold, `${label} bold`) } : {}),
    ...(optionalBoolean(item.italic, `${label} italic`) !== undefined ? { italic: optionalBoolean(item.italic, `${label} italic`) } : {}),
    ...(item.alignment === undefined ? {} : { alignment: enumeration(item.alignment, `${label} alignment`, ALIGNMENTS) as DocumentStructureTextStyle['alignment'] }),
    ...(item.direction === undefined ? {} : { direction: text(item.direction, `${label} direction`, 1, 20) }),
    ...(optionalBoolean(item.hyperlink, `${label} hyperlink`) !== undefined ? { hyperlink: optionalBoolean(item.hyperlink, `${label} hyperlink`) } : {}),
    ...(item.styleId === undefined ? {} : { styleId: text(item.styleId, `${label} style id`, 1, 200) }),
    ...(item.styleName === undefined ? {} : { styleName: text(item.styleName, `${label} style name`, 1, 200) }),
  };
}

function block(value: unknown, index: number, limits: StructureLimits, maxPage: number): DocumentStructureBlock {
  const label = `Structured block ${index}`;
  const item = object(value, label);
  exactKeys(
    item,
    ['blockId', 'type', 'text', 'pageId', 'pageNumber', 'order', 'parentId', 'children', 'boundingBox', 'confidence', 'provenance', 'layoutInferred', 'sourceRef', 'level', 'style', 'listMarker', 'tableId', 'rowIndex', 'columnIndex', 'rowSpan', 'columnSpan', 'warnings'],
    label,
  );
  const children = item.children === undefined
    ? undefined
    : array(item.children, `${label} children`, limits.maxBlocks).map((child, childIndex) => id(child, `${label} child ${childIndex}`));
  return {
    blockId: id(item.blockId, `${label} id`),
    type: enumeration(item.type, `${label} type`, BLOCK_TYPES),
    text: text(item.text, `${label} text`, 0, limits.maxBlockTextChars),
    pageId: id(item.pageId, `${label} page id`),
    pageNumber: integer(item.pageNumber, `${label} page number`, 1, maxPage),
    order: integer(item.order, `${label} order`, 0, 1_000_000_000),
    ...(item.parentId === undefined ? {} : { parentId: id(item.parentId, `${label} parent id`) }),
    ...(children ? { children } : {}),
    ...(item.boundingBox === undefined ? {} : { boundingBox: boundingBox(item.boundingBox, `${label} bounding box`) }),
    ...(item.confidence === undefined ? {} : { confidence: number(item.confidence, `${label} confidence`, 0, 100) }),
    provenance: enumeration(item.provenance, `${label} provenance`, PROVENANCES),
    ...(optionalBoolean(item.layoutInferred, `${label} layout inferred`) !== undefined
      ? { layoutInferred: optionalBoolean(item.layoutInferred, `${label} layout inferred`) }
      : {}),
    ...(item.sourceRef === undefined ? {} : { sourceRef: text(item.sourceRef, `${label} source reference`, 1, 200) }),
    ...(item.level === undefined ? {} : { level: integer(item.level, `${label} level`, 1, 9) }),
    ...(item.style === undefined ? {} : { style: style(item.style, `${label} style`) }),
    ...(item.listMarker === undefined ? {} : { listMarker: text(item.listMarker, `${label} list marker`, 1, 40) }),
    ...(item.tableId === undefined ? {} : { tableId: id(item.tableId, `${label} table id`) }),
    ...(item.rowIndex === undefined ? {} : { rowIndex: integer(item.rowIndex, `${label} row index`, 0, limits.maxTableRows) }),
    ...(item.columnIndex === undefined ? {} : { columnIndex: integer(item.columnIndex, `${label} column index`, 0, limits.maxTableCells) }),
    ...(item.rowSpan === undefined ? {} : { rowSpan: integer(item.rowSpan, `${label} row span`, 1, limits.maxTableRows) }),
    ...(item.columnSpan === undefined ? {} : { columnSpan: integer(item.columnSpan, `${label} column span`, 1, limits.maxTableCells) }),
    ...(item.warnings === undefined
      ? {}
      : { warnings: warningList(item.warnings, `${label} warnings`, maxPage, limits.maxWarnings) }),
  };
}

function page(value: unknown, index: number, limits: StructureLimits, maxPage: number): DocumentStructurePage {
  const label = `Structured page ${index}`;
  const item = object(value, label);
  exactKeys(item, ['pageId', 'pageNumber', 'pageKind', 'pageType', 'extractionMethod', 'blockIds', 'pageBounds', 'conversion', 'warnings'], label);
  const blockIds = array(item.blockIds, `${label} block ids`, limits.maxBlocks)
    .map((entry, blockIndex) => id(entry, `${label} block ${blockIndex}`));
  let pageBounds;
  if (item.pageBounds !== undefined) {
    const bounds = object(item.pageBounds, `${label} bounds`);
    exactKeys(bounds, ['width', 'height', 'coordinateSpace'], `${label} bounds`);
    pageBounds = {
      width: number(bounds.width, `${label} width`, 1, 1_000_000),
      height: number(bounds.height, `${label} height`, 1, 1_000_000),
      coordinateSpace: enumeration(bounds.coordinateSpace, `${label} coordinate space`, COORDINATE_SPACES),
    };
  }
  let conversion;
  if (item.conversion !== undefined) {
    const value = object(item.conversion, `${label} conversion`);
    exactKeys(value, ['from', 'to', 'scaleX', 'scaleY', 'width', 'height'], `${label} conversion`);
    if (value.from !== 'ocr_render_pixels' || value.to !== 'pdf_page_points') {
      fail(`${label} conversion is unsupported.`);
    }
    conversion = {
      from: 'ocr_render_pixels' as const,
      to: 'pdf_page_points' as const,
      scaleX: number(value.scaleX, `${label} scaleX`, 0.000001, 1_000_000),
      scaleY: number(value.scaleY, `${label} scaleY`, 0.000001, 1_000_000),
      width: number(value.width, `${label} conversion width`, 1, 1_000_000),
      height: number(value.height, `${label} conversion height`, 1, 1_000_000),
    };
  }
  return {
    pageId: id(item.pageId, `${label} id`),
    pageNumber: integer(item.pageNumber, `${label} number`, 1, maxPage),
    pageKind: enumeration(item.pageKind, `${label} kind`, PAGE_SEMANTICS),
    pageType: enumeration(item.pageType, `${label} type`, PAGE_TYPES),
    extractionMethod: enumeration(item.extractionMethod, `${label} extraction method`, PAGE_METHODS),
    blockIds,
    ...(pageBounds ? { pageBounds } : {}),
    ...(conversion ? { conversion } : {}),
    ...(item.warnings === undefined
      ? {}
      : { warnings: warningList(item.warnings, `${label} warnings`, maxPage, limits.maxWarnings) }),
  };
}

function section(value: unknown, index: number, limits: StructureLimits, maxPage: number): DocumentStructureSection {
  const label = `Structured section ${index}`;
  const item = object(value, label);
  exactKeys(item, ['sectionId', 'headingBlockId', 'level', 'title', 'blockIds', 'pageStart', 'pageEnd', 'parentSectionId'], label);
  return {
    sectionId: id(item.sectionId, `${label} id`),
    ...(item.headingBlockId === undefined ? {} : { headingBlockId: id(item.headingBlockId, `${label} heading block`) }),
    level: integer(item.level, `${label} level`, 1, 9),
    title: text(item.title, `${label} title`, 0, 500),
    blockIds: array(item.blockIds, `${label} block ids`, limits.maxBlocks)
      .map((entry, blockIndex) => id(entry, `${label} block ${blockIndex}`)),
    pageStart: integer(item.pageStart, `${label} page start`, 1, maxPage),
    pageEnd: integer(item.pageEnd, `${label} page end`, 1, maxPage),
    ...(item.parentSectionId === undefined ? {} : { parentSectionId: id(item.parentSectionId, `${label} parent section`) }),
  };
}

function table(value: unknown, index: number, limits: StructureLimits, maxPage: number): DocumentStructureTable {
  const label = `Structured table ${index}`;
  const item = object(value, label);
  exactKeys(item, ['tableId', 'blockId', 'pageId', 'pageNumber', 'rowBlockIds', 'columnCount', 'rowCount'], label);
  const rowBlockIds = array(item.rowBlockIds, `${label} row blocks`, limits.maxTableRows)
    .map((entry, rowIndex) => id(entry, `${label} row ${rowIndex}`));
  return {
    tableId: id(item.tableId, `${label} id`),
    blockId: id(item.blockId, `${label} block id`),
    pageId: id(item.pageId, `${label} page id`),
    pageNumber: integer(item.pageNumber, `${label} page number`, 1, maxPage),
    rowBlockIds,
    columnCount: integer(item.columnCount, `${label} column count`, 0, limits.maxTableCells),
    rowCount: integer(item.rowCount, `${label} row count`, 0, limits.maxTableRows),
  };
}

export function validateDocumentStructure(
  value: unknown,
  limits: StructureLimits = STRUCTURE_LIMITS,
): DocumentStructure {
  const structure = object(value, 'Document structure');
  exactKeys(
    structure,
    ['schemaVersion', 'extractionVersion', 'documentFormat', 'pageSemantics', 'pages', 'blocks', 'sections', 'tables', 'readingOrder', 'warnings', 'metadata'],
    'Document structure',
  );
  if (structure.schemaVersion !== DOCUMENT_STRUCTURE_SCHEMA_VERSION) {
    fail('Document structure schema version is unsupported.');
  }
  const extractionVersion = integer(structure.extractionVersion, 'Document structure extraction version', 1, 1_000);
  const documentFormat = enumeration(structure.documentFormat, 'Document structure format', STRUCTURE_FORMATS as Set<'pdf' | 'docx' | 'txt'>);
  const pageSemantics = enumeration(structure.pageSemantics, 'Document structure page semantics', PAGE_SEMANTICS);
  if (documentFormat === 'pdf' && pageSemantics !== 'physical') {
    fail('PDF structure must use physical page semantics.');
  }
  if ((documentFormat === 'docx' || documentFormat === 'txt') && pageSemantics !== 'logical') {
    fail('DOCX and TXT structure must use logical page semantics.');
  }

  const pagesRaw = array(structure.pages, 'Document structure pages', limits.maxPages);
  const blocksRaw = array(structure.blocks, 'Document structure blocks', limits.maxBlocks);
  const sectionsRaw = array(structure.sections, 'Document structure sections', limits.maxSections);
  const tablesRaw = array(structure.tables, 'Document structure tables', limits.maxTables);
  const readingOrderRaw = array(structure.readingOrder, 'Document structure reading order', limits.maxReadingOrder);

  const pages = pagesRaw.map((entry, index) => page(entry, index, limits, limits.maxPages));
  const blocks = blocksRaw.map((entry, index) => block(entry, index, limits, limits.maxPages));
  const sections = sectionsRaw.map((entry, index) => section(entry, index, limits, limits.maxPages));
  const tables = tablesRaw.map((entry, index) => table(entry, index, limits, limits.maxPages));
  const readingOrder = readingOrderRaw.map((entry, index) => id(entry, `Document structure reading order ${index}`));
  const warnings = warningList(structure.warnings, 'Document structure warnings', limits.maxPages, limits.maxWarnings);

  const pageIds = new Set<string>();
  const pageNumberById = new Map<string, number>();
  for (const item of pages) {
    if (pageIds.has(item.pageId)) fail('Document structure contains duplicate page ids.');
    pageIds.add(item.pageId);
    pageNumberById.set(item.pageId, item.pageNumber);
  }
  if (new Set(pages.map((item) => item.pageNumber)).size !== pages.length) {
    fail('Document structure contains duplicate page numbers.');
  }

  const blockIds = new Set<string>();
  const blockById = new Map<string, DocumentStructureBlock>();
  let textChars = 0;
  let bboxCount = 0;
  for (const item of blocks) {
    if (blockIds.has(item.blockId)) fail('Document structure contains duplicate block ids.');
    blockIds.add(item.blockId);
    blockById.set(item.blockId, item);
    textChars += item.text.length;
    if (textChars > limits.maxTextChars) fail('Document structure text exceeds the supported limit.');
    if (item.boundingBox) {
      bboxCount += 1;
      if (bboxCount > limits.maxBoundingBoxes) fail('Document structure contains too many bounding boxes.');
    }
    const pageNumber = pageNumberById.get(item.pageId);
    if (pageNumber === undefined || pageNumber !== item.pageNumber) {
      fail('Document structure block page references are inconsistent.');
    }
  }

  for (const pageItem of pages) {
    if (new Set(pageItem.blockIds).size !== pageItem.blockIds.length) fail('Document structure page contains duplicate block ids.');
    for (const blockId of pageItem.blockIds) {
      const item = blockById.get(blockId);
      if (!item || item.pageId !== pageItem.pageId) fail('Document structure page references an unknown or foreign block.');
      if (item.parentId) fail('Document structure page lists a child block as a top-level block.');
    }
    if (pageItem.warnings && pageItem.warnings.length > limits.maxWarnings) fail('Document structure page has too many warnings.');
  }

  for (const item of blocks) {
    if (item.parentId) {
      const parent = blockById.get(item.parentId);
      if (!parent) fail('Document structure block references an unknown parent.');
      if (parent.blockId === item.blockId) fail('Document structure block cannot parent itself.');
      if (parent.children && !parent.children.includes(item.blockId)) {
        fail('Document structure parent does not list its child.');
      }
    }
    if (item.children) {
      if (new Set(item.children).size !== item.children.length) fail('Document structure block contains duplicate children.');
      for (const childId of item.children) {
        const child = blockById.get(childId);
        if (!child) fail('Document structure block references an unknown child.');
        if (child.parentId !== item.blockId) fail('Document structure child does not reference its parent.');
      }
    }
    let depth = 0;
    let cursor: DocumentStructureBlock | undefined = item;
    const seen = new Set<string>();
    while (cursor?.parentId) {
      if (seen.has(cursor.blockId) || depth > limits.maxDepth) fail('Document structure hierarchy is too deep or cyclic.');
      seen.add(cursor.blockId);
      cursor = blockById.get(cursor.parentId);
      depth += 1;
    }
    if (depth > limits.maxDepth) fail('Document structure hierarchy is too deep.');
  }

  if (new Set(readingOrder).size !== readingOrder.length) fail('Document structure reading order contains duplicates.');
  for (const blockId of readingOrder) {
    if (!blockById.has(blockId)) fail('Document structure reading order references an unknown block.');
  }

  const sectionIds = new Set<string>();
  const headingSectionIds = new Set<string>();
  for (const item of sections) {
    if (sectionIds.has(item.sectionId)) fail('Document structure contains duplicate section ids.');
    sectionIds.add(item.sectionId);
    if (item.pageStart > item.pageEnd) fail('Document structure section page range is inverted.');
    if (item.headingBlockId) {
      if (headingSectionIds.has(item.headingBlockId)) fail('Document structure section headings are duplicated.');
      headingSectionIds.add(item.headingBlockId);
      const heading = blockById.get(item.headingBlockId);
      if (!heading || heading.type !== 'heading') fail('Document structure section heading is not a heading block.');
    }
    for (const blockId of item.blockIds) {
      if (!blockById.has(blockId)) fail('Document structure section references an unknown block.');
    }
  }
  for (const item of sections) {
    if (item.parentSectionId && !sectionIds.has(item.parentSectionId)) {
      fail('Document structure section references an unknown parent section.');
    }
  }

  const tableIds = new Set<string>();
  for (const item of tables) {
    if (tableIds.has(item.tableId)) fail('Document structure contains duplicate table ids.');
    tableIds.add(item.tableId);
    const tableBlock = blockById.get(item.blockId);
    if (!tableBlock || tableBlock.type !== 'table') fail('Document structure table does not reference a table block.');
    if (tableBlock.pageId !== item.pageId || tableBlock.pageNumber !== item.pageNumber) {
      fail('Document structure table page references are inconsistent.');
    }
    if (new Set(item.rowBlockIds).size !== item.rowBlockIds.length) fail('Document structure table has duplicate row references.');
    if (item.rowBlockIds.length !== item.rowCount) fail('Document structure table row count is inconsistent.');
    for (const rowId of item.rowBlockIds) {
      const row = blockById.get(rowId);
      if (!row || row.type !== 'table_row') fail('Document structure table references a row that is not a table row.');
      if (row.parentId !== item.blockId) fail('Document structure table row does not reference its table.');
    }
  }

  const metadata = object(structure.metadata, 'Document structure metadata');
  exactKeys(metadata, ['pageCount', 'blockCount', 'sectionCount', 'tableCount', 'ocrPageCount', 'truncated'], 'Document structure metadata');
  const metadataPageCount = integer(metadata.pageCount, 'Document structure metadata page count', 0, limits.maxPages);
  const metadataBlockCount = integer(metadata.blockCount, 'Document structure metadata block count', 0, limits.maxBlocks);
  const metadataSectionCount = integer(metadata.sectionCount, 'Document structure metadata section count', 0, limits.maxSections);
  const metadataTableCount = integer(metadata.tableCount, 'Document structure metadata table count', 0, limits.maxTables);
  const ocrPageCount = integer(metadata.ocrPageCount, 'Document structure metadata OCR page count', 0, limits.maxPages);
  if (metadataPageCount !== pages.length
    || metadataBlockCount !== blocks.length
    || metadataSectionCount !== sections.length
    || metadataTableCount !== tables.length
    || ocrPageCount !== pages.filter((item) => item.extractionMethod === 'ocr').length) {
    fail('Document structure metadata counts are inconsistent.');
  }
  boolean(metadata.truncated, 'Document structure metadata truncated flag');

  return {
    schemaVersion: DOCUMENT_STRUCTURE_SCHEMA_VERSION,
    extractionVersion,
    documentFormat,
    pageSemantics,
    pages,
    blocks,
    sections,
    tables,
    readingOrder,
    warnings,
    metadata: {
      pageCount: metadataPageCount,
      blockCount: metadataBlockCount,
      sectionCount: metadataSectionCount,
      tableCount: metadataTableCount,
      ocrPageCount,
      truncated: boolean(metadata.truncated, 'Document structure metadata truncated flag'),
    },
  };
}

/** Deterministic plain-text view of top-level structured blocks. */
export function structureToPlainText(structure: DocumentStructure): string {
  const byId = new Map(structure.blocks.map((block) => [block.blockId, block]));
  const order = structure.readingOrder.length
    ? structure.readingOrder
    : structure.pages.flatMap((page) => page.blockIds);
  const parts: string[] = [];
  for (const blockId of order) {
    const block = byId.get(blockId);
    if (!block) continue;
    if (block.type === 'table') {
      const rows: string[] = [];
      for (const rowId of block.children ?? []) {
        const row = byId.get(rowId);
        if (!row) continue;
        const cells = (row.children ?? [])
          .map((cellId) => byId.get(cellId)?.text.replace(/\s+/g, ' ').trim() ?? '')
          .filter(Boolean);
        if (cells.length) rows.push(cells.join('\t'));
      }
      if (rows.length) parts.push(rows.join('\n'));
    } else if (block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n').replace(/\r\n?/g, '\n').trim();
}
