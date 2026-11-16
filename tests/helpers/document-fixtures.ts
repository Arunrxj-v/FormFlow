import { strToU8, zipSync } from 'fflate';

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

interface PdfPage {
  text?: string;
  image?: boolean;
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
  const pageIds: number[] = [];
  for (const page of options.pages) {
    let xObject = '';
    if (page.image) {
      const imageId = add(
        '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\u0000\nendstream',
      );
      xObject = `/XObject << /Im1 ${imageId} 0 R >>`;
    }
    const content = page.text
      ? `BT /F1 18 Tf 72 720 Td (${escapePdfText(page.text)}) Tj ET`
      : page.image
        ? 'q 100 0 0 100 72 600 cm /Im1 Do Q'
        : '';
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'binary')} >>\nstream\n${content}\nendstream`);
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> ${xObject} >> /Contents ${contentId} 0 R >>`,
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
}

export interface DocxFixtureOptions {
  paragraphs?: DocxFixtureParagraph[];
  tables?: string[][][];
  includeStyles?: boolean;
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
  const style = paragraph.heading ? `<w:pPr><w:pStyle w:val="Heading${paragraph.heading}"/></w:pPr>` : '';
  const runs = paragraph.text.split('\n').map((part, index) => (
    `${index > 0 || paragraph.lineBreak ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeXml(part)}</w:t>`
  )).join('');
  return `<w:p>${style}<w:r>${runs}</w:r></w:p>`;
}

function tableXml(rows: string[][]): string {
  const trs = rows.map((row) => (
    `<w:tr>${row.map((cell) => `<w:tc><w:p><w:r><w:t xml:space="preserve">${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`
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
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyParts.join('')}<w:sectPr/></w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`;
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
