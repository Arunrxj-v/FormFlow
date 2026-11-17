import {
  DOCUMENT_STRUCTURE_SCHEMA_VERSION,
  MAX_STRUCTURE_BLOCKS,
  MAX_STRUCTURE_BOUNDING_BOXES,
  MAX_STRUCTURE_TEXT_CHARS,
} from '@shared/constants';
import type {
  DocumentBlockType,
  DocumentExtractionProvenance,
  DocumentPageExtractionMethod,
  DocumentPageSemantics,
  DocumentPageType,
  DocumentPaginationInfo,
  DocumentStructure,
  DocumentStructureBlock,
  DocumentStructureDocxLayout,
  DocumentStructureBoundingBox,
  DocumentStructurePage,
  DocumentStructurePageBounds,
  DocumentStructureSection,
  DocumentStructureTable,
  DocumentStructureTextStyle,
  ExtractionWarning,
} from '@shared/types';
import { sanitizeWarnings } from './text-utils';

export interface StructureDraft {
  extractionVersion: number;
  documentFormat: DocumentStructure['documentFormat'];
  pageSemantics: DocumentPageSemantics;
  pages: DocumentStructurePage[];
  blocks: DocumentStructureBlock[];
  warnings: ExtractionWarning[];
  pagination?: DocumentPaginationInfo;
  docxLayout?: DocumentStructureDocxLayout;
}

export function structureBlockId(pageNumber: number, index: number, suffix?: string): string {
  return `p${pageNumber}_b${index}${suffix ? `_${suffix}` : ''}`;
}

export function structurePageId(pageNumber: number): string {
  return `p${pageNumber}`;
}

export function structurePage(input: {
  pageNumber: number;
  pageKind: DocumentPageSemantics;
  pageType: DocumentPageType;
  extractionMethod: DocumentPageExtractionMethod;
  blockIds: string[];
  pageBounds?: DocumentStructurePageBounds;
  conversion?: DocumentStructurePage['conversion'];
  warnings?: ExtractionWarning[];
}): DocumentStructurePage {
  return {
    pageId: structurePageId(input.pageNumber),
    pageNumber: input.pageNumber,
    pageKind: input.pageKind,
    pageType: input.pageType,
    extractionMethod: input.extractionMethod,
    blockIds: [...input.blockIds],
    ...(input.pageBounds ? { pageBounds: input.pageBounds } : {}),
    ...(input.conversion ? { conversion: input.conversion } : {}),
    ...(input.warnings ? { warnings: input.warnings } : {}),
  };
}

export function structureBlock(input: {
  blockId: string;
  type: DocumentBlockType;
  text: string;
  pageNumber: number;
  order: number;
  parentId?: string;
  children?: string[];
  boundingBox?: DocumentStructureBoundingBox;
  confidence?: number;
  provenance: DocumentExtractionProvenance;
  layoutInferred?: boolean;
  sourceRef?: string;
  level?: number;
  style?: DocumentStructureTextStyle;
  listMarker?: string;
  tableId?: string;
  rowIndex?: number;
  columnIndex?: number;
  rowSpan?: number;
  columnSpan?: number;
  columnBreakAfter?: boolean;
  image?: DocumentStructureBlock['image'];
  warnings?: ExtractionWarning[];
}): DocumentStructureBlock {
  return {
    blockId: input.blockId,
    type: input.type,
    text: input.text,
    pageId: structurePageId(input.pageNumber),
    pageNumber: input.pageNumber,
    order: input.order,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.children?.length ? { children: [...input.children] } : {}),
    ...(input.boundingBox ? { boundingBox: input.boundingBox } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    provenance: input.provenance,
    ...(input.layoutInferred ? { layoutInferred: true } : {}),
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    ...(input.level !== undefined ? { level: input.level } : {}),
    ...(input.style && Object.keys(input.style).length ? { style: input.style } : {}),
    ...(input.listMarker ? { listMarker: input.listMarker } : {}),
    ...(input.tableId ? { tableId: input.tableId } : {}),
    ...(input.rowIndex !== undefined ? { rowIndex: input.rowIndex } : {}),
    ...(input.columnIndex !== undefined ? { columnIndex: input.columnIndex } : {}),
    ...(input.rowSpan !== undefined ? { rowSpan: input.rowSpan } : {}),
    ...(input.columnSpan !== undefined ? { columnSpan: input.columnSpan } : {}),
    ...(input.columnBreakAfter ? { columnBreakAfter: true } : {}),
    ...(input.image ? { image: input.image } : {}),
    ...(input.warnings?.length ? { warnings: input.warnings } : {}),
  };
}

