import { EXTRACTION_VERSION, MAX_DOCX_UNCOMPRESSED_BYTES, MAX_DOCX_XML_BYTES } from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type { DocumentExtractionMetadata, DocumentStructureBlock, ExtractionWarning } from '@shared/types';
import { strFromU8, unzipSync } from 'fflate';
import { finalizeStructure, structureBlock, structureBlockId, structurePage } from '../structure';
import {
  normalizeExtractedText,
  sanitizeMetadata,
  sanitizeMetadataValue,
  stripControlCharacters,
} from '../text-utils';
import {
  throwIfAborted,
  warning,
  type DocumentParseInput,
  type DocumentParseResult,
} from './types';

interface DocxStyles {
  names: Map<string, string>;
}

interface DocxNumberingLevel {
  format: string;
  levelText?: string;
}

interface DocxNumbering {
  levels: Map<string, Map<number, DocxNumberingLevel>>;
}

interface ParagraphState {
  styleId?: string;
  outlineLevel?: number;
  alignment?: 'left' | 'center' | 'right' | 'justified' | 'unknown';
  list?: { numId: string; level: number };
  hyperlink?: boolean;
  text: string;
}

interface DocxTableCell {
  text: string;
  colSpan: number;
  rowSpan: number;
  columnIndex: number;
  vMerge?: 'restart' | 'continue';
}

interface DocxTableRow {
  cells: DocxTableCell[];
}

type DocxBlock =
  | {
    type: 'paragraph';
    text: string;
    headingLevel?: number;
    styleId?: string;
    styleName?: string;
    alignment?: 'left' | 'center' | 'right' | 'justified' | 'unknown';
    list?: { numId: string; level: number; marker: string };
    hyperlink?: boolean;
  }
  | { type: 'table'; rows: DocxTableRow[]; columnCount: number; mergedCells: number };

interface StructureResult {
  text: string;
  headings: Array<{ level: number; text: string }>;
  tableCount: number;
  rowCount: number;
  nestedTables: number;
  unresolvedHeadingStyles: boolean;
  blocks: DocxBlock[];
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => {
      const code = Number.parseInt(decimal, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([A-Za-z0-9_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag)) !== null) {
    result[match[1]!] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }
  return result;
}

function localName(tagName: string): string {
  const separator = tagName.indexOf(':');
  return separator >= 0 ? tagName.slice(separator + 1) : tagName;
}

function headingLevel(styleId: string | undefined, outlineLevel: number | undefined, styles: DocxStyles): number | undefined {
  if (typeof outlineLevel === 'number' && outlineLevel >= 0 && outlineLevel <= 8) {
    return outlineLevel + 1;
  }
  if (!styleId) return undefined;
  const name = styles.names.get(styleId);
  const candidates = [styleId, name].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (/^title$/i.test(candidate.trim())) return 1;
    const match = /(?:^heading|^heading\s*|^heading\s+|^h)([1-9])$/i.exec(candidate.trim())
      ?? /^heading\s*([1-9])$/i.exec(candidate.trim());
    if (match) return Number(match[1]);
  }
  return undefined;
}

function parseStyles(xml: string | undefined): DocxStyles {
  const styles: DocxStyles = { names: new Map() };
  if (!xml) return styles;
  const stylePattern = /<w:style\b[^>]*>[\s\S]*?<\/w:style>/g;
  let match: RegExpExecArray | null;
  while ((match = stylePattern.exec(xml)) !== null) {
    const block = match[0];
    const opening = /^<w:style\b[^>]*>/.exec(block)?.[0] ?? '';
    const styleId = attributes(opening)['w:styleId'];
    if (!styleId) continue;
    const nameMatch = /<w:name\b[^>]*\/?>/.exec(block);
    const name = nameMatch ? attributes(nameMatch[0])['w:val'] : undefined;
    if (name) styles.names.set(styleId, name);
  }
  return styles;
}

