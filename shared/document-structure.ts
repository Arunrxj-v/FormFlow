import {
  DOCUMENT_STRUCTURE_SCHEMA_VERSION,
  MAX_EXTRACTION_WARNINGS,
  MAX_IMAGE_APPEARANCES,
  MAX_IMAGE_NESTED_TABLE_DEPTH,
  MAX_PAGINATION_GEOMETRY_ENTRIES,
  MAX_PAGINATION_LINES_PER_BLOCK,
  MAX_PDF_PAGES,
  MAX_STRUCTURE_BLOCKS,
  MAX_STRUCTURE_BLOCK_TEXT_CHARS,
  MAX_STRUCTURE_BOUNDING_BOXES,
  MAX_STRUCTURE_DEPTH,
  MAX_STRUCTURE_IMAGES,
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
  DocumentEmbeddedFont,
  DocumentExtractionProvenance,
  DocumentFontFaceResolution,
  DocumentFontResolution,
  DocumentFontResolutionSource,
  DocumentGeometryBox,
  DocumentGeometryConfidence,
  DocumentPageExtractionMethod,
  DocumentPageSemantics,
  DocumentPageType,
  DocumentPaginationBlockPage,
  DocumentPaginationBreakReason,
  DocumentPaginationCellGeometry,
  DocumentPaginationColumnGeometry,
  DocumentPaginationInfo,
  DocumentPaginationLineGeometry,
  DocumentPaginationMechanism,
  DocumentPaginationPageKind,
  DocumentPaginationRowGeometry,
  DocumentPaginationStatus,
  DocumentStructure,
  DocumentStructureBlock,
  DocumentStructureBoundingBox,
  DocumentStructureDocxColumns,
  DocumentStructureDocxLayout,
  DocumentStructureDocxSection,
  DocumentStructureHeaderFooterReference,
  DocumentStructureImage,
  DocumentStructurePage,
  DocumentStructureSection,
  DocumentStructureTable,
  DocumentStructureTextStyle,
  DocumentImageAppearance,
  DocumentStructureImageHeaderFooter,
  DocumentThemeFonts,
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
  'table_cell', 'header', 'footer', 'caption', 'image', 'unknown',
]);
const PROVENANCES = new Set<DocumentExtractionProvenance>([
  'pdf_native', 'docx_xml', 'ocr', 'mixed', 'inferred_from_layout', 'txt_native',
]);
const PAGE_TYPES = new Set<DocumentPageType>(['text', 'image_only', 'blank', 'unknown']);
const PAGE_METHODS = new Set<DocumentPageExtractionMethod>([
  'pdf_native', 'docx_xml', 'ocr', 'mixed', 'txt_native',
]);
const PAGE_SEMANTICS = new Set<DocumentPageSemantics>(['physical', 'logical']);
const COORDINATE_SPACES = new Set<DocumentCoordinateSpace>(['pdf_page_points', 'ocr_render_pixels', 'renderer_page_content_points', 'renderer_page_points']);
const GEOMETRY_CONFIDENCES = new Set<DocumentGeometryConfidence>([
  'exact', 'renderer_approximate', 'source_approximate', 'text_order', 'unavailable',
]);
const FONT_SOURCES = new Set<DocumentFontResolutionSource>([
  'embedded', 'exact_local', 'metric_substitute', 'generic_fallback', 'unavailable',
]);
const IMAGE_POSITIONINGS = new Set(['inline', 'anchored']);
const IMAGE_WRAPS = new Set([
  'inline', 'square', 'squareLeft', 'squareRight', 'tight', 'through',
  'topAndBottom', 'behind', 'inFront', 'unknown',
]);
const STRUCTURE_FORMATS = new Set(['pdf', 'docx', 'txt']);
const ALIGNMENTS = new Set(['left', 'center', 'right', 'justified', 'unknown']);
const PAGINATION_STATUSES = new Set<DocumentPaginationStatus>([
  'logical_fallback', 'unavailable', 'explicit_breaks', 'renderer_reported_breaks',
  'renderer_derived_physical', 'verified_physical',
]);
const PAGINATION_MECHANISMS = new Set<DocumentPaginationMechanism>([
  'none', 'wordprocessingml_breaks', 'wordprocessingml_last_rendered_breaks',
  'wordprocessingml_sections', 'local_renderer',
]);
const PAGINATION_PAGE_KINDS = new Set<DocumentPaginationPageKind>([
  'logical', 'explicit_break_segment', 'renderer_reported', 'renderer_derived_physical', 'verified_physical',
]);
const PAGINATION_BREAK_REASONS = new Set<DocumentPaginationBreakReason>([
  'document_start', 'explicit_page_break', 'last_rendered_page_break',
  'section_break', 'renderer_generated', 'unknown',
]);
const HEADER_FOOTER_KINDS = new Set(['header', 'footer']);
const HEADER_FOOTER_VARIANTS = new Set(['default', 'first', 'even']);
const SECTION_BREAK_TYPES = new Set(['nextPage', 'continuous', 'evenPage', 'oddPage']);
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

function imageHeaderFooter(value: unknown, label: string): DocumentStructureImageHeaderFooter {
  const item = object(value, label);
  exactKeys(item, ['kind', 'variant', 'partName', 'definingSectionIndex', 'inheritedSectionIndexes'], label);
  const kind = enumeration(item.kind, `${label} kind`, new Set(['header', 'footer'])) as 'header' | 'footer';
  const variant = enumeration(item.variant, `${label} variant`, HEADER_FOOTER_VARIANTS) as 'default' | 'first' | 'even';
  const definingSectionIndex = integer(item.definingSectionIndex, `${label} defining section`, 0, 10_000);
  const inherited = item.inheritedSectionIndexes === undefined
    ? undefined
    : array(item.inheritedSectionIndexes, `${label} inherited sections`, 1_000)
      .map((entry, index) => integer(entry, `${label} inherited section ${index}`, 0, 10_000));
  if (inherited) {
    if (new Set(inherited).size !== inherited.length) fail(`${label} inherited sections contain duplicates.`);
    if (inherited.includes(definingSectionIndex)) fail(`${label} inherited sections include its defining section.`);
  }
  return {
    kind,
    variant,
    partName: text(item.partName, `${label} part`, 1, 200),
    definingSectionIndex,
    ...(inherited ? { inheritedSectionIndexes: inherited } : {}),
  };
}

