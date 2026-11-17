import type {
  DocumentStructureBlock,
  DocumentStructureBoundingBox,
  DocumentStructurePage,
  ExtractionWarning,
  OcrBoundingBox,
} from '@shared/types';
import { structureBlock, structureBlockId, structurePage } from '../structure';
import { sanitizeWarnings } from '../text-utils';

export interface PdfLayoutItem {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fontSize: number;
  fontName: string;
  bold: boolean;
  italic: boolean;
  direction: string;
  hasEOL: boolean;
}

export interface PdfLayoutLine {
  text: string;
  bbox: OcrBoundingBox;
  fontSize: number;
  fontName: string;
  bold: boolean;
  italic: boolean;
  direction: string;
  items: PdfLayoutItem[];
}

export interface PdfPageStructureResult {
  page: DocumentStructurePage;
  blocks: DocumentStructureBlock[];
  warnings: ExtractionWarning[];
}

interface InternalLine extends PdfLayoutLine {
  column: number;
}

const HEADER_BAND = 0.12;
const FOOTER_BAND = 0.88;
const LIST_MARKER = /^([-*•▪◦]|\(?\d{1,3}[.)]|[A-Za-z][.)])\s+(.+)$/;

function union(items: Array<OcrBoundingBox>): OcrBoundingBox {
  return items.reduce<OcrBoundingBox>((box, item) => ({
    x0: Math.min(box.x0, item.x0),
    y0: Math.min(box.y0, item.y0),
    x1: Math.max(box.x1, item.x1),
    y1: Math.max(box.y1, item.y1),
  }), { x0: Number.POSITIVE_INFINITY, y0: Number.POSITIVE_INFINITY, x1: 0, y1: 0 });
}

function lineText(items: PdfLayoutItem[]): string {
  let output = '';
  for (const item of items) {
    const value = item.text;
    if (!value) continue;
    if (output && !/\s$/.test(output) && !/^\s/.test(value)) {
      const previous = items[Math.max(0, items.indexOf(item) - 1)];
      const gap = previous ? item.x0 - previous.x1 : 0;
      if (gap > Math.max(1.5, item.fontSize * 0.18)) output += ' ';
    }
    output += value;
  }
  return output.replace(/\s+/g, ' ').trim();
}

export function groupPdfItemsIntoLines(items: PdfLayoutItem[], pageWidth: number): PdfLayoutLine[] {
  const usable = items
    .filter((item) => item.text.trim().length > 0 && item.x1 >= item.x0 && item.y1 >= item.y0)
    .sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
  const groups: PdfLayoutItem[][] = [];
  for (const item of usable) {
    const center = (item.y0 + item.y1) / 2;
    let target: PdfLayoutItem[] | null = null;
    for (const group of groups) {
      const groupBox = union(group.map((entry) => ({
        x0: entry.x0, y0: entry.y0, x1: entry.x1, y1: entry.y1,
      })));
      const groupCenter = (groupBox.y0 + groupBox.y1) / 2;
      const tolerance = Math.max(3, Math.min(9, Math.max(item.fontSize, groupBox.y1 - groupBox.y0) * 0.55));
      if (Math.abs(center - groupCenter) <= tolerance) {
        target = group;
        break;
      }
    }
    if (target) target.push(item);
    else groups.push([item]);
  }
  const lines: PdfLayoutLine[] = [];
  const makeLine = (group: PdfLayoutItem[]) => {
    const sorted = [...group].sort((a, b) => a.x0 - b.x0);
    const text = lineText(sorted);
    if (!text) return;
    const bbox = union(sorted.map((item) => ({
      x0: item.x0, y0: item.y0, x1: item.x1, y1: item.y1,
    })));
    const fontSizes = sorted.map((item) => item.fontSize).filter((size) => Number.isFinite(size) && size > 0);
    const fontSize = fontSizes.length
      ? fontSizes.sort((a, b) => a - b)[Math.floor(fontSizes.length / 2)]!
      : 10;
    const reference = sorted[0]!;
    lines.push({
      text,
      bbox,
      fontSize,
      fontName: reference.fontName,
      bold: sorted.some((item) => item.bold),
      italic: sorted.some((item) => item.italic),
      direction: reference.direction,
      items: sorted,
    });
  };
  const fragmentGap = Math.max(20, pageWidth * 0.045);
  for (const group of groups) {
    const sorted = [...group].sort((a, b) => a.x0 - b.x0);
    let fragment: PdfLayoutItem[] = [];
    let previousEnd: number | null = null;
    for (const item of sorted) {
      if (previousEnd !== null && item.x0 - previousEnd > fragmentGap) {
        if (fragment.length) makeLine(fragment);
        fragment = [];
      }
      fragment.push(item);
      previousEnd = item.x1;
    }
    if (fragment.length) makeLine(fragment);
  }
  return lines.sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
}