function parseNumbering(xml: string | undefined): DocxNumbering {
  const numbering: DocxNumbering = { levels: new Map() };
  if (!xml) return numbering;
  const abstractLevels = new Map<string, Map<number, DocxNumberingLevel>>();
  const abstractPattern = /<w:abstractNum\b[^>]*>[\s\S]*?<\/w:abstractNum>/g;
  let abstractMatch: RegExpExecArray | null;
  while ((abstractMatch = abstractPattern.exec(xml)) !== null) {
    const block = abstractMatch[0];
    const opening = /^<w:abstractNum\b[^>]*>/.exec(block)?.[0] ?? '';
    const abstractId = attributes(opening)['w:abstractNumId'];
    if (!abstractId) continue;
    const levels = new Map<number, DocxNumberingLevel>();
    const levelPattern = /<w:lvl\b[^>]*>[\s\S]*?<\/w:lvl>/g;
    let levelMatch: RegExpExecArray | null;
    while ((levelMatch = levelPattern.exec(block)) !== null) {
      const levelBlock = levelMatch[0];
      const levelOpening = /^<w:lvl\b[^>]*>/.exec(levelBlock)?.[0] ?? '';
      const level = Number(attributes(levelOpening)['w:ilvl']);
      if (!Number.isFinite(level) || level < 0 || level > 8) continue;
      const formatTag = /<w:numFmt\b[^>]*\/?>/.exec(levelBlock);
      const textTag = /<w:lvlText\b[^>]*\/?>/.exec(levelBlock);
      levels.set(level, {
        format: formatTag ? attributes(formatTag[0])['w:val'] ?? 'decimal' : 'decimal',
        ...(textTag ? { levelText: attributes(textTag[0])['w:val'] } : {}),
      });
    }
    abstractLevels.set(abstractId, levels);
  }
  const numPattern = /<w:num\b[^>]*>[\s\S]*?<\/w:num>/g;
  let numMatch: RegExpExecArray | null;
  while ((numMatch = numPattern.exec(xml)) !== null) {
    const block = numMatch[0];
    const opening = /^<w:num\b[^>]*>/.exec(block)?.[0] ?? '';
    const numId = attributes(opening)['w:numId'];
    const abstractTag = /<w:abstractNumId\b[^>]*\/?>/.exec(block);
    const abstractId = abstractTag ? attributes(abstractTag[0])['w:val'] : undefined;
    if (!numId || !abstractId) continue;
    const levels = abstractLevels.get(abstractId);
    if (levels) numbering.levels.set(numId, levels);
  }
  return numbering;
}

function listMarker(numbering: DocxNumbering, numId: string, level: number, index: number): string {
  const info = numbering.levels.get(numId)?.get(level);
  const format = info?.format ?? (info ? 'bullet' : 'decimal');
  if (format === 'bullet' || format === 'none') return '•';
  if (format === 'lowerLetter') return `${String.fromCharCode(97 + (index % 26))}.`;
  if (format === 'upperLetter') return `${String.fromCharCode(65 + (index % 26))}.`;
  if (format === 'lowerRoman') return `${index + 1}.`;
  if (format === 'upperRoman') return `${index + 1}.`;
  return `${index + 1}.`;
}

function finalizeTableRows(rows: DocxTableRow[], gridColumns: number): { rows: DocxTableRow[]; columnCount: number; mergedCells: number } {
  const output: DocxTableRow[] = [];
  let mergedCells = 0;
  for (const row of rows) {
    const outputRow: DocxTableRow = { cells: [] };
    let column = 0;
    for (const cell of row.cells) {
      const colSpan = Math.max(1, Math.min(cell.colSpan, 100));
      if (cell.vMerge === 'continue') {
        // A vertical-merge continuation is represented by the restart cell's
        // rowSpan; do not emit a duplicate cell.
        mergedCells += 1;
        const existing = output
          .slice()
          .reverse()
          .flatMap((previous) => previous.cells)
          .find((previous) => previous.columnIndex <= column && previous.columnIndex + previous.colSpan > column);
        if (existing) existing.rowSpan += 1;
        column += colSpan;
        continue;
      }
      outputRow.cells.push({
        text: cell.text,
        colSpan,
        rowSpan: Math.max(1, cell.rowSpan),
        columnIndex: column,
        ...(cell.vMerge ? { vMerge: cell.vMerge } : {}),
      });
      column += colSpan;
    }
    if (outputRow.cells.length) output.push(outputRow);
  }
  const computed = Math.max(
    gridColumns,
    ...output.flatMap((row) => row.cells.map((cell) => cell.columnIndex + cell.colSpan)),
    0,
  );
  return { rows: output, columnCount: computed, mergedCells };
}

