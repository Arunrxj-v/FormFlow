import { readFileSync } from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  fontSize?: number;
  bold?: boolean;
}

interface PdfPage {
  text?: string;
  image?: boolean;
  textItems?: PdfTextItem[];
  rotate?: 0 | 90 | 180 | 270;
}

export interface PdfFixtureOptions {
  pages: PdfPage[];
  password?: boolean;
  metadata?: { title?: string; author?: string; subject?: string };
}

export function buildPdf(options: PdfFixtureOptions): Uint8Array {
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldFontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageIds: number[] = [];
  for (const page of options.pages) {
    let xObject = '';
    if (page.image) {
      const imageId = add(
        '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\u0000\nendstream',
      );
      xObject = `/XObject << /Im1 ${imageId} 0 R >>`;
    }
    const items = page.textItems?.length
      ? page.textItems.map((item) => {
        const font = item.bold ? 'F2' : 'F1';
        const size = item.fontSize ?? 12;
        return `BT /${font} ${size} Tf ${item.x} ${item.y} Td (${escapePdfText(item.text)}) Tj ET`;
      }).join('\n')
      : '';
    const content = items || (page.text
      ? `BT /F1 18 Tf 72 720 Td (${escapePdfText(page.text)}) Tj ET`
      : page.image
        ? 'q 100 0 0 100 72 600 cm /Im1 Do Q'
        : '');
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'binary')} >>\nstream\n${content}\nendstream`);
    const rotation = page.rotate ? ` /Rotate ${page.rotate}` : '';
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792]${rotation} /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R >> ${xObject} >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  let encryptId: number | null = null;
  if (options.password) {
    encryptId = add(
      '<< /Filter /Standard /V 1 /R 2 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>',
    );
  }
  let infoId: number | null = null;
  if (options.metadata) {
    const entries = [
      options.metadata.title ? `/Title (${escapePdfText(options.metadata.title)})` : '',
      options.metadata.author ? `/Author (${escapePdfText(options.metadata.author)})` : '',
      options.metadata.subject ? `/Subject (${escapePdfText(options.metadata.subject)})` : '',
    ].filter(Boolean);
    infoId = add(`<< ${entries.join(' ')} >>`);
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R`;
  if (infoId) pdf += ` /Info ${infoId} 0 R`;
  if (encryptId) {
    pdf += ` /Encrypt ${encryptId} 0 R /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]`;
  }
  pdf += ` >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'binary'));
}

export interface DocxFixtureParagraph {
  text: string;
  heading?: number;
  lineBreak?: boolean;
  list?: { level?: number; numId?: number; ordered?: boolean };
  hyperlink?: boolean;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  pageBreakBefore?: boolean;
  explicitPageBreak?: boolean;
  lastRenderedPageBreak?: boolean;
  sectionBreak?: { widthTwips?: number; heightTwips?: number; orientation?: 'portrait' | 'landscape' };
}

export interface DocxFixtureCell {
  text: string;
  colSpan?: number;
  vMerge?: 'restart' | 'continue';
}

export type DocxFixtureTable = Array<Array<string | DocxFixtureCell>>;

export interface DocxFixtureOptions {
  paragraphs?: DocxFixtureParagraph[];
  tables?: DocxFixtureTable[];
  includeStyles?: boolean;
  includeNumbering?: boolean;
  headers?: string[];
  footers?: string[];
  pageSize?: { widthTwips?: number; heightTwips?: number; orientation?: 'portrait' | 'landscape' };
  margins?: { top?: number; right?: number; bottom?: number; left?: number; header?: number; footer?: number };
  core?: { title?: string; author?: string };
  empty?: boolean;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function paragraphXml(paragraph: DocxFixtureParagraph): string {
  const properties: string[] = [];
  if (paragraph.heading) properties.push(`<w:pStyle w:val="Heading${paragraph.heading}"/>`);
  if (paragraph.alignment) properties.push(`<w:jc w:val="${paragraph.alignment}"/>`);
  if (paragraph.pageBreakBefore) properties.push('<w:pageBreakBefore/>');
  if (paragraph.list) {
    properties.push(
      `<w:numPr><w:ilvl w:val="${paragraph.list.level ?? 0}"/><w:numId w:val="${paragraph.list.numId ?? 1}"/></w:numPr>`,
    );
  }
  const style = properties.length ? `<w:pPr>${properties.join('')}</w:pPr>` : '';
  const runs = paragraph.text.split('\n').map((part, index) => (
    `${index > 0 || paragraph.lineBreak ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeXml(part)}</w:t>`
  )).join('');
  const pageBreak = paragraph.explicitPageBreak ? '<w:br w:type="page"/>' : '';
  const renderedBreak = paragraph.lastRenderedPageBreak ? '<w:lastRenderedPageBreak/>' : '';
  const sectionBreak = paragraph.sectionBreak
    ? `<w:sectPr><w:pgSz w:w="${paragraph.sectionBreak.widthTwips ?? 12240}" w:h="${paragraph.sectionBreak.heightTwips ?? 15840}"${paragraph.sectionBreak.orientation ? ` w:orient="${paragraph.sectionBreak.orientation}"` : ''}/></w:sectPr>`
    : '';
  const runWrapper = paragraph.hyperlink
    ? `<w:hyperlink r:id="rIdLink"><w:r>${runs}${pageBreak}${renderedBreak}</w:r></w:hyperlink>`
    : `<w:r>${runs}${pageBreak}${renderedBreak}</w:r>`;
  return `<w:p>${style ? style.replace('</w:pPr>', `${sectionBreak}</w:pPr>`) : sectionBreak ? `<w:pPr>${sectionBreak}</w:pPr>` : ''}${runWrapper}</w:p>`;
}

function tableXml(rows: DocxFixtureTable): string {
  const trs = rows.map((row) => (
    `<w:tr>${row.map((cell) => {
      const value = typeof cell === 'string' ? { text: cell } : cell;
      const properties: string[] = [];
      if (value.colSpan && value.colSpan > 1) properties.push(`<w:gridSpan w:val="${value.colSpan}"/>`);
      if (value.vMerge) properties.push(`<w:vMerge w:val="${value.vMerge}"/>`);
      const cellProperties = properties.length ? `<w:tcPr>${properties.join('')}</w:tcPr>` : '';
      return `<w:tc>${cellProperties}<w:p><w:r><w:t xml:space="preserve">${escapeXml(value.text)}</w:t></w:r></w:p></w:tc>`;
    }).join('')}</w:tr>`
  )).join('');
  return `<w:tbl>${trs}</w:tbl>`;
}

export function buildDocx(options: DocxFixtureOptions = {}): Uint8Array {
  const bodyParts: string[] = [];
  for (const paragraph of options.paragraphs ?? []) bodyParts.push(paragraphXml(paragraph));
  for (const table of options.tables ?? []) bodyParts.push(tableXml(table));
  if (!options.empty && bodyParts.length === 0) {
    bodyParts.push(paragraphXml({ text: 'Default fixture paragraph' }));
  }
  const pageSize = options.pageSize ?? {};
  const margins = options.margins ?? {};
  const sectPr = `<w:sectPr><w:pgSz w:w="${pageSize.widthTwips ?? 12240}" w:h="${pageSize.heightTwips ?? 15840}"${pageSize.orientation ? ` w:orient="${pageSize.orientation}"` : ''}/><w:pgMar w:top="${margins.top ?? 1440}" w:right="${margins.right ?? 1440}" w:bottom="${margins.bottom ?? 1440}" w:left="${margins.left ?? 1440}" w:header="${margins.header ?? 720}" w:footer="${margins.footer ?? 720}"/></w:sectPr>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${bodyParts.join('')}${sectPr}</w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`;
  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:title>${escapeXml(options.core?.title ?? 'Fixture document')}</dc:title>
  <dc:creator>${escapeXml(options.core?.author ?? 'Fixture Author')}</dc:creator>
  <dcterms:created>2026-01-02T03:04:05Z</dcterms:created>
</cp:coreProperties>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'word/document.xml': strToU8(documentXml),
    'docProps/core.xml': strToU8(coreXml),
  };
  if (options.includeStyles !== false) files['word/styles.xml'] = strToU8(stylesXml);
  if (options.includeNumbering !== false) files['word/numbering.xml'] = strToU8(numberingXml);
  const headerParagraphs = (options.headers ?? []).map((text) => paragraphXml({ text })).join('');
  if (headerParagraphs) {
    files['word/header1.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${headerParagraphs}</w:hdr>`);
  }
  const footerParagraphs = (options.footers ?? []).map((text) => paragraphXml({ text })).join('');
  if (footerParagraphs) {
    files['word/footer1.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${footerParagraphs}</w:ftr>`);
  }
  return zipSync(files);
}