function median(values: number[]): number {
  if (!values.length) return 10;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function normalizedMarginText(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\d+/g, '#').trim().toLowerCase();
}

function looksLikePageNumber(text: string): boolean {
  return /^\s*(?:page\s*)?\d{1,5}(?:\s*(?:of|\/)\s*\d{1,5})?\s*$/i.test(text);
}

function marginType(line: PdfLayoutLine, pageHeight: number, repeated: Set<string>): 'header' | 'footer' | null {
  const top = line.bbox.y1 <= pageHeight * HEADER_BAND;
  const bottom = line.bbox.y0 >= pageHeight * FOOTER_BAND;
  if (!top && !bottom) return null;
  if (repeated.has(normalizedMarginText(line.text)) || looksLikePageNumber(line.text)) {
    return top ? 'header' : 'footer';
  }
  return null;
}

function findColumnGap(lines: PdfLayoutLine[], pageWidth: number, pageHeight: number): { start: number; end: number; left: PdfLayoutLine[]; right: PdfLayoutLine[] } | null {
  const narrow = lines.filter((line) => line.bbox.x1 - line.bbox.x0 <= pageWidth * 0.55);
  if (narrow.length < 6) return null;
  const intervals = narrow
    .map((line) => [line.bbox.x0, line.bbox.x1] as const)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (!last || interval[0] > last[1]) merged.push([interval[0], interval[1]]);
    else last[1] = Math.max(last[1], interval[1]);
  }
  const contentLeft = Math.min(...narrow.map((line) => line.bbox.x0));
  const contentRight = Math.max(...narrow.map((line) => line.bbox.x1));
  let best: { start: number; end: number; left: PdfLayoutLine[]; right: PdfLayoutLine[] } | null = null;
  for (let index = 0; index < merged.length - 1; index += 1) {
    const start = merged[index]![1];
    const end = merged[index + 1]![0];
    const width = end - start;
    if (width < Math.max(10, pageWidth * 0.045)) continue;
    if (start <= contentLeft || end >= contentRight) continue;
    const left = narrow.filter((line) => line.bbox.x1 <= start);
    const right = narrow.filter((line) => line.bbox.x0 >= end);
    if (left.length < 3 || right.length < 3) continue;
    const leftSpan = Math.max(...left.map((line) => line.bbox.y1)) - Math.min(...left.map((line) => line.bbox.y0));
    const rightSpan = Math.max(...right.map((line) => line.bbox.y1)) - Math.min(...right.map((line) => line.bbox.y0));
    if (leftSpan < pageHeight * 0.12 || rightSpan < pageHeight * 0.12) continue;
    if (!best || width > best.end - best.start) best = { start, end, left, right };
  }
  return best;
}

function splitColumns(
  lines: PdfLayoutLine[],
  pageWidth: number,
  pageHeight: number,
  depth = 0,
): { columns: PdfLayoutLine[][]; uncertain: boolean } {
  if (depth >= 3 || lines.length < 3) return { columns: [lines], uncertain: false };
  const gap = findColumnGap(lines, pageWidth, pageHeight);
  if (!gap) return { columns: [lines], uncertain: false };
  const leftLines = lines.filter((line) => line.bbox.x1 <= gap.start);
  const rightLines = lines.filter((line) => line.bbox.x0 >= gap.end);
  const crossing = lines.filter((line) => line.bbox.x0 < gap.end && line.bbox.x1 > gap.start && line.bbox.x1 - line.bbox.x0 > pageWidth * 0.28);
  const unresolved = lines.filter((line) => !leftLines.includes(line) && !rightLines.includes(line) && !crossing.includes(line));
  const leftSplit = splitColumns(leftLines, pageWidth, pageHeight, depth + 1);
  const rightSplit = splitColumns(rightLines, pageWidth, pageHeight, depth + 1);
  const columns = [...leftSplit.columns, ...rightSplit.columns, crossing, unresolved.length ? unresolved : []]
    .filter((column) => column.length > 0)
    .sort((a, b) => Math.min(...a.map((line) => line.bbox.x0)) - Math.min(...b.map((line) => line.bbox.x0)));
  return {
    columns,
    uncertain: leftSplit.uncertain || rightSplit.uncertain || unresolved.length > 0 || columns.length > 4,
  };
}

