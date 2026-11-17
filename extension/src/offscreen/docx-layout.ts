import {
  openFontBackedDocumentForExport,
  type ExportFontResolutionReport,
  type ExportSemanticLayout,
} from '@docx-editor.dev/core/export';
import { setHarfBuzzWasmUrl } from '@docx-editor.dev/core/layout';
import { packagedFonts } from '@docx-editor.dev/fonts';
import {
  MAX_IMAGE_APPEARANCES_TOTAL,
  MAX_PAGINATION_COLUMNS,
  MAX_PAGINATION_GEOMETRY_CHARS,
  MAX_PAGINATION_GEOMETRY_ENTRIES,
  MAX_PAGINATION_LINES_PER_BLOCK,
  MAX_PDF_PAGES,
  MAX_STRUCTURE_BLOCKS,
} from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type {
  DocumentEmbeddedFont,
  DocumentFontFaceResolution,
  DocumentFontResolution,
  DocumentFontResolutionSource,
  DocumentGeometryBox,
  DocumentPaginationBlockPage,
  DocumentPaginationCellGeometry,
  DocumentPaginationColumnGeometry,
  DocumentPaginationGeometrySummary,
  DocumentPaginationInfo,
  DocumentPaginationLineGeometry,
  DocumentPaginationPage,
  DocumentPaginationRowGeometry,
  DocumentStructure,
  DocumentStructureBlock,
  DocumentStructureDocxSection,
  ExtractionWarning,
} from '@shared/types';
import { sanitizeWarnings } from '../../../core/documents/text-utils';
import { normalizeDocxTablesForLayout } from './docx-layout-normalize';

const DOCX_PAGINATION_TIMEOUT_MS = 20_000;
const RENDERER_NAME = '@docx-editor.dev/core 2.38.0';
const SUPPORTED_FONT_FAMILIES = ['Calibri', 'Arial', 'Times New Roman'] as const;

interface CoreBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CoreResource {
  kind: string;
  partName?: string;
  mime?: string;
  pixelWidth?: number;
  pixelHeight?: number;
}

interface CoreDrawing {
  kind: string;
  drawingNodeId?: string;
  anchorParagraphId?: string;
  ownerPartName?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  paintBounds?: CoreBox;
  resource?: CoreResource;
  accessibility?: {
    hidden?: boolean;
    decorative?: boolean;
    label?: string | null;
  };
  placeholderGraphicKind?: string | null;
  wrap?: string;
  horizontalFrame?: string;
  verticalFrame?: string;
  behindDocument?: boolean;
}

interface CoreLine {
  id?: string;
  box: CoreBox;
  contentX?: number;
  spans?: Array<{ text?: string }>;
  drawings?: CoreDrawing[];
}

interface CoreCell {
  id: string;
  gridColumn: number;
  gridSpan: number;
  rowSpan?: number;
  vMergeContinue?: boolean;
  box: CoreBox;
  blocks?: CoreFragment[];
}

interface CoreRow {
  id: string;
  rowIndex: number;
  isHeaderRow?: boolean;
  isHeaderRepeat?: boolean;
  isContinuation?: boolean;
  hasContinuation?: boolean;
  box: CoreBox;
  cells: CoreCell[];
}

interface CoreFragment {
  kind: string;
  paragraphId?: string;
  paragraphEnd?: boolean;
  fragmentIndex?: number;
  tableId?: string;
  box?: CoreBox;
  columnEdges?: number[];
  lines?: CoreLine[];
  rows?: CoreRow[];
}

interface CoreStory {
  kind: 'header' | 'footer';
  variant: string;
  partName: string;
  box: CoreBox;
  fragments: CoreFragment[];
  anchoredDrawings?: CoreDrawing[];
}

interface CorePage {
  index: number;
  box: CoreBox;
  contentBox: CoreBox;
  fragments: CoreFragment[];
  anchoredDrawings?: CoreDrawing[];
  columnSeparators?: CoreBox[];
  header?: CoreStory;
  footer?: CoreStory;
}

interface CoreLayout {
  pages: CorePage[];
  sectionBreaks?: Array<{ paragraphId: string; kind: string }>;
  contentWarnings?: Array<{ code: string; partName: string }>;
}

interface ParagraphLine {
  lineIndex: number;
  pageNumber: number;
  fragmentIndex: number;
  box: CoreBox;
}

interface InlineDrawingPlacement {
  pageNumber: number;
  fragmentIndex?: number;
  drawing: CoreDrawing;
}

interface ParagraphGroup {
  id: string;
  text: string;
  pages: Map<number, number[]>;
  lines: ParagraphLine[];
  drawings: InlineDrawingPlacement[];
}

interface TableRowState {
  pageNumber: number;
  fragmentIndex: number;
  box: CoreBox;
  isHeaderRow: boolean;
  isHeaderRepeat: boolean;
  isContinuation: boolean;
  hasContinuation: boolean;
  fragments: Array<{ pageNumber: number; fragmentIndex: number; box: CoreBox }>;
  cells: Map<number, {
    pageNumber: number;
    fragmentIndex: number;
    box: CoreBox;
    rowSpan?: number;
    columnSpan: number;
    fragments: Array<{ pageNumber: number; fragmentIndex: number; box: CoreBox }>;
  }>;
}

interface TableRowPlacement {
  pageNumber: number;
  fragmentIndex: number;
  row: CoreRow;
}

interface TableGroup {
  id: string;
  pages: Map<number, number[]>;
  rows: Map<number, TableRowState>;
  allRows: TableRowPlacement[];
  box?: CoreBox;
  firstPageNumber?: number;
}

interface PageSection {
  sectionIndex: number;
  approximate: boolean;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, '').replace(/\u00a0/g, '').toLowerCase();
}