export interface DocxHeaderFooterSet {
  default?: string[];
  first?: string[];
  even?: string[];
}

export interface DocxSectionFixture {
  paragraphs: DocxFixtureParagraph[];
  pageSize?: DocxFixtureOptions['pageSize'];
  margins?: DocxFixtureOptions['margins'];
  breakType?: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage';
  titlePage?: boolean;
  pageNumberStart?: number;
  pageNumberFormat?: string;
  columns?: number;
  headers?: DocxHeaderFooterSet;
  footers?: DocxHeaderFooterSet;
}

export interface DocxSectionedFixtureOptions {
  sections: DocxSectionFixture[];
  evenAndOddHeaders?: boolean;
  includeStyles?: boolean;
  includeNumbering?: boolean;
  core?: DocxFixtureOptions['core'];
}

/**
 * Builds real WordprocessingML sections with header/footer references,
 * relationship targets, first/even variants, page numbering, and inherited
 * section furniture. Used to validate section metadata against actual OOXML.
 */
export function buildDocxWithSections(options: DocxSectionedFixtureOptions): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const relationships: string[] = [];
  let headerCounter = 0;
  let footerCounter = 0;
  let relationshipCounter = 0;
  const contentOverrides: string[] = [];
  const bodyParts: string[] = [];

  const auxXml = (kind: 'header' | 'footer', texts: string[]): string => {
    const tag = kind === 'header' ? 'hdr' : 'ftr';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:${tag} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${texts.map((text) => paragraphXml({ text })).join('')}</w:${tag}>`;
  };

  for (let sectionIndex = 0; sectionIndex < options.sections.length; sectionIndex += 1) {
    const section = options.sections[sectionIndex]!;
    const references: string[] = [];
    const registerFurniture = (kind: 'header' | 'footer', variants: DocxHeaderFooterSet | undefined) => {
      if (!variants) return;
      for (const variant of ['default', 'first', 'even'] as const) {
        const texts = variants[variant];
        if (!texts?.length) continue;
        headerCounter += kind === 'header' ? 1 : 0;
        footerCounter += kind === 'footer' ? 1 : 0;
        const suffix = kind === 'header' ? headerCounter : footerCounter;
        const partName = `${kind}${suffix}.xml`;
        const relationshipId = `rIdSection${relationshipCounter += 1}`;
        files[`word/${partName}`] = strToU8(auxXml(kind, texts));
        relationships.push(`<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${partName}"/>`);
        contentOverrides.push(`<Override PartName="/word/${partName}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`);
        references.push(`<w:${kind}Reference w:type="${variant}" r:id="${relationshipId}"/>`);
      }
    };
    registerFurniture('header', section.headers);
    registerFurniture('footer', section.footers);

    const pageSize = section.pageSize ?? {};
    const margins = section.margins ?? {};
    const sectionProperties = [
      `<w:type w:val="${section.breakType ?? 'nextPage'}"/>`,
      `<w:pgSz w:w="${pageSize.widthTwips ?? 12240}" w:h="${pageSize.heightTwips ?? 15840}"${pageSize.orientation ? ` w:orient="${pageSize.orientation}"` : ''}/>`,
      `<w:pgMar w:top="${margins.top ?? 1440}" w:right="${margins.right ?? 1440}" w:bottom="${margins.bottom ?? 1440}" w:left="${margins.left ?? 1440}" w:header="${margins.header ?? 720}" w:footer="${margins.footer ?? 720}"/>`,
      section.titlePage ? '<w:titlePg/>' : '',
      section.pageNumberStart !== undefined || section.pageNumberFormat
        ? `<w:pgNumType${section.pageNumberStart !== undefined ? ` w:start="${section.pageNumberStart}"` : ''}${section.pageNumberFormat ? ` w:fmt="${section.pageNumberFormat}"` : ''}/>`
        : '',
      section.columns && section.columns > 1 ? `<w:cols w:num="${section.columns}"/>` : '',
      ...references,
    ].filter(Boolean).join('');
    const paragraphs = section.paragraphs.map((paragraph) => paragraphXml(paragraph));
    if (sectionIndex === options.sections.length - 1) {
      bodyParts.push(...paragraphs, `<w:sectPr>${sectionProperties}</w:sectPr>`);
    } else {
      if (paragraphs.length === 0) paragraphs.push('<w:p></w:p>');
      const last = paragraphs.pop()!;
      const wrappedSectionProperties = `<w:sectPr>${sectionProperties}</w:sectPr>`;
      paragraphs.push(last.includes('<w:pPr>')
        ? last.replace('</w:pPr>', `${wrappedSectionProperties}</w:pPr>`)
        : last.replace('<w:p>', `<w:p><w:pPr>${wrappedSectionProperties}</w:pPr>`));
      bodyParts.push(...paragraphs);
    }
  }

  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:title>${escapeXml(options.core?.title ?? 'Sectioned fixture document')}</dc:title>
  <dc:creator>${escapeXml(options.core?.author ?? 'Fixture Author')}</dc:creator>
  <dcterms:created>2026-01-02T03:04:05Z</dcterms:created>