function deriveSections(blocks: Map<string, DocumentStructureBlock>, readingOrder: string[]): DocumentStructureSection[] {
  const sections: DocumentStructureSection[] = [];
  let current: DocumentStructureSection | null = null;
  let counter = 0;
  const stack: DocumentStructureSection[] = [];
  const flush = () => {
    if (!current || current.blockIds.length === 0) return;
    sections.push(current);
  };
  for (const blockId of readingOrder) {
    const block = blocks.get(blockId);
    if (!block) continue;
    if (block.type === 'heading') {
      flush();
      counter += 1;
      while (stack.length && stack[stack.length - 1]!.level >= (block.level ?? 1)) stack.pop();
      const section: DocumentStructureSection = {
        sectionId: `s${counter}`,
        headingBlockId: block.blockId,
        level: block.level ?? 1,
        title: block.text.slice(0, 500),
        blockIds: [block.blockId],
        pageStart: block.pageNumber,
        pageEnd: block.pageNumber,
        ...(stack.length ? { parentSectionId: stack[stack.length - 1]!.sectionId } : {}),
      };
      current = section;
      stack.push(section);
      continue;
    }
    if (!current) {
      counter += 1;
      current = {
        sectionId: `s${counter}`,
        level: 1,
        title: 'Document',
        blockIds: [],
        pageStart: block.pageNumber,
        pageEnd: block.pageNumber,
      };
      stack.length = 0;
      stack.push(current);
    }
    current.blockIds.push(block.blockId);
    current.pageStart = Math.min(current.pageStart, block.pageNumber);
    current.pageEnd = Math.max(current.pageEnd, block.pageNumber);
  }
  flush();
  return sections;
}

function deriveTables(blocks: Map<string, DocumentStructureBlock>, readingOrder: string[]): DocumentStructureTable[] {
  const tables: DocumentStructureTable[] = [];
  let counter = 0;
  for (const blockId of readingOrder) {
    const block = blocks.get(blockId);
    if (!block || block.type !== 'table') continue;
    counter += 1;
    const tableId = block.tableId ?? `t${counter}`;
    const rows = (block.children ?? [])
      .map((rowId) => blocks.get(rowId))
      .filter((row): row is DocumentStructureBlock => Boolean(row && row.type === 'table_row'));
    const columns = rows.reduce((max, row) => {
      const cells = (row.children ?? [])
        .map((cellId) => blocks.get(cellId))
        .filter((cell): cell is DocumentStructureBlock => Boolean(cell && cell.type === 'table_cell'));
      return Math.max(max, cells.reduce((sum, cell) => sum + (cell.columnSpan ?? 1), 0));
    }, 0);
    tables.push({
      tableId,
      blockId: block.blockId,
      pageId: block.pageId,
      pageNumber: block.pageNumber,
      rowBlockIds: rows.map((row) => row.blockId),
      columnCount: columns,
      rowCount: rows.length,
    });
  }
  return tables;
}

/**
 * Applies deterministic derived metadata and the hard structure limits. This
 * is the only place sections, reading order, tables, and metadata counts are
 * finalized, so PDF/DOCX/OCR produce the same envelope.
 */
