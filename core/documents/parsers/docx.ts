import {
  EXTRACTION_VERSION,
  MAX_DOCX_EMBEDDED_FONTS,
  MAX_DOCX_IMAGE_BYTES,
  MAX_DOCX_IMAGE_DIMENSION,
  MAX_DOCX_IMAGE_PIXELS,
  MAX_DOCX_IMAGES,
  MAX_DOCX_TOTAL_IMAGE_BYTES,
  MAX_DOCX_UNCOMPRESSED_BYTES,
  MAX_DOCX_XML_BYTES,
  MAX_STRUCTURE_IMAGES,
  MAX_STRUCTURE_SECTIONS,
} from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type {
  DocumentExtractionMetadata,
  DocumentHeaderFooterKind,
  DocumentHeaderFooterVariant,
  DocumentPaginationBreakReason,
  DocumentPaginationInfo,
  DocumentPaginationPage,
  DocumentSectionBreakType,
  DocumentStructureBlock,
  DocumentStructureDocxColumns,
  DocumentStructureDocxLayout,
  DocumentStructureDocxSection,
  DocumentStructureHeaderFooterReference,
  DocumentStructureImage,
  DocumentEmbeddedFont,
  DocumentThemeFonts,
  ExtractionWarning,
} from '@shared/types';
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

interface DocxPageMargins {
  topPt: number;
  rightPt: number;
  bottomPt: number;
  leftPt: number;
  headerPt?: number;
  footerPt?: number;
}

interface DocxPageSetup {
  widthPt: number;
  heightPt: number;
  orientation: 'portrait' | 'landscape';
  margins: DocxPageMargins;
}

interface DocxHeaderFooterReference {
  variant: DocumentHeaderFooterVariant;
  relationshipId?: string;
  partName?: string;
}

interface DocxSectionSnapshot {
  breakType: DocumentSectionBreakType;
  pageSetup: DocxPageSetup;
  titlePage: boolean;
  pageNumberStart?: number;
  pageNumberFormat?: string;
  columnCount?: number;
  columns?: DocumentStructureDocxColumns;
  headers: DocxHeaderFooterReference[];
  footers: DocxHeaderFooterReference[];
}

interface DocxImageSource {
  relationshipId?: string;
  sourcePart: string;
  mediaPart?: string;
  mimeType?: string;
  external: boolean;
  originalWidthPx?: number;
  originalHeightPx?: number;
  displayWidthPt: number;
  displayHeightPt: number;
  positioning: 'inline' | 'anchored';
  wrap: DocumentStructureImage['wrap'];
  alternativeText?: string;
  title?: string;
  warnings: ExtractionWarning[];
}

interface DocxMediaPart {
  partName: string;
  bytes: Uint8Array;
}

interface DocxImageInspection {
  mimeType?: string;
  width?: number;
  height?: number;
  warning?: ExtractionWarning;
}

interface DocxAuxiliaryPart {
  partName: string;
  blocks: DocxBlock[];
}

interface DocxParagraphBreakInfo {
  pageBreakBefore?: boolean;
  explicitPageBreakAfter?: boolean;
  lastRenderedPageBreakAfter?: boolean;
  sectionBreakAfter?: DocxPageSetup;
}

interface ParagraphState extends DocxParagraphBreakInfo {
  styleId?: string;
  outlineLevel?: number;
  alignment?: 'left' | 'center' | 'right' | 'justified' | 'unknown';
  list?: { numId: string; level: number };
  hyperlink?: boolean;
  columnBreakAfter?: boolean;
  images: DocxImageSource[];
  text: string;
}

interface DocxCellImage {
  image: DocxImageSource;
  paragraphIndex: number;
  imageIndex: number;
  nestedTableDepth: number;
  captionText?: string;
}

interface DocxTableCell {
  text: string;
  colSpan: number;
  rowSpan: number;
  columnIndex: number;
  vMerge?: 'restart' | 'continue';
  images: DocxCellImage[];
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
    pageBreakBefore?: boolean;
    explicitPageBreakAfter?: boolean;
    lastRenderedPageBreakAfter?: boolean;
    columnBreakAfter?: boolean;
    sectionBreakAfter?: DocxPageSetup;
    images?: DocxImageSource[];
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
  pageSetup: DocxPageSetup;
}

const DEFAULT_PAGE_SETUP: DocxPageSetup = {
  widthPt: 612,
  heightPt: 792,
  orientation: 'portrait',
  margins: { topPt: 72, rightPt: 72, bottomPt: 72, leftPt: 72, headerPt: 36, footerPt: 36 },
};

function twipsToPt(value: string | undefined, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric / 20 : fallback;
}

function applyPageBounds(setup: DocxPageSetup, attrs: Record<string, string>): DocxPageSetup {
  const widthPt = twipsToPt(attrs['w:w'] ?? attrs['w'], setup.widthPt);
  const heightPt = twipsToPt(attrs['w:h'] ?? attrs['h'], setup.heightPt);
  const authoredOrientation = String(attrs['w:orient'] ?? attrs['orient'] ?? '').toLowerCase();
  const orientation = authoredOrientation === 'landscape' || (authoredOrientation === '' && widthPt > heightPt)
    ? 'landscape'
    : 'portrait';
  return {
    ...setup,
    widthPt: orientation === 'landscape' ? Math.max(widthPt, heightPt) : Math.min(widthPt, heightPt),
    heightPt: orientation === 'landscape' ? Math.min(widthPt, heightPt) : Math.max(widthPt, heightPt),
    orientation,
  };
}

function applyPageMargins(setup: DocxPageSetup, attrs: Record<string, string>): DocxPageSetup {
  return {
    ...setup,
    margins: {
      topPt: twipsToPt(attrs['w:top'] ?? attrs['top'], setup.margins.topPt),
      rightPt: twipsToPt(attrs['w:right'] ?? attrs['right'], setup.margins.rightPt),
      bottomPt: twipsToPt(attrs['w:bottom'] ?? attrs['bottom'], setup.margins.bottomPt),
      leftPt: twipsToPt(attrs['w:left'] ?? attrs['left'], setup.margins.leftPt),
      ...(attrs['w:header'] ?? attrs['header']) !== undefined
        ? { headerPt: twipsToPt(attrs['w:header'] ?? attrs['header'], setup.margins.headerPt ?? 36) }
        : (setup.margins.headerPt !== undefined ? { headerPt: setup.margins.headerPt } : {}),
      ...(attrs['w:footer'] ?? attrs['footer']) !== undefined
        ? { footerPt: twipsToPt(attrs['w:footer'] ?? attrs['footer'], setup.margins.footerPt ?? 36) }
        : (setup.margins.footerPt !== undefined ? { footerPt: setup.margins.footerPt } : {}),
    },
  };
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

function onOffValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') return false;
  if (normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes') return true;
  return fallback;
}

type DocxRelationshipKind =
  | DocumentHeaderFooterKind
  | 'image'
  | 'font'
  | 'theme'
  | 'fontTable'
  | 'other';

interface DocxRelationshipTarget {
  kind: DocxRelationshipKind;
  partName?: string;
  rawTarget: string;
  external: boolean;
}

function normalizeDocxPartTarget(target: string): string | undefined {
  const normalized = target.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return undefined;
  const candidate = segments[0] === 'word' ? segments.join('/') : `word/${segments.join('/')}`;
  return /^word\/[A-Za-z0-9_.\-/]+$/.test(candidate) ? candidate : undefined;
}

function parseDocumentRelationships(xml: string | undefined): Map<string, DocxRelationshipTarget> {
  const result = new Map<string, DocxRelationshipTarget>();
  if (!xml) return result;
  const pattern = /<Relationship\b[^>]*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const attrs = attributes(match[0]);
    const id = attrs['Id'] ?? attrs['id'];
    const type = attrs['Type'] ?? attrs['type'] ?? '';
    const target = attrs['Target'] ?? attrs['target'];
    if (!id || !target) continue;
    const kind: DocxRelationshipKind = /\/header$/i.test(type)
      ? 'header'
      : /\/footer$/i.test(type)
        ? 'footer'
        : /\/image$/i.test(type)
          ? 'image'
          : /\/font$/i.test(type)
            ? 'font'
            : /\/theme$/i.test(type)
              ? 'theme'
              : /\/fontTable$/i.test(type)
                ? 'fontTable'
                : 'other';
    const external = String(attrs['TargetMode'] ?? attrs['targetMode'] ?? '').toLowerCase() === 'external';
    const partName = external ? undefined : normalizeDocxPartTarget(target);
    result.set(id, {
      kind,
      ...(partName ? { partName } : {}),
      rawTarget: target,
      external,
    });
  }
  return result;
}