</cp:coreProperties>`;
  files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  ${contentOverrides.join('\n  ')}
</Types>`);
  files['_rels/.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`);
  files['word/_rels/document.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  ${relationships.join('\n  ')}
</Relationships>`);
  files['word/document.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${bodyParts.join('')}</w:body></w:document>`);
  files['word/settings.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${options.evenAndOddHeaders ? '<w:evenAndOddHeaders/>' : ''}</w:settings>`);
  files['docProps/core.xml'] = strToU8(coreXml);
  if (options.includeStyles !== false) {
    files['word/styles.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`);
  }
  if (options.includeNumbering !== false) {
    files['word/numbering.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`);
  }
  return zipSync(files);
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);

export interface DocxImageFixtureOptions {
  alt?: string;
  title?: string;
  anchored?: boolean;
  wrap?: 'square' | 'tight' | 'through' | 'topAndBottom' | 'none';
  external?: boolean;
  missingRelationship?: boolean;
  missingMedia?: boolean;
  invalidSignature?: boolean;
  oversizedDimensions?: boolean;
  caption?: string;
  images?: number;
}

export function buildDocxWithImage(options: DocxImageFixtureOptions = {}): Uint8Array {
  const imageCount = Math.max(1, options.images ?? 1);
  const files: Record<string, Uint8Array> = {};
  const relationships: string[] = [];
  const body: string[] = [];
  for (let index = 1; index <= imageCount; index += 1) {
    const relationshipId = `rIdImg${index}`;
    if (!options.missingRelationship) {
      relationships.push(options.external
        ? `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/image${index}.png" TargetMode="External"/>`
        : `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${index}.png"/>`);
    }
    if (!options.external && !options.missingMedia) {
      if (options.oversizedDimensions) {
        const oversized = new Uint8Array(24);
        oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0x4e, 0x20, 0, 0, 0x4e, 0x20]);
        files[`word/media/image${index}.png`] = oversized;
      } else {
        files[`word/media/image${index}.png`] = options.invalidSignature
          ? strToU8('not a real image')
          : PNG_1X1;
      }
    }
    const wrapTag = options.wrap === 'none'
      ? '<wp:wrapNone/>'
      : options.wrap
        ? `<wp:wrap${options.wrap[0]!.toUpperCase() + options.wrap.slice(1)}${['square', 'tight', 'through'].includes(options.wrap) ? ' wrapText="bothSides"' : ''}/>`
        : '';
    const drawing = options.anchored
      ? `<w:drawing><wp:anchor behindDoc="0" layoutInCell="1" allowOverlap="1" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="1828800" cy="1371600"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${index}" name="image${index}" title="${escapeXml(options.title ?? '')}" descr="${escapeXml(options.alt ?? '')}"/>${wrapTag}<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${index}" name="image${index}.png" descr="${escapeXml(options.alt ?? '')}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing>`
      : `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="1828800" cy="1371600"/><wp:docPr id="${index}" name="image${index}" title="${escapeXml(options.title ?? '')}" descr="${escapeXml(options.alt ?? '')}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${index}" name="image${index}.png" descr="${escapeXml(options.alt ?? '')}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
    body.push(`<w:p><w:r>${drawing}</w:r></w:p>`);
    if (options.caption) {
      body.push(`<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>${escapeXml(options.caption)}</w:t></w:r></w:p>`);
    }
  }
  files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  files['_rels/.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  files['word/_rels/document.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${relationships.join('')}</Relationships>`);
  files['word/styles.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/></w:style></w:styles>');
  files['word/document.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return zipSync(files);
}

export interface DocxTableImageFixtureOptions {
  alt?: string;
  title?: string;
  caption?: string;
  imagesPerCell?: number;
  nested?: boolean;
  missingRelationship?: boolean;
  external?: boolean;
  invalidSignature?: boolean;
}

function inlineImageXml(relationshipId: string, index: number, alt = '', title = ''): string {
  return `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="1828800" cy="1371600"/><wp:docPr id="${index}" name="image${index}" title="${escapeXml(title)}" descr="${escapeXml(alt)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${index}" name="image${index}.png" descr="${escapeXml(alt)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

export function buildDocxWithTableImage(options: DocxTableImageFixtureOptions = {}): Uint8Array {
  const imagesPerCell = Math.max(1, options.imagesPerCell ?? 1);
  const files: Record<string, Uint8Array> = {};
  const relationships: string[] = [];
  let imageCounter = 0;
  const imageParagraph = (cellIndex: number): string => {
    const paragraphs: string[] = [];
    for (let index = 0; index < imagesPerCell; index += 1) {
      imageCounter += 1;
      const relationshipId = `rIdCellImg${imageCounter}`;
      if (!options.missingRelationship) {
        relationships.push(options.external
          ? `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/cell-${imageCounter}.png" TargetMode="External"/>`
          : `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/cell-${imageCounter}.png"/>`);
      }
      if (!options.external && !options.missingRelationship) {
        files[`word/media/cell-${imageCounter}.png`] = options.invalidSignature ? strToU8('not an image') : PNG_1X1;
      }
      paragraphs.push(`<w:p><w:r>${inlineImageXml(relationshipId, imageCounter, options.alt ?? `Cell ${cellIndex} image`, options.title ?? '')}</w:r></w:p>`);
    }
    if (options.caption) {
      paragraphs.push(`<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>${escapeXml(options.caption)}</w:t></w:r></w:p>`);
    }
    return paragraphs.join('');
  };
  const nested = options.nested
    ? `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc>${imageParagraph(3)}</w:tc><w:tc><w:p><w:r><w:t>Nested text</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/>`
    : '';
  const table = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4320"/><w:gridCol w:w="4320"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:gridSpan w:val="1"/></w:tcPr><w:p><w:r><w:t>Cell one</w:t></w:r></w:p>${imageParagraph(1)}${nested}</w:tc><w:tc><w:p><w:r><w:t>Cell two</w:t></w:r></w:p>${imageParagraph(2)}</w:tc></w:tr></w:tbl>`;
  files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  files['_rels/.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  files['word/_rels/document.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${relationships.join('')}</Relationships>`);
  files['word/styles.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/></w:style></w:styles>');
  files['word/document.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Table image introduction</w:t></w:r></w:p>${table}<w:p><w:r><w:t>Table image conclusion</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return zipSync(files);
}

export interface DocxHeaderFooterImageFixtureOptions {
  header?: boolean;
  footer?: boolean;
  variant?: 'default' | 'first' | 'even';
  images?: number;
  inheritedSections?: boolean;
  secondSectionHeader?: boolean;
  alt?: string;
  caption?: string;
  bodyParagraphs?: number;
  missingRelationship?: boolean;
  external?: boolean;
  invalidSignature?: boolean;
}

export function buildDocxWithHeaderFooterImage(options: DocxHeaderFooterImageFixtureOptions = {}): Uint8Array {
  const header = options.header !== false;
  const footer = options.footer === true;
  const variant = options.variant ?? 'default';
  const images = Math.max(1, options.images ?? 1);
  const files: Record<string, Uint8Array> = {};
  const relationships: string[] = [];
  const contentOverrides: string[] = [];
  let imageCounter = 0;
  const createPart = (kind: 'header' | 'footer', partIndex: number): { partName: string; relationshipId: string; xml: string } => {
    const paragraphImages: string[] = [];
    for (let index = 0; index < images; index += 1) {
      imageCounter += 1;
      const relationshipId = `rIdFurnitureImg${imageCounter}`;
      if (!options.missingRelationship) {
        relationships.push(options.external
          ? `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/${kind}-${imageCounter}.png" TargetMode="External"/>`
          : `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${kind}-${imageCounter}.png"/>`);
      }
      if (!options.external && !options.missingRelationship) {
        files[`word/media/${kind}-${imageCounter}.png`] = options.invalidSignature ? strToU8('not an image') : PNG_1X1;
      }
      paragraphImages.push(`<w:p><w:r>${inlineImageXml(relationshipId, imageCounter, options.alt ?? `${kind} logo`, '')}</w:r></w:p>`);
    }
    if (options.caption) {
      paragraphImages.push(`<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>${escapeXml(options.caption)}</w:t></w:r></w:p>`);
    }
    const partName = `${kind}${partIndex}.xml`;
    const relationshipId = `rId${kind}${partIndex}`;
    files[`word/${partName}`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${kind === 'header' ? 'hdr' : 'ftr'} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p><w:r><w:t>${kind} text</w:t></w:r></w:p>${paragraphImages.join('')}</w:${kind === 'header' ? 'hdr' : 'ftr'}>`);
    files[`word/_rels/${partName}.rels`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.filter((entry) => entry.includes(`rIdFurnitureImg`) && entry.includes(kind)).join('')}</Relationships>`);
    contentOverrides.push(`<Override PartName="/word/${partName}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`);
    return { partName, relationshipId, xml: '' };
  };
  const sections: string[] = [];
  const firstHeader = header ? createPart('header', 1) : undefined;
  const firstFooter = footer ? createPart('footer', 1) : undefined;
  const secondHeader = options.secondSectionHeader ? createPart('header', 2) : undefined;
  const headerReference = (part: { relationshipId: string } | undefined): string => (
    part ? `<w:headerReference w:type="${variant}" r:id="${part.relationshipId}"/>` : ''
  );
  const footerReference = (part: { relationshipId: string } | undefined): string => (
    part ? `<w:footerReference w:type="${variant}" r:id="${part.relationshipId}"/>` : ''
  );
  const bodyParagraphs = Array.from({ length: Math.max(1, options.bodyParagraphs ?? 2) }, (_, index) => (
    `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:t>Header/footer fixture body paragraph ${index + 1} with deterministic text.</w:t></w:r></w:p>`
  )).join('');
  sections.push(`${bodyParagraphs}<w:sectPr>${variant === 'first' ? '<w:titlePg/>' : ''}${headerReference(firstHeader)}${footerReference(firstFooter)}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`);
  sections.push(`<w:p><w:r><w:t>${options.inheritedSections ? 'Inherited section body' : 'Second section body'}</w:t></w:r></w:p><w:sectPr>${options.secondSectionHeader && secondHeader ? headerReference(secondHeader) : ''}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`);
  files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${contentOverrides.join('')}</Types>`);
  files['_rels/.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const documentRelationships = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    firstHeader ? `<Relationship Id="${firstHeader.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="${firstHeader.partName}"/>` : '',
    firstFooter ? `<Relationship Id="${firstFooter.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="${firstFooter.partName}"/>` : '',
    secondHeader ? `<Relationship Id="${secondHeader.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="${secondHeader.partName}"/>` : '',
  ].filter(Boolean).join('');
  files['word/_rels/document.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${documentRelationships}</Relationships>`);
  files['word/styles.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/></w:style></w:styles>');
  files['word/document.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${sections.join('')}</w:body></w:document>`);
  return zipSync(files);
}

export interface DocxFontFixtureOptions {
  family?: string;
  embedded?: boolean;
  missingFontPart?: boolean;
  corruptFont?: boolean;
  themeMajor?: string;
  themeMinor?: string;
  useTheme?: boolean;
  paragraphCount?: number;
}

function obfuscateEmbeddedFont(bytes: Uint8Array, key: string): Uint8Array {
  const hex = key.replace(/[{}-]/g, '');
  const keyBytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    keyBytes[index] = Number.parseInt(hex.slice((15 - index) * 2, (15 - index) * 2 + 2), 16);
  }
  const output = new Uint8Array(bytes);
  for (let index = 0; index < Math.min(32, output.length); index += 1) {
    output[index] ^= keyBytes[index % 16]!;
  }
  return output;
}