function orderedBodyLines(
  lines: PdfLayoutLine[],
  pageWidth: number,
  pageHeight: number,
): { lines: InternalLine[]; uncertain: boolean } {
  const { columns, uncertain } = splitColumns(lines, pageWidth, pageHeight);
  if (columns.length <= 1) {
    return {
      lines: [...lines].sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0))
        .map((line) => ({ ...line, column: 0 })),
      uncertain,
    };
  }
  const ordered: InternalLine[] = [];
  const allLines = columns.flat();
  const fullLines = allLines
    .filter((line) => line.bbox.x1 - line.bbox.x0 > pageWidth * 0.55)
    .sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
  const widthColumns = columns
    .map((column) => column.filter((line) => !fullLines.includes(line)))
    .filter((column) => column.length > 0);
  if (widthColumns.length < 2) {
    return {
      lines: [...lines].sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0))
        .map((line) => ({ ...line, column: 0 })),
      uncertain,
    };
  }
  const columnTop = Math.min(...widthColumns.flat().map((line) => line.bbox.y0));
  const columnBottom = Math.max(...widthColumns.flat().map((line) => line.bbox.y1));
  const pre = fullLines.filter((line) => line.bbox.y1 <= columnTop);
  const post = fullLines.filter((line) => line.bbox.y0 >= columnBottom);
  const middle = fullLines.filter((line) => !pre.includes(line) && !post.includes(line));
  for (const line of pre) ordered.push({ ...line, column: 0 });
  for (let index = 0; index < widthColumns.length; index += 1) {
    const column = [...widthColumns[index]!].sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
    for (const line of column) ordered.push({ ...line, column: index + 1 });
  }
  for (const line of middle) ordered.push({ ...line, column: 0 });
  for (const line of post) ordered.push({ ...line, column: widthColumns.length + 1 });
  return { lines: ordered, uncertain: uncertain || middle.length > 0 };
}

interface TableRowCandidate {
  cells: InternalLine[];
  bbox: OcrBoundingBox;
}

interface TableCandidate {
  rows: TableRowCandidate[];
}

function groupTableRows(lines: InternalLine[]): TableRowCandidate[] {
  const rows: TableRowCandidate[] = [];
  for (const line of lines) {
    let target: TableRowCandidate | null = null;
    for (const row of rows) {
      if (row.cells[0]?.column !== line.column) continue;
      const overlap = Math.min(row.bbox.y1, line.bbox.y1) - Math.max(row.bbox.y0, line.bbox.y0);
      const tolerance = Math.max(2, Math.min(row.bbox.y1 - row.bbox.y0, line.bbox.y1 - line.bbox.y0) * 0.45);
      if (overlap >= tolerance) {
        target = row;
        break;
      }
    }
    if (target) {
      target.cells.push(line);
      target.bbox = union([target.bbox, line.bbox]);
    } else {
      rows.push({ cells: [line], bbox: { ...line.bbox } });
    }
  }
  for (const row of rows) row.cells.sort((a, b) => a.bbox.x0 - b.bbox.x0);
  return rows;
}

function isTableRow(row: TableRowCandidate, pageWidth: number): boolean {
  if (row.cells.length < 2 || row.cells.length > 8) return false;
  for (const cell of row.cells) {
    if (!cell.text.trim() || cell.text.length > 160) return false;
    if (cell.bbox.x1 - cell.bbox.x0 > pageWidth * 0.42) return false;
  }
  for (let index = 1; index < row.cells.length; index += 1) {
    const gap = row.cells[index]!.bbox.x0 - row.cells[index - 1]!.bbox.x1;
    if (gap < 0 || gap > pageWidth * 0.25) return false;
  }
  return true;
}

