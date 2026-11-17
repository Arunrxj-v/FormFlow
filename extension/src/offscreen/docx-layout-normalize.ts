import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { ExtractionWarning } from '@shared/types';

const MAX_NORMALIZED_TABLES = 1_000;
const MAX_NORMALIZATION_ENTRIES = 10_000;
const MAX_NORMALIZATION_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const DEFAULT_CONTENT_WIDTH_TWIPS = 9_360;
const DEFAULT_CELL_MARGIN_TWIPS = 216;
const LAYOUT_PART_PATTERN = /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/;

interface TableEdit {
  start: number;
  end: number;
  text: string;
}

interface OpenTable {
  depth: number;
  openTagEnd: number;
  tblPr?: { start: number; startTagEnd: number; end: number };
  tblW?: { start: number; end: number; type: string; width: number };
  tblLayout?: { start: number; end: number; type: string };
  grid?: { start: number; end: number };
  gridWidths: number[];
  inGrid: boolean;
  inTblPr: boolean;
  floating: boolean;
  maxSpanSum: number;
  currentRowSpanSum: number;
  currentCellSpan: number;
  currentCellWidth?: number;
  cells: number[];
  normalized?: boolean;
}

function tagAttributes(token: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([A-Za-z0-9_:.-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(token)) !== null) {
    result[match[1]!] = match[2]!;
  }
  return result;
}

function twips(value: string | undefined): number {
  if (!value) return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.min(1_000_000, Math.floor(numeric)) : 0;
}