function parseDocxSections(xml: string): DocxSectionSnapshot[] {
  const snapshots: DocxSectionSnapshot[] = [];
  let pageSetup = DEFAULT_PAGE_SETUP;
  const sectionPattern = /<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>/g;
  let sectionMatch: RegExpExecArray | null;
  while ((sectionMatch = sectionPattern.exec(xml)) !== null) {
    const sectionXml = sectionMatch[0];
    let nextSetup: DocxPageSetup = { ...pageSetup, margins: { ...pageSetup.margins } };
    let breakType: DocumentSectionBreakType = 'nextPage';
    let titlePage = false;
    let pageNumberStart: number | undefined;
    let pageNumberFormat: string | undefined;
    let columns: DocumentStructureDocxColumns | undefined;
    const headers: DocxHeaderFooterReference[] = [];
    const footers: DocxHeaderFooterReference[] = [];
    const columnsMatch = /<w:cols\b([^>]*?)(?:\/>|>([\s\S]*?)<\/w:cols>)/.exec(sectionXml);
    if (columnsMatch) {
      const columnAttrs = attributes(`<w:cols ${columnsMatch[1] ?? ''}/>`);
      const count = Math.max(1, Math.min(100, Number(columnAttrs['w:num'] ?? columnAttrs['num'] ?? 1) || 1));
      const gapPt = twipsToPt(columnAttrs['w:space'] ?? columnAttrs['space'], 36);
      const equalWidth = onOffValue(columnAttrs['w:equalWidth'] ?? columnAttrs['equalWidth'], true);
      const separator = onOffValue(columnAttrs['w:sep'] ?? columnAttrs['sep'], false);
      const rightToLeft = onOffValue(columnAttrs['w:rtl'] ?? columnAttrs['rtl'], false);
      const definitions: Array<{ widthPt: number; gapPt: number }> = [];
      const columnPattern = /<w:col\b[^>]*\/?>/g;
      let columnMatch: RegExpExecArray | null;
      while ((columnMatch = columnPattern.exec(columnsMatch[2] ?? '')) !== null) {
        const attrs = attributes(columnMatch[0]);
        definitions.push({
          widthPt: twipsToPt(attrs['w:w'] ?? attrs['w'], 0),
          gapPt: twipsToPt(attrs['w:space'] ?? attrs['space'], 0),
        });
      }
      columns = {
        count,
        equalWidth,
        gapPt,
        separator,
        ...(definitions.length === count ? {
          widthsPt: definitions.map((definition) => definition.widthPt),
          gapsPt: definitions.map((definition) => definition.gapPt),
        } : {}),
        ...(rightToLeft ? { rightToLeft: true } : {}),
      };
    }
    const propertyPattern = /<w:(pgSz|pgMar|type|titlePg|pgNumType|headerReference|footerReference)\b[^>]*\/?>/g;
    let propertyMatch: RegExpExecArray | null;
    while ((propertyMatch = propertyPattern.exec(sectionXml)) !== null) {
      const name = propertyMatch[1];
      const attrs = attributes(propertyMatch[0]);
      if (name === 'pgSz') {
        nextSetup = applyPageBounds(nextSetup, attrs);
      } else if (name === 'pgMar') {
        nextSetup = applyPageMargins(nextSetup, attrs);
      } else if (name === 'type') {
        const value = String(attrs['w:val'] ?? attrs['val'] ?? '').toLowerCase();
        breakType = value === 'continuous'
          ? 'continuous'
          : value === 'evenpage'
            ? 'evenPage'
            : value === 'oddpage'
              ? 'oddPage'
              : 'nextPage';
      } else if (name === 'titlePg') {
        titlePage = onOffValue(attrs['w:val'] ?? attrs['val'], true);
      } else if (name === 'pgNumType') {
        const start = Number(attrs['w:start'] ?? attrs['start']);
        if (Number.isSafeInteger(start) && start > 0) pageNumberStart = start;
        const format = attrs['w:fmt'] ?? attrs['fmt'];
        if (format && /^[A-Za-z]{1,32}$/.test(format)) pageNumberFormat = format;
      } else if (name === 'headerReference' || name === 'footerReference') {
        const variantValue = String(attrs['w:type'] ?? attrs['type'] ?? 'default').toLowerCase();
        const variant: DocumentHeaderFooterVariant = variantValue === 'first' || variantValue === 'even' ? variantValue : 'default';
        const relationshipId = attrs['r:id'] ?? attrs['id'];
        const reference: DocxHeaderFooterReference = {
          variant,
          ...(relationshipId ? { relationshipId } : {}),
        };
        (name === 'headerReference' ? headers : footers).push(reference);
      }
    }
    pageSetup = nextSetup;
    snapshots.push({
      breakType,
      pageSetup: nextSetup,
      titlePage,
      ...(pageNumberStart !== undefined ? { pageNumberStart } : {}),
      ...(pageNumberFormat ? { pageNumberFormat } : {}),
      ...(columns ? { columnCount: columns.count, columns } : {}),
      headers,
      footers,
    });
  }
  if (snapshots.length === 0) {
    snapshots.push({
      breakType: 'nextPage',
      pageSetup: DEFAULT_PAGE_SETUP,
      titlePage: false,
      headers: [],
      footers: [],
    });
  }
  return snapshots;
}

function parseEvenAndOddHeaders(xml: string | undefined): boolean {
  if (!xml) return false;
  const match = /<w:evenAndOddHeaders\b[^>]*\/?>/.exec(xml);
  if (!match) return false;
  return onOffValue(attributes(match[0])['w:val'] ?? attributes(match[0])['val'], true);
}

function parseEmbeddedFonts(
  xml: string | undefined,
  relationships: Map<string, DocxRelationshipTarget>,
): DocumentEmbeddedFont[] {
  if (!xml) return [];
  const fonts: DocumentEmbeddedFont[] = [];
  const fontPattern = /<w:font\b[^>]*>([\s\S]*?)<\/w:font>/g;
  let fontMatch: RegExpExecArray | null;
  while ((fontMatch = fontPattern.exec(xml)) !== null) {
    const opening = /^<w:font\b[^>]*>/.exec(fontMatch[0])?.[0] ?? '';
    const family = attributes(opening)['w:name'] ?? attributes(opening)['name'];
    if (!family) continue;
    const body = fontMatch[1] ?? '';
    const embeddedPattern = /<w:(embedRegular|embedBold|embedItalic|embedBoldItalic)\b[^>]*\/?>/g;
    let embeddedMatch: RegExpExecArray | null;
    while ((embeddedMatch = embeddedPattern.exec(body)) !== null && fonts.length < MAX_DOCX_EMBEDDED_FONTS) {
      const attrs = attributes(embeddedMatch[0]);
      const relationshipId = attrs['r:id'] ?? attrs['id'];
      const target = relationshipId ? relationships.get(relationshipId) : undefined;
      fonts.push({
        family,
        style: embeddedMatch[1] === 'embedBold'
          ? 'bold'
          : embeddedMatch[1] === 'embedItalic'
            ? 'italic'
            : embeddedMatch[1] === 'embedBoldItalic'
              ? 'boldItalic'
              : 'regular',
        ...(relationshipId ? { relationshipId } : {}),
        ...(target?.partName ? { partName: target.partName } : {}),
        ...(attrs['w:fontKey'] ?? attrs['fontKey'] ? { fontKey: attrs['w:fontKey'] ?? attrs['fontKey'] } : {}),
        status: target?.partName ? 'declared' : 'malformed',
        ...(!target?.partName ? { warning: 'Embedded font relationship could not be resolved.' } : {}),
      });
    }
  }
  return fonts;
}