export function finalizeStructure(draft: StructureDraft): DocumentStructure {
  let truncated = false;
  const warnings = [...draft.warnings];
  if (warnings.length > 100) {
    warnings.splice(100);
    warnings.push({
      code: 'STRUCTURE_WARNING_TRUNCATED',
      message: 'Some structure warnings were omitted because the warning limit was reached.',
    });
  }

  let blocks = [...draft.blocks].sort((a, b) => a.order - b.order);
  const kept: DocumentStructureBlock[] = [];
  let textChars = 0;
  for (const block of blocks) {
    if (kept.length >= MAX_STRUCTURE_BLOCKS || textChars + block.text.length > MAX_STRUCTURE_TEXT_CHARS) {
      truncated = true;
      break;
    }
    kept.push(block);
    textChars += block.text.length;
  }
  blocks = kept;
  const blockMap = new Map(blocks.map((block) => [block.blockId, block]));
  if (blocks.length !== draft.blocks.length) {
    truncated = true;
  }

  let bboxCount = 0;
  for (const block of blocks) {
    if (!block.boundingBox) continue;
    bboxCount += 1;
    if (bboxCount > MAX_STRUCTURE_BOUNDING_BOXES) {
      delete block.boundingBox;
      truncated = true;
    }
  }

  const keptIds = new Set(blocks.map((block) => block.blockId));
  for (const block of blocks) {
    if (block.parentId && !keptIds.has(block.parentId)) {
      delete block.parentId;
    }
    if (block.children) {
      const children = block.children.filter((childId) => keptIds.has(childId));
      if (children.length !== block.children.length) truncated = true;
      if (children.length) block.children = children;
      else delete block.children;
    }
  }

  const pages = draft.pages.map((page) => ({
    ...page,
    blockIds: page.blockIds.filter((blockId) => keptIds.has(blockId)),
  }));
  const pageOrder = pages.flatMap((page) => page.blockIds);
  const topLevel = blocks
    .filter((block) => !block.parentId)
    .sort((a, b) => a.order - b.order)
    .map((block) => block.blockId);
  const readingOrder = pageOrder.length
    ? [...pageOrder, ...topLevel.filter((blockId) => !pageOrder.includes(blockId))]
    : topLevel;
  const sections = deriveSections(blockMap, readingOrder);
  const tables = deriveTables(blockMap, readingOrder);

  if (truncated && !warnings.some((item) => item.code === 'STRUCTURE_TRUNCATED')) {
    warnings.push({
      code: 'STRUCTURE_TRUNCATED',
      message: 'The structured representation was bounded to the local structure limit; plain text remains complete.',
    });
  }

  return {
    schemaVersion: DOCUMENT_STRUCTURE_SCHEMA_VERSION,
    extractionVersion: draft.extractionVersion,
    documentFormat: draft.documentFormat,
    pageSemantics: draft.pageSemantics,
    pages,
    blocks,
    sections,
    tables,
    readingOrder,
    warnings: sanitizeWarnings(warnings),
    metadata: {
      pageCount: pages.length,
      blockCount: blocks.length,
      sectionCount: sections.length,
      tableCount: tables.length,
      ocrPageCount: pages.filter((page) => page.extractionMethod === 'ocr').length,
      truncated,
    },
    ...(draft.pagination ? { pagination: draft.pagination } : {}),
    ...(draft.docxLayout ? { docxLayout: draft.docxLayout } : {}),
  };
}

/** Replaces one or more physical pages after OCR without touching native pages. */
export function replaceStructurePages(
  structure: DocumentStructure,
  replacements: Array<{ page: DocumentStructurePage; blocks: DocumentStructureBlock[] }>,
  warnings: ExtractionWarning[] = [],
): DocumentStructure {
  if (replacements.length === 0) return structure;
  const pageIds = new Set(replacements.map((entry) => entry.page.pageId));
  const replacedPageNumbers = new Set(replacements.map((entry) => entry.page.pageNumber));
  const pages = structure.pages.map((page) => (
    pageIds.has(page.pageId)
      ? replacements.find((entry) => entry.page.pageId === page.pageId)!.page
      : page
  ));
  const blocks = structure.blocks.filter((block) => !pageIds.has(block.pageId));
  for (const replacement of replacements) {
    if (!pages.some((page) => page.pageId === replacement.page.pageId)) pages.push(replacement.page);
    blocks.push(...replacement.blocks);
  }
  const stillHasImageOnlyPage = pages.some((page) => page.pageType === 'image_only');
  const retainedWarnings = structure.warnings.filter((item) => {
    if (item.code === 'OCR_REQUIRED' && !stillHasImageOnlyPage) return false;
    if (item.code === 'PAGE_REQUIRES_OCR' && typeof item.page === 'number' && replacedPageNumbers.has(item.page)) return false;
    return true;
  });
  return finalizeStructure({
    extractionVersion: structure.extractionVersion,
    documentFormat: structure.documentFormat,
    pageSemantics: structure.pageSemantics,
    pages,
    blocks,
    warnings: [...retainedWarnings, ...warnings],
    ...(structure.pagination ? { pagination: structure.pagination } : {}),
    ...(structure.docxLayout ? { docxLayout: structure.docxLayout } : {}),
  });
}