function cleanParagraphText(value: string): string {
  return stripControlCharacters(value)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function serializeBlocks(blocks: DocxBlock[]): StructureResult {
  const headings: Array<{ level: number; text: string }> = [];
  let tableCount = 0;
  let rowCount = 0;
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      parts.push(block.text);
      if (block.headingLevel) headings.push({ level: block.headingLevel, text: block.text });
    } else {
      tableCount += 1;
      rowCount += block.rows.length;
      const rows = block.rows
        .map((row) => row.cells.map((cell) => cell.text.replace(/\n+/g, ' ').replace(/\t+/g, ' ').trim()).join('\t'))
        .filter((row) => row.trim().length > 0);
      if (rows.length) parts.push(rows.join('\n'));
    }
  }
  return {
    text: normalizeExtractedText(parts.join('\n\n')),
    headings,
    tableCount,
    rowCount,
    nestedTables: 0,
    unresolvedHeadingStyles: false,
    blocks,
  };
}

function parseDocumentXml(xml: string, styles: DocxStyles, numbering: DocxNumbering): StructureResult {
  const blocks: DocxBlock[] = [];
  const tokens = xml.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  let paragraph: ParagraphState | null = null;
  let inText = false;
  let tableDepth = 0;
  let currentTable: { rows: DocxTableRow[]; gridColumns: number } | null = null;
  let currentRow: DocxTableRow | null = null;
  let currentCell: { text: string; colSpan: number; vMerge?: 'restart' | 'continue' } | null = null;
  let nestedTables = 0;
  let unresolvedHeadingStyles = false;
  let sawHeadingStyle = false;
  let sawResolvedHeading = false;
  const listCounters = new Map<string, number>();

  const finalizeParagraph = () => {
    if (!paragraph) return;
    const text = cleanParagraphText(paragraph.text);
    if (text) {
      if (tableDepth > 0 && currentCell) {
        currentCell.text = currentCell.text ? `${currentCell.text}\n${text}` : text;
      } else if (tableDepth === 0) {
        const level = headingLevel(paragraph.styleId, paragraph.outlineLevel, styles);
        let list: { numId: string; level: number; marker: string } | undefined;
        if (paragraph.list) {
          const key = `${paragraph.list.numId}:${paragraph.list.level}`;
          const index = listCounters.get(key) ?? 0;
          listCounters.set(key, index + 1);
          list = {
            numId: paragraph.list.numId,
            level: paragraph.list.level,
            marker: listMarker(numbering, paragraph.list.numId, paragraph.list.level, index),
          };
        }
        blocks.push({
          type: 'paragraph',
          text,
          ...(level ? { headingLevel: level } : {}),
          ...(paragraph.styleId ? { styleId: paragraph.styleId } : {}),
          ...(paragraph.styleId && styles.names.has(paragraph.styleId)
            ? { styleName: styles.names.get(paragraph.styleId) }
            : {}),
          ...(paragraph.alignment ? { alignment: paragraph.alignment } : {}),
          ...(list ? { list } : {}),
          ...(paragraph.hyperlink ? { hyperlink: true } : {}),
        });
        if (level) {
          sawResolvedHeading = true;
        } else if (paragraph.styleId && /heading/i.test(paragraph.styleId)) {
          sawHeadingStyle = true;
          if (!styles.names.has(paragraph.styleId)) unresolvedHeadingStyles = true;
        }
      }
    }
    paragraph = null;
  };

  for (const token of tokens) {
    if (!token.startsWith('<')) {
      if (inText && paragraph) paragraph.text += decodeXmlEntities(token);
      continue;
    }
    if (token.startsWith('<!--')) continue;
    const closing = /^<\s*\//.test(token);
    const selfClosing = /\/\s*>$/.test(token);
    const nameMatch = /^<\s*\/?\s*([^\s/>]+)/.exec(token);
    if (!nameMatch) continue;
    const name = localName(nameMatch[1]!);
    const attrs = attributes(token);

    if (name === 't') {
      if (closing || selfClosing) inText = false;
      else inText = true;
      continue;
    }
    if (name === 'p') {
      if (closing) {
        finalizeParagraph();
      } else if (!selfClosing) {
        if (paragraph) finalizeParagraph();
        paragraph = { text: '' };
      }
      continue;
    }
    if (name === 'pStyle' && paragraph) {
      paragraph.styleId = attrs['w:val'] ?? attrs['val'];
      continue;
    }
    if (name === 'outlineLvl' && paragraph) {
      const value = Number(attrs['w:val'] ?? attrs['val']);
      if (Number.isFinite(value)) paragraph.outlineLevel = value;
      continue;
    }
    if (name === 'numId' && paragraph) {
      const numId = attrs['w:val'] ?? attrs['val'];
      if (numId !== undefined) {
        paragraph.list = { numId, level: paragraph.list?.level ?? 0 };
      }
      continue;
    }
    if (name === 'ilvl' && paragraph) {
      const value = Number(attrs['w:val'] ?? attrs['val']);
      if (Number.isFinite(value)) {
        paragraph.list = {
          numId: paragraph.list?.numId ?? '',
          level: Math.max(0, Math.min(8, Math.trunc(value))),
        };
      }
      continue;
    }
    if (name === 'jc' && paragraph) {
      const value = String(attrs['w:val'] ?? attrs['val'] ?? '').toLowerCase();
      if (value === 'left' || value === 'center' || value === 'right' || value === 'both' || value === 'justify') {
        paragraph.alignment = value === 'both' || value === 'justify' ? 'justified' : value;
      }
      continue;
    }
    if (name === 'hyperlink' && paragraph) {
      if (!closing) paragraph.hyperlink = true;
      continue;
    }
    if (name === 'tab' && paragraph) {
      paragraph.text += '\t';
      continue;
    }
    if ((name === 'br' || name === 'cr') && paragraph) {
      paragraph.text += '\n';
      continue;
    }
    if (name === 'noBreakHyphen' && paragraph) {
      paragraph.text += '-';
      continue;
    }
    if (name === 'tbl') {
      if (!closing) {
        if (tableDepth === 0) currentTable = { rows: [], gridColumns: 0 };
        else nestedTables += 1;
        tableDepth += 1;
      } else if (tableDepth > 0) {
        tableDepth -= 1;
        if (tableDepth === 0 && currentTable) {
          const finalized = finalizeTableRows(currentTable.rows, currentTable.gridColumns);
          blocks.push({
            type: 'table',
            rows: finalized.rows,
            columnCount: finalized.columnCount,
            mergedCells: finalized.mergedCells,
          });
          currentTable = null;
        }
      }
      continue;
    }
    if (name === 'gridCol' && tableDepth === 1 && currentTable) {
      if (!closing) currentTable.gridColumns += 1;
      continue;
    }
    if (name === 'tr' && tableDepth === 1) {
      if (closing) {
        if (currentRow && currentTable && currentRow.cells.length) currentTable.rows.push(currentRow);
        currentRow = null;
      } else currentRow = { cells: [] };
      continue;
    }
    if (name === 'tc' && tableDepth === 1) {
      if (closing) {
        if (currentCell && currentRow) {
          currentRow.cells.push({
            text: currentCell.text,
            colSpan: currentCell.colSpan,
            rowSpan: 1,
            columnIndex: 0,
            ...(currentCell.vMerge ? { vMerge: currentCell.vMerge } : {}),
          });
        }
        currentCell = null;
      } else currentCell = { text: '', colSpan: 1 };
      continue;
    }
    if ((name === 'gridSpan' || name === 'vMerge') && currentCell) {
      if (name === 'gridSpan') {
        const value = Number(attrs['w:val'] ?? attrs['val']);
        if (Number.isFinite(value)) currentCell.colSpan = Math.max(1, Math.min(100, Math.trunc(value)));
      } else {
        const value = String(attrs['w:val'] ?? attrs['val'] ?? '').toLowerCase();
        currentCell.vMerge = value === 'restart' ? 'restart' : 'continue';
      }
      continue;
    }
  }
  finalizeParagraph();
  const serialized = serializeBlocks(blocks);
  return {
    ...serialized,
    nestedTables,
    unresolvedHeadingStyles: unresolvedHeadingStyles && sawHeadingStyle && !sawResolvedHeading,
  };
}

