import { EXTRACTION_VERSION, MAX_DOCX_UNCOMPRESSED_BYTES, MAX_DOCX_XML_BYTES } from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type { DocumentExtractionMetadata, ExtractionWarning } from '@shared/types';
import { strFromU8, unzipSync } from 'fflate';
import {
  normalizeExtractedText,
  sanitizeMetadata,
  sanitizeMetadataValue,
  sanitizeWarnings,
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

interface ParagraphState {
  styleId?: string;
  outlineLevel?: number;
  text: string;
}

type DocxBlock =
  | { type: 'paragraph'; text: string; headingLevel?: number }
  | { type: 'table'; rows: string[][] };

interface StructureResult {
  text: string;
  headings: Array<{ level: number; text: string }>;
  tableCount: number;
  rowCount: number;
  nestedTables: number;
  unresolvedHeadingStyles: boolean;
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
        .map((row) => row.map((cell) => cell.replace(/\n+/g, ' ').replace(/\t+/g, ' ').trim()).join('\t'))
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
  };
}

function parseDocumentXml(xml: string, styles: DocxStyles): StructureResult {
  const blocks: DocxBlock[] = [];
  const tokens = xml.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  let paragraph: ParagraphState | null = null;
  let inText = false;
  let tableDepth = 0;
  let currentTable: string[][] | null = null;
  let currentRow: string[] | null = null;
  let currentCell: string[] | null = null;
  let nestedTables = 0;
  let unresolvedHeadingStyles = false;
  let sawHeadingStyle = false;
  let sawResolvedHeading = false;

  const finalizeParagraph = () => {
    if (!paragraph) return;
    const text = cleanParagraphText(paragraph.text);
    if (text) {
      if (tableDepth > 0 && currentCell) {
        currentCell.push(text);
      } else if (tableDepth > 0 && currentRow) {
        currentRow.push(text);
      } else if (tableDepth === 0) {
        const level = headingLevel(paragraph.styleId, paragraph.outlineLevel, styles);
        if (level) {
          sawResolvedHeading = true;
          blocks.push({ type: 'paragraph', text, headingLevel: level });
        } else {
          blocks.push({ type: 'paragraph', text });
        }
        if (paragraph.styleId && /heading/i.test(paragraph.styleId)) {
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
        if (tableDepth === 0) currentTable = [];
        else nestedTables += 1;
        tableDepth += 1;
      } else if (tableDepth > 0) {
        tableDepth -= 1;
        if (tableDepth === 0 && currentTable) {
          blocks.push({ type: 'table', rows: currentTable });
          currentTable = null;
        }
      }
      continue;
    }
    if (name === 'tr' && tableDepth === 1) {
      if (closing) {
        if (currentRow && currentTable) currentTable.push(currentRow);
        currentRow = null;
      } else currentRow = [];
      continue;
    }
    if (name === 'tc' && tableDepth === 1) {
      if (closing) {
        if (currentCell && currentRow) currentRow.push(currentCell.join('\n'));
        currentCell = null;
      } else currentCell = [];
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
        if (!['word/document.xml', 'word/styles.xml', 'docProps/core.xml'].includes(file.name)) return false;
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
  const coreXml = archive['docProps/core.xml'] ? strFromU8(archive['docProps/core.xml']) : undefined;
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
    structure = parseDocumentXml(documentXml, parseStyles(stylesXml));
  } catch {
    structure = {
      text: '',
      headings: [],
      tableCount: 0,
      rowCount: 0,
      nestedTables: 0,
      unresolvedHeadingStyles: false,
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
    warnings: sanitizeWarnings(warnings),
    metadata: sanitizeMetadata(metadata),
  };
}