function fragmentLineText(fragment: CoreFragment): string {
  return (fragment.lines ?? [])
    .flatMap((line) => (line.spans ?? []).map((span) => span.text ?? ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function pageMargins(page: CorePage): DocumentPaginationPage['margins'] {
  const leftPt = Math.max(0, page.contentBox.x - page.box.x);
  const topPt = Math.max(0, page.contentBox.y - page.box.y);
  const rightPt = Math.max(0, page.box.width - leftPt - page.contentBox.width);
  const bottomPt = Math.max(0, page.box.height - topPt - page.contentBox.height);
  return { topPt, rightPt, bottomPt, leftPt };
}

function geometryBox(box: CoreBox | undefined): DocumentGeometryBox | undefined {
  if (!box || ![box.x, box.y, box.width, box.height].every((value) => Number.isFinite(value))) return undefined;
  return {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: Math.max(0, box.width),
    height: Math.max(0, box.height),
    coordinateSpace: 'renderer_page_content_points',
  };
}

function coreLayout(layout: ExportSemanticLayout): CoreLayout {
  return layout as unknown as CoreLayout;
}

function collectGroups(pages: CorePage[]): { paragraphs: ParagraphGroup[]; tables: TableGroup[] } {
  const paragraphMap = new Map<string, ParagraphGroup>();
  const tableMap = new Map<string, TableGroup>();
  const paragraphOrder: string[] = [];
  const tableOrder: string[] = [];
  for (const page of pages) {
    const pageNumber = page.index + 1;
    for (const fragment of page.fragments) {
      if (fragment.kind === 'paragraph' && fragment.paragraphId) {
        let group = paragraphMap.get(fragment.paragraphId);
        if (!group) {
          group = { id: fragment.paragraphId, text: '', pages: new Map(), lines: [], drawings: [] };
          paragraphMap.set(fragment.paragraphId, group);
          paragraphOrder.push(fragment.paragraphId);
        }
        group.text += fragmentLineText(fragment);
        const fragmentIndex = fragment.fragmentIndex ?? 0;
        const fragments = group.pages.get(pageNumber) ?? [];
        fragments.push(fragmentIndex);
        group.pages.set(pageNumber, fragments);
        for (const line of fragment.lines ?? []) {
          group.lines.push({
            lineIndex: group.lines.length,
            pageNumber,
            fragmentIndex,
            box: line.box,
          });
          for (const drawing of line.drawings ?? []) {
            group.drawings.push({ pageNumber, fragmentIndex, drawing });
          }
        }
      } else if (fragment.kind === 'table' && fragment.tableId) {
        let group = tableMap.get(fragment.tableId);
        if (!group) {
          group = { id: fragment.tableId, pages: new Map(), rows: new Map(), allRows: [] };
          tableMap.set(fragment.tableId, group);
          tableOrder.push(fragment.tableId);
        }
        if (!group.box && fragment.box) {
          group.box = fragment.box;
          group.firstPageNumber = pageNumber;
        }
        const fragmentIndex = fragment.fragmentIndex ?? 0;
        group.pages.set(pageNumber, [...(group.pages.get(pageNumber) ?? []), fragmentIndex]);
        for (const row of fragment.rows ?? []) {
          group.allRows.push({ pageNumber, fragmentIndex, row });
          const existing = group.rows.get(row.rowIndex);
          if (existing && row.isHeaderRepeat) continue;
          const state: TableRowState = existing ?? {
            pageNumber,
            fragmentIndex,
            box: row.box,
            isHeaderRow: row.isHeaderRow === true,
            isHeaderRepeat: row.isHeaderRepeat === true,
            isContinuation: row.isContinuation === true,
            hasContinuation: row.hasContinuation === true,
            fragments: [],
            cells: new Map(),
          };
          if (!row.isHeaderRepeat) {
            state.pageNumber = state.fragments.length ? state.pageNumber : pageNumber;
            state.fragmentIndex = state.fragments.length ? state.fragmentIndex : fragmentIndex;
            state.box = state.fragments.length ? state.box : row.box;
            state.fragments.push({ pageNumber, fragmentIndex, box: row.box });
          }
          for (const cell of row.cells ?? []) {
            const cellState = state.cells.get(cell.gridColumn) ?? {
              pageNumber,
              fragmentIndex,
              box: cell.box,
              ...(cell.rowSpan !== undefined ? { rowSpan: cell.rowSpan } : {}),
              columnSpan: cell.gridSpan,
              fragments: [],
            };
            if (!row.isHeaderRepeat) cellState.fragments.push({ pageNumber, fragmentIndex, box: cell.box });
            state.cells.set(cell.gridColumn, cellState);
          }
          group.rows.set(row.rowIndex, state);
        }
      }
    }
  }
  return {
    paragraphs: paragraphOrder.map((id) => paragraphMap.get(id)!),
    tables: tableOrder.map((id) => tableMap.get(id)!),
  };
}

interface ImageCandidate {
  scope: 'body' | 'table' | 'header' | 'footer';
  pageNumber: number;
  fragmentIndex?: number;
  drawing: CoreDrawing;
  box?: DocumentGeometryBox;
  tableId?: string;
  rowIndex?: number;
  columnIndex?: number;
  nestedTableDepth?: number;
  partName?: string;
  order: number;
}

interface ImageContext {
  scope: ImageCandidate['scope'];
  tableId?: string;
  rowIndex?: number;
  columnIndex?: number;
  nestedTableDepth?: number;
  partName?: string;
}

function collectImageCandidates(pages: CorePage[]): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const paragraphContexts = new Map<string, { context: ImageContext; dx: number; dy: number }>();
  let order = 0;
  const drawingBox = (
    drawing: CoreDrawing,
    dx = 0,
    dy = 0,
    coordinateSpace: 'renderer_page_content_points' | 'renderer_page_points' = 'renderer_page_content_points',
  ): DocumentGeometryBox | undefined => {
    const box = drawing.paintBounds ?? (drawing.width !== undefined && drawing.height !== undefined
      ? { x: drawing.x ?? 0, y: drawing.y ?? 0, width: drawing.width, height: drawing.height }
      : undefined);
    if (!box) return undefined;
    return {
      x: Math.max(0, box.x + dx),
      y: Math.max(0, box.y + dy),
      width: Math.max(0, box.width),
      height: Math.max(0, box.height),
      coordinateSpace,
    };
  };
  const addDrawing = (
    context: ImageContext,
    pageNumber: number,
    fragmentIndex: number | undefined,
    drawing: CoreDrawing,
    dx = 0,
    dy = 0,
  ) => {
    const furniture = context.scope === 'header' || context.scope === 'footer';
    const box = drawingBox(drawing, dx, dy, furniture ? 'renderer_page_points' : 'renderer_page_content_points');
    candidates.push({
      ...context,
      pageNumber,
      ...(fragmentIndex !== undefined ? { fragmentIndex } : {}),
      drawing,
      ...(box ? { box } : {}),
      order: order++,
    });
  };
  const walkParagraph = (
    fragment: CoreFragment,
    context: ImageContext,
    pageNumber: number,
    dx: number,
    dy: number,
  ) => {
    if (fragment.paragraphId) paragraphContexts.set(fragment.paragraphId, { context, dx, dy });
    for (const line of fragment.lines ?? []) {
      for (const drawing of line.drawings ?? []) {
        addDrawing(context, pageNumber, fragment.fragmentIndex, drawing, dx, dy);
      }
    }
  };
  const walkTable = (
    fragment: CoreFragment,
    context: ImageContext,
    pageNumber: number,
    dx: number,
    dy: number,
    nestedDepth: number,
  ) => {
    const outerTableId = context.tableId ?? fragment.tableId;
    for (const row of fragment.rows ?? []) {
      for (const cell of row.cells ?? []) {
        for (const block of cell.blocks ?? []) {
          const cellContext: ImageContext = {
            ...context,
            tableId: outerTableId,
            ...(context.tableId === undefined ? { rowIndex: row.rowIndex, columnIndex: cell.gridColumn } : {}),
            nestedTableDepth: nestedDepth,
          };
          if (block.kind === 'paragraph') {
            walkParagraph(block, cellContext, pageNumber, dx, dy);
          } else if (block.kind === 'table') {
            walkTable(block, cellContext, pageNumber, dx, dy, nestedDepth + 1);
          }
        }
      }
    }
  };
  for (const page of pages) {
    const pageNumber = page.index + 1;
    for (const fragment of page.fragments) {
      if (fragment.kind === 'paragraph') {
        walkParagraph(fragment, { scope: 'body' }, pageNumber, 0, 0);
      } else if (fragment.kind === 'table') {
        walkTable(fragment, { scope: 'table' }, pageNumber, 0, 0, 0);
      }
    }
    for (const drawing of page.anchoredDrawings ?? []) {
      const paragraph = drawing.anchorParagraphId ? paragraphContexts.get(drawing.anchorParagraphId) : undefined;
      addDrawing(paragraph?.context ?? { scope: 'body' }, pageNumber, undefined, drawing, paragraph?.dx ?? 0, paragraph?.dy ?? 0);
    }
    for (const story of [page.header, page.footer]) {
      if (!story) continue;
      const dx = story.box.x - page.box.x;
      const dy = story.box.y - page.box.y;
      const context: ImageContext = { scope: story.kind, partName: story.partName };
      for (const fragment of story.fragments ?? []) {
        if (fragment.kind === 'paragraph') {
          walkParagraph(fragment, context, pageNumber, dx, dy);
        } else if (fragment.kind === 'table') {
          walkTable(fragment, context, pageNumber, dx, dy, 0);
        }
      }
      for (const drawing of story.anchoredDrawings ?? []) {
        addDrawing(context, pageNumber, undefined, drawing, dx, dy);
      }
    }
  }
  return candidates;
}

function findParagraphGroup(
  groups: ParagraphGroup[],
  cursor: number,
  text: string,
): { group?: ParagraphGroup; next: number; approximate: boolean } {
  const wanted = normalizedText(text);
  const fuzzyPrefixLength = 32;
  for (let index = cursor; index < groups.length; index += 1) {
    const candidate = normalizedText(groups[index]!.text);
    if (candidate === wanted) {
      return { group: groups[index]!, next: index + 1, approximate: false };
    }
    if (wanted.length >= fuzzyPrefixLength
      && candidate.length >= fuzzyPrefixLength
      && (candidate.startsWith(wanted.slice(0, fuzzyPrefixLength)) || wanted.startsWith(candidate.slice(0, fuzzyPrefixLength)))) {
      return { group: groups[index]!, next: index + 1, approximate: false };
    }
  }
  if (cursor < groups.length) {
    return { group: groups[cursor]!, next: cursor + 1, approximate: true };
  }
  return { next: cursor, approximate: true };
}

function groupPageRange(group: { pages: Map<number, number[]> }): { start: number; end: number; fragments: Array<{ pageNumber: number; fragmentIndex?: number }> } {
  const numbers = [...group.pages.keys()].sort((a, b) => a - b);
  const fragments = numbers.flatMap((pageNumber) => (
    (group.pages.get(pageNumber) ?? []).map((fragmentIndex) => ({ pageNumber, fragmentIndex }))
  ));
  return { start: numbers[0] ?? 1, end: numbers[numbers.length - 1] ?? 1, fragments };
}

function buildPageSections(
  pages: CorePage[],
  groups: { paragraphs: ParagraphGroup[] },
  layout: CoreLayout,
  structure: DocumentStructure,
): PageSection[] {
  const pageCount = pages.length;
  const sections: PageSection[] = Array.from({ length: pageCount }, () => ({ sectionIndex: 0, approximate: false }));
  const breaks = layout.sectionBreaks ?? [];
  const sectionCount = structure.docxLayout?.sections.length ?? 1;
  if (!breaks.length) {
    return sections.map((entry) => ({ ...entry, approximate: sectionCount > 1 }));
  }
  const paragraphMap = new Map(groups.paragraphs.map((group) => [group.id, group]));
  let currentSection = 0;
  let coveredPage = 0;
  for (const sectionBreak of breaks) {
    const group = paragraphMap.get(sectionBreak.paragraphId);
    const endPage = group ? groupPageRange(group).end : Math.max(1, coveredPage);
    for (let pageNumber = coveredPage + 1; pageNumber <= Math.min(pageCount, endPage); pageNumber += 1) {
      sections[pageNumber - 1] = { sectionIndex: currentSection, approximate: sectionBreak.kind === 'continuous' };
    }
    if (endPage <= coveredPage && sections[endPage - 1]) {
      sections[endPage - 1] = { ...sections[endPage - 1]!, approximate: true };
    }
    coveredPage = Math.max(coveredPage, endPage);
    currentSection += 1;
    if (currentSection >= sectionCount) break;
  }
  for (let pageNumber = coveredPage + 1; pageNumber <= pageCount; pageNumber += 1) {
    sections[pageNumber - 1] = {
      sectionIndex: Math.min(currentSection, Math.max(0, (structure.docxLayout?.sections.length ?? 1) - 1)),
      approximate: false,
    };
  }
  return sections;
}

interface ColumnBand {
  x: number;
  width: number;
}

function columnBands(section: DocumentStructureDocxSection | undefined, contentWidth: number): { bands: ColumnBand[]; source: 'section_properties' | 'renderer_content' | 'mixed' } {
  const count = Math.max(1, Math.min(MAX_PAGINATION_COLUMNS, section?.columns?.count ?? section?.columnCount ?? 1));
  if (count === 1 || contentWidth <= 0) return { bands: [{ x: 0, width: Math.max(0, contentWidth) }], source: 'section_properties' };
  const columns = section?.columns;
  if (columns && !columns.equalWidth && columns.widthsPt?.length === count) {
    const gaps = columns.gapsPt ?? Array.from({ length: count }, (_, index) => (index === count - 1 ? 0 : columns.gapPt));
    const total = columns.widthsPt.reduce((sum, width) => sum + width, 0)
      + gaps.reduce((sum, gap, index) => sum + (index === count - 1 ? 0 : gap), 0);
    const scale = total > 0 && total > contentWidth ? contentWidth / total : 1;
    const bands: ColumnBand[] = [];
    let x = 0;
    for (let index = 0; index < count; index += 1) {
      const width = columns.widthsPt[index]! * scale;
      bands.push({ x, width });
      x += width + (index === count - 1 ? 0 : (gaps[index] ?? columns.gapPt) * scale);
    }
    return { bands, source: scale === 1 ? 'section_properties' : 'mixed' };
  }
  const gap = Math.max(0, columns?.gapPt ?? 0);
  const width = Math.max(0, (contentWidth - gap * (count - 1)) / count);
  return {
    bands: Array.from({ length: count }, (_, index) => ({ x: index * (width + gap), width })),
    source: 'section_properties',
  };
}

function columnIndexForX(bands: ColumnBand[], x: number): number | undefined {
  if (!bands.length) return undefined;
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index]!;
    const current = x < band.x ? band.x - x : x > band.x + band.width ? x - band.x - band.width : 0;
    if (current < distance) {
      distance = current;
      best = index;
    }
  }
  return best;
}