function compatibleTableRows(row: TableRowCandidate, reference: TableRowCandidate, pageWidth: number): boolean {
  if (row.cells.length !== reference.cells.length) return false;
  return row.cells.every((cell, index) => {
    const ref = reference.cells[index]!;
    return Math.abs(cell.bbox.x0 - ref.bbox.x0) <= Math.max(8, pageWidth * 0.015);
  });
}

function detectTables(lines: InternalLine[], pageWidth: number): { tables: TableCandidate[]; used: Set<InternalLine>; uncertain: boolean } {
  const tables: TableCandidate[] = [];
  const used = new Set<InternalLine>();
  let uncertain = false;
  const rows = groupTableRows(lines);
  for (let index = 0; index < rows.length; index += 1) {
    const first = rows[index]!;
    if (!isTableRow(first, pageWidth)) continue;
    if (first.cells.some((cell) => used.has(cell))) continue;
    const run: TableRowCandidate[] = [first];
    let cursor = index + 1;
    while (cursor < rows.length) {
      const next = rows[cursor]!;
      if (used.size && next.cells.some((cell) => used.has(cell))) break;
      if (!isTableRow(next, pageWidth) || !compatibleTableRows(next, first, pageWidth)) break;
      const previous = run[run.length - 1]!;
      const gap = next.bbox.y0 - previous.bbox.y1;
      if (gap > Math.max(8, Math.min(30, next.bbox.y1 - next.bbox.y0) * 2.4)) break;
      run.push(next);
      cursor += 1;
    }
    if (run.length >= 2) {
      for (const row of run) for (const cell of row.cells) used.add(cell);
      tables.push({ rows: run });
      index = cursor - 1;
    } else {
      uncertain = true;
    }
  }
  return { tables, used, uncertain };
}

function alignmentFor(box: OcrBoundingBox, pageWidth: number): 'left' | 'center' | 'right' | 'justified' | 'unknown' {
  const width = box.x1 - box.x0;
  const center = (box.x0 + box.x1) / 2;
  if (width < pageWidth * 0.2) return 'unknown';
  if (Math.abs(center - pageWidth / 2) < pageWidth * 0.06 && width < pageWidth * 0.7) return 'center';
  if (box.x1 > pageWidth * 0.9 && width < pageWidth * 0.7) return 'right';
  return 'left';
}

function pdfBox(box: OcrBoundingBox, pageWidth: number, pageHeight: number): DocumentStructureBoundingBox {
  return {
    x0: Math.round(box.x0 * 100) / 100,
    y0: Math.round(box.y0 * 100) / 100,
    x1: Math.round(box.x1 * 100) / 100,
    y1: Math.round(box.y1 * 100) / 100,
    coordinateSpace: 'pdf_page_points',
    pageWidth: Math.round(pageWidth * 100) / 100,
    pageHeight: Math.round(pageHeight * 100) / 100,
  };
}

function listMatch(line: PdfLayoutLine, baseX: number): { marker: string; text: string; level: number } | null {
  const match = LIST_MARKER.exec(line.text);
  if (!match) return null;
  return {
    marker: match[1]!,
    text: match[2]!,
    level: Math.max(1, Math.min(3, Math.floor(Math.max(0, line.bbox.x0 - baseX) / 18) + 1)),
  };
}