function parseThemeFonts(xml: string | undefined): DocumentThemeFonts | undefined {
  if (!xml) return undefined;
  const readFont = (kind: 'major' | 'minor'): { latin?: string; eastAsia?: string } => {
    const block = new RegExp(`<a:${kind}Font\\b[^>]*>([\\s\\S]*?)<\\/a:${kind}Font>`).exec(xml)?.[1] ?? '';
    const readFace = (face: 'latin' | 'ea'): string | undefined => {
      const tag = new RegExp(`<a:${face}\\b[^>]*\\/?>`).exec(block)?.[0];
      if (!tag) return undefined;
      const value = attributes(tag)['typeface'];
      return value ? value.trim().slice(0, 200) : undefined;
    };
    return { latin: readFace('latin'), eastAsia: readFace('ea') };
  };
  const major = readFont('major');
  const minor = readFont('minor');
  const result: DocumentThemeFonts = {
    ...(major.latin ? { major: major.latin } : {}),
    ...(minor.latin ? { minor: minor.latin } : {}),
    ...(major.eastAsia ? { majorEastAsia: major.eastAsia } : {}),
    ...(minor.eastAsia ? { minorEastAsia: minor.eastAsia } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

function imageMimeFromName(name: string): string | undefined {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'bmp') return 'image/bmp';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'tif' || extension === 'tiff') return 'image/tiff';
  if (extension === 'emf') return 'image/x-emf';
  if (extension === 'wmf') return 'image/x-wmf';
  return undefined;
}

function inspectDocxImage(bytes: Uint8Array, mediaPart: string): DocxImageInspection {
  const declared = imageMimeFromName(mediaPart);
  if (bytes.byteLength > MAX_DOCX_IMAGE_BYTES) {
    return { mimeType: declared, warning: warning('DOCX_IMAGE_TOO_LARGE', 'An embedded image exceeded the per-image size limit and was not inspected.') };
  }
  let mimeType: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    mimeType = 'image/png';
    width = (bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!;
    height = (bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!;
  } else if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    mimeType = 'image/gif';
    width = bytes[6]! | (bytes[7]! << 8);
    height = bytes[8]! | (bytes[9]! << 8);
  } else if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    mimeType = 'image/bmp';
    width = Math.abs(bytes[18]! | (bytes[19]! << 8) | (bytes[20]! << 16) | (bytes[21]! << 24));
    height = Math.abs(bytes[22]! | (bytes[23]! << 8) | (bytes[24]! << 16) | (bytes[25]! << 24));
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    mimeType = 'image/jpeg';
    for (let index = 2; index + 9 < bytes.length;) {
      if (bytes[index] !== 0xff) { index += 1; continue; }
      const marker = bytes[index + 1]!;
      if (marker >= 0xc0 && marker <= 0xc3) {
        height = (bytes[index + 5]! << 8) | bytes[index + 6]!;
        width = (bytes[index + 7]! << 8) | bytes[index + 8]!;
        break;
      }
      const length = (bytes[index + 2]! << 8) | bytes[index + 3]!;
      if (length < 2) break;
      index += 2 + length;
    }
  } else if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    mimeType = 'image/webp';
  } else if (bytes.length >= 12 && bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) {
    mimeType = 'image/tiff';
  } else if (bytes.length >= 44 && bytes[0] === 0x01 && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x00) {
    mimeType = 'image/x-emf';
  } else if (bytes.length >= 6 && bytes[0] === 0xd7 && bytes[1] === 0xcd && bytes[2] === 0xc6 && bytes[3] === 0x9a) {
    mimeType = 'image/x-wmf';
  } else if (bytes.length >= 5) {
    const prefix = String.fromCharCode(...bytes.slice(0, Math.min(512, bytes.length))).trimStart().toLowerCase();
    if (prefix.startsWith('<svg') || prefix.startsWith('<?xml') && prefix.includes('<svg')) {
      mimeType = 'image/svg+xml';
    }
  }
  if (!mimeType) {
    return {
      ...(declared ? { mimeType: declared } : {}),
      warning: warning('DOCX_IMAGE_INVALID_SIGNATURE', 'An embedded image did not match a supported image signature.'),
    };
  }
  if (declared && declared !== mimeType && !(declared === 'image/jpeg' && mimeType === 'image/jpeg')) {
    return { mimeType, width, height, warning: warning('DOCX_IMAGE_MIME_MISMATCH', 'An embedded image signature did not match its declared file extension.') };
  }
  if (width !== undefined && height !== undefined) {
    if (width <= 0 || height <= 0 || width > MAX_DOCX_IMAGE_DIMENSION || height > MAX_DOCX_IMAGE_DIMENSION
      || width * height > MAX_DOCX_IMAGE_PIXELS) {
      return { mimeType, warning: warning('DOCX_IMAGE_DIMENSIONS_REJECTED', 'An embedded image exceeded the decoded dimension limit.') };
    }
  }
  return {
    mimeType,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(width === undefined || height === undefined
      ? { warning: warning('DOCX_IMAGE_DIMENSIONS_UNAVAILABLE', 'An embedded image did not expose intrinsic pixel dimensions.') }
      : {}),
  };
}