function buildPageColumns(
  pages: CorePage[],
  sections: PageSection[],
  structure: DocumentStructure,
  groups: { paragraphs: ParagraphGroup[]; tables: TableGroup[] },
  reserve: (count: number, approximateChars: number) => boolean,
): { columns: DocumentPaginationColumnGeometry[][]; sectionIndexes: PageSection[] } {
  const columnsByPage: DocumentPaginationColumnGeometry[][] = [];
  const used = pages.map(() => new Map<number, { minY: number; maxY: number }>());
  const addUsed = (pageIndex: number, x: number, y: number, width: number, height: number, bands: ColumnBand[]) => {
    const columnIndex = columnIndexForX(bands, x + width / 2);
    if (columnIndex === undefined) return;
    const current = used[pageIndex]!.get(columnIndex);
    used[pageIndex]!.set(columnIndex, {
      minY: current ? Math.min(current.minY, y) : y,
      maxY: current ? Math.max(current.maxY, y + height) : y + height,
    });
  };
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]!;
    const sectionIndex = sections[pageIndex]?.sectionIndex ?? 0;
    const section = structure.docxLayout?.sections[sectionIndex];
    const { bands, source } = columnBands(section, page.contentBox.width);
    for (const group of groups.paragraphs) {
      for (const line of group.lines) {
        if (line.pageNumber !== page.index + 1) continue;
        addUsed(pageIndex, line.box.x, line.box.y, line.box.width, line.box.height, bands);
      }
    }
    for (const table of groups.tables) {
      for (const placement of table.allRows) {
        if (placement.pageNumber !== page.index + 1 || placement.row.isHeaderRepeat) continue;
        addUsed(pageIndex, placement.row.box.x, placement.row.box.y, placement.row.box.width, placement.row.box.height, bands);
        for (const cell of placement.row.cells) {
          addUsed(pageIndex, cell.box.x, cell.box.y, cell.box.width, cell.box.height, bands);
        }
      }
    }
    const pageColumns: DocumentPaginationColumnGeometry[] = [];
    for (let columnIndex = 0; columnIndex < bands.length && columnIndex < MAX_PAGINATION_COLUMNS; columnIndex += 1) {
      if (!reserve(1, 220)) break;
      const band = bands[columnIndex]!;
      const extent = used[pageIndex]!.get(columnIndex);
      const y = extent?.minY ?? 0;
      const height = extent ? Math.max(0, extent.maxY - extent.minY) : 0;
      pageColumns.push({
        pageNumber: page.index + 1,
        columnIndex,
        sectionIndex,
        box: {
          x: band.x,
          y,
          width: band.width,
          height,
          coordinateSpace: 'renderer_page_content_points',
        },
        widthPt: band.width,
        heightPt: height,
        confidence: extent ? 'renderer_approximate' : 'source_approximate',
        source: extent ? 'mixed' : source,
      });
    }
    columnsByPage.push(pageColumns);
  }
  return { columns: columnsByPage, sectionIndexes: sections };
}