function imageAppearance(value: unknown, index: number, label: string, maxPage: number): DocumentImageAppearance {
  const item = object(value, `${label} appearance ${index}`);
  exactKeys(item, ['pageNumber', 'box', 'confidence'], `${label} appearance ${index}`);
  return {
    pageNumber: integer(item.pageNumber, `${label} appearance page`, 1, maxPage),
    ...(item.box === undefined ? {} : { box: geometryBox(item.box, `${label} appearance box`, IMAGE_GEOMETRY_SPACES) }),
    confidence: geometryConfidence(item.confidence, `${label} appearance confidence`),
  };
}

function imageMetadata(value: unknown, label: string, maxPage: number, limits: StructureLimits): DocumentStructureImage {
  const item = object(value, label);
  exactKeys(
    item,
    [
      'relationshipId', 'sourcePart', 'mediaPart', 'mimeType', 'external', 'originalWidthPx', 'originalHeightPx',
      'displayWidthPt', 'displayHeightPt', 'positioning', 'wrap', 'alternativeText', 'title', 'placementId',
      'sourceParagraphBlockId', 'sourceParagraphIndex', 'placementIndex', 'parentTableBlockId', 'parentRowBlockId',
      'parentCellBlockId', 'tableId', 'rowIndex', 'columnIndex', 'nestedTableDepth', 'headerFooter', 'appearances',
      'captionBlockId', 'captionText', 'warnings',
    ],
    label,
  );
  const external = boolean(item.external, `${label} external`);
  const mimeType = item.mimeType === undefined ? undefined : text(item.mimeType, `${label} MIME type`, 1, 100);
  if (mimeType && !/^image\/[A-Za-z0-9.+-]+$/.test(mimeType)) fail(`${label} MIME type is unsupported.`);
  const appearances = item.appearances === undefined
    ? undefined
    : array(item.appearances, `${label} appearances`, MAX_IMAGE_APPEARANCES)
      .map((entry, index) => imageAppearance(entry, index, label, maxPage));
  if (appearances) {
    if (new Set(appearances.map((entry) => entry.pageNumber)).size !== appearances.length) {
      fail(`${label} appearances contain duplicate pages.`);
    }
  }
  const parentTableBlockId = item.parentTableBlockId === undefined
    ? undefined
    : id(item.parentTableBlockId, `${label} parent table block`);
  const parentRowBlockId = item.parentRowBlockId === undefined
    ? undefined
    : id(item.parentRowBlockId, `${label} parent row block`);
  const parentCellBlockId = item.parentCellBlockId === undefined
    ? undefined
    : id(item.parentCellBlockId, `${label} parent cell block`);
  if ((parentTableBlockId || parentRowBlockId || parentCellBlockId)
    && !(parentTableBlockId && parentRowBlockId && parentCellBlockId)) {
    fail(`${label} table image parents must include table, row, and cell references.`);
  }
  if ((parentTableBlockId || parentRowBlockId || parentCellBlockId) && item.headerFooter !== undefined) {
    fail(`${label} cannot be both a table image and a header/footer image.`);
  }
  const nestedTableDepth = item.nestedTableDepth === undefined
    ? undefined
    : integer(item.nestedTableDepth, `${label} nested table depth`, 0, MAX_IMAGE_NESTED_TABLE_DEPTH);
  return {
    ...(item.relationshipId === undefined ? {} : { relationshipId: text(item.relationshipId, `${label} relationship`, 1, 80) }),
    sourcePart: text(item.sourcePart, `${label} source part`, 1, 200),
    ...(item.mediaPart === undefined ? {} : { mediaPart: text(item.mediaPart, `${label} media part`, 1, 200) }),
    ...(mimeType === undefined ? {} : { mimeType }),
    external,
    ...(item.originalWidthPx === undefined ? {} : { originalWidthPx: integer(item.originalWidthPx, `${label} original width`, 0, 1_000_000) }),
    ...(item.originalHeightPx === undefined ? {} : { originalHeightPx: integer(item.originalHeightPx, `${label} original height`, 0, 1_000_000) }),
    displayWidthPt: number(item.displayWidthPt, `${label} display width`, 0, 1_000_000),
    displayHeightPt: number(item.displayHeightPt, `${label} display height`, 0, 1_000_000),
    positioning: enumeration(item.positioning, `${label} positioning`, IMAGE_POSITIONINGS) as DocumentStructureImage['positioning'],
    wrap: enumeration(item.wrap, `${label} wrap`, IMAGE_WRAPS) as DocumentStructureImage['wrap'],
    ...(item.alternativeText === undefined ? {} : { alternativeText: text(item.alternativeText, `${label} alternative text`, 0, 2_000) }),
    ...(item.title === undefined ? {} : { title: text(item.title, `${label} title`, 0, 500) }),
    ...(item.placementId === undefined ? {} : { placementId: text(item.placementId, `${label} placement id`, 1, 300) }),
    ...(item.sourceParagraphBlockId === undefined ? {} : { sourceParagraphBlockId: id(item.sourceParagraphBlockId, `${label} source paragraph block`) }),
    ...(item.sourceParagraphIndex === undefined ? {} : { sourceParagraphIndex: integer(item.sourceParagraphIndex, `${label} source paragraph index`, 0, 1_000_000) }),
    ...(item.placementIndex === undefined ? {} : { placementIndex: integer(item.placementIndex, `${label} placement index`, 0, 1_000_000) }),
    ...(parentTableBlockId === undefined ? {} : { parentTableBlockId }),
    ...(parentRowBlockId === undefined ? {} : { parentRowBlockId }),
    ...(parentCellBlockId === undefined ? {} : { parentCellBlockId }),
    ...(item.tableId === undefined ? {} : { tableId: text(item.tableId, `${label} table id`, 1, 100) }),
    ...(item.rowIndex === undefined ? {} : { rowIndex: integer(item.rowIndex, `${label} row index`, 0, limits.maxTableRows) }),
    ...(item.columnIndex === undefined ? {} : { columnIndex: integer(item.columnIndex, `${label} column index`, 0, limits.maxTableCells) }),
    ...(nestedTableDepth === undefined ? {} : { nestedTableDepth }),
    ...(item.headerFooter === undefined ? {} : { headerFooter: imageHeaderFooter(item.headerFooter, `${label} header/footer`) }),
    ...(appearances ? { appearances } : {}),
    ...(item.captionBlockId === undefined ? {} : { captionBlockId: id(item.captionBlockId, `${label} caption block`) }),
    ...(item.captionText === undefined ? {} : { captionText: text(item.captionText, `${label} caption text`, 0, 1_000) }),
    warnings: warningList(item.warnings, `${label} warnings`, maxPage, limits.maxWarnings),
  };
}