function parseDrawingImage(
  xml: string,
  relationships: Map<string, DocxRelationshipTarget>,
  mediaParts: Map<string, DocxMediaPart>,
  sourcePart: string,
): DocxImageSource | undefined {
  const embedId = /\br:embed=["']([^"']+)["']/.exec(xml)?.[1];
  const linkId = /\br:link=["']([^"']+)["']/.exec(xml)?.[1];
  const vmlId = /<v:imagedata\b[^>]*\br:id=["']([^"']+)["']/.exec(xml)?.[1];
  const relationshipId = embedId ?? linkId ?? vmlId;
  if (!relationshipId) return undefined;
  const relationship = relationships.get(relationshipId);
  const external = relationship?.external === true || relationship === undefined && /TargetMode=["']External["']/i.test(xml);
  const warnings: ExtractionWarning[] = [];
  let mimeType: string | undefined;
  let originalWidthPx: number | undefined;
  let originalHeightPx: number | undefined;
  const mediaPart = relationship?.partName;
  if (external) {
    warnings.push(warning('DOCX_IMAGE_EXTERNAL_LINK', 'A linked external image was not fetched; only its placement metadata was preserved.'));
    mimeType = mediaPart ? imageMimeFromName(mediaPart) : undefined;
  } else if (!relationship || !mediaPart) {
    warnings.push(warning('DOCX_IMAGE_RELATIONSHIP_MISSING', 'An image relationship could not be resolved to a package part.'));
  } else {
    const media = mediaParts.get(mediaPart);
    if (!media) {
      warnings.push(warning('DOCX_IMAGE_MISSING', 'An image part referenced by the document is missing or was omitted by the image limit.'));
      mimeType = imageMimeFromName(mediaPart);
    } else {
      const inspection = inspectDocxImage(media.bytes, mediaPart);
      mimeType = inspection.mimeType;
      originalWidthPx = inspection.width;
      originalHeightPx = inspection.height;
      if (inspection.warning) warnings.push(inspection.warning);
    }
  }
  const extentTag = /<wp:extent\b[^>]*\/?>/.exec(xml)?.[0];
  const extentAttributes = extentTag ? attributes(extentTag) : {};
  const extentWidth = Number(extentAttributes['cx']);
  const extentHeight = Number(extentAttributes['cy']);
  const hasExtent = Number.isFinite(extentWidth) && Number.isFinite(extentHeight) && extentWidth > 0 && extentHeight > 0;
  let displayWidthPt = hasExtent ? extentWidth / 12700 : 0;
  let displayHeightPt = hasExtent ? extentHeight / 12700 : 0;
  if (!hasExtent) {
    const style = /<v:shape\b[^>]*\bstyle=["']([^"']+)["']/.exec(xml)?.[1] ?? '';
    const width = /(?:^|;)\s*width\s*:\s*([0-9.]+)\s*(pt|in|cm|mm)?/i.exec(style);
    const height = /(?:^|;)\s*height\s*:\s*([0-9.]+)\s*(pt|in|cm|mm)?/i.exec(style);
    const convert = (match: RegExpExecArray | null): number => {
      if (!match) return 0;
      const value = Number(match[1]);
      const unit = (match[2] ?? 'pt').toLowerCase();
      return unit === 'in' ? value * 72 : unit === 'cm' ? value * 72 / 2.54 : unit === 'mm' ? value * 72 / 25.4 : value;
    };
    displayWidthPt = convert(width);
    displayHeightPt = convert(height);
  }
  if ((!displayWidthPt || !displayHeightPt) && originalWidthPx && originalHeightPx) {
    displayWidthPt = originalWidthPx * 72 / 96;
    displayHeightPt = originalHeightPx * 72 / 96;
    warnings.push(warning('DOCX_IMAGE_DISPLAY_SIZE_DERIVED', 'An image display size was derived from its pixel dimensions at 96 DPI.'));
  }
  if (!displayWidthPt || !displayHeightPt) {
    warnings.push(warning('DOCX_IMAGE_DISPLAY_SIZE_UNAVAILABLE', 'An image display size could not be determined.'));
  }
  const docProperties = /<wp:docPr\b[^>]*\/?>/.exec(xml)?.[0];
  const pictureProperties = /<pic:cNvPr\b[^>]*\/?>/.exec(xml)?.[0];
  const docAttributes = docProperties ? attributes(docProperties) : {};
  const pictureAttributes = pictureProperties ? attributes(pictureProperties) : {};
  const alternativeText = docAttributes['descr'] ?? pictureAttributes['descr'];
  const title = docAttributes['title'] ?? pictureAttributes['title'];
  const positioning = /<wp:anchor\b/.test(xml) ? 'anchored' : 'inline';
  const behindDocument = /<wp:anchor\b[^>]*\bbehindDoc=["'](?:1|true)["']/.test(xml);
  const wrap = positioning === 'inline'
    ? 'inline'
    : behindDocument
      ? 'behind'
      : /<wp:wrapSquare\b[^>]*\bwrapText=["']left["']/.test(xml)
        ? 'squareLeft'
        : /<wp:wrapSquare\b[^>]*\bwrapText=["']right["']/.test(xml)
          ? 'squareRight'
          : /<wp:wrapSquare\b/.test(xml)
            ? 'square'
            : /<wp:wrapTight\b/.test(xml)
              ? 'tight'
              : /<wp:wrapThrough\b/.test(xml)
                ? 'through'
                : /<wp:wrapTopAndBottom\b/.test(xml)
                  ? 'topAndBottom'
                  : 'inFront';
  return {
    ...(relationshipId ? { relationshipId } : {}),
    sourcePart,
    ...(mediaPart ? { mediaPart } : {}),
    ...(mimeType ? { mimeType } : {}),
    external,
    ...(originalWidthPx !== undefined ? { originalWidthPx } : {}),
    ...(originalHeightPx !== undefined ? { originalHeightPx } : {}),
    displayWidthPt: Math.max(0, displayWidthPt),
    displayHeightPt: Math.max(0, displayHeightPt),
    positioning,
    wrap,
    ...(alternativeText ? { alternativeText: alternativeText.slice(0, 2000) } : {}),
    ...(title ? { title: title.slice(0, 500) } : {}),
    warnings,
  };
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
        if (existing) {
          existing.rowSpan += 1;
          if (cell.images?.length) existing.images.push(...cell.images);
        }
        column += colSpan;
        continue;
      }
      outputRow.cells.push({
        text: cell.text,
        colSpan,
        rowSpan: Math.max(1, cell.rowSpan),
        columnIndex: column,
        ...(cell.vMerge ? { vMerge: cell.vMerge } : {}),
        images: cell.images ?? [],
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

function isCaptionText(text: string, styleId?: string, styleName?: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const style = `${styleId ?? ''} ${styleName ?? ''}`;
  return /(^|\b)caption\b/i.test(style)
    || /^(?:figure|fig\.?|table|exhibit|plate)\s+[A-Za-z0-9]/i.test(normalized);
}

function docxBlockHasImages(block: DocxBlock): boolean {
  if (block.type === 'paragraph') return (block.images?.length ?? 0) > 0;
  return block.rows.some((row) => row.cells.some((cell) => (cell.images?.length ?? 0) > 0));
}

function serializeBlocks(blocks: DocxBlock[], pageSetup: DocxPageSetup = DEFAULT_PAGE_SETUP): StructureResult {
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
    pageSetup,
  };
}

function parseDocumentXml(
  xml: string,
  styles: DocxStyles,
  numbering: DocxNumbering,
  relationships: Map<string, DocxRelationshipTarget> = new Map(),
  mediaParts: Map<string, DocxMediaPart> = new Map(),
  sourcePart = 'word/document.xml',
): StructureResult {
  const blocks: DocxBlock[] = [];
  const tokens = xml.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  let paragraph: ParagraphState | null = null;
  let inText = false;
  let drawingDepth = 0;
  let drawingTokens: string[] = [];
  let tableDepth = 0;
  let currentTable: { rows: DocxTableRow[]; gridColumns: number } | null = null;
  let currentRow: DocxTableRow | null = null;
  let currentCell: {
    text: string;
    colSpan: number;
    vMerge?: 'restart' | 'continue';
    images: DocxCellImage[];
    paragraphIndex: number;
    pendingImageIndexes: number[];
  } | null = null;
  let nestedTables = 0;
  let unresolvedHeadingStyles = false;
  let sawHeadingStyle = false;
  let sawResolvedHeading = false;
  let pageSetup = DEFAULT_PAGE_SETUP;
  let inSectionProperties = false;
  let sectionDraft: DocxPageSetup | null = null;
  let sectionBreakType = 'nextPage';
  const listCounters = new Map<string, number>();

  const finalizeParagraph = () => {
    if (!paragraph) return;
    const text = cleanParagraphText(paragraph.text);
    if (text || paragraph.images.length > 0) {
      if (tableDepth > 0 && currentCell) {
        if (text) currentCell.text = currentCell.text ? `${currentCell.text}\n${text}` : text;
        const nestedTableDepth = Math.max(0, tableDepth - 1);
        for (const image of paragraph.images) {
          const imageIndex = currentCell.images.length;
          currentCell.images.push({
            image,
            paragraphIndex: currentCell.paragraphIndex,
            imageIndex,
            nestedTableDepth,
          });
          currentCell.pendingImageIndexes.push(imageIndex);
        }
        if (text && paragraph.images.length === 0) {
          const captionStyle = paragraph.styleId && styles.names.has(paragraph.styleId)
            ? styles.names.get(paragraph.styleId)
            : undefined;
          if (isCaptionText(text, paragraph.styleId, captionStyle) && currentCell.pendingImageIndexes.length) {
            for (const imageIndex of currentCell.pendingImageIndexes) {
              const cellImage = currentCell.images[imageIndex];
              if (cellImage) cellImage.captionText = text.slice(0, 1_000);
            }
          }
          currentCell.pendingImageIndexes = [];
        }
        currentCell.paragraphIndex += 1;
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
          ...(paragraph.pageBreakBefore ? { pageBreakBefore: true } : {}),
          ...(paragraph.explicitPageBreakAfter ? { explicitPageBreakAfter: true } : {}),
          ...(paragraph.lastRenderedPageBreakAfter ? { lastRenderedPageBreakAfter: true } : {}),
          ...(paragraph.columnBreakAfter ? { columnBreakAfter: true } : {}),
          ...(paragraph.images.length ? { images: paragraph.images } : {}),
          ...(paragraph.sectionBreakAfter && sectionBreakType !== 'continuous'
            ? { sectionBreakAfter: paragraph.sectionBreakAfter }
            : {}),
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

    if (drawingDepth > 0) {
      drawingTokens.push(token);
      if (!closing && !selfClosing && (name === 'drawing' || name === 'pict')) drawingDepth += 1;
      if (closing && (name === 'drawing' || name === 'pict')) {
        drawingDepth -= 1;
        if (drawingDepth === 0) {
          const image = parseDrawingImage(drawingTokens.join(''), relationships, mediaParts, sourcePart);
          if (image && paragraph) paragraph.images.push(image);
          drawingTokens = [];
        }
      }
      continue;
    }
    if (!closing && !selfClosing && (name === 'drawing' || name === 'pict')) {
      drawingDepth = 1;
      drawingTokens = [token];
      continue;
    }

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
        paragraph = { text: '', images: [] };
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
    if (name === 'pageBreakBefore' && paragraph) {
      paragraph.pageBreakBefore = true;
      continue;
    }
    if (name === 'lastRenderedPageBreak' && paragraph) {
      paragraph.lastRenderedPageBreakAfter = true;
      continue;
    }
    if (name === 'sectPr') {
      if (!closing) {
        inSectionProperties = true;
        sectionDraft = { ...pageSetup, margins: { ...pageSetup.margins } };
        sectionBreakType = 'nextPage';
      } else {
        if (sectionDraft) {
          pageSetup = sectionDraft;
          if (paragraph) paragraph.sectionBreakAfter = sectionDraft;
        }
        inSectionProperties = false;
        sectionDraft = null;
      }
      continue;
    }
    if (inSectionProperties && name === 'pgSz' && sectionDraft) {
      sectionDraft = applyPageBounds(sectionDraft, attrs);
      continue;
    }
    if (inSectionProperties && name === 'pgMar' && sectionDraft) {
      sectionDraft = applyPageMargins(sectionDraft, attrs);
      continue;
    }
    if (inSectionProperties && name === 'type') {
      const value = String(attrs['w:val'] ?? attrs['val'] ?? '').toLowerCase();
      if (value) sectionBreakType = value;
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
      const breakType = String(attrs['w:type'] ?? attrs['type'] ?? '').toLowerCase();
      if (name === 'br' && breakType === 'page') {
        paragraph.explicitPageBreakAfter = true;
      } else if (name === 'br' && breakType === 'column') {
        paragraph.columnBreakAfter = true;
      } else {
        paragraph.text += '\n';
      }
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
            images: currentCell.images,
          });
        }
        currentCell = null;
      } else currentCell = {
        text: '',
        colSpan: 1,
        images: [],
        paragraphIndex: 0,
        pendingImageIndexes: [],
      };
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
  const serialized = serializeBlocks(blocks, pageSetup);
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

function buildDocxPagination(
  bodyBlockIds: string[],
  breaks: Map<string, { before?: DocumentPaginationBreakReason; after?: DocumentPaginationBreakReason; setupAfter?: DocxPageSetup }>,
  pageSetup: DocxPageSetup,
  warnings: ExtractionWarning[],
): DocumentPaginationInfo {
  const hasExplicit = [...breaks.values()].some((entry) => entry.after === 'explicit_page_break' || entry.before === 'explicit_page_break' || entry.after === 'section_break');
  const hasReported = [...breaks.values()].some((entry) => entry.after === 'last_rendered_page_break' || entry.before === 'last_rendered_page_break');
  const status = hasReported ? 'renderer_reported_breaks' : hasExplicit ? 'explicit_breaks' : 'logical_fallback';
  if (status === 'logical_fallback') {
    const paginationWarnings: ExtractionWarning[] = [{
      code: 'DOCX_PAGINATION_UNAVAILABLE',
      message: 'WordprocessingML does not expose automatic physical page breaks. The document remains a logical page; no physical page count is claimed.',
    }];
    warnings.push(...paginationWarnings);
    return {
      status,
      mechanism: 'none',
      pageCount: 1,
      pages: [],
      blockPages: [],
      warnings: paginationWarnings,
    };
  }

  const pages: DocumentPaginationPage[] = [];
  const blockPages: Array<{ blockId: string; startPageNumber: number; endPageNumber?: number }> = [];
  let current: DocumentPaginationPage | null = null;
  let currentSetup = pageSetup;
  let pageNumber = 1;
  let nextReason: DocumentPaginationBreakReason = 'document_start';
  const startPage = (reason: DocumentPaginationBreakReason, setup: DocxPageSetup) => {
    current = {
      pageNumber: pageNumber++,
      pageKind: status === 'renderer_reported_breaks' ? 'renderer_reported' : 'explicit_break_segment',
      blockIds: [],
      breakReason: reason,
      pageWidthPt: setup.widthPt,
      pageHeightPt: setup.heightPt,
      orientation: setup.orientation,
      margins: setup.margins,
    };
    pages.push(current);
  };
  for (const blockId of bodyBlockIds) {
    const info = breaks.get(blockId);
    if (!current) startPage(nextReason, currentSetup);
    if (info?.before && current!.blockIds.length > 0) {
      currentSetup = info.setupAfter ?? currentSetup;
      startPage(info.before, currentSetup);
    }
    current!.blockIds.push(blockId);
    blockPages.push({ blockId, startPageNumber: current!.pageNumber });
    if (info?.after) {
      const ended = current!;
      const nextSetup = info.setupAfter ?? currentSetup;
      current = null;
      currentSetup = nextSetup;
      nextReason = info.after;
      blockPages[blockPages.length - 1]!.endPageNumber = ended.pageNumber;
    }
  }
  const mechanism = hasReported
    ? 'wordprocessingml_last_rendered_breaks'
    : hasExplicit ? ([...breaks.values()].some((entry) => entry.after === 'section_break')
      ? 'wordprocessingml_sections'
      : 'wordprocessingml_breaks') : 'none';
  const paginationWarnings: ExtractionWarning[] = [{
    code: hasReported ? 'DOCX_RENDERER_REPORTED_BREAKS' : 'DOCX_EXPLICIT_BREAK_PAGINATION',
    message: hasReported
      ? 'Page boundaries come from WordprocessingML last-rendered break markers. Automatic layout pagination was not performed; boundaries are not verified against Microsoft Word.'
      : 'Page boundaries come only from explicit page breaks and section breaks. Automatic layout pagination was not performed; the page count is not a verified physical page count.',
  }];
  warnings.push(...paginationWarnings);
  return {
    status,
    mechanism,
    pageCount: pages.length,
    pages,
    blockPages,
    warnings: paginationWarnings,
  };
}
interface EffectiveHeaderFooterReference {
  variant: DocumentHeaderFooterVariant;
  relationshipId?: string;
  partName?: string;
  definingSectionIndex: number;
}

function buildDocxLayout(
  snapshots: DocxSectionSnapshot[],
  relationships: Map<string, DocxRelationshipTarget>,
  evenAndOddHeaders: boolean,
  blockIdsByPart: Map<string, string[]>,
  embeddedFonts: DocumentEmbeddedFont[],
  themeFonts: DocumentThemeFonts | undefined,
): DocumentStructureDocxLayout {
  const effective = new Map<DocumentHeaderFooterKind, Map<DocumentHeaderFooterVariant, EffectiveHeaderFooterReference>>([
    ['header', new Map()],
    ['footer', new Map()],
  ]);
  const sections: DocumentStructureDocxSection[] = [];
  for (let sectionIndex = 0; sectionIndex < snapshots.length; sectionIndex += 1) {
    const snapshot = snapshots[sectionIndex]!;
    for (const kind of ['header', 'footer'] as const) {
      const current = effective.get(kind)!;
      const explicit = kind === 'header' ? snapshot.headers : snapshot.footers;
      for (const reference of explicit) {
        const target = reference.relationshipId ? relationships.get(reference.relationshipId) : undefined;
        current.set(reference.variant, {
          variant: reference.variant,
          ...(reference.relationshipId ? { relationshipId: reference.relationshipId } : {}),
          ...(target?.kind === kind && target.partName ? { partName: target.partName } : {}),
          definingSectionIndex: sectionIndex,
        });
      }
    }
    const toReferences = (kind: DocumentHeaderFooterKind): DocumentStructureHeaderFooterReference[] => (
      [...effective.get(kind)!.values()]
        .sort((left, right) => ['default', 'first', 'even'].indexOf(left.variant) - ['default', 'first', 'even'].indexOf(right.variant))
        .map((reference) => ({
          kind,
          variant: reference.variant,
          ...(reference.relationshipId ? { relationshipId: reference.relationshipId } : {}),
          ...(reference.partName ? { partName: reference.partName } : {}),
          inherited: reference.definingSectionIndex !== sectionIndex,
          definingSectionIndex: reference.definingSectionIndex,
          blockIds: reference.partName ? [...(blockIdsByPart.get(reference.partName) ?? [])] : [],
        }))
    );
    sections.push({
      sectionIndex,
      breakType: snapshot.breakType,
      pageWidthPt: snapshot.pageSetup.widthPt,
      pageHeightPt: snapshot.pageSetup.heightPt,
      orientation: snapshot.pageSetup.orientation,
      margins: { ...snapshot.pageSetup.margins },
      ...(snapshot.columnCount !== undefined ? { columnCount: snapshot.columnCount } : {}),
      ...(snapshot.columns ? { columns: snapshot.columns } : {}),
      titlePage: snapshot.titlePage,
      ...(snapshot.pageNumberStart !== undefined ? { pageNumberStart: snapshot.pageNumberStart } : {}),
      ...(snapshot.pageNumberFormat ? { pageNumberFormat: snapshot.pageNumberFormat } : {}),
      headers: toReferences('header'),
      footers: toReferences('footer'),
    });
  }
  return {
    evenAndOddHeaders,
    sections,
    ...(embeddedFonts.length ? { embeddedFonts } : {}),
    ...(themeFonts ? { themeFonts } : {}),
  };
}

function buildDocxDocumentStructure(
  bodyBlocks: DocxBlock[],
  headerParts: DocxAuxiliaryPart[],
  footerParts: DocxAuxiliaryPart[],
  docxSections: DocxSectionSnapshot[],
  docxRelationships: Map<string, DocxRelationshipTarget>,
  evenAndOddHeaders: boolean,
  embeddedFonts: DocumentEmbeddedFont[],
  themeFonts: DocumentThemeFonts | undefined,
  warnings: ExtractionWarning[],
  pageSetup: DocxPageSetup,
): ReturnType<typeof finalizeStructure> {
  const blocks: DocumentStructureBlock[] = [];
  const pageBlockIds: string[] = [];
  const furnitureIds = new Set<string>();
  const breaks = new Map<string, { before?: DocumentPaginationBreakReason; after?: DocumentPaginationBreakReason; setupAfter?: DocxPageSetup }>();
  let order = 0;
  let counter = 0;
  let listCounter = 0;
  let tableCounter = 0;
  let mergedCells = 0;
  const add = (block: DocumentStructureBlock) => {
    blocks.push(block);
    return block;
  };
  const blockIdsByPart = new Map<string, string[]>();
  interface FurnitureMeta {
    kind: 'header' | 'footer';
    variant: 'default' | 'first' | 'even';
    partName: string;
    definingSectionIndex: number;
  }
  const furnitureMeta = new Map<string, FurnitureMeta>();
  for (let sectionIndex = 0; sectionIndex < docxSections.length; sectionIndex += 1) {
    const snapshot = docxSections[sectionIndex]!;
    for (const kind of ['header', 'footer'] as const) {
      const references = kind === 'header' ? snapshot.headers : snapshot.footers;
      for (const reference of references) {
        const target = reference.relationshipId ? docxRelationships.get(reference.relationshipId) : undefined;
        if (!target?.partName || furnitureMeta.has(target.partName)) continue;
        furnitureMeta.set(target.partName, {
          kind,
          variant: reference.variant,
          partName: target.partName,
          definingSectionIndex: sectionIndex,
        });
      }
    }
  }
  interface ImagePlacementOptions {
    sourceParagraphBlockId?: string;
    sourceParagraphIndex?: number;
    sourceRefPrefix: string;
    placementOffset?: number;
    captionText?: string;
    topLevel?: boolean;
    parent?: {
      tableBlockId: string;
      rowBlockId: string;
      cellBlockId: string;
      tableId: string;
      rowIndex: number;
      columnIndex: number;
      nestedTableDepth: number;
    };
    headerFooter?: FurnitureMeta;
  }
  let imageBlockCount = 0;
  let imagePlacementLimitWarned = false;
  const addImageBlocks = (images: DocxImageSource[] | undefined, options: ImagePlacementOptions): DocumentStructureBlock[] => {
    const created: DocumentStructureBlock[] = [];
    if (!images?.length) return created;
    const placementOffset = options.placementOffset ?? 0;
    for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
      if (imageBlockCount >= MAX_STRUCTURE_IMAGES) {
        if (!imagePlacementLimitWarned) {
          warnings.push(warning(
            'DOCX_IMAGE_PLACEMENT_LIMIT',
            `Image placement extraction was bounded to ${MAX_STRUCTURE_IMAGES} blocks; remaining placements were omitted.`,
          ));
          imagePlacementLimitWarned = true;
        }
        break;
      }
      imageBlockCount += 1;
      const source = images[imageIndex]!;
      counter += 1;
      const id = structureBlockId(1, counter, `img${placementOffset + imageIndex + 1}`);
      const imageWarnings = [...source.warnings];
      if (!source.alternativeText?.trim()) {
        imageWarnings.push(warning('DOCX_IMAGE_ALT_TEXT_MISSING', 'An embedded image has no alternative text.'));
      }
      const topLevel = options.topLevel !== false;
      if (topLevel) pageBlockIds.push(id);
      if (options.headerFooter) furnitureIds.add(id);
      const placementIndex = placementOffset + imageIndex;
      const sourceRef = `${options.sourceRefPrefix}:image${placementIndex + 1}`;
      const imageBlock = add(structureBlock({
        blockId: id,
        type: 'image',
        text: '',
        pageNumber: 1,
        order: order++,
        ...(options.parent ? { parentId: options.parent.cellBlockId } : {}),
        provenance: 'docx_xml',
        sourceRef,
        image: {
          ...(source.relationshipId ? { relationshipId: source.relationshipId } : {}),
          sourcePart: source.sourcePart,
          ...(source.mediaPart ? { mediaPart: source.mediaPart } : {}),
          ...(source.mimeType ? { mimeType: source.mimeType } : {}),
          external: source.external,
          ...(source.originalWidthPx !== undefined ? { originalWidthPx: source.originalWidthPx } : {}),
          ...(source.originalHeightPx !== undefined ? { originalHeightPx: source.originalHeightPx } : {}),
          displayWidthPt: source.displayWidthPt,
          displayHeightPt: source.displayHeightPt,
          positioning: source.positioning,
          wrap: source.wrap,
          ...(source.alternativeText ? { alternativeText: source.alternativeText } : {}),
          ...(source.title ? { title: source.title } : {}),
          placementId: sourceRef,
          ...(options.sourceParagraphBlockId ? { sourceParagraphBlockId: options.sourceParagraphBlockId } : {}),
          ...(options.sourceParagraphIndex !== undefined ? { sourceParagraphIndex: options.sourceParagraphIndex } : {}),
          placementIndex,
          ...(options.parent ? {
            parentTableBlockId: options.parent.tableBlockId,
            parentRowBlockId: options.parent.rowBlockId,
            parentCellBlockId: options.parent.cellBlockId,
            tableId: options.parent.tableId,
            rowIndex: options.parent.rowIndex,
            columnIndex: options.parent.columnIndex,
            nestedTableDepth: options.parent.nestedTableDepth,
          } : {}),
          ...(options.headerFooter ? {
            headerFooter: {
              kind: options.headerFooter.kind,
              variant: options.headerFooter.variant,
              partName: options.headerFooter.partName,
              definingSectionIndex: options.headerFooter.definingSectionIndex,
            },
          } : {}),
          ...(options.captionText ? { captionText: options.captionText.slice(0, 1_000) } : {}),
          warnings: imageWarnings,
        },
        ...(imageWarnings.length ? { warnings: imageWarnings } : {}),
      }));
      created.push(imageBlock);
    }
    return created;
  };
  let pendingCaptionImages: DocumentStructureBlock[] = [];
  const isCaptionBlock = (block: DocxBlock): boolean => (
    block.type === 'paragraph' ? isCaptionText(block.text, block.styleId, block.styleName) : false
  );
  const addTextGroup = (source: DocxAuxiliaryPart[], type: 'header' | 'footer') => {
    for (const part of source) {
      const partBlockIds = blockIdsByPart.get(part.partName) ?? [];
      const meta = furnitureMeta.get(part.partName);
      let pendingFurnitureImages: DocumentStructureBlock[] = [];
      let furnitureImageOrdinal = 0;
      for (let blockIndex = 0; blockIndex < part.blocks.length; blockIndex += 1) {
        const block = part.blocks[blockIndex]!;
        const text = block.type === 'paragraph'
          ? block.text
          : block.rows.map((row) => row.cells.map((cell) => cell.text).join('\t')).join('\n');
        let sourceBlockId: string | undefined;
        if (text.trim()) {
          counter += 1;
          const id = structureBlockId(1, counter);
          pageBlockIds.push(id);
          furnitureIds.add(id);
          partBlockIds.push(id);
          sourceBlockId = id;
          add(structureBlock({
            blockId: id,
            type,
            text,
            pageNumber: 1,
            order: order++,
            provenance: 'docx_xml',
            sourceRef: `docx:${type}:${part.partName.replace(/^word\//, '')}:p${blockIndex + 1}`,
            ...(block.type === 'paragraph' && block.alignment ? { style: { alignment: block.alignment } } : {}),
          }));
        }
        if (!meta) {
          if (part.blocks.some(docxBlockHasImages) && !warnings.some((item) => item.code === 'DOCX_HEADER_FOOTER_IMAGE_UNREFERENCED')) {
            warnings.push(warning(
              'DOCX_HEADER_FOOTER_IMAGE_UNREFERENCED',
              'A header/footer part with images is not referenced by any section; its image placements were not emitted.',
            ));
          }
          continue;
        }
        const captionBlock = isCaptionBlock(block);
        if (captionBlock && pendingFurnitureImages.length) {
          for (const image of pendingFurnitureImages) {
            if (!image.image) continue;
            image.image.captionText = block.type === 'paragraph' ? block.text.slice(0, 1_000) : undefined;
            if (sourceBlockId) image.image.captionBlockId = sourceBlockId;
          }
          pendingFurnitureImages = [];
        }
        if (block.type === 'paragraph') {
          if (!captionBlock) pendingFurnitureImages = [];
          const images = addImageBlocks(block.images, {
            ...(sourceBlockId ? { sourceParagraphBlockId: sourceBlockId } : {}),
            sourceRefPrefix: `docx:${type}:${part.partName.replace(/^word\//, '')}:p${blockIndex + 1}`,
            placementOffset: furnitureImageOrdinal,
            headerFooter: meta,
          });
          furnitureImageOrdinal += images.length;
          if (images.length) pendingFurnitureImages = images;
          for (const image of images) partBlockIds.push(image.blockId);
        } else {
          pendingFurnitureImages = [];
          for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
            const row = block.rows[rowIndex]!;
            for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
              const cell = row.cells[cellIndex]!;
              for (const cellImage of cell.images) {
                const images = addImageBlocks([cellImage.image], {
                  ...(sourceBlockId ? { sourceParagraphBlockId: sourceBlockId } : {}),
                  sourceParagraphIndex: cellImage.paragraphIndex,
                  sourceRefPrefix: `docx:${type}:${part.partName.replace(/^word\//, '')}:table${blockIndex + 1}:row${rowIndex + 1}:cell${cellIndex + 1}:p${cellImage.paragraphIndex + 1}`,
                  placementOffset: furnitureImageOrdinal + cellImage.imageIndex,
                  ...(cellImage.captionText ? { captionText: cellImage.captionText } : {}),
                  headerFooter: meta,
                });
                furnitureImageOrdinal += images.length;
                for (const image of images) partBlockIds.push(image.blockId);
              }
            }
          }
        }
      }
      blockIdsByPart.set(part.partName, partBlockIds);
    }
  };
  addTextGroup(headerParts, 'header');
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
          const cellBlock = add(structureBlock({
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
          const cellImageIds: string[] = [];
          for (const cellImage of cell.images) {
            const imageBlocks = addImageBlocks([cellImage.image], {
              sourceParagraphBlockId: cellId,
              sourceParagraphIndex: cellImage.paragraphIndex,
              sourceRefPrefix: `docx:table${tableCounter}:row${rowIndex + 1}:cell${cellIndex + 1}:p${cellImage.paragraphIndex + 1}`,
              placementOffset: cellImage.imageIndex,
              ...(cellImage.captionText ? { captionText: cellImage.captionText } : {}),
              topLevel: false,
              parent: {
                tableBlockId,
                rowBlockId: rowId,
                cellBlockId: cellId,
                tableId,
                rowIndex,
                columnIndex: cell.columnIndex,
                nestedTableDepth: cellImage.nestedTableDepth,
              },
            });
            for (const imageBlock of imageBlocks) cellImageIds.push(imageBlock.blockId);
          }
          if (cellImageIds.length) cellBlock.children = cellImageIds;
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
        if (candidate.pageBreakBefore && items.length > 0) break;
        items.push(candidate);
        cursor += 1;
      }
      listCounter += 1;
      counter += 1;
      const listBlockId = structureBlockId(1, counter);
      const firstItem = items[0] as Extract<DocxBlock, { type: 'paragraph' }>;
      const lastItem = items[items.length - 1] as Extract<DocxBlock, { type: 'paragraph' }>;
      breaks.set(listBlockId, {
        ...(firstItem.pageBreakBefore ? { before: 'explicit_page_break' as const } : {}),
        ...(lastItem.sectionBreakAfter
          ? { after: 'section_break' as const, setupAfter: lastItem.sectionBreakAfter }
          : lastItem.explicitPageBreakAfter
            ? { after: 'explicit_page_break' as const }
            : lastItem.lastRenderedPageBreakAfter
              ? { after: 'last_rendered_page_break' as const }
              : {}),
      });
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
          ...(item.columnBreakAfter ? { columnBreakAfter: true } : {}),
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
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex] as Extract<DocxBlock, { type: 'paragraph' }>;
        const itemImages = addImageBlocks(item.images, {
          ...(itemIds[itemIndex] ? { sourceParagraphBlockId: itemIds[itemIndex] } : {}),
          sourceRefPrefix: `docx:list${listCounter}:item${itemIndex + 1}`,
        });
        pendingCaptionImages.push(...itemImages);
      }
      index = cursor - 1;
      continue;
    }
    const hasText = block.text.trim().length > 0;
    const caption = isCaptionBlock(block);
    if (!caption && !block.images?.length) pendingCaptionImages = [];
    const blockBreakInfo = {
      ...(block.pageBreakBefore ? { before: 'explicit_page_break' as const } : {}),
      ...(block.sectionBreakAfter
        ? { after: 'section_break' as const, setupAfter: block.sectionBreakAfter }
        : block.explicitPageBreakAfter
          ? { after: 'explicit_page_break' as const }
          : block.lastRenderedPageBreakAfter
            ? { after: 'last_rendered_page_break' as const }
            : {}),
    };
    let blockId: string | undefined;
    if (hasText) {
      counter += 1;
      blockId = structureBlockId(1, counter);
      pageBlockIds.push(blockId);
      breaks.set(blockId, blockBreakInfo);
      add(structureBlock({
        blockId,
        type: block.headingLevel ? 'heading' : 'paragraph',
        text: block.text,
        pageNumber: 1,
        order: order++,
        ...(block.headingLevel ? { level: block.headingLevel } : {}),
        ...(block.columnBreakAfter ? { columnBreakAfter: true } : {}),
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
      if (caption && pendingCaptionImages.length) {
        for (const imageBlock of pendingCaptionImages) {
          if (!imageBlock.image) continue;
          imageBlock.image.captionBlockId = blockId;
          imageBlock.image.captionText = block.text.slice(0, 1000);
        }
        pendingCaptionImages = [];
      }
    }
    const imageBlocks = addImageBlocks(block.images, {
      ...(blockId ? { sourceParagraphBlockId: blockId } : {}),
      sourceRefPrefix: `docx:image:${blockId ?? `paragraph${index + 1}`}`,
    });
    pendingCaptionImages.push(...imageBlocks);
    if (!hasText && imageBlocks.length && Object.keys(blockBreakInfo).length) {
      breaks.set(imageBlocks[0]!.blockId, blockBreakInfo);
    }
  }
  addTextGroup(footerParts, 'footer');
  const imageWarningCodes = new Set(
    blocks
      .filter((block) => block.type === 'image')
      .flatMap((block) => block.image?.warnings ?? [])
      .map((item) => item.code),
  );
  if (imageWarningCodes.size > 0) {
    warnings.push(warning(
      'DOCX_IMAGES_WITH_WARNINGS',
      `Some embedded images were preserved with warnings (${[...imageWarningCodes].slice(0, 6).join(', ')}).`,
    ));
  }
  if (mergedCells > 0) {
    warnings.push(warning(
      'DOCX_MERGED_CELLS_RECONSTRUCTED',
      'Merged table cells were reconstructed from WordprocessingML span and vertical-merge properties.',
    ));
  }
  const docxLayout = buildDocxLayout(
    docxSections,
    docxRelationships,
    evenAndOddHeaders,
    blockIdsByPart,
    embeddedFonts,
    themeFonts,
  );
  const inheritedSectionsByPart = new Map<string, number[]>();
  for (const section of docxLayout.sections) {
    for (const reference of [...section.headers, ...section.footers]) {
      if (!reference.partName || !reference.inherited) continue;
      const inherited = inheritedSectionsByPart.get(reference.partName) ?? [];
      if (!inherited.includes(section.sectionIndex)) inherited.push(section.sectionIndex);
      inheritedSectionsByPart.set(reference.partName, inherited);
    }
  }
  for (const block of blocks) {
    if (!block.image?.headerFooter) continue;
    const inherited = inheritedSectionsByPart.get(block.image.headerFooter.partName);
    if (inherited?.length) block.image.headerFooter.inheritedSectionIndexes = inherited;
  }
  const hasReferencedFurniture = docxLayout.sections.some((section) => (
    section.headers.some((reference) => reference.partName) || section.footers.some((reference) => reference.partName)
  ));
  const hasFurniture = headerParts.length > 0 || footerParts.length > 0;
  if (hasFurniture) {
    warnings.push(hasReferencedFurniture
      ? warning(
        'DOCX_HEADERS_FOOTERS_SECTION_AWARE',
        'DOCX headers and footers were preserved once per source part; section-specific placement, variant, inheritance, page size, orientation, margins, and page numbering are recorded in the DOCX section metadata.',
      )
      : warning(
        'DOCX_HEADERS_FOOTERS_APPROXIMATE',
        'DOCX headers and footers were preserved as logical-page blocks, but the document does not reference them from a section; placement is approximate.',
      ));
  }
  for (const section of docxLayout.sections) {
    for (const reference of [...section.headers, ...section.footers]) {
      if (!reference.partName) {
        warnings.push(warning(
          'DOCX_HEADER_FOOTER_REFERENCE_UNRESOLVED',
          `A section ${reference.kind} reference could not be resolved to a packaged DOCX part; its text is omitted.`,
        ));
      }
    }
  }
  const bodyPageBlockIds = pageBlockIds.filter((blockId) => !furnitureIds.has(blockId));
  const pagination = buildDocxPagination(bodyPageBlockIds, breaks, pageSetup, warnings);
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
    pagination,
    docxLayout,
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
  let imageCount = 0;
  let totalImageBytes = 0;
  let imageLimitHit = false;
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
        if (/^word\/media\//.test(file.name)) {
          if (imageCount >= MAX_DOCX_IMAGES || file.originalSize > MAX_DOCX_IMAGE_BYTES
            || totalImageBytes + file.originalSize > MAX_DOCX_TOTAL_IMAGE_BYTES) {
            imageLimitHit = true;
            return false;
          }
          imageCount += 1;
          totalImageBytes += file.originalSize;
          return true;
        }
        if (![
          'word/document.xml',
          'word/styles.xml',
          'word/numbering.xml',
          'word/settings.xml',
          'word/fontTable.xml',
          'word/theme/theme1.xml',
          'word/_rels/document.xml.rels',
          'word/_rels/fontTable.xml.rels',
          'docProps/core.xml',
        ].includes(file.name)
          && !/^word\/(?:header|footer)\d+\.xml$/.test(file.name)
          && !/^word\/theme\/[A-Za-z0-9_.-]+\.xml$/.test(file.name)) return false;
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
  if (imageLimitHit) {
    warnings.push(warning(
      'DOCX_IMAGE_LIMIT_REACHED',
      'Some embedded images exceeded the local image count, size, or total-byte limit and were not inspected.',
    ));
  }
  if (documentSkippedForSize || !archive['word/document.xml']) {
    throw new FormFlowError('CORRUPTED_DOCUMENT', 'This DOCX does not contain a readable word/document.xml.');
  }

  const documentXml = strFromU8(archive['word/document.xml']);
  const stylesXml = archive['word/styles.xml'] ? strFromU8(archive['word/styles.xml']) : undefined;
  const numberingXml = archive['word/numbering.xml'] ? strFromU8(archive['word/numbering.xml']) : undefined;
  const coreXml = archive['docProps/core.xml'] ? strFromU8(archive['docProps/core.xml']) : undefined;
  const settingsXml = archive['word/settings.xml'] ? strFromU8(archive['word/settings.xml']) : undefined;
  const relationshipsXml = archive['word/_rels/document.xml.rels']
    ? strFromU8(archive['word/_rels/document.xml.rels'])
    : undefined;
  const styles = parseStyles(stylesXml);
  const numbering = parseNumbering(numberingXml);
  const docxRelationships = parseDocumentRelationships(relationshipsXml);
  const mediaParts = new Map<string, DocxMediaPart>();
  for (const [partName, bytes] of Object.entries(archive)) {
    if (/^word\/media\//.test(partName)) mediaParts.set(partName, { partName, bytes });
  }
  const fontTableXml = archive['word/fontTable.xml'] ? strFromU8(archive['word/fontTable.xml']) : undefined;
  const themePart = [...docxRelationships.values()].find((relationship) => relationship.kind === 'theme' && relationship.partName)?.partName
    ?? 'word/theme/theme1.xml';
  const themeXml = archive[themePart] ? strFromU8(archive[themePart]) : undefined;
  const fontTableRelationshipsXml = archive['word/_rels/fontTable.xml.rels']
    ? strFromU8(archive['word/_rels/fontTable.xml.rels'])
    : undefined;
  const fontTableRelationships = parseDocumentRelationships(fontTableRelationshipsXml);
  const embeddedFonts = parseEmbeddedFonts(fontTableXml, fontTableRelationships);
  const themeFonts = parseThemeFonts(themeXml);
  const evenAndOddHeaders = parseEvenAndOddHeaders(settingsXml);
  let docxSections = parseDocxSections(documentXml);
  if (docxSections.length > MAX_STRUCTURE_SECTIONS) {
    docxSections = docxSections.slice(0, MAX_STRUCTURE_SECTIONS);
    warnings.push(warning(
      'DOCX_SECTION_METADATA_TRUNCATED',
      'DOCX section metadata was bounded to the local structure limit.',
    ));
  }
  const headerEntries = Object.entries(archive)
    .filter(([name]) => /^word\/header\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  const footerEntries = Object.entries(archive)
    .filter(([name]) => /^word\/footer\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  throwIfAborted(input.signal);

  let mammothText = '';
  let mammothMessages = 0;
  let mammothError: unknown;
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
    mammothError = error;
  }
  throwIfAborted(input.signal);

  let structureParsed = true;
  let structure: StructureResult;
  try {
    structure = parseDocumentXml(documentXml, styles, numbering, docxRelationships, mediaParts, 'word/document.xml');
  } catch {
    structureParsed = false;
    structure = {
      text: '',
      headings: [],
      tableCount: 0,
      rowCount: 0,
      nestedTables: 0,
      unresolvedHeadingStyles: false,
      blocks: [],
      pageSetup: DEFAULT_PAGE_SETUP,
    };
  }
  if (mammothError !== undefined) {
    if (!structureParsed) {
      throw new FormFlowError('CORRUPTED_DOCUMENT', 'Mammoth could not read this DOCX container.', { cause: mammothError });
    }
    warnings.push(warning(
      'DOCX_MAMMOTH_UNAVAILABLE',
      'The compatibility converter could not read this DOCX container; the structural WordprocessingML parser continued locally.',
    ));
  } else if (!structureParsed) {
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

  const parseAuxiliary = (entries: Array<[string, Uint8Array]>, label: 'header' | 'footer'): DocxAuxiliaryPart[] => {
    const result: DocxAuxiliaryPart[] = [];
    for (const [name, bytes] of entries) {
      try {
        const relationshipPart = `word/_rels/${name.replace(/^word\//, '')}.rels`;
        const relationshipXml = archive[relationshipPart] ? strFromU8(archive[relationshipPart]!) : undefined;
        const relationships = parseDocumentRelationships(relationshipXml);
        result.push({
          partName: name,
          blocks: parseDocumentXml(strFromU8(bytes), styles, numbering, relationships, mediaParts, name).blocks,
        });
      } catch {
        warnings.push(warning(
          'DOCX_HEADER_FOOTER_UNREADABLE',
          `A DOCX ${label} part could not be read; its text was omitted.`,
        ));
      }
    }
    return result;
  };
  const headerParts = parseAuxiliary(headerEntries, 'header');
  const footerParts = parseAuxiliary(footerEntries, 'footer');
  const hasImageStructure = structure.blocks.some(docxBlockHasImages)
    || [...headerParts, ...footerParts].some((part) => part.blocks.some(docxBlockHasImages));
  if (!text && !hasImageStructure) {
    throw new FormFlowError('EMPTY_DOCUMENT', 'This DOCX contains no extractable text or image structure.');
  }
  const bodyBlocks = text === structure.text && structure.blocks.length
    ? structure.blocks
    : fallbackParagraphs(text);
  const documentStructure = buildDocxDocumentStructure(
    bodyBlocks,
    headerParts,
    footerParts,
    docxSections,
    docxRelationships,
    evenAndOddHeaders,
    embeddedFonts,
    themeFonts,
    warnings,
    structure.pageSetup,
  );

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