function addBlockPage(
  output: DocumentPaginationBlockPage[],
  pagesById: Map<number, DocumentPaginationPage>,
  blockId: string,
  group: { pages: Map<number, number[]> },
  approximate: boolean,
  geometry?: {
    box?: DocumentGeometryBox;
    lines?: DocumentPaginationLineGeometry[];
    confidence?: DocumentPaginationBlockPage['geometryConfidence'];
    tableRows?: DocumentPaginationRowGeometry[];
    rowIndex?: number;
    columnIndex?: number;
    rowSpan?: number;
    columnSpan?: number;
  },
): DocumentPaginationBlockPage {
  const range = groupPageRange(group);
  const includeFragmentPages = range.fragments.length > 1 || range.start !== range.end;
  const entry: DocumentPaginationBlockPage = {
    blockId,
    startPageNumber: range.start,
    ...(range.end !== range.start ? { endPageNumber: range.end } : {}),
    ...(includeFragmentPages ? { fragmentPages: range.fragments } : {}),
    ...(approximate ? { approximate: true } : {}),
    ...(geometry?.box ? { boundingBox: geometry.box } : {}),
    ...(geometry?.lines?.length ? { lines: geometry.lines } : {}),
    ...(geometry?.tableRows?.length ? { tableRows: geometry.tableRows } : {}),
    ...(geometry?.confidence ? { geometryConfidence: geometry.confidence } : {}),
    ...(geometry?.rowIndex !== undefined ? { rowIndex: geometry.rowIndex } : {}),
    ...(geometry?.columnIndex !== undefined ? { columnIndex: geometry.columnIndex } : {}),
    ...(geometry?.rowSpan !== undefined ? { rowSpan: geometry.rowSpan } : {}),
    ...(geometry?.columnSpan !== undefined ? { columnSpan: geometry.columnSpan } : {}),
  };
  output.push(entry);
  for (let pageNumber = range.start; pageNumber <= range.end; pageNumber += 1) {
    const page = pagesById.get(pageNumber);
    if (page && !page.blockIds.includes(blockId)) page.blockIds.push(blockId);
  }
  return entry;
}

function rowPageFor(
  block: DocumentStructureBlock,
  tableGroup: TableGroup,
): TableRowState | undefined {
  return block.rowIndex === undefined ? undefined : tableGroup.rows.get(block.rowIndex);
}

let assetsConfigured = false;
function configureLocalLayoutAssets(): (name: string) => string {
  const assetUrl = (name: string) => new URL(`fonts/${name}`, self.location.href).href;
  if (!assetsConfigured) {
    setHarfBuzzWasmUrl(assetUrl('harfbuzz.wasm'));
    assetsConfigured = true;
  }
  return assetUrl;
}

interface LocalFontManifestEntry {
  file: string;
  family: string;
  weight: 400 | 700;
  style: 'normal' | 'italic';
  byteLength: number;
  hash: string;
}

interface LocalFontResult {
  sources: Array<{
    request: { family: string; weight: 400 | 700; style: 'normal' | 'italic' };
    id: string;
    bytes: Uint8Array;
    hash: string;
    faceIndex: number;
  }>;
  substitutions: Array<{
    from: { family: string; weight: 400 | 700; style: 'normal' | 'italic' };
    to: { family: string; weight: 400 | 700; style: 'normal' | 'italic' };
  }>;
  failures: string[];
}

const LOCAL_FONT_FAMILIES: ReadonlyArray<[word: string, source: string]> = [
  ['Calibri', 'Carlito'],
  ['Arial', 'Liberation Sans'],
  ['Times New Roman', 'Liberation Serif'],
];
const MAX_LOCAL_FONT_BYTES = 16 * 1024 * 1024;
let localFontResultPromise: Promise<LocalFontResult | null> | null = null;

function validLocalFontEntry(value: unknown): value is LocalFontManifestEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.file === 'string'
    && /^[A-Za-z0-9_.-]+\.ttf$/.test(entry.file)
    && typeof entry.family === 'string'
    && entry.family.length > 0
    && entry.family.length <= 100
    && (entry.weight === 400 || entry.weight === 700)
    && (entry.style === 'normal' || entry.style === 'italic')
    && typeof entry.byteLength === 'number'
    && Number.isSafeInteger(entry.byteLength)
    && entry.byteLength > 0
    && entry.byteLength <= MAX_LOCAL_FONT_BYTES
    && typeof entry.hash === 'string'
    && /^sha256:[0-9a-f]{64}$/.test(entry.hash);
}