function block(value: unknown, index: number, limits: StructureLimits, maxPage: number): DocumentStructureBlock {
  const label = `Structured block ${index}`;
  const item = object(value, label);
  exactKeys(
    item,
    ['blockId', 'type', 'text', 'pageId', 'pageNumber', 'order', 'parentId', 'children', 'boundingBox', 'confidence', 'provenance', 'layoutInferred', 'sourceRef', 'level', 'style', 'listMarker', 'tableId', 'rowIndex', 'columnIndex', 'rowSpan', 'columnSpan', 'columnBreakAfter', 'image', 'warnings'],
    label,
  );
  const type = enumeration(item.type, `${label} type`, BLOCK_TYPES);
  if (type === 'image' && item.image === undefined) fail(`${label} image block is missing image metadata.`);
  if (type !== 'image' && item.image !== undefined) fail(`${label} only image blocks may carry image metadata.`);
  const children = item.children === undefined
    ? undefined
    : array(item.children, `${label} children`, limits.maxBlocks).map((child, childIndex) => id(child, `${label} child ${childIndex}`));
  return {
    blockId: id(item.blockId, `${label} id`),
    type,
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
    ...(optionalBoolean(item.columnBreakAfter, `${label} column break after`) !== undefined
      ? { columnBreakAfter: optionalBoolean(item.columnBreakAfter, `${label} column break after`) }
      : {}),
    ...(item.image === undefined ? {} : { image: imageMetadata(item.image, `${label} image`, maxPage, limits) }),
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

function paginationMargins(value: unknown, label: string): DocumentPaginationInfo['pages'][number]['margins'] {
  const item = object(value, label);
  exactKeys(item, ['topPt', 'rightPt', 'bottomPt', 'leftPt', 'headerPt', 'footerPt'], label);
  return {
    topPt: number(item.topPt, `${label} top`, 0, 10_000),
    rightPt: number(item.rightPt, `${label} right`, 0, 10_000),
    bottomPt: number(item.bottomPt, `${label} bottom`, 0, 10_000),
    leftPt: number(item.leftPt, `${label} left`, 0, 10_000),
    ...(item.headerPt === undefined ? {} : { headerPt: number(item.headerPt, `${label} header`, 0, 10_000) }),
    ...(item.footerPt === undefined ? {} : { footerPt: number(item.footerPt, `${label} footer`, 0, 10_000) }),
  };
}

function geometryBox(
  value: unknown,
  label: string,
  spaces: ReadonlySet<string> = new Set(['renderer_page_content_points']),
): DocumentGeometryBox {
  const item = object(value, label);
  exactKeys(item, ['x', 'y', 'width', 'height', 'coordinateSpace'], label);
  if (typeof item.coordinateSpace !== 'string' || !spaces.has(item.coordinateSpace)) {
    fail(`${label} coordinate space is unsupported.`);
  }
  return {
    x: number(item.x, `${label} x`, 0, 1_000_000),
    y: number(item.y, `${label} y`, 0, 1_000_000),
    width: number(item.width, `${label} width`, 0, 1_000_000),
    height: number(item.height, `${label} height`, 0, 1_000_000),
    coordinateSpace: item.coordinateSpace as DocumentGeometryBox['coordinateSpace'],
  };
}
const IMAGE_GEOMETRY_SPACES = new Set(['renderer_page_content_points', 'renderer_page_points']);

function geometryConfidence(value: unknown, label: string): DocumentGeometryConfidence {
  return enumeration(value, label, GEOMETRY_CONFIDENCES);
}

function lineGeometry(value: unknown, index: number, label: string, maxPage: number): DocumentPaginationLineGeometry {
  const item = object(value, `${label} line ${index}`);
  exactKeys(item, ['lineIndex', 'pageNumber', 'fragmentIndex', 'box', 'columnIndex', 'confidence'], `${label} line ${index}`);
  return {
    lineIndex: integer(item.lineIndex, `${label} line index`, 0, 1_000_000),
    pageNumber: integer(item.pageNumber, `${label} line page`, 1, maxPage),
    fragmentIndex: integer(item.fragmentIndex, `${label} line fragment`, 0, 1_000_000),
    box: geometryBox(item.box, `${label} line box`),
    ...(item.columnIndex === undefined ? {} : { columnIndex: integer(item.columnIndex, `${label} line column`, 0, 64) }),
    confidence: geometryConfidence(item.confidence, `${label} line confidence`),
  };
}

function cellGeometry(value: unknown, index: number, label: string, maxPage: number, limits: StructureLimits): DocumentPaginationCellGeometry {
  const item = object(value, `${label} cell ${index}`);
  exactKeys(
    item,
    ['rowIndex', 'columnIndex', 'rowSpan', 'columnSpan', 'pageNumber', 'fragmentIndex', 'box', 'confidence', 'repeatedHeader'],
    `${label} cell ${index}`,
  );
  return {
    rowIndex: integer(item.rowIndex, `${label} cell row`, 0, limits.maxTableRows),
    columnIndex: integer(item.columnIndex, `${label} cell column`, 0, limits.maxTableCells),
    ...(item.rowSpan === undefined ? {} : { rowSpan: integer(item.rowSpan, `${label} cell row span`, 1, limits.maxTableRows) }),
    ...(item.columnSpan === undefined ? {} : { columnSpan: integer(item.columnSpan, `${label} cell column span`, 1, limits.maxTableCells) }),
    pageNumber: integer(item.pageNumber, `${label} cell page`, 1, maxPage),
    fragmentIndex: integer(item.fragmentIndex, `${label} cell fragment`, 0, 1_000_000),
    box: geometryBox(item.box, `${label} cell box`),
    confidence: geometryConfidence(item.confidence, `${label} cell confidence`),
    ...(optionalBoolean(item.repeatedHeader, `${label} cell repeated header`) !== undefined
      ? { repeatedHeader: optionalBoolean(item.repeatedHeader, `${label} cell repeated header`) }
      : {}),
  };
}

function rowGeometry(value: unknown, index: number, label: string, maxPage: number, limits: StructureLimits): DocumentPaginationRowGeometry {
  const item = object(value, `${label} row ${index}`);
  exactKeys(
    item,
    ['rowIndex', 'pageNumber', 'fragmentIndex', 'box', 'isHeaderRow', 'isHeaderRepeat', 'isContinuation', 'hasContinuation', 'confidence', 'cells'],
    `${label} row ${index}`,
  );
  const cells = item.cells === undefined
    ? undefined
    : array(item.cells, `${label} row cells`, limits.maxTableCells)
      .map((cell, cellIndex) => cellGeometry(cell, cellIndex, `${label} row ${index}`, maxPage, limits));
  return {
    rowIndex: integer(item.rowIndex, `${label} row index`, 0, limits.maxTableRows),
    pageNumber: integer(item.pageNumber, `${label} row page`, 1, maxPage),
    fragmentIndex: integer(item.fragmentIndex, `${label} row fragment`, 0, 1_000_000),
    box: geometryBox(item.box, `${label} row box`),
    ...(optionalBoolean(item.isHeaderRow, `${label} row header`) !== undefined ? { isHeaderRow: optionalBoolean(item.isHeaderRow, `${label} row header`) } : {}),
    ...(optionalBoolean(item.isHeaderRepeat, `${label} row repeated header`) !== undefined ? { isHeaderRepeat: optionalBoolean(item.isHeaderRepeat, `${label} row repeated header`) } : {}),
    ...(optionalBoolean(item.isContinuation, `${label} row continuation`) !== undefined ? { isContinuation: optionalBoolean(item.isContinuation, `${label} row continuation`) } : {}),
    ...(optionalBoolean(item.hasContinuation, `${label} row has continuation`) !== undefined ? { hasContinuation: optionalBoolean(item.hasContinuation, `${label} row has continuation`) } : {}),
    confidence: geometryConfidence(item.confidence, `${label} row confidence`),
    ...(cells ? { cells } : {}),
  };
}

function columnGeometry(value: unknown, index: number, label: string, maxPage: number): DocumentPaginationColumnGeometry {
  const item = object(value, `${label} column ${index}`);
  exactKeys(
    item,
    ['pageNumber', 'columnIndex', 'sectionIndex', 'box', 'widthPt', 'heightPt', 'confidence', 'source'],
    `${label} column ${index}`,
  );
  const source = enumeration(item.source, `${label} column source`, new Set(['section_properties', 'renderer_content', 'mixed']));
  return {
    pageNumber: integer(item.pageNumber, `${label} column page`, 1, maxPage),
    columnIndex: integer(item.columnIndex, `${label} column index`, 0, 64),
    ...(item.sectionIndex === undefined ? {} : { sectionIndex: integer(item.sectionIndex, `${label} column section`, 0, 10_000) }),
    box: geometryBox(item.box, `${label} column box`),
    widthPt: number(item.widthPt, `${label} column width`, 0, 1_000_000),
    heightPt: number(item.heightPt, `${label} column height`, 0, 1_000_000),
    confidence: geometryConfidence(item.confidence, `${label} column confidence`),
    source: source as DocumentPaginationColumnGeometry['source'],
  };
}

function fontFaceResolution(value: unknown, index: number, label: string): DocumentFontFaceResolution {
  const item = object(value, `${label} face ${index}`);
  exactKeys(
    item,
    ['weight', 'style', 'requestedFamily', 'resolvedFamily', 'source', 'exact', 'substituted', 'embedded', 'identity', 'warning'],
    `${label} face ${index}`,
  );
  return {
    weight: integer(item.weight, `${label} face weight`, 1, 1_000),
    style: enumeration(item.style, `${label} face style`, new Set(['normal', 'italic'])) as 'normal' | 'italic',
    requestedFamily: text(item.requestedFamily, `${label} face requested family`, 1, 200),
    ...(item.resolvedFamily === undefined ? {} : { resolvedFamily: text(item.resolvedFamily, `${label} face resolved family`, 1, 200) }),
    source: enumeration(item.source, `${label} face source`, FONT_SOURCES),
    exact: boolean(item.exact, `${label} face exact`),
    substituted: boolean(item.substituted, `${label} face substituted`),
    embedded: boolean(item.embedded, `${label} face embedded`),
    ...(item.identity === undefined ? {} : { identity: text(item.identity, `${label} face identity`, 1, 200) }),
    ...(item.warning === undefined ? {} : { warning: text(item.warning, `${label} face warning`, 1, 500) }),
  };
}

function fontResolution(value: unknown, index: number, label: string): DocumentFontResolution {
  const item = object(value, `${label} font ${index}`);
  exactKeys(item, ['requestedFamily', 'resolvedFamily', 'source', 'exact', 'substituted', 'embedded', 'coverage', 'faces', 'warnings'], `${label} font ${index}`);
  return {
    requestedFamily: text(item.requestedFamily, `${label} font requested family`, 1, 200),
    ...(item.resolvedFamily === undefined ? {} : { resolvedFamily: text(item.resolvedFamily, `${label} font resolved family`, 1, 200) }),
    source: enumeration(item.source, `${label} font source`, FONT_SOURCES),
    exact: boolean(item.exact, `${label} font exact`),
    substituted: boolean(item.substituted, `${label} font substituted`),
    embedded: boolean(item.embedded, `${label} font embedded`),
    coverage: enumeration(item.coverage, `${label} font coverage`, new Set(['complete', 'partial', 'none'])) as DocumentFontResolution['coverage'],
    faces: array(item.faces, `${label} font faces`, 8).map((face, faceIndex) => fontFaceResolution(face, faceIndex, `${label} font ${index}`)),
    warnings: array(item.warnings, `${label} font warnings`, 16).map((warning, warningIndex) => text(warning, `${label} font warning ${warningIndex}`, 1, 500)),
  };
}

function embeddedFont(value: unknown, index: number, label: string): DocumentEmbeddedFont {
  const item = object(value, `${label} embedded font ${index}`);
  exactKeys(item, ['family', 'style', 'partName', 'relationshipId', 'fontKey', 'status', 'warning'], `${label} embedded font ${index}`);
  return {
    family: text(item.family, `${label} embedded font family`, 1, 200),
    style: enumeration(item.style, `${label} embedded font style`, new Set(['regular', 'bold', 'italic', 'boldItalic'])) as DocumentEmbeddedFont['style'],
    ...(item.partName === undefined ? {} : { partName: text(item.partName, `${label} embedded font part`, 1, 200) }),
    ...(item.relationshipId === undefined ? {} : { relationshipId: text(item.relationshipId, `${label} embedded font relationship`, 1, 80) }),
    ...(item.fontKey === undefined ? {} : { fontKey: text(item.fontKey, `${label} embedded font key`, 1, 80) }),
    status: enumeration(item.status, `${label} embedded font status`, new Set(['declared', 'used', 'dropped', 'oversize', 'malformed'])) as DocumentEmbeddedFont['status'],
    ...(item.warning === undefined ? {} : { warning: text(item.warning, `${label} embedded font warning`, 1, 500) }),
  };
}

function themeFonts(value: unknown, label: string): DocumentThemeFonts {
  const item = object(value, label);
  exactKeys(item, ['major', 'minor', 'majorEastAsia', 'minorEastAsia'], label);
  return {
    ...(item.major === undefined ? {} : { major: text(item.major, `${label} major`, 1, 200) }),
    ...(item.minor === undefined ? {} : { minor: text(item.minor, `${label} minor`, 1, 200) }),
    ...(item.majorEastAsia === undefined ? {} : { majorEastAsia: text(item.majorEastAsia, `${label} major East Asia`, 1, 200) }),
    ...(item.minorEastAsia === undefined ? {} : { minorEastAsia: text(item.minorEastAsia, `${label} minor East Asia`, 1, 200) }),
  };
}

function docxColumns(value: unknown, label: string): DocumentStructureDocxColumns {
  const item = object(value, label);
  exactKeys(item, ['count', 'equalWidth', 'gapPt', 'separator', 'widthsPt', 'gapsPt', 'rightToLeft'], label);
  const count = integer(item.count, `${label} count`, 1, 100);
  const widths = item.widthsPt === undefined ? undefined : array(item.widthsPt, `${label} widths`, 100)
    .map((width, index) => number(width, `${label} width ${index}`, 0, 1_000_000));
  const gaps = item.gapsPt === undefined ? undefined : array(item.gapsPt, `${label} gaps`, 100)
    .map((gap, index) => number(gap, `${label} gap ${index}`, 0, 1_000_000));
  if (widths && widths.length !== count) fail(`${label} width count is inconsistent.`);
  if (gaps && gaps.length !== count) fail(`${label} gap count is inconsistent.`);
  return {
    count,
    equalWidth: boolean(item.equalWidth, `${label} equal width`),
    gapPt: number(item.gapPt, `${label} gap`, 0, 1_000_000),
    separator: boolean(item.separator, `${label} separator`),
    ...(widths ? { widthsPt: widths } : {}),
    ...(gaps ? { gapsPt: gaps } : {}),
    ...(optionalBoolean(item.rightToLeft, `${label} right to left`) !== undefined
      ? { rightToLeft: optionalBoolean(item.rightToLeft, `${label} right to left`) }
      : {}),
  };
}

function headerFooterReference(
  value: unknown,
  label: string,
  kind: 'header' | 'footer',
  sectionIndex: number,
  blockIds: Set<string>,
  maxBlocks: number,
): DocumentStructureHeaderFooterReference {
  const item = object(value, label);
  exactKeys(
    item,
    ['kind', 'variant', 'relationshipId', 'partName', 'inherited', 'definingSectionIndex', 'blockIds'],
    label,
  );
  const actualKind = enumeration(item.kind, `${label} kind`, HEADER_FOOTER_KINDS) as 'header' | 'footer';
  if (actualKind !== kind) fail(`${label} kind is inconsistent with its section collection.`);
  const definingSectionIndex = integer(item.definingSectionIndex, `${label} defining section`, 0, sectionIndex);
  const referenceBlocks = array(item.blockIds, `${label} blocks`, maxBlocks).map((entry, index) => {
    const blockId = id(entry, `${label} block ${index}`);
    if (!blockIds.has(blockId)) fail(`${label} references an unknown block.`);
    return blockId;
  });
  if (new Set(referenceBlocks).size !== referenceBlocks.length) fail(`${label} contains duplicate blocks.`);
  return {
    kind,
    variant: enumeration(item.variant, `${label} variant`, HEADER_FOOTER_VARIANTS) as 'default' | 'first' | 'even',
    ...(item.relationshipId === undefined ? {} : { relationshipId: text(item.relationshipId, `${label} relationship`, 1, 80) }),
    ...(item.partName === undefined ? {} : { partName: text(item.partName, `${label} part`, 1, 200) }),
    inherited: boolean(item.inherited, `${label} inherited`),
    definingSectionIndex,
    blockIds: referenceBlocks,
  };
}

function docxLayoutInfo(
  value: unknown,
  limits: StructureLimits,
  blockIds: Set<string>,
): DocumentStructureDocxLayout {
  const item = object(value, 'DOCX layout metadata');
  exactKeys(item, ['evenAndOddHeaders', 'sections', 'fonts', 'embeddedFonts', 'themeFonts'], 'DOCX layout metadata');
  const sections = array(item.sections, 'DOCX layout sections', limits.maxSections).map((entry, index): DocumentStructureDocxSection => {
    const label = `DOCX layout section ${index}`;
    const sectionObject = object(entry, label);
    exactKeys(
      sectionObject,
      [
        'sectionIndex', 'breakType', 'pageWidthPt', 'pageHeightPt', 'orientation', 'margins',
        'columnCount', 'columns', 'columnBreakCount', 'titlePage', 'pageNumberStart', 'pageNumberFormat', 'headers', 'footers',
      ],
      label,
    );
    const sectionIndex = integer(sectionObject.sectionIndex, `${label} index`, 0, limits.maxSections - 1);
    if (sectionIndex !== index) fail(`${label} is out of order.`);
    const headers = array(sectionObject.headers, `${label} headers`, 3)
      .map((reference, referenceIndex) => headerFooterReference(reference, `${label} header ${referenceIndex}`, 'header', sectionIndex, blockIds, limits.maxBlocks));
    const footers = array(sectionObject.footers, `${label} footers`, 3)
      .map((reference, referenceIndex) => headerFooterReference(reference, `${label} footer ${referenceIndex}`, 'footer', sectionIndex, blockIds, limits.maxBlocks));
    for (const references of [headers, footers]) {
      if (new Set(references.map((reference) => reference.variant)).size !== references.length) {
        fail(`${label} contains duplicate header/footer variants.`);
      }
    }
    return {
      sectionIndex,
      breakType: enumeration(sectionObject.breakType, `${label} break type`, SECTION_BREAK_TYPES) as DocumentStructureDocxSection['breakType'],
      pageWidthPt: number(sectionObject.pageWidthPt, `${label} page width`, 1, 1_000_000),
      pageHeightPt: number(sectionObject.pageHeightPt, `${label} page height`, 1, 1_000_000),
      orientation: enumeration(sectionObject.orientation, `${label} orientation`, new Set(['portrait', 'landscape'])) as 'portrait' | 'landscape',
      margins: paginationMargins(sectionObject.margins, `${label} margins`)!,
      ...(sectionObject.columnCount === undefined ? {} : { columnCount: integer(sectionObject.columnCount, `${label} column count`, 1, 100) }),
      ...(sectionObject.columns === undefined ? {} : { columns: docxColumns(sectionObject.columns, `${label} columns`) }),
      ...(sectionObject.columnBreakCount === undefined ? {} : { columnBreakCount: integer(sectionObject.columnBreakCount, `${label} column break count`, 0, 1_000_000) }),
      ...(sectionObject.titlePage === undefined ? {} : { titlePage: boolean(sectionObject.titlePage, `${label} title page`) }),
      ...(sectionObject.pageNumberStart === undefined ? {} : { pageNumberStart: integer(sectionObject.pageNumberStart, `${label} page number start`, 1, 1_000_000_000) }),
      ...(sectionObject.pageNumberFormat === undefined ? {} : { pageNumberFormat: text(sectionObject.pageNumberFormat, `${label} page number format`, 1, 32) }),
      headers,
      footers,
    };
  });
  return {
    evenAndOddHeaders: boolean(item.evenAndOddHeaders, 'DOCX even/odd headers flag'),
    sections,
    ...(item.fonts === undefined ? {} : {
      fonts: array(item.fonts, 'DOCX font resolutions', 256).map((font, index) => fontResolution(font, index, 'DOCX')),
    }),
    ...(item.embeddedFonts === undefined ? {} : {
      embeddedFonts: array(item.embeddedFonts, 'DOCX embedded fonts', 64).map((font, index) => embeddedFont(font, index, 'DOCX')),
    }),
    ...(item.themeFonts === undefined ? {} : { themeFonts: themeFonts(item.themeFonts, 'DOCX theme fonts') }),
  };
}

function paginationInfo(
  value: unknown,
  limits: StructureLimits,
  blockIds: Set<string>,
  maxPage: number,
): DocumentPaginationInfo {
  const item = object(value, 'Document pagination');
  exactKeys(item, ['status', 'mechanism', 'pageCount', 'pages', 'blockPages', 'warnings', 'renderer', 'geometry'], 'Document pagination');
  const status = enumeration(item.status, 'Document pagination status', PAGINATION_STATUSES);
  const mechanism = enumeration(item.mechanism, 'Document pagination mechanism', PAGINATION_MECHANISMS);
  const pageCount = integer(item.pageCount, 'Document pagination page count', 0, maxPage);
  let geometryLineCount = 0;
  let geometryCellCount = 0;
  let geometryColumnCount = 0;
  const geometryEntries = () => geometryLineCount + geometryCellCount + geometryColumnCount;
  const pages = array(item.pages, 'Document pagination pages', limits.maxPages).map((entry, index) => {
    const label = `Document pagination page ${index}`;
    const page = object(entry, label);
    exactKeys(
      page,
      ['pageNumber', 'pageKind', 'blockIds', 'breakReason', 'pageWidthPt', 'pageHeightPt', 'orientation', 'margins', 'sectionIndex', 'sectionIndexApproximate', 'columnCount', 'columns'],
      label,
    );
    const pageBlockIds = array(page.blockIds, `${label} block ids`, limits.maxBlocks)
      .map((blockId, blockIndex) => {
        const parsed = id(blockId, `${label} block ${blockIndex}`);
        if (!blockIds.has(parsed)) fail(`${label} references an unknown block.`);
        return parsed;
      });
    let margins;
    if (page.margins !== undefined) {
      const value = object(page.margins, `${label} margins`);
      exactKeys(value, ['topPt', 'rightPt', 'bottomPt', 'leftPt', 'headerPt', 'footerPt'], `${label} margins`);
      margins = {
        topPt: number(value.topPt, `${label} top margin`, 0, 10_000),
        rightPt: number(value.rightPt, `${label} right margin`, 0, 10_000),
        bottomPt: number(value.bottomPt, `${label} bottom margin`, 0, 10_000),
        leftPt: number(value.leftPt, `${label} left margin`, 0, 10_000),
        ...(value.headerPt === undefined ? {} : { headerPt: number(value.headerPt, `${label} header margin`, 0, 10_000) }),
        ...(value.footerPt === undefined ? {} : { footerPt: number(value.footerPt, `${label} footer margin`, 0, 10_000) }),
      };
    }
    const orientation = page.orientation === undefined
      ? undefined
      : enumeration(page.orientation, `${label} orientation`, new Set(['portrait', 'landscape']));
    const columns = page.columns === undefined
      ? undefined
      : array(page.columns, `${label} columns`, 64).map((column, columnIndex) => {
        const parsed = columnGeometry(column, columnIndex, label, maxPage);
        if (parsed.pageNumber !== integer(page.pageNumber, `${label} number`, 1, pageCount || maxPage)) {
          fail(`${label} column references a different page.`);
        }
        return parsed;
      });
    if (columns) {
      geometryColumnCount += columns.length;
      if (geometryEntries() > MAX_PAGINATION_GEOMETRY_ENTRIES) fail(`${label} geometry exceeds the supported limit.`);
      if (new Set(columns.map((column) => column.columnIndex)).size !== columns.length) {
        fail(`${label} contains duplicate column indices.`);
      }
    }
    return {
      pageNumber: integer(page.pageNumber, `${label} number`, 1, pageCount || maxPage),
      pageKind: enumeration(page.pageKind, `${label} kind`, PAGINATION_PAGE_KINDS),
      blockIds: pageBlockIds,
      breakReason: enumeration(page.breakReason, `${label} break reason`, PAGINATION_BREAK_REASONS),
      ...(page.pageWidthPt === undefined ? {} : { pageWidthPt: number(page.pageWidthPt, `${label} width`, 1, 1_000_000) }),
      ...(page.pageHeightPt === undefined ? {} : { pageHeightPt: number(page.pageHeightPt, `${label} height`, 1, 1_000_000) }),
      ...(orientation ? { orientation } : {}),
      ...(margins ? { margins } : {}),
      ...(page.sectionIndex === undefined ? {} : { sectionIndex: integer(page.sectionIndex, `${label} section`, 0, 10_000) }),
      ...(optionalBoolean(page.sectionIndexApproximate, `${label} section approximate`) !== undefined
        ? { sectionIndexApproximate: optionalBoolean(page.sectionIndexApproximate, `${label} section approximate`) }
        : {}),
      ...(page.columnCount === undefined ? {} : { columnCount: integer(page.columnCount, `${label} column count`, 1, 64) }),
      ...(columns ? { columns } : {}),
    };
  });
  if (pages.length && pages.length !== pageCount) fail('Document pagination page count is inconsistent.');
  if (new Set(pages.map((page) => page.pageNumber)).size !== pages.length) fail('Document pagination contains duplicate page numbers.');
  const blockPages = array(item.blockPages, 'Document pagination block pages', limits.maxBlocks).map((entry, index) => {
    const label = `Document pagination block ${index}`;
    const entryObject = object(entry, label);
    exactKeys(
      entryObject,
      [
        'blockId', 'startPageNumber', 'endPageNumber', 'fragmentPages', 'approximate', 'geometryConfidence',
        'boundingBox', 'lines', 'tableRows', 'rowIndex', 'columnIndex', 'rowSpan', 'columnSpan',
      ],
      label,
    );
    const blockId = id(entryObject.blockId, `${label} block id`);
    if (!blockIds.has(blockId)) fail(`${label} references an unknown block.`);
    const startPageNumber = integer(entryObject.startPageNumber, `${label} start page`, 1, maxPage);
    const endPageNumber = entryObject.endPageNumber === undefined
      ? undefined
      : integer(entryObject.endPageNumber, `${label} end page`, 1, maxPage);
    if (endPageNumber !== undefined && endPageNumber < startPageNumber) fail(`${label} page range is inverted.`);
    if (pageCount > 0 && (startPageNumber > pageCount || (endPageNumber !== undefined && endPageNumber > pageCount))) {
      fail(`${label} references a page beyond the pagination page count.`);
    }
    const fragmentPages = entryObject.fragmentPages === undefined
      ? undefined
      : array(entryObject.fragmentPages, `${label} fragment pages`, limits.maxPages).map((fragment, fragmentIndex) => {
        const fragmentLabel = `${label} fragment page ${fragmentIndex}`;
        const fragmentObject = object(fragment, fragmentLabel);
        exactKeys(fragmentObject, ['pageNumber', 'fragmentIndex'], fragmentLabel);
        return {
          pageNumber: integer(fragmentObject.pageNumber, `${fragmentLabel} page`, 1, pageCount || maxPage),
          ...(fragmentObject.fragmentIndex === undefined
            ? {}
            : { fragmentIndex: integer(fragmentObject.fragmentIndex, `${fragmentLabel} index`, 0, 1_000_000) }),
        };
      });
    const lines = entryObject.lines === undefined
      ? undefined
      : array(entryObject.lines, `${label} lines`, MAX_PAGINATION_LINES_PER_BLOCK)
        .map((line, lineIndex) => lineGeometry(line, lineIndex, label, pageCount || maxPage));
    if (lines) {
      geometryLineCount += lines.length;
      if (geometryEntries() > MAX_PAGINATION_GEOMETRY_ENTRIES) fail(`${label} geometry exceeds the supported limit.`);
    }
    const tableRows = entryObject.tableRows === undefined
      ? undefined
      : array(entryObject.tableRows, `${label} table rows`, limits.maxTableRows)
        .map((row, rowIndex) => rowGeometry(row, rowIndex, label, pageCount || maxPage, limits));
    if (tableRows) {
      for (const row of tableRows) {
        geometryCellCount += row.cells?.length ?? 0;
      }
      if (geometryEntries() > MAX_PAGINATION_GEOMETRY_ENTRIES) fail(`${label} geometry exceeds the supported limit.`);
    }
    return {
      blockId,
      startPageNumber,
      ...(endPageNumber !== undefined ? { endPageNumber } : {}),
      ...(fragmentPages ? { fragmentPages } : {}),
      ...(optionalBoolean(entryObject.approximate, `${label} approximate`) !== undefined
        ? { approximate: optionalBoolean(entryObject.approximate, `${label} approximate`) }
        : {}),
      ...(entryObject.geometryConfidence === undefined
        ? {}
        : { geometryConfidence: geometryConfidence(entryObject.geometryConfidence, `${label} geometry confidence`) }),
      ...(entryObject.boundingBox === undefined ? {} : {
        boundingBox: geometryBox(entryObject.boundingBox, `${label} bounding box`, IMAGE_GEOMETRY_SPACES),
      }),
      ...(lines ? { lines } : {}),
      ...(tableRows ? { tableRows } : {}),
      ...(entryObject.rowIndex === undefined ? {} : { rowIndex: integer(entryObject.rowIndex, `${label} row index`, 0, limits.maxTableRows) }),
      ...(entryObject.columnIndex === undefined ? {} : { columnIndex: integer(entryObject.columnIndex, `${label} column index`, 0, limits.maxTableCells) }),
      ...(entryObject.rowSpan === undefined ? {} : { rowSpan: integer(entryObject.rowSpan, `${label} row span`, 1, limits.maxTableRows) }),
      ...(entryObject.columnSpan === undefined ? {} : { columnSpan: integer(entryObject.columnSpan, `${label} column span`, 1, limits.maxTableCells) }),
    };
  });
  if (new Set(blockPages.map((entry) => entry.blockId)).size !== blockPages.length) fail('Document pagination contains duplicate block page entries.');
  let geometry;
  if (item.geometry !== undefined) {
    const value = object(item.geometry, 'Document pagination geometry');
    exactKeys(value, ['lineCount', 'cellCount', 'columnCount', 'truncated'], 'Document pagination geometry');
    geometry = {
      lineCount: integer(value.lineCount, 'Document pagination geometry line count', 0, MAX_PAGINATION_GEOMETRY_ENTRIES),
      cellCount: integer(value.cellCount, 'Document pagination geometry cell count', 0, MAX_PAGINATION_GEOMETRY_ENTRIES),
      columnCount: integer(value.columnCount, 'Document pagination geometry column count', 0, MAX_PAGINATION_GEOMETRY_ENTRIES),
      truncated: boolean(value.truncated, 'Document pagination geometry truncated'),
    };
    if (geometry.lineCount !== geometryLineCount || geometry.cellCount !== geometryCellCount || geometry.columnCount !== geometryColumnCount) {
      fail('Document pagination geometry counts are inconsistent.');
    }
  }
  return {
    status,
    mechanism,
    pageCount,
    pages,
    blockPages,
    warnings: warningList(item.warnings, 'Document pagination warnings', maxPage, limits.maxWarnings),
    ...(item.renderer === undefined ? {} : { renderer: text(item.renderer, 'Document pagination renderer', 1, 200) }),
    ...(geometry ? { geometry } : {}),
  };
}

export function validateDocumentStructure(
  value: unknown,
  limits: StructureLimits = STRUCTURE_LIMITS,
): DocumentStructure {
  const structure = object(value, 'Document structure');
  exactKeys(
    structure,
    ['schemaVersion', 'extractionVersion', 'documentFormat', 'pageSemantics', 'pages', 'blocks', 'sections', 'tables', 'readingOrder', 'warnings', 'metadata', 'pagination', 'docxLayout'],
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
  const imagePlacementIds = new Set<string>();
  let imageCount = 0;
  for (const item of blocks) {
    if (!item.image) continue;
    imageCount += 1;
    if (imageCount > MAX_STRUCTURE_IMAGES) fail('Document structure contains too many image blocks.');
    if (item.type !== 'image') fail('Document structure image metadata is attached to a non-image block.');
    if (item.image.placementId) {
      if (imagePlacementIds.has(item.image.placementId)) fail('Document structure contains duplicate image placement ids.');
      imagePlacementIds.add(item.image.placementId);
    }
    if (item.image.captionBlockId) {
      const caption = blockById.get(item.image.captionBlockId);
      if (!caption || !['paragraph', 'caption', 'header', 'footer'].includes(caption.type)) {
        fail('Document structure image caption does not reference a text block.');
      }
    }
    if (item.image.sourceParagraphBlockId) {
      const source = blockById.get(item.image.sourceParagraphBlockId);
      if (!source || !['paragraph', 'heading', 'table_cell', 'header', 'footer'].includes(source.type)) {
        fail('Document structure image source block is invalid.');
      }
    }
    const { parentTableBlockId, parentRowBlockId, parentCellBlockId } = item.image;
    if (parentTableBlockId && parentRowBlockId && parentCellBlockId) {
      const table = blockById.get(parentTableBlockId);
      const row = blockById.get(parentRowBlockId);
      const cell = blockById.get(parentCellBlockId);
      if (!table || table.type !== 'table') fail('Document structure image references an unknown parent table.');
      if (!row || row.type !== 'table_row' || row.parentId !== table.blockId) {
        fail('Document structure image references an invalid parent row.');
      }
      if (!cell || cell.type !== 'table_cell' || cell.parentId !== row.blockId) {
        fail('Document structure image references an invalid parent cell.');
      }
      if (item.parentId !== cell.blockId) fail('Document structure table image must be a child of its parent cell.');
      if (item.image.tableId !== table.tableId) fail('Document structure image table id is inconsistent.');
      if (item.image.rowIndex !== row.rowIndex) fail('Document structure image row index is inconsistent.');
      if (item.image.columnIndex !== cell.columnIndex) fail('Document structure image column index is inconsistent.');
      if (item.image.headerFooter) fail('Document structure table image also carries header/footer metadata.');
    } else if (parentTableBlockId || parentRowBlockId || parentCellBlockId) {
      fail('Document structure image table parents are incomplete.');
    } else if (item.image.nestedTableDepth !== undefined) {
      fail('Document structure image nested depth requires a parent cell.');
    }
    if (item.image.headerFooter) {
      if (item.parentId) fail('Document structure header/footer image cannot have a parent block.');
      if (item.image.sourceParagraphBlockId) {
        const source = blockById.get(item.image.sourceParagraphBlockId);
        if (!source || (source.type !== 'header' && source.type !== 'footer')) {
          fail('Document structure header/footer image source block is invalid.');
        }
      }
    }
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

  const pagination = structure.pagination === undefined
    ? undefined
    : paginationInfo(structure.pagination, limits, blockIds, limits.maxPages);
  const docxLayout = structure.docxLayout === undefined
    ? undefined
    : docxLayoutInfo(structure.docxLayout, limits, blockIds);
  if (docxLayout && documentFormat !== 'docx') fail('DOCX layout metadata is only valid for DOCX structure.');
  for (const item of blocks) {
    if (!item.image) continue;
    if (item.image.appearances) {
      if (!pagination) fail('Document structure image appearances require pagination metadata.');
      for (const appearance of item.image.appearances) {
        if (appearance.pageNumber > pagination!.pageCount) {
          fail('Document structure image appearance references a page outside the pagination.');
        }
      }
    }
    if (item.image.headerFooter) {
      if (!docxLayout) fail('Document structure header/footer image requires DOCX layout metadata.');
      const headerFooter = item.image.headerFooter;
      const section = docxLayout!.sections[headerFooter.definingSectionIndex];
      if (!section) fail('Document structure header/footer image references an unknown defining section.');
      const references = [...section.headers, ...section.footers];
      const defining = references.find((reference) => (
        reference.kind === headerFooter.kind
        && reference.variant === headerFooter.variant
        && reference.partName === headerFooter.partName
        && reference.definingSectionIndex === headerFooter.definingSectionIndex
        && reference.inherited === false
      ));
      if (!defining) fail('Document structure header/footer image does not match its defining section reference.');
      for (const inheritedSectionIndex of headerFooter.inheritedSectionIndexes ?? []) {
        const inheritedSection = docxLayout!.sections[inheritedSectionIndex];
        if (!inheritedSection) fail('Document structure header/footer image references an unknown inherited section.');
        const inherited = [...inheritedSection.headers, ...inheritedSection.footers].find((reference) => (
          reference.kind === headerFooter.kind
          && reference.variant === headerFooter.variant
          && reference.partName === headerFooter.partName
          && reference.definingSectionIndex === headerFooter.definingSectionIndex
          && reference.inherited === true
        ));
        if (!inherited) fail('Document structure header/footer image inheritance is inconsistent.');
      }
    }
  }

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
    ...(pagination ? { pagination } : {}),
    ...(docxLayout ? { docxLayout } : {}),
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