export function buildDocxWithEmbeddedFont(options: DocxFontFixtureOptions = {}): Uint8Array {
  const family = options.family ?? 'FormFlow Embedded Test';
  const themeMajor = options.themeMajor ?? 'Calibri Light';
  const themeMinor = options.themeMinor ?? family;
  const key = '{00112233-4455-6677-8899-AABBCCDDEEFF}';
  const fontPath = path.join(process.cwd(), 'node_modules', '@docx-editor.dev', 'fonts', 'assets', 'Carlito-Regular.ttf');
  const fontBytes = options.embedded === false
    ? new Uint8Array(0)
    : options.corruptFont
      ? strToU8('corrupted embedded font content')
      : obfuscateEmbeddedFont(new Uint8Array(readFileSync(fontPath)), key);
  const fontRuns = options.useTheme
    ? '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>'
    : `<w:rFonts w:ascii="${escapeXml(family)}" w:hAnsi="${escapeXml(family)}"/>`;
  const paragraphs = Array.from({ length: options.paragraphCount ?? 12 }, (_, index) => (
    `<w:p><w:r><w:rPr>${fontRuns}<w:sz w:val="24"/></w:rPr><w:t>Font fixture paragraph ${index + 1} with deterministic text.</w:t></w:r></w:p>`
  )).join('');
  const files: Record<string, Uint8Array> = {};
  files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/><Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`);
  files['_rels/.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  files['word/_rels/document.xml.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFontTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/><Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>');
  files['word/fontTable.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:font w:name="${escapeXml(family)}">${options.embedded === false ? '' : `<w:embedRegular r:id="rIdFont1" w:fontKey="${key}"/>`}</w:font></w:fonts>`);
  files['word/_rels/fontTable.xml.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFont1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.odttf"/></Relationships>');
  if (!options.missingFontPart && options.embedded !== false) files['word/fonts/font1.odttf'] = fontBytes;
  files['word/theme/theme1.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Fixture"><a:themeElements><a:fontScheme name="Fixture"><a:majorFont><a:latin typeface="${escapeXml(themeMajor)}"/><a:ea typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${escapeXml(themeMinor)}"/><a:ea typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`);
  files['word/document.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return zipSync(files);
}

export function buildTxt(
  text: string,
  options: { bom?: boolean; lineEndings?: 'lf' | 'crlf' | 'cr' } = {},
): Uint8Array {
  const normalized = options.lineEndings === 'crlf'
    ? text.replace(/\n/g, '\r\n')
    : options.lineEndings === 'cr'
      ? text.replace(/\n/g, '\r')
      : text;
  const bytes = strToU8(normalized);
  if (!options.bom) return bytes;
  const output = new Uint8Array(bytes.length + 3);
  output.set([0xef, 0xbb, 0xbf], 0);
  output.set(bytes, 3);
  return output;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export const pdfFixtures = {
  normal: () => buildPdf({
    pages: [{ text: 'Hello FormFlow text extraction fixture.' }],
    metadata: { title: 'Fixture PDF', author: 'Fixture Author', subject: 'Ingestion test' },
  }),
  multiPage: () => buildPdf({
    pages: [
      { text: 'First page admission certificate content.' },
      { text: 'Second page academic transcript content.' },
    ],
  }),
  imageOnly: () => buildPdf({ pages: [{ image: true }, { image: true }] }),
  mixed: () => buildPdf({ pages: [{ text: 'A text page with useful content.' }, { image: true }] }),
  empty: () => buildPdf({ pages: [{ text: '' }] }),
  password: () => buildPdf({ pages: [{ text: 'Protected secret content.' }], password: true }),
  corrupted: () => strToU8('%PDF-1.4\nthis is not a complete PDF\n%%EOF\n'),
};