export function buildPdfPageStructure(input: {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  lines: PdfLayoutLine[];
  pageType: 'text' | 'image_only' | 'blank' | 'unknown';
  repeatedMarginText: Set<string>;
}): PdfPageStructureResult {
  const { pageNumber, pageWidth, pageHeight, lines, pageType, repeatedMarginText } = input;
  const warnings: ExtractionWarning[] = [];
  const blocks: DocumentStructureBlock[] = [];
  let order = 0;
  const addBlock = (block: DocumentStructureBlock) => {
    blocks.push(block);
    return block;
  };

  const headerLines: PdfLayoutLine[] = [];
  const footerLines: PdfLayoutLine[] = [];
  const bodyLines: PdfLayoutLine[] = [];
  for (const line of lines) {
    const margin = marginType(line, pageHeight, repeatedMarginText);
    if (margin === 'header') headerLines.push(line);
    else if (margin === 'footer') footerLines.push(line);
    else bodyLines.push(line);
  }
  const orderedHeaders = [...headerLines].sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
  const orderedFooters = [...footerLines].sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
  for (const line of orderedHeaders) {
    addBlock(structureBlock({
      blockId: structureBlockId(pageNumber, order + 1),
      type: 'header',
      text: line.text,
      pageNumber,
      order: order++,
      boundingBox: pdfBox(line.bbox, pageWidth, pageHeight),
      provenance: 'pdf_native',
      layoutInferred: true,
      sourceRef: `pdf:page${pageNumber}:margin`,
      style: {
        fontSize: Math.round(line.fontSize * 10) / 10,
        fontFamily: line.fontName || undefined,
        ...(line.bold ? { bold: true } : {}),
        ...(line.italic ? { italic: true } : {}),
        alignment: alignmentFor(line.bbox, pageWidth),
        direction: line.direction,
      },
    }));
  }

  const orderedBody = orderedBodyLines(bodyLines, pageWidth, pageHeight);
  if (orderedBody.uncertain) {
    warnings.push({
      code: 'READING_ORDER_UNCERTAIN',
      message: 'Column regions were detected but the reading order could not be established with certainty; geometric order was retained.',
      page: pageNumber,
    });
  }
  const bodyMedian = median(orderedBody.lines.map((line) => line.fontSize));
  const listBaseX = orderedBody.lines.length ? Math.min(...orderedBody.lines.map((line) => line.bbox.x0)) : 0;
  const tableResult = detectTables(orderedBody.lines, pageWidth);
  if (tableResult.uncertain) {
    warnings.push({
      code: 'TABLE_RECONSTRUCTION_UNCERTAIN',
      message: 'A possible table was found, but the cell boundaries were not reliable enough to reconstruct it. Ordered text was preserved.',
      page: pageNumber,
    });
  }
  const consumed = new Set<InternalLine>(tableResult.used);
  const tableByLine = new Map<InternalLine, TableCandidate>();
  for (const table of tableResult.tables) {
    for (const row of table.rows) {
      for (const cell of row.cells) tableByLine.set(cell, table);
    }
  }

  let tableCounter = 0;
  let index = 0;
  while (index < orderedBody.lines.length) {
    const line = orderedBody.lines[index]!;
    if (consumed.has(line)) {
      const table = tableByLine.get(line);
      if (!table) { index += 1; continue; }
      tableCounter += 1;
      const tableId = `p${pageNumber}_t${tableCounter}`;
      const tableBlockId = structureBlockId(pageNumber, order + 1);
      const rowIds: string[] = [];
      const rows: DocumentStructureBlock[] = [];
      const tableLineCount = table.rows.reduce((sum, row) => sum + row.cells.length, 0);
      for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
        const row = table.rows[rowIndex]!;
        const rowId = structureBlockId(pageNumber, order + 1, `r${rowIndex + 1}`);
        const cellIds: string[] = [];
        const cellBlocks: DocumentStructureBlock[] = [];
        for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
          const cell = row.cells[cellIndex]!;
          const cellId = structureBlockId(pageNumber, order + 1, `r${rowIndex + 1}c${cellIndex + 1}`);
          cellIds.push(cellId);
          cellBlocks.push(structureBlock({
            blockId: cellId,
            type: 'table_cell',
            text: cell.text,
            pageNumber,
            order: order++,
            parentId: rowId,
            boundingBox: pdfBox(cell.bbox, pageWidth, pageHeight),
            provenance: 'pdf_native',
            layoutInferred: true,
            tableId,
            rowIndex,
            columnIndex: cellIndex,
            sourceRef: `pdf:page${pageNumber}:table${tableCounter}:row${rowIndex + 1}:cell${cellIndex + 1}`,
          }));
        }
        rowIds.push(rowId);
        rows.push(structureBlock({
          blockId: rowId,
          type: 'table_row',
          text: row.cells.map((cell) => cell.text).join('\t'),
          pageNumber,
          order: order++,
          parentId: tableBlockId,
          children: cellIds,
          boundingBox: pdfBox(row.bbox, pageWidth, pageHeight),
          provenance: 'inferred_from_layout',
          layoutInferred: true,
          tableId,
          rowIndex,
          sourceRef: `pdf:page${pageNumber}:table${tableCounter}:row${rowIndex + 1}`,
        }));
        // Child blocks are appended after their parent, keeping document order deterministic.
        rows.push(...cellBlocks);
      }
      const tableBox = union(table.rows.map((row) => row.bbox));
      addBlock(structureBlock({
        blockId: tableBlockId,
        type: 'table',
        text: table.rows.map((row) => row.cells.map((cell) => cell.text).join('\t')).join('\n'),
        pageNumber,
        order: order++,
        children: rowIds,
        boundingBox: pdfBox(tableBox, pageWidth, pageHeight),
        provenance: 'inferred_from_layout',
        layoutInferred: true,
        tableId,
        sourceRef: `pdf:page${pageNumber}:table${tableCounter}`,
        warnings: [{
          code: 'TABLE_RECONSTRUCTED',
          message: 'Table rows and cells were reconstructed from text positions; verify against the original document.',
          page: pageNumber,
        }],
      }));
      // Append rows after the table container so the table is the top-level reading-order entry.
      blocks.push(...rows);
      index += tableLineCount;
      continue;
    }

    const list = listMatch(line, listBaseX);
    if (list) {
      const listItems: InternalLine[] = [];
      let cursor = index;
      while (cursor < orderedBody.lines.length) {
        const candidate = orderedBody.lines[cursor]!;
        if (consumed.has(candidate)) break;
        const matched = listMatch(candidate, listBaseX);
        if (!matched) break;
        listItems.push(candidate);
        cursor += 1;
      }
      const listBlockId = structureBlockId(pageNumber, order + 1);
      const itemBlocks: DocumentStructureBlock[] = [];
      const itemIds: string[] = [];
      for (let itemIndex = 0; itemIndex < listItems.length; itemIndex += 1) {
        const itemLine = listItems[itemIndex]!;
        const matched = listMatch(itemLine, listBaseX)!;
        const itemId = structureBlockId(pageNumber, order + 1, `li${itemIndex + 1}`);
        itemIds.push(itemId);
        itemBlocks.push(structureBlock({
          blockId: itemId,
          type: 'list_item',
          text: matched.text,
          pageNumber,
          order: order++,
          parentId: listBlockId,
          boundingBox: pdfBox(itemLine.bbox, pageWidth, pageHeight),
          provenance: 'pdf_native',
          layoutInferred: true,
          level: matched.level,
          listMarker: matched.marker,
          sourceRef: `pdf:page${pageNumber}:list${listBlockId}:item${itemIndex + 1}`,
        }));
        consumed.add(itemLine);
      }
      addBlock(structureBlock({
        blockId: listBlockId,
        type: 'list',
        text: listItems.map((item) => listMatch(item, listBaseX)?.text ?? item.text).join('\n'),
        pageNumber,
        order: order++,
        children: itemIds,
        boundingBox: pdfBox(union(listItems.map((item) => item.bbox)), pageWidth, pageHeight),
        provenance: 'inferred_from_layout',
        layoutInferred: true,
        sourceRef: `pdf:page${pageNumber}:list${listBlockId}`,
      }));
      blocks.push(...itemBlocks);
      index = cursor;
      continue;
    }

    // Paragraph: gather consecutive body lines with similar geometry/font size.
    const paragraphLines: InternalLine[] = [line];
    let cursor = index + 1;
    while (cursor < orderedBody.lines.length) {
      const next = orderedBody.lines[cursor]!;
      if (consumed.has(next) || tableByLine.has(next)) break;
      if (listMatch(next, listBaseX)) break;
      if (next.column !== line.column) break;
      const previous = paragraphLines[paragraphLines.length - 1]!;
      const gap = next.bbox.y0 - previous.bbox.y1;
      if (gap > Math.max(3, bodyMedian * 1.65)) break;
      if (Math.abs(next.fontSize - previous.fontSize) > Math.max(2, previous.fontSize * 0.22)) break;
      if (next.bold !== previous.bold && next.fontSize < bodyMedian * 1.15) break;
      paragraphLines.push(next);
      cursor += 1;
    }
    const paragraphBox = union(paragraphLines.map((item) => item.bbox));
    const headingSizes = paragraphLines.map((item) => item.fontSize);
    const maxSize = Math.max(...headingSizes);
    const sizeRatio = maxSize / Math.max(1, bodyMedian);
    const heading = paragraphLines.length <= 2
      && line.text.length <= 160
      && (sizeRatio >= 1.18 || (line.bold && sizeRatio >= 1.06))
      && !looksLikePageNumber(line.text);
    const level = sizeRatio >= 1.55 ? 1 : sizeRatio >= 1.3 ? 2 : 3;
    addBlock(structureBlock({
      blockId: structureBlockId(pageNumber, order + 1),
      type: heading ? 'heading' : 'paragraph',
      text: paragraphLines.map((item) => item.text).join('\n'),
      pageNumber,
      order: order++,
      boundingBox: pdfBox(paragraphBox, pageWidth, pageHeight),
      provenance: heading ? 'inferred_from_layout' : 'pdf_native',
      layoutInferred: heading,
      ...(heading ? { level } : {}),
      sourceRef: `pdf:page${pageNumber}:text${index + 1}`,
      style: {
        fontSize: Math.round(maxSize * 10) / 10,
        fontFamily: paragraphLines[0]?.fontName || undefined,
        ...(paragraphLines.some((item) => item.bold) ? { bold: true } : {}),
        ...(paragraphLines.some((item) => item.italic) ? { italic: true } : {}),
        alignment: alignmentFor(paragraphBox, pageWidth),
        direction: line.direction,
      },
    }));
    index = cursor;
  }

  for (const line of orderedFooters) {
    addBlock(structureBlock({
      blockId: structureBlockId(pageNumber, order + 1),
      type: 'footer',
      text: line.text,
      pageNumber,
      order: order++,
      boundingBox: pdfBox(line.bbox, pageWidth, pageHeight),
      provenance: 'pdf_native',
      layoutInferred: true,
      sourceRef: `pdf:page${pageNumber}:margin`,
      style: {
        fontSize: Math.round(line.fontSize * 10) / 10,
        fontFamily: line.fontName || undefined,
        ...(line.bold ? { bold: true } : {}),
        ...(line.italic ? { italic: true } : {}),
        alignment: alignmentFor(line.bbox, pageWidth),
        direction: line.direction,
      },
    }));
  }

  // Headers/footers are top-level reading-order blocks; table rows/cells and
  // list items remain children of their containers.
  const pageBlockIds = blocks
    .filter((block) => !block.parentId)
    .sort((a, b) => a.order - b.order)
    .map((block) => block.blockId);
  const page = structurePage({
    pageNumber,
    pageKind: 'physical',
    pageType,
    extractionMethod: 'pdf_native',
    blockIds: pageBlockIds,
    ...(pageWidth > 0 && pageHeight > 0 ? {
      pageBounds: {
        width: Math.round(pageWidth * 100) / 100,
        height: Math.round(pageHeight * 100) / 100,
        coordinateSpace: 'pdf_page_points' as const,
      },
    } : {}),
    ...(warnings.length ? { warnings: sanitizeWarnings(warnings) } : {}),
  });
  return { page, blocks, warnings };
}

/** Builds a compact repeated-margin set from page line summaries. */
export function repeatedMarginTexts(pages: Array<{ pageHeight: number; lines: PdfLayoutLine[] }>): Set<string> {
  const counts = new Map<string, Set<number>>();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]!;
    for (const line of page.lines) {
      if (line.bbox.y1 > page.pageHeight * HEADER_BAND && line.bbox.y0 < page.pageHeight * FOOTER_BAND) continue;
      const text = normalizedMarginText(line.text);
      if (!text) continue;
      const set = counts.get(text) ?? new Set<number>();
      set.add(pageIndex);
      counts.set(text, set);
    }
  }
  return new Set([...counts.entries()].filter(([, pagesSeen]) => pagesSeen.size >= 2).map(([text]) => text));
}