function parseCoreProperties(xml: string | undefined): DocumentExtractionMetadata {
  if (!xml) return {};
  const read = (tag: string): string | undefined => {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
    return match ? sanitizeMetadataValue(decodeXmlEntities(match[1]!), 1000) : undefined;
  };
  return sanitizeMetadata({
    title: read('dc:title'),
    author: read('dc:creator'),
    subject: read('dc:subject'),
    keywords: read('cp:keywords'),
    creator: read('cp:lastModifiedBy'),
    creationDate: read('dcterms:created'),
    modDate: read('dcterms:modified'),
  });
}

function fallbackParagraphs(text: string): DocxBlock[] {
  return text.split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({ type: 'paragraph', text: paragraph }));
}

function buildDocxDocumentStructure(
  bodyBlocks: DocxBlock[],
  headerBlocks: DocxBlock[],
  footerBlocks: DocxBlock[],
  warnings: ExtractionWarning[],
): ReturnType<typeof finalizeStructure> {
  const blocks: DocumentStructureBlock[] = [];
  const pageBlockIds: string[] = [];
  let order = 0;
  let counter = 0;
  let listCounter = 0;
  let tableCounter = 0;
  let mergedCells = 0;
  const add = (block: DocumentStructureBlock) => {
    blocks.push(block);
    return block;
  };
  const addTextGroup = (source: DocxBlock[], type: 'header' | 'footer') => {
    for (const block of source) {
      const text = block.type === 'paragraph'
        ? block.text
        : block.rows.map((row) => row.cells.map((cell) => cell.text).join('\t')).join('\n');
      if (!text.trim()) continue;
      counter += 1;
      const id = structureBlockId(1, counter);
      pageBlockIds.push(id);
      add(structureBlock({
        blockId: id,
        type,
        text,
        pageNumber: 1,
        order: order++,
        provenance: 'docx_xml',
        sourceRef: `docx:${type}`,
        ...(block.type === 'paragraph' && block.alignment ? { style: { alignment: block.alignment } } : {}),
      }));
    }
  };
  addTextGroup(headerBlocks, 'header');
  for (let index = 0; index < bodyBlocks.length; index += 1) {
    const block = bodyBlocks[index]!;
    if (block.type === 'table') {
      tableCounter += 1;
      mergedCells += block.mergedCells;
      counter += 1;
      const tableBlockId = structureBlockId(1, counter);
      const tableId = `p1_t${tableCounter}`;
      const rowIds: string[] = [];
      for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
        const row = block.rows[rowIndex]!;
        counter += 1;
        const rowId = structureBlockId(1, counter);
        const cellIds: string[] = [];
        for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
          const cell = row.cells[cellIndex]!;
          counter += 1;
          const cellId = structureBlockId(1, counter);
          cellIds.push(cellId);
          add(structureBlock({
            blockId: cellId,
            type: 'table_cell',
            text: cell.text,
            pageNumber: 1,
            order: order++,
            parentId: rowId,
            tableId,
            rowIndex,
            columnIndex: cell.columnIndex,
            ...(cell.rowSpan > 1 ? { rowSpan: cell.rowSpan } : {}),
            ...(cell.colSpan > 1 ? { columnSpan: cell.colSpan } : {}),
            provenance: 'docx_xml',
            sourceRef: `docx:table${tableCounter}:row${rowIndex + 1}:cell${cellIndex + 1}`,
          }));
        }
        rowIds.push(rowId);
        add(structureBlock({
          blockId: rowId,
          type: 'table_row',
          text: row.cells.map((cell) => cell.text.replace(/\s+/g, ' ').trim()).join('\t'),
          pageNumber: 1,
          order: order++,
          parentId: tableBlockId,
          children: cellIds,
          tableId,
          rowIndex,
          provenance: 'docx_xml',
          sourceRef: `docx:table${tableCounter}:row${rowIndex + 1}`,
        }));
      }
      pageBlockIds.push(tableBlockId);
      add(structureBlock({
        blockId: tableBlockId,
        type: 'table',
        text: block.rows.map((row) => row.cells.map((cell) => cell.text.replace(/\s+/g, ' ').trim()).join('\t')).join('\n'),
        pageNumber: 1,
        order: order++,
        children: rowIds,
        provenance: 'docx_xml',
        tableId,
        sourceRef: `docx:table${tableCounter}`,
      }));
      continue;
    }
    if (block.list) {
      const items: DocxBlock[] = [];
      let cursor = index;
      while (cursor < bodyBlocks.length) {
        const candidate = bodyBlocks[cursor]!;
        if (candidate.type !== 'paragraph' || !candidate.list) break;
        items.push(candidate);
        cursor += 1;
      }
      listCounter += 1;
      counter += 1;
      const listBlockId = structureBlockId(1, counter);
      const itemIds: string[] = [];
      const itemBlocks: DocumentStructureBlock[] = [];
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex] as Extract<DocxBlock, { type: 'paragraph' }>;
        counter += 1;
        const itemId = structureBlockId(1, counter);
        itemIds.push(itemId);
        itemBlocks.push(structureBlock({
          blockId: itemId,
          type: 'list_item',
          text: item.text,
          pageNumber: 1,
          order: order++,
          parentId: listBlockId,
          level: (item.list?.level ?? 0) + 1,
          listMarker: item.list?.marker ?? '•',
          provenance: 'docx_xml',
          sourceRef: `docx:list${listCounter}:item${itemIndex + 1}`,
          ...(item.alignment ? { style: { alignment: item.alignment } } : {}),
        }));
      }
      pageBlockIds.push(listBlockId);
      blocks.push(structureBlock({
        blockId: listBlockId,
        type: 'list',
        text: items.map((item) => (item as Extract<DocxBlock, { type: 'paragraph' }>).text).join('\n'),
        pageNumber: 1,
        order: order++,
        children: itemIds,
        provenance: 'docx_xml',
        sourceRef: `docx:list${listCounter}`,
      }));
      blocks.push(...itemBlocks);
      index = cursor - 1;
      continue;
    }
    counter += 1;
    const blockId = structureBlockId(1, counter);
    pageBlockIds.push(blockId);
    add(structureBlock({
      blockId,
      type: block.headingLevel ? 'heading' : 'paragraph',
      text: block.text,
      pageNumber: 1,
      order: order++,
      ...(block.headingLevel ? { level: block.headingLevel } : {}),
      provenance: 'docx_xml',
      sourceRef: block.styleId ? `docx:pStyle:${block.styleId}` : `docx:paragraph${index + 1}`,
      ...(block.alignment || block.hyperlink ? {
        style: {
          ...(block.alignment ? { alignment: block.alignment } : {}),
          ...(block.hyperlink ? { hyperlink: true } : {}),
          ...(block.styleId ? { styleId: block.styleId } : {}),
          ...(block.styleName ? { styleName: block.styleName } : {}),
        },
      } : block.styleId || block.styleName ? {
        style: {
          ...(block.styleId ? { styleId: block.styleId } : {}),
          ...(block.styleName ? { styleName: block.styleName } : {}),
        },
      } : {}),
    }));
  }
  addTextGroup(footerBlocks, 'footer');
  if (mergedCells > 0) {
    warnings.push(warning(
      'DOCX_MERGED_CELLS_RECONSTRUCTED',
      'Merged table cells were reconstructed from WordprocessingML span and vertical-merge properties.',
    ));
  }
  if (headerBlocks.length || footerBlocks.length) {
    warnings.push(warning(
      'DOCX_HEADERS_FOOTERS_APPROXIMATE',
      'DOCX headers and footers were preserved as logical-page blocks; section-specific placement is approximate.',
    ));
  }
  return finalizeStructure({
    extractionVersion: EXTRACTION_VERSION,
    documentFormat: 'docx',
    pageSemantics: 'logical',
    pages: [structurePage({
      pageNumber: 1,
      pageKind: 'logical',
      pageType: 'text',
      extractionMethod: 'docx_xml',
      blockIds: pageBlockIds,
    })],
    blocks,
    warnings,
  });
}