function distributeWidth(total: number, count: number): number[] {
  const safeCount = Math.max(1, Math.min(100, count));
  const safeTotal = Math.max(safeCount, Math.floor(total));
  const base = Math.floor(safeTotal / safeCount);
  const remainder = safeTotal - base * safeCount;
  return Array.from({ length: safeCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

function scaleWidths(widths: number[], available: number): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= 0 || available <= 0 || total <= available) return widths;
  let remaining = available;
  return widths.map((width, index) => {
    if (index === widths.length - 1) return Math.max(1, remaining);
    const scaled = Math.max(1, Math.floor((width / total) * available));
    remaining -= scaled;
    return scaled;
  });
}

function gridXml(widths: number[]): string {
  return `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;
}

function normalizePart(
  xml: string,
  contentWidthTwips: number,
  maxTables: number,
): { xml: string; normalized: number; skipped: number } {
  if (xml.indexOf('<w:tbl') < 0) return { xml, normalized: 0, skipped: 0 };
  const tokens = xml.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  const edits: TableEdit[] = [];
  const stack: OpenTable[] = [];
  let offset = 0;
  let normalized = 0;
  let skipped = 0;
  let limitReached = maxTables <= 0;

  const current = () => stack[stack.length - 1];

  const cellWidthFor = (table: OpenTable, span: number, startColumn: number): number => {
    if (table.gridWidths.length > 0) {
      const selected = table.gridWidths.slice(startColumn, startColumn + span);
      const total = selected.reduce((sum, width) => sum + width, 0);
      if (total > 0) return total;
    }
    const columnCount = Math.max(1, Math.min(100, table.maxSpanSum || table.cells.length + 1));
    return Math.floor(contentWidthTwips / columnCount) * Math.max(1, span);
  };

  const finishTable = (table: OpenTable, closeTagStart: number) => {
    const parent = stack[stack.length - 2] as OpenTable | undefined;
    const parentCellWidth = parent?.currentCellWidth;
    const available = parentCellWidth
      ? Math.max(720, parentCellWidth - DEFAULT_CELL_MARGIN_TWIPS)
      : Math.max(720, contentWidthTwips);
    const alreadyFixed = table.tblLayout?.type === 'fixed'
      && table.tblW?.type !== undefined
      && table.tblW.type !== 'auto'
      && table.tblW.type !== 'pct'
      && table.tblW.width > 0;
    if (alreadyFixed || table.floating || table.tblW?.type === 'pct') {
      skipped += 1;
      return;
    }
    if (limitReached) {
      skipped += 1;
      return;
    }
    let widths = table.gridWidths.filter((width) => width > 0);
    if (widths.length === 0) {
      const columnCount = Math.max(1, Math.min(100, table.maxSpanSum || table.cells.length || 1));
      widths = distributeWidth(available, columnCount);
    } else if (parent && widths.reduce((sum, width) => sum + width, 0) > available) {
      widths = scaleWidths(widths, available);
    }
    if (widths.length === 0) {
      skipped += 1;
      return;
    }
    const tableWidth = widths.reduce((sum, width) => sum + width, 0);
    const widthTag = `<w:tblW w:w="${tableWidth}" w:type="dxa"/>`;
    const layoutTag = '<w:tblLayout w:type="fixed"/>';
    if (!table.tblPr) {
      edits.push({
        start: table.openTagEnd,
        end: table.openTagEnd,
        text: `<w:tblPr>${widthTag}${layoutTag}</w:tblPr>${table.grid ? '' : gridXml(widths)}`,
      });
      if (table.grid && (widths.length !== table.gridWidths.length || widths.some((width, index) => width !== table.gridWidths[index]))) {
        edits.push({ start: table.grid.start, end: table.grid.end, text: gridXml(widths) });
      }
    } else {
      const inner = xml.slice(table.tblPr.startTagEnd, table.tblPr.end - '</w:tblPr>'.length)
        .replace(/<w:tblW\b[^>]*\/>/g, '')
        .replace(/<w:tblLayout\b[^>]*\/>/g, '');
      edits.push({
        start: table.tblPr.start,
        end: table.tblPr.end,
        text: `<w:tblPr>${widthTag}${layoutTag}${inner}</w:tblPr>`,
      });
      if (!table.grid) {
        edits.push({
          start: table.tblPr.end,
          end: table.tblPr.end,
          text: gridXml(widths),
        });
      } else if (widths.length !== table.gridWidths.length || widths.some((width, index) => width !== table.gridWidths[index])) {
        edits.push({ start: table.grid.start, end: table.grid.end, text: gridXml(widths) });
      }
    }
    normalized += 1;
    table.normalized = true;
    if (normalized >= maxTables) limitReached = true;
  };

  for (const token of tokens) {
    const tokenStart = offset;
    const tokenEnd = offset + token.length;
    offset = tokenEnd;
    if (!token.startsWith('<') || token.startsWith('<!--')) continue;
    const closing = /^<\s*\//.test(token);
    const selfClosing = /\/\s*>$/.test(token);
    const rawName = /^<\s*\/?\s*([^\s/>]+)/.exec(token)?.[1];
    if (!rawName) continue;
    const name = rawName.split(':').pop();
    const table = current();

    if (name === 'tbl') {
      if (!closing && !selfClosing) {
        if (stack.length > 0) {
          const parent = stack[stack.length - 1]!;
          parent.maxSpanSum = Math.max(parent.maxSpanSum, parent.currentRowSpanSum);
        }
        stack.push({
          depth: stack.length + 1,
          openTagEnd: tokenEnd,
          gridWidths: [],
          inGrid: false,
          inTblPr: false,
          floating: false,
          maxSpanSum: 0,
          currentRowSpanSum: 0,
          currentCellSpan: 1,
          cells: [],
        });
      } else if (closing && table) {
        finishTable(table, tokenStart);
        stack.pop();
      }
      continue;
    }
    if (!table) continue;

    if (name === 'tblPr' && !closing) {
      table.tblPr = { start: tokenStart, startTagEnd: tokenEnd, end: tokenEnd };
      table.inTblPr = true;
      continue;
    }
    if (name === 'tblPr' && closing) {
      if (table.tblPr) table.tblPr.end = tokenEnd;
      table.inTblPr = false;
      continue;
    }
    if (table.inTblPr && name === 'tblW' && !closing) {
      const attrs = tagAttributes(token);
      table.tblW = {
        start: tokenStart,
        end: tokenEnd,
        type: attrs['w:type'] ?? attrs['type'] ?? 'auto',
        width: twips(attrs['w:w'] ?? attrs['w']),
      };
      continue;
    }
    if (table.inTblPr && name === 'tblLayout' && !closing) {
      const attrs = tagAttributes(token);
      table.tblLayout = {
        start: tokenStart,
        end: tokenEnd,
        type: (attrs['w:type'] ?? attrs['type'] ?? '').toLowerCase(),
      };
      continue;
    }
    if (table.inTblPr && name === 'tblpPr' && !closing) {
      table.floating = true;
      continue;
    }
    if (name === 'tblGrid' && !closing) {
      table.grid = { start: tokenStart, end: tokenEnd };
      table.inGrid = true;
      continue;
    }
    if (name === 'tblGrid' && closing) {
      if (table.grid) table.grid.end = tokenEnd;
      table.inGrid = false;
      continue;
    }
    if (table.inGrid && name === 'gridCol' && !closing) {
      const attrs = tagAttributes(token);
      table.gridWidths.push(twips(attrs['w:w'] ?? attrs['w']));
      continue;
    }
    if (name === 'tr' && !closing) {
      table.currentRowSpanSum = 0;
      continue;
    }
    if (name === 'tr' && closing) {
      table.maxSpanSum = Math.max(table.maxSpanSum, table.currentRowSpanSum);
      continue;
    }
    if (name === 'tc' && !closing) {
      table.currentCellSpan = 1;
      table.currentCellWidth = cellWidthFor(table, 1, table.currentRowSpanSum);
      continue;
    }
    if (name === 'tc' && closing) {
      const width = table.currentCellWidth ?? cellWidthFor(table, table.currentCellSpan, table.currentRowSpanSum);
      table.cells.push(width);
      table.currentRowSpanSum += table.currentCellSpan;
      table.currentCellWidth = undefined;
      continue;
    }
    if (name === 'gridSpan' && !closing) {
      const attrs = tagAttributes(token);
      const value = Number(attrs['w:val'] ?? attrs['val']);
      if (Number.isFinite(value)) {
        table.currentCellSpan = Math.max(1, Math.min(100, Math.trunc(value)));
        table.currentCellWidth = cellWidthFor(table, table.currentCellSpan, table.currentRowSpanSum);
      }
      continue;
    }
  }

  if (edits.length === 0) return { xml, normalized: 0, skipped };
  const sorted = edits.sort((left, right) => right.start - left.start || right.end - left.end);
  let output = xml;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > lastStart) continue;
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    lastStart = edit.start;
  }
  return { xml: output, normalized, skipped };
}

export function normalizeDocxTablesForLayout(
  bytes: Uint8Array,
  options: { contentWidthTwips?: number; maxTables?: number; signal?: AbortSignal } = {},
): { bytes: Uint8Array; normalizedTables: number; warnings: ExtractionWarning[] } {
  const maxTables = Math.max(0, Math.min(MAX_NORMALIZED_TABLES, options.maxTables ?? MAX_NORMALIZED_TABLES));
  const contentWidthTwips = options.contentWidthTwips && options.contentWidthTwips > 0
    ? Math.min(100_000, Math.floor(options.contentWidthTwips))
    : DEFAULT_CONTENT_WIDTH_TWIPS;
  if (options.signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  let archive: Record<string, Uint8Array>;
  try {
    let entryCount = 0;
    let totalBytes = 0;
    archive = unzipSync(new Uint8Array(bytes), {
      filter: (file) => {
        entryCount += 1;
        totalBytes += file.originalSize;
        if (entryCount > MAX_NORMALIZATION_ENTRIES || totalBytes > MAX_NORMALIZATION_UNCOMPRESSED_BYTES) {
          throw new Error('DOCX layout normalization limit reached.');
        }
        return true;
      },
    });
  } catch {
    return { bytes, normalizedTables: 0, warnings: [] };
  }
  let normalizedTables = 0;
  let skippedTables = 0;
  const changed = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(archive)) {
    if (!LAYOUT_PART_PATTERN.test(name) || data.byteLength === 0) continue;
    const result = normalizePart(strFromU8(data), contentWidthTwips, Math.max(0, maxTables - normalizedTables));
    normalizedTables += result.normalized;
    skippedTables += result.skipped;
    if (result.xml !== strFromU8(data)) {
      changed.set(name, strToU8(result.xml));
    }
  }
  const buildWarnings = (): ExtractionWarning[] => {
    const warnings: ExtractionWarning[] = [];
    if (skippedTables > 0) {
      warnings.push({
        code: 'DOCX_TABLE_LAYOUT_SKIPPED',
        message: `${skippedTables} explicit-width, percentage-width, or floating table(s) were left at their authored layout.`,
      });
    }
    if (normalizedTables >= maxTables && maxTables > 0) {
      warnings.push({
        code: 'DOCX_TABLE_NORMALIZATION_LIMIT',
        message: `Table layout normalization was bounded to ${maxTables} table(s); remaining tables were left at their authored layout.`,
      });
    }
    return warnings;
  };
  if (changed.size === 0) {
    return { bytes, normalizedTables: 0, warnings: buildWarnings() };
  }
  const output: Record<string, [Uint8Array, { level: 0 | 1 | 6 }]> = {};
  for (const [name, data] of Object.entries(archive)) {
    const replacement = changed.get(name);
    if (replacement) {
      output[name] = [replacement, { level: 6 }];
    } else if (/\.(?:xml|rels)$/i.test(name)) {
      output[name] = [data, { level: 1 }];
    } else {
      output[name] = [data, { level: 0 }];
    }
  }
  return {
    bytes: zipSync(output),
    normalizedTables,
    warnings: buildWarnings(),
  };
}