async function loadLocalFontConfiguration(
  assetUrl: (name: string) => string,
  signal: AbortSignal,
): Promise<LocalFontResult | null> {
  if (localFontResultPromise) return localFontResultPromise;
  localFontResultPromise = (async () => {
    let manifest: unknown;
    try {
      const response = await fetch(assetUrl('font-metrics.json'), { signal });
      if (!response.ok) return null;
      manifest = await response.json();
    } catch {
      return null;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
    const value = manifest as Record<string, unknown>;
    if (value.version !== 1 || !Array.isArray(value.fonts) || value.fonts.length === 0 || value.fonts.length > 64) {
      return null;
    }
    const entries = value.fonts.filter(validLocalFontEntry);
    if (entries.length !== value.fonts.length) return null;
    const files = new Set<string>();
    const requested = new Set(LOCAL_FONT_FAMILIES.map(([, source]) => source));
    const available = new Map<string, LocalFontManifestEntry>();
    for (const entry of entries) {
      if (files.has(entry.file) || !requested.has(entry.family)) continue;
      files.add(entry.file);
      available.set(`${entry.family}\u0000${entry.weight}\u0000${entry.style}`, entry);
    }
    if (available.size === 0) return null;
    const failures: string[] = [];
    const sources: LocalFontResult['sources'] = [];
    for (const entry of available.values()) {
      try {
        const response = await fetch(assetUrl(entry.file), { signal });
        if (!response.ok) {
          failures.push(`${entry.family} ${entry.file}: HTTP ${response.status}`);
          continue;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== entry.byteLength) {
          failures.push(`${entry.family} ${entry.file}: byte length mismatch`);
          continue;
        }
        sources.push({
          request: { family: entry.family, weight: entry.weight, style: entry.style },
          id: `local:${entry.file}`,
          bytes,
          hash: entry.hash,
          faceIndex: 0,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        failures.push(`${entry.family} ${entry.file}: ${String(error).slice(0, 160)}`);
      }
    }
    if (sources.length === 0) return null;
    const availableFaces = new Set(sources.map((source) => (
      `${source.request.family}\u0000${source.request.weight}\u0000${source.request.style}`
    )));
    const substitutions: LocalFontResult['substitutions'] = [];
    for (const [wordFamily, sourceFamily] of LOCAL_FONT_FAMILIES) {
      for (const weight of [400, 700] as const) {
        for (const style of ['normal', 'italic'] as const) {
          if (!availableFaces.has(`${sourceFamily}\u0000${weight}\u0000${style}`)) continue;
          substitutions.push({
            from: { family: wordFamily, weight, style },
            to: { family: sourceFamily, weight, style },
          });
        }
      }
    }
    return { sources, substitutions, failures };
  })().catch(() => {
    localFontResultPromise = null;
    return null;
  });
  return localFontResultPromise;
}

function fontResolution(
  report: ExportFontResolutionReport,
  embeddedFonts: DocumentEmbeddedFont[] | undefined,
): { fonts: DocumentFontResolution[]; embeddedFonts?: DocumentEmbeddedFont[]; warnings: ExtractionWarning[] } {
  const warnings: ExtractionWarning[] = [];
  const embeddedFamilies = new Set((embeddedFonts ?? []).map((font) => font.family.toLowerCase()));
  const dropped = new Map(
    (report.droppedEmbeddedFonts ?? []).map((font) => [font.partName.replace(/^\//, ''), font.reason] as const),
  );
  const updatedEmbedded = embeddedFonts?.map((font) => {
    const reason = font.partName ? dropped.get(font.partName.replace(/^\//, '')) : undefined;
    if (!reason) return font;
    return {
      ...font,
      status: reason === 'overLimit' ? 'oversize' : 'malformed',
      warning: reason === 'overLimit' ? 'Embedded font exceeded the local byte limit.' : 'Embedded font was malformed and was not used.',
    } satisfies DocumentEmbeddedFont;
  });
  for (const [partName, reason] of dropped) {
    warnings.push({
      code: 'DOCX_EMBEDDED_FONT_DROPPED',
      message: `Embedded font ${partName.split('/').pop() ?? partName} was ${reason === 'overLimit' ? 'larger than the local limit' : 'malformed'} and was not used.`,
    });
  }
  for (const failure of report.originFailures) {
    warnings.push({
      code: 'DOCX_FONT_ORIGIN_FAILED',
      message: `A local font source failed and was skipped: ${String(failure.originName ?? failure.cause ?? 'unknown')}`.slice(0, 500),
    });
  }
  const fonts = report.families.map((family): DocumentFontResolution => {
    const embeddedFamily = embeddedFamilies.has(family.family.toLowerCase());
    const faces: DocumentFontFaceResolution[] = family.faces.map((face) => {
      const embeddedFace = embeddedFamily || face.id?.startsWith('embedded:') === true || face.hash !== undefined && face.id?.includes('/word/fonts/') === true;
      const source: DocumentFontResolutionSource = face.via === 'direct'
        ? embeddedFace ? 'embedded' : 'exact_local'
        : 'metric_substitute';
      return {
        weight: face.weight,
        style: face.style,
        requestedFamily: family.family,
        resolvedFamily: face.sourceFamily,
        source,
        exact: face.via === 'direct',
        substituted: face.via !== 'direct',
        embedded: source === 'embedded',
        ...(face.identity ? { identity: face.identity } : {}),
        ...(face.via !== 'direct' ? { warning: `Substituted ${family.family} with ${face.sourceFamily}.` } : {}),
      };
    });
    if (faces.length === 0) {
      faces.push({
        weight: 400,
        style: 'normal',
        requestedFamily: family.family,
        source: 'generic_fallback',
        exact: false,
        substituted: true,
        embedded: false,
        warning: `No exact or substitute face was available for ${family.family}.`,
      });
    }
    const familyWarnings = [...new Set(faces.flatMap((face) => face.warning ? [face.warning] : []))];
    if (family.coverage !== 'complete') familyWarnings.push(`Font coverage for ${family.family} is ${family.coverage}.`);
    const source: DocumentFontResolutionSource = faces.some((face) => face.source === 'embedded')
      ? 'embedded'
      : faces.some((face) => face.source === 'metric_substitute')
        ? 'metric_substitute'
        : faces.some((face) => face.source === 'exact_local')
          ? 'exact_local'
          : family.coverage === 'none' ? 'unavailable' : 'generic_fallback';
    return {
      requestedFamily: family.family,
      ...(faces[0]?.resolvedFamily ? { resolvedFamily: faces[0].resolvedFamily } : {}),
      source,
      exact: faces.every((face) => face.exact),
      substituted: faces.some((face) => face.substituted),
      embedded: faces.some((face) => face.embedded),
      coverage: family.coverage,
      faces,
      warnings: familyWarnings,
    };
  });
  const familyReports = new Map(fonts.map((font) => [font.requestedFamily.toLowerCase(), font]));
  const finalEmbedded = updatedEmbedded?.map((font) => {
    if (font.status !== 'declared') return font;
    const family = familyReports.get(font.family.toLowerCase());
    if (family?.embedded) return { ...font, status: 'used' as const } satisfies DocumentEmbeddedFont;
    if (family) {
      warnings.push({
        code: 'DOCX_EMBEDDED_FONT_UNAVAILABLE',
        message: `Embedded font ${font.family} was declared but no embedded face was admitted; a substitute or fallback was used.`,
      });
      return {
        ...font,
        status: 'malformed' as const,
        warning: 'The embedded face was not admitted by the local font validator; a substitute or fallback was used.',
      } satisfies DocumentEmbeddedFont;
    }
    return font;
  });
  return { fonts, ...(finalEmbedded ? { embeddedFonts: finalEmbedded } : {}), warnings };
}

export async function paginateDocxWithLocalRenderer(
  bytes: ArrayBuffer,
  structure: DocumentStructure,
  signal?: AbortSignal,
): Promise<{
  pagination: DocumentPaginationInfo;
  warnings: ExtractionWarning[];
  fonts?: DocumentFontResolution[];
  embeddedFonts?: DocumentEmbeddedFont[];
  timings?: {
    fontResolutionMs: number;
    layoutMs: number;
    mappingMs: number;
  };
} | null> {
  if (signal?.aborted) throw new FormFlowError('CANCELLED', 'Document processing was cancelled.');
  const assetUrl = configureLocalLayoutAssets();
  const paginationStarted = performance.now();
  let fontResolutionMs = 0;
  let layoutOnlyMs = 0;
  const controller = new AbortController();
  const firstSection = structure.docxLayout?.sections[0];
  const contentWidthTwips = firstSection
    ? Math.max(720, Math.round((firstSection.pageWidthPt - firstSection.margins.leftPt - firstSection.margins.rightPt) * 20))
    : undefined;
  const normalization = structure.tables.length > 0
    ? normalizeDocxTablesForLayout(new Uint8Array(bytes), {
      ...(contentWidthTwips !== undefined ? { contentWidthTwips } : {}),
      signal: controller.signal,
    })
    : { bytes: new Uint8Array(bytes), normalizedTables: 0, warnings: [] as ExtractionWarning[] };
  const normalizationWarnings = normalization.warnings;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DOCX_PAGINATION_TIMEOUT_MS);
  const fontFailures: string[] = [];
  let fontCoverageIncomplete = false;
  let normalizedFontMetrics = false;
  const fetcher: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const name = url.split('/').pop() ?? '';
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      return new Response(null, { status: 404 });
    }
    return fetch(assetUrl(name));
  };
  let opened: Awaited<ReturnType<typeof openFontBackedDocumentForExport>> | null = null;
  let fontReport: ExportFontResolutionReport | undefined;
  try {
    const localFonts = await loadLocalFontConfiguration(assetUrl, controller.signal);
    const fontOrigin = localFonts
      ? {
        sources: localFonts.sources,
        substitutions: localFonts.substitutions,
        supportedFamilies: LOCAL_FONT_FAMILIES.map(([family]) => family),
        defaultFont: { family: 'Calibri', sizeHalfPoints: 22 },
      }
      : packagedFonts({
        allow: [...SUPPORTED_FONT_FAMILIES],
        fetcher,
        loading: 'eager',
        onFailure: (failure) => fontFailures.push(`${failure.family}: ${failure.diagnostic}`),
      });
    if (localFonts) {
      normalizedFontMetrics = true;
      fontFailures.push(...localFonts.failures);
    } else {
      fontFailures.push('Local normalized font metrics were unavailable; packaged metrics were used.');
    }
    opened = await openFontBackedDocumentForExport(normalization.bytes, {
      fonts: fontOrigin,
      fontPolicy: 'best-effort',
      signal: controller.signal,
      resourceTimeoutMs: DOCX_PAGINATION_TIMEOUT_MS,
      onFontResolution: (report) => {
        fontReport = report;
        fontCoverageIncomplete = report.families.some((family) => family.coverage !== 'complete');
        for (const failure of report.originFailures) fontFailures.push(String(failure.originName ?? failure.cause));
      },
    });
    if (!opened.ok) {
      if (signal?.aborted) {
        throw new FormFlowError('CANCELLED', 'Document processing was cancelled.');
      }
      return null;
    }
    fontResolutionMs = performance.now() - paginationStarted;
    const layoutStarted = performance.now();
    const layout = await opened.session.layout();
    layoutOnlyMs = performance.now() - layoutStarted;
    if (signal?.aborted) throw new FormFlowError('CANCELLED', 'Document processing was cancelled.');
    const core = coreLayout(layout);
    const pages = core.pages;
    if (pages.length === 0 || pages.length > MAX_PDF_PAGES) return null;
    const groups = collectGroups(pages);
    const resolvedFonts = opened.session.fontResolution ?? fontReport;
    const fontMetadata = resolvedFonts
      ? fontResolution(resolvedFonts, structure.docxLayout?.embeddedFonts)
      : { fonts: undefined, embeddedFonts: structure.docxLayout?.embeddedFonts, warnings: [] as ExtractionWarning[] };
    const pageModels: DocumentPaginationPage[] = pages.map((page) => ({
      pageNumber: page.index + 1,
      pageKind: 'renderer_derived_physical',
      blockIds: [],
      breakReason: 'renderer_generated',
      pageWidthPt: page.box.width,
      pageHeightPt: page.box.height,
      orientation: page.box.width > page.box.height ? 'landscape' : 'portrait',
      margins: pageMargins(page),
    }));
    const pagesById = new Map(pageModels.map((page) => [page.pageNumber, page]));
    let geometryCount = 0;
    let geometryChars = 0;
    let geometryTruncated = false;
    const reserveGeometry = (count: number, approximateChars: number): boolean => {
      if (geometryCount + count > MAX_PAGINATION_GEOMETRY_ENTRIES
        || geometryChars + count * approximateChars > MAX_PAGINATION_GEOMETRY_CHARS) {
        geometryTruncated = true;
        return false;
      }
      geometryCount += count;
      geometryChars += count * approximateChars;
      return true;
    };
    const pageSections = buildPageSections(pages, groups, core, structure);
    const columnsResult = buildPageColumns(pages, pageSections, structure, groups, reserveGeometry);
    for (let pageIndex = 0; pageIndex < pageModels.length; pageIndex += 1) {
      const page = pageModels[pageIndex]!;
      const section = columnsResult.sectionIndexes[pageIndex]!;
      const columns = columnsResult.columns[pageIndex]!;
      page.sectionIndex = section.sectionIndex;
      if (section.approximate) page.sectionIndexApproximate = true;
      if (columns.length) {
        page.columnCount = columns.length;
        page.columns = columns;
      }
    }
    const columnIndexFor = (pageNumber: number, x: number): number | undefined => {
      const bands = columnsResult.columns[pageNumber - 1]?.map((column) => ({ x: column.box.x, width: column.box.width })) ?? [];
      return columnIndexForX(bands, x);
    };
    const paragraphLineGeometry = (group: ParagraphGroup): DocumentPaginationLineGeometry[] => {
      const lines = group.lines.slice(0, MAX_PAGINATION_LINES_PER_BLOCK);
      if (group.lines.length > lines.length) geometryTruncated = true;
      if (!reserveGeometry(lines.length, 180)) return [];
      return lines.map((line) => ({
        lineIndex: line.lineIndex,
        pageNumber: line.pageNumber,
        fragmentIndex: line.fragmentIndex,
        box: {
          x: Math.max(0, line.box.x),
          y: Math.max(0, line.box.y),
          width: Math.max(0, line.box.width),
          height: Math.max(0, line.box.height),
          coordinateSpace: 'renderer_page_content_points',
        },
        ...(columnIndexFor(line.pageNumber, line.box.x) !== undefined
          ? { columnIndex: columnIndexFor(line.pageNumber, line.box.x) }
          : {}),
        confidence: 'exact',
      }));
    };
    const blockPages: DocumentPaginationBlockPage[] = [];
    const pendingTableBlocks: DocumentPaginationBlockPage[] = [];
    const imageCandidates = collectImageCandidates(pages);
    const usedImageCandidates = new Set<number>();
    const imageAppearanceWarnings: ExtractionWarning[] = [];
    let imageAppearanceCount = 0;
    let paragraphCursor = 0;
    let tableCursor = 0;
    let approximateMapping = false;
    const structureTables = structure.readingOrder
      .map((blockId) => structure.blocks.find((block) => block.blockId === blockId))
      .filter((block): block is DocumentStructureBlock => block !== undefined && block.type === 'table');
    const rendererTableIdByBlockId = new Map<string, string>();
    for (let index = 0; index < structureTables.length; index += 1) {
      const table = structureTables[index];
      const rendererTable = groups.tables[index];
      if (table && rendererTable) rendererTableIdByBlockId.set(table.blockId, rendererTable.id);
    }
    const candidateMedia = (candidate: ImageCandidate): string | undefined => (
      candidate.drawing.resource?.partName?.replace(/^\//, '')
    );
    const candidateAlt = (candidate: ImageCandidate): string => (
      candidate.drawing.accessibility?.label?.trim() ?? ''
    );
    const candidateMatchesImage = (candidate: ImageCandidate, image: NonNullable<DocumentStructureBlock['image']>): boolean => {
      const mediaPart = image.mediaPart?.replace(/^\//, '');
      if (mediaPart) return candidateMedia(candidate) === mediaPart;
      const label = image.alternativeText?.trim();
      return label ? candidateAlt(candidate) === label : true;
    };
    const takeCandidate = (predicate: (candidate: ImageCandidate) => boolean): ImageCandidate | undefined => {
      const candidate = imageCandidates.find((entry) => !usedImageCandidates.has(entry.order) && predicate(entry));
      if (candidate) usedImageCandidates.add(candidate.order);
      return candidate;
    };
    const applyImageAppearances = (
      block: DocumentStructureBlock,
      allAppearances: Array<{ pageNumber: number; box?: DocumentGeometryBox }>,
    ): boolean => {
      if (allAppearances.length === 0 || !block.image) return false;
      const remaining = Math.max(0, MAX_IMAGE_APPEARANCES_TOTAL - imageAppearanceCount);
      const appearances = allAppearances.slice(0, remaining);
      if (appearances.length < allAppearances.length && !imageAppearanceWarnings.some((item) => item.code === 'DOCX_IMAGE_APPEARANCE_LIMIT')) {
        imageAppearanceWarnings.push({
          code: 'DOCX_IMAGE_APPEARANCE_LIMIT',
          message: `Image page appearances were bounded to ${MAX_IMAGE_APPEARANCES_TOTAL}; remaining appearances were omitted while source placements were retained.`,
        });
      }
      if (appearances.length === 0) return false;
      imageAppearanceCount += appearances.length;
      block.image.appearances = appearances.map((appearance) => ({
        pageNumber: appearance.pageNumber,
        ...(appearance.box ? { box: appearance.box } : {}),
        confidence: 'exact' as const,
      }));
      for (const appearance of appearances) {
        const page = pagesById.get(appearance.pageNumber);
        if (page && !page.blockIds.includes(block.blockId)) page.blockIds.push(block.blockId);
      }
      const first = appearances[0]!;
      const last = appearances[appearances.length - 1]!;
      blockPages.push({
        blockId: block.blockId,
        startPageNumber: first.pageNumber,
        ...(last.pageNumber !== first.pageNumber ? { endPageNumber: last.pageNumber } : {}),
        ...(first.box ? { boundingBox: first.box } : {}),
        geometryConfidence: 'exact',
      });
      return true;
    };
    const topLevelBlocks = structure.readingOrder
      .map((blockId) => structure.blocks.find((block) => block.blockId === blockId))
      .filter((block): block is DocumentStructureBlock => Boolean(block))
      .filter((block) => block.type !== 'header' && block.type !== 'footer');
    for (const block of topLevelBlocks) {
      if (block.type === 'image') continue;
      if (block.type === 'table') {
        const tableGroup = groups.tables[tableCursor];
        if (!tableGroup) {
          approximateMapping = true;
          continue;
        }
        tableCursor += 1;
        const tableRows: DocumentPaginationRowGeometry[] = [];
        let geometryAvailable = true;
        for (const placement of tableGroup.allRows.slice(0, 5000)) {
          const rowCells: DocumentPaginationCellGeometry[] = [];
          for (const cell of placement.row.cells) {
            if (!reserveGeometry(1, 240)) {
              geometryAvailable = false;
              break;
            }
            rowCells.push({
              rowIndex: placement.row.rowIndex,
              columnIndex: cell.gridColumn,
              ...(cell.rowSpan !== undefined ? { rowSpan: cell.rowSpan } : {}),
              ...(cell.gridSpan > 1 ? { columnSpan: cell.gridSpan } : {}),
              pageNumber: placement.pageNumber,
              fragmentIndex: placement.fragmentIndex,
              box: {
                x: Math.max(0, cell.box.x),
                y: Math.max(0, cell.box.y),
                width: Math.max(0, cell.box.width),
                height: Math.max(0, cell.box.height),
                coordinateSpace: 'renderer_page_content_points',
              },
              confidence: 'exact',
              ...(placement.row.isHeaderRepeat ? { repeatedHeader: true } : {}),
            });
          }
          if (!geometryAvailable) break;
          if (!reserveGeometry(1, 180)) {
            geometryAvailable = false;
            break;
          }
          tableRows.push({
            rowIndex: placement.row.rowIndex,
            pageNumber: placement.pageNumber,
            fragmentIndex: placement.fragmentIndex,
            box: {
              x: Math.max(0, placement.row.box.x),
              y: Math.max(0, placement.row.box.y),
              width: Math.max(0, placement.row.box.width),
              height: Math.max(0, placement.row.box.height),
              coordinateSpace: 'renderer_page_content_points',
            },
            ...(placement.row.isHeaderRow ? { isHeaderRow: true } : {}),
            ...(placement.row.isHeaderRepeat ? { isHeaderRepeat: true } : {}),
            ...(placement.row.isContinuation ? { isContinuation: true } : {}),
            ...(placement.row.hasContinuation ? { hasContinuation: true } : {}),
            confidence: 'exact',
            ...(rowCells.length ? { cells: rowCells } : {}),
          });
        }
        const tableBox = geometryBox(tableGroup.box);
        const tablePageNumber = tableGroup.firstPageNumber ?? tableGroup.allRows[0]?.pageNumber ?? 1;
        const tableEntry = addBlockPage(
          blockPages,
          pagesById,
          block.blockId,
          tableGroup,
          false,
          {
            ...(tableBox ? { box: tableBox } : {}),
            confidence: 'exact',
            ...(tableRows.length ? { tableRows } : {}),
            ...(tableBox ? { columnIndex: columnIndexFor(tablePageNumber, tableBox.x) } : {}),
          },
        );
        if (geometryTruncated && tableRows.length === 0) tableEntry.geometryConfidence = 'unavailable';
        for (const rowId of block.children ?? []) {
          const row = structure.blocks.find((candidate) => candidate.blockId === rowId);
          if (!row) continue;
          const rowState = rowPageFor(row, tableGroup);
          if (!rowState) {
            approximateMapping = true;
            continue;
          }
          pendingTableBlocks.push({
            blockId: row.blockId,
            startPageNumber: rowState.pageNumber,
            ...(rowState.fragments.length > 1 ? { endPageNumber: rowState.fragments[rowState.fragments.length - 1]!.pageNumber } : {}),
            ...(rowState.fragments.length > 1
              ? { fragmentPages: rowState.fragments.map((fragment) => ({ pageNumber: fragment.pageNumber, fragmentIndex: fragment.fragmentIndex })) }
              : {}),
            ...(geometryBox(rowState.box) ? { boundingBox: geometryBox(rowState.box) } : {}),
            geometryConfidence: 'exact',
            rowIndex: row.rowIndex,
          });
          for (const cellId of row.children ?? []) {
            const cellBlock = structure.blocks.find((candidate) => candidate.blockId === cellId);
            if (!cellBlock || row.rowIndex === undefined) continue;
            const cellState = rowState.cells.get(cellBlock.columnIndex ?? 0);
            if (!cellState) {
              approximateMapping = true;
              continue;
            }
            pendingTableBlocks.push({
              blockId: cellBlock.blockId,
              startPageNumber: cellState.pageNumber,
              ...(cellState.fragments.length > 1 ? { endPageNumber: cellState.fragments[cellState.fragments.length - 1]!.pageNumber } : {}),
              ...(cellState.fragments.length > 1
                ? { fragmentPages: cellState.fragments.map((fragment) => ({ pageNumber: fragment.pageNumber, fragmentIndex: fragment.fragmentIndex })) }
                : {}),
              ...(geometryBox(cellState.box) ? { boundingBox: geometryBox(cellState.box) } : {}),
              geometryConfidence: 'exact',
              rowIndex: row.rowIndex,
              columnIndex: cellBlock.columnIndex,
              ...(cellBlock.rowSpan !== undefined ? { rowSpan: cellBlock.rowSpan } : {}),
              ...(cellBlock.columnSpan !== undefined ? { columnSpan: cellBlock.columnSpan } : {}),
            });
          }
        }
        continue;
      }
      if (block.type === 'list') {
        const itemIds = block.children ?? [];
        const itemGroups: ParagraphGroup[] = [];
        for (const itemId of itemIds) {
          const item = structure.blocks.find((candidate) => candidate.blockId === itemId);
          if (!item) continue;
          const found = findParagraphGroup(groups.paragraphs, paragraphCursor, item.text);
          paragraphCursor = found.next;
          if (found.approximate || !found.group) approximateMapping = true;
          if (!found.group) continue;
          itemGroups.push(found.group);
          addBlockPage(blockPages, pagesById, item.blockId, found.group, found.approximate, {
            lines: paragraphLineGeometry(found.group),
            confidence: 'exact',
          });
        }
        if (itemGroups.length) {
          const first = groupPageRange(itemGroups[0]!).start;
          const last = groupPageRange(itemGroups[itemGroups.length - 1]!).end;
          const entry = addBlockPage(blockPages, pagesById, block.blockId, {
            pages: new Map(itemGroups.flatMap((group) => [...group.pages.entries()])),
          }, false, { confidence: 'text_order' });
          entry.startPageNumber = first;
          if (last !== first) entry.endPageNumber = last;
        }
        continue;
      }
      const found = findParagraphGroup(groups.paragraphs, paragraphCursor, block.text);
      paragraphCursor = found.next;
      if (found.approximate || !found.group) approximateMapping = true;
      if (found.group) {
        addBlockPage(blockPages, pagesById, block.blockId, found.group, found.approximate, {
          lines: paragraphLineGeometry(found.group),
          confidence: 'exact',
        });
      }
    }
    for (const block of structure.blocks) {
      if (block.type !== 'image' || !block.image) continue;
      const image = block.image;
      if (image.headerFooter) {
        const partName = image.headerFooter.partName.replace(/^\//, '');
        const placementIndex = image.placementIndex ?? 0;
        const byPage = new Map<number, ImageCandidate[]>();
        for (const candidate of imageCandidates) {
          if (candidate.scope !== image.headerFooter.kind) continue;
          if (candidate.partName?.replace(/^\//, '') !== partName) continue;
          if (!candidateMatchesImage(candidate, image)) continue;
          const list = byPage.get(candidate.pageNumber) ?? [];
          list.push(candidate);
          byPage.set(candidate.pageNumber, list);
        }
        const appearances: Array<{ pageNumber: number; box?: DocumentGeometryBox }> = [];
        for (const pageNumber of [...byPage.keys()].sort((left, right) => left - right)) {
          const list = byPage.get(pageNumber)!.sort((left, right) => left.order - right.order);
          const candidate = list[placementIndex];
          if (!candidate || usedImageCandidates.has(candidate.order)) continue;
          usedImageCandidates.add(candidate.order);
          appearances.push({ pageNumber, ...(candidate.box ? { box: candidate.box } : {}) });
        }
        if (!applyImageAppearances(block, appearances)) {
          approximateMapping = true;
        }
        continue;
      }
      if (image.parentCellBlockId) {
        const tableBlock = structure.blocks.find((candidate) => candidate.type === 'table' && candidate.tableId === image.tableId);
        const rendererTableId = tableBlock ? rendererTableIdByBlockId.get(tableBlock.blockId) : undefined;
        const candidate = takeCandidate((entry) => (
          entry.scope === 'table'
          && entry.tableId === rendererTableId
          && entry.rowIndex === image.rowIndex
          && entry.columnIndex === image.columnIndex
          && (entry.nestedTableDepth ?? 0) === (image.nestedTableDepth ?? 0)
          && candidateMatchesImage(entry, image)
        ));
        if (candidate) {
          applyImageAppearances(block, [{
            pageNumber: candidate.pageNumber,
            ...(candidate.box ? { box: candidate.box } : {}),
          }]);
        } else {
          const parent = blockPages.find((entry) => entry.blockId === image.parentCellBlockId);
          if (parent) {
            addBlockPage(blockPages, pagesById, block.blockId, {
              pages: new Map([[parent.startPageNumber, []]]),
            }, true, { confidence: 'text_order' });
          } else {
            approximateMapping = true;
          }
        }
        continue;
      }
      const candidate = takeCandidate((entry) => entry.scope === 'body' && candidateMatchesImage(entry, image));
      if (candidate) {
        applyImageAppearances(block, [{
          pageNumber: candidate.pageNumber,
          ...(candidate.box ? { box: candidate.box } : {}),
        }]);
      } else {
        const sourceParagraph = image.sourceParagraphBlockId
          ? blockPages.find((entry) => entry.blockId === image.sourceParagraphBlockId)
          : undefined;
        if (sourceParagraph) {
          addBlockPage(blockPages, pagesById, block.blockId, {
            pages: new Map([[sourceParagraph.startPageNumber, []]]),
          }, true, { confidence: 'text_order' });
        } else {
          approximateMapping = true;
        }
      }
    }
    for (const pending of pendingTableBlocks) {
      if (blockPages.length >= MAX_STRUCTURE_BLOCKS) {
        approximateMapping = true;
        break;
      }
      blockPages.push(pending);
    }
    const geometry: DocumentPaginationGeometrySummary = {
      lineCount: blockPages.reduce((count, entry) => count + (entry.lines?.length ?? 0), 0),
      cellCount: blockPages.reduce((count, entry) => count + (entry.tableRows?.reduce((sum, row) => sum + (row.cells?.length ?? 0), 0) ?? 0), 0),
      columnCount: pageModels.reduce((count, page) => count + (page.columns?.length ?? 0), 0),
      truncated: geometryTruncated,
    };
    const warnings: ExtractionWarning[] = [{
      code: 'DOCX_RENDERER_DERIVED_PAGINATION',
      message: 'Automatic page boundaries were derived by the local font-backed @docx-editor.dev/core layout engine. These are renderer-derived physical pages, not an independently verified Microsoft Word reproduction.',
    }];
    warnings.push(...normalizationWarnings);
    warnings.push(...imageAppearanceWarnings);
    if (normalization.normalizedTables > 0) {
      warnings.push({
        code: 'DOCX_TABLE_WIDTHS_NORMALIZED',
        message: `${normalization.normalizedTables} table(s) without an explicit fixed width were laid out from their authored grid or available cell width so nested-table rows do not collapse to content-minimum widths.`,
      });
    }
    if (approximateMapping) {
      warnings.push({
        code: 'DOCX_PAGINATION_MAPPING_APPROXIMATE',
        message: 'Some FormFlow blocks could not be matched exactly to renderer fragments; their page references are marked approximate.',
      });
    }
    if (geometryTruncated) {
      warnings.push({
        code: 'DOCX_GEOMETRY_TRUNCATED',
        message: 'Line, cell, or column geometry was bounded to the local structure limit; page associations remain available.',
      });
    }
    if (fontCoverageIncomplete || fontFailures.length > 0 || fontMetadata.fonts?.some((font) => font.substituted)) {
      warnings.push({
        code: 'DOCX_PAGINATION_FONT_SUBSTITUTION',
        message: 'Some document fonts were substituted or unavailable; line wrapping and page boundaries may differ from Microsoft Word.',
      });
    }
    if (normalizedFontMetrics) {
      warnings.push({
        code: 'DOCX_FONT_VERTICAL_METRICS_NORMALIZED',
        message: 'Packaged substitute faces use normalized typo vertical metrics so mixed-size run line boxes match Word/LibreOffice ascent+descent behavior. Glyph outlines and advance widths are unchanged.',
      });
    }
    warnings.push(...fontMetadata.warnings);
    for (const contentWarning of core.contentWarnings ?? []) {
      warnings.push({
        code: 'DOCX_RENDERER_CONTENT_WARNING',
        message: `The DOCX renderer preserved but did not fully lay out ${contentWarning.code} content in ${contentWarning.partName}.`,
      });
    }
    return {
      pagination: {
        status: 'renderer_derived_physical',
        mechanism: 'local_renderer',
        pageCount: pages.length,
        pages: pageModels,
        blockPages,
        warnings: sanitizeWarnings(warnings),
        renderer: RENDERER_NAME,
        geometry,
      },
      warnings: sanitizeWarnings(warnings),
      ...(fontMetadata.fonts ? { fonts: fontMetadata.fonts } : {}),
      ...(fontMetadata.embeddedFonts ? { embeddedFonts: fontMetadata.embeddedFonts } : {}),
      timings: {
        fontResolutionMs,
        layoutMs: layoutOnlyMs,
        mappingMs: Math.max(0, performance.now() - paginationStarted - fontResolutionMs - layoutOnlyMs),
      },
    };
  } catch (error) {
    if (signal?.aborted) throw new FormFlowError('CANCELLED', 'Document processing was cancelled.', { cause: error });
    if (timedOut) return null;
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    opened?.ok ? opened.session.dispose() : undefined;
  }
}