function docxError(error: unknown): FormFlowError {
  if (error instanceof FormFlowError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new FormFlowError('CORRUPTED_DOCUMENT', `This DOCX could not be read: ${message.slice(0, 200)}`, {
    cause: error,
  });
}

export async function parseDocx(input: DocumentParseInput): Promise<DocumentParseResult> {
  throwIfAborted(input.signal);
  const warnings: ExtractionWarning[] = [];
  let archive: Record<string, Uint8Array>;
  let totalUncompressed = 0;
  let documentSkippedForSize = false;
  try {
    archive = unzipSync(new Uint8Array(input.bytes), {
      filter: (file) => {
        totalUncompressed += file.originalSize;
        if (totalUncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) {
          throw new FormFlowError(
            'EXTRACTION_TOO_LARGE',
            'This DOCX expands beyond the local processing limit.',
          );
        }
        if (!['word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'docProps/core.xml'].includes(file.name)
          && !/^word\/(?:header|footer)\d+\.xml$/.test(file.name)) return false;
        if (file.originalSize > MAX_DOCX_XML_BYTES) {
          if (file.name === 'word/document.xml') documentSkippedForSize = true;
          return false;
        }
        return true;
      },
    });
  } catch (error) {
    throw docxError(error);
  }
  if (documentSkippedForSize || !archive['word/document.xml']) {
    throw new FormFlowError('CORRUPTED_DOCUMENT', 'This DOCX does not contain a readable word/document.xml.');
  }

  const documentXml = strFromU8(archive['word/document.xml']);
  const stylesXml = archive['word/styles.xml'] ? strFromU8(archive['word/styles.xml']) : undefined;
  const numberingXml = archive['word/numbering.xml'] ? strFromU8(archive['word/numbering.xml']) : undefined;
  const coreXml = archive['docProps/core.xml'] ? strFromU8(archive['docProps/core.xml']) : undefined;
  const styles = parseStyles(stylesXml);
  const numbering = parseNumbering(numberingXml);
  const headerEntries = Object.entries(archive)
    .filter(([name]) => /^word\/header\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  const footerEntries = Object.entries(archive)
    .filter(([name]) => /^word\/footer\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  throwIfAborted(input.signal);

  let mammothText = '';
  let mammothMessages = 0;
  try {
    const mammothModule = await import('mammoth/mammoth.browser.js');
    const mammoth = (mammothModule.default ?? mammothModule) as {
      extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{
        value: string;
        messages?: Array<{ type?: string; message?: string }>;
      }>;
    };
    const result = await mammoth.extractRawText({ arrayBuffer: input.bytes });
    mammothText = normalizeExtractedText(result.value);
    mammothMessages = result.messages?.length ?? 0;
  } catch (error) {
    throw new FormFlowError('CORRUPTED_DOCUMENT', 'Mammoth could not read this DOCX container.', { cause: error });
  }
  throwIfAborted(input.signal);

  let structure: StructureResult;
  try {
    structure = parseDocumentXml(documentXml, styles, numbering);
  } catch {
    structure = {
      text: '',
      headings: [],
      tableCount: 0,
      rowCount: 0,
      nestedTables: 0,
      unresolvedHeadingStyles: false,
      blocks: [],
    };
    warnings.push(warning(
      'DOCX_STRUCTURE_FALLBACK',
      'FormFlow could not preserve the DOCX structure; Mammoth raw text was used instead.',
    ));
  }

  let text = structure.text;
  if (!text && mammothText) {
    text = mammothText;
    warnings.push(warning(
      'DOCX_STRUCTURE_FALLBACK',
      'The structured DOCX body was empty; Mammoth raw text was used instead.',
    ));
  } else if (mammothText && text.length < mammothText.length * 0.8) {
    text = mammothText;
    warnings.push(warning(
      'DOCX_STRUCTURE_FALLBACK',
      'Some DOCX body content could not be preserved by the structural extractor; Mammoth raw text was used.',
    ));
  }
  if (!text) {
    throw new FormFlowError('EMPTY_DOCUMENT', 'This DOCX contains no extractable text.');
  }
  if (structure.unresolvedHeadingStyles) {
    warnings.push(warning(
      'DOCX_HEADING_STYLES_UNRESOLVED',
      'Heading styles could not be resolved; heading text was preserved as paragraphs.',
    ));
  }
  if (structure.nestedTables > 0) {
    warnings.push(warning(
      'DOCX_NESTED_TABLES',
      'Nested tables were flattened into their parent cell while preserving the text.',
    ));
  }
  if (mammothMessages > 0) {
    warnings.push(warning(
      'DOCX_CONVERSION_WARNINGS',
      `The DOCX converter reported ${mammothMessages} warning(s); extracted text may be incomplete.`,
    ));
  }
  warnings.push(warning(
    'DOCX_PAGE_COUNT_UNAVAILABLE',
    'DOCX files do not expose reliable page boundaries; the document is stored as one logical page.',
  ));

  const parseAuxiliary = (entries: Array<[string, Uint8Array]>, label: 'header' | 'footer'): DocxBlock[] => {
    const result: DocxBlock[] = [];
    for (const [name, bytes] of entries) {
      try {
        result.push(...parseDocumentXml(strFromU8(bytes), styles, numbering).blocks);
      } catch {
        warnings.push(warning(
          'DOCX_HEADER_FOOTER_UNREADABLE',
          `A DOCX ${label} part could not be read; its text was omitted.`,
        ));
      }
    }
    return result;
  };
  const headerBlocks = parseAuxiliary(headerEntries, 'header');
  const footerBlocks = parseAuxiliary(footerEntries, 'footer');
  const bodyBlocks = text === structure.text && structure.blocks.length
    ? structure.blocks
    : fallbackParagraphs(text);
  const documentStructure = buildDocxDocumentStructure(bodyBlocks, headerBlocks, footerBlocks, warnings);

  const metadata = parseCoreProperties(coreXml);
  metadata.headings = structure.headings;
  metadata.tableCount = structure.tableCount;
  metadata.rowCount = structure.rowCount;

  return {
    text,
    pageTexts: [text],
    pageCount: 1,
    method: 'docx',
    version: EXTRACTION_VERSION,
    ocrRequired: false,
    pagesNeedingOcr: [],
    warnings: documentStructure.warnings,
    metadata: sanitizeMetadata(metadata),
    structure: documentStructure,
  };
}
