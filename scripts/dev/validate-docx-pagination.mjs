import { chromium } from 'playwright';
import { strToU8, zipSync } from 'fflate';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const extensionPath = path.join(root, 'extension', 'dist');
const sofficePath = process.env.SOFFICE_PATH
  ?? ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/soffice', '/usr/local/bin/soffice']
    .find((candidate) => existsSync(candidate));
const executablePath = process.env.CHROME_PATH;
const passphrase = 'phase4-reference-corpus-passphrase';
const workDir = await mkdtemp(path.join(tmpdir(), 'ff-docx-corpus-'));
const outputMarkdown = path.join(root, 'docs', 'PHASE_4_1_4_PAGINATION_VALIDATION.md');
const failures = [];

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function runXml(text, options = {}) {
  const font = options.font ?? 'Calibri';
  const size = options.size ?? 11;
  const bold = options.bold ? '<w:b/>' : '';
  const italic = options.italic ? '<w:i/>' : '';
  const parts = String(text).split('\n');
  const runs = parts.map((part, index) => (
    `${index > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeXml(part)}</w:t>`
  )).join('');
  return `<w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>${bold}${italic}<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/></w:rPr>${runs}</w:r>`;
}

function paragraphXml(text, options = {}) {
  const properties = [
    `<w:spacing w:before="${options.before ?? 0}" w:after="${options.after ?? 0}" w:line="${options.line ?? 240}" w:lineRule="auto"/>`,
    options.keepNext ? '<w:keepNext/>' : '',
    options.keepLines ? '<w:keepLines/>' : '',
    options.widowControl === false ? '<w:widowControl w:val="0"/>' : options.widowControl ? '<w:widowControl/>' : '',
    options.pageBreakBefore ? '<w:pageBreakBefore/>' : '',
    options.alignment ? `<w:jc w:val="${options.alignment}"/>` : '',
    options.indent ? `<w:ind w:left="${options.indent}"/>` : '',
    options.numbered ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : '',
  ].filter(Boolean).join('');
  const runProperties = options.italic ? { ...options } : options;
  const runs = options.runs
    ? options.runs.map((run) => runXml(run.text, run)).join('')
    : runXml(text, runProperties);
  const pageBreak = options.pageBreakAfter ? '<w:r><w:br w:type="page"/></w:r>' : '';
  const columnBreak = options.columnBreakAfter ? '<w:r><w:br w:type="column"/></w:r>' : '';
  return `<w:p><w:pPr>${properties}</w:pPr>${runs}${pageBreak}${columnBreak}</w:p>`;
}

function tableRowXml(cells, options = {}) {
  const rowProperties = options.header ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
  return `<w:tr>${rowProperties}${cells.map((cell) => {
    const value = typeof cell === 'string' ? { text: cell } : cell;
    const properties = [
      value.colSpan > 1 ? `<w:gridSpan w:val="${value.colSpan}"/>` : '',
      value.vMerge ? `<w:vMerge w:val="${value.vMerge}"/>` : '',
      '<w:tcMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/></w:tcMar>',
    ].filter(Boolean).join('');
    return `<w:tc><w:tcPr>${properties}</w:tcPr>${paragraphXml(value.text ?? '', { font: 'Calibri', size: 10 })}</w:tc>`;
  }).join('')}</w:tr>`;
}

function tableXml(rows, options = {}) {
  const columns = options.columns ?? 3;
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: columns }, () => '<w:gridCol w:w="3000"/>').join('')}</w:tblGrid>${rows.map((row) => tableRowXml(row, row.options ?? {})).join('')}</w:tbl>`;
}

function sectionPropertiesXml(options = {}) {
  const width = options.width ?? 12240;
  const height = options.height ?? 15840;
  const margins = options.margins ?? {};
  return [
    `<w:type w:val="${options.type ?? 'nextPage'}"/>`,
    `<w:pgSz w:w="${width}" w:h="${height}"${options.orientation ? ` w:orient="${options.orientation}"` : ''}/>`,
    `<w:pgMar w:top="${margins.top ?? 1440}" w:right="${margins.right ?? 1440}" w:bottom="${margins.bottom ?? 1440}" w:left="${margins.left ?? 1440}" w:header="${margins.header ?? 720}" w:footer="${margins.footer ?? 720}" w:gutter="0"/>`,
    options.titlePage ? '<w:titlePg/>' : '',
    options.pageNumberStart !== undefined || options.pageNumberFormat
      ? `<w:pgNumType${options.pageNumberStart !== undefined ? ` w:start="${options.pageNumberStart}"` : ''}${options.pageNumberFormat ? ` w:fmt="${options.pageNumberFormat}"` : ''}/>`
      : '',
    options.columns > 1
      ? options.columnDefinitions?.length
        ? `<w:cols w:num="${options.columns}" w:equalWidth="0" w:space="720">${options.columnDefinitions.map((width) => `<w:col w:w="${width}" w:space="720"/>`).join('')}</w:cols>`
        : `<w:cols w:num="${options.columns}" w:space="720"${options.separator !== false ? ' w:sep="1"' : ''}/>`
      : '',
    ...(options.references ?? []),
  ].filter(Boolean).join('');
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);

function imageXml(relationshipId, id) {
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="120" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="1828800" cy="1371600"/><wp:docPr id="${id}" name="Corpus image ${id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function buildDocx({ sections, evenAndOddHeaders = false, images = 0 }) {
  const files = {};
  const relationships = [];
  const contentOverrides = [];
  const body = [];
  let headerCounter = 0;
  let footerCounter = 0;
  let relationshipCounter = 0;
  const registerFurniture = (kind, variants) => {
    const references = [];
    if (!variants) return references;
    for (const variant of ['default', 'first', 'even']) {
      const value = variants[variant];
      if (!value) continue;
      if (kind === 'header') headerCounter += 1;
      else footerCounter += 1;
      const suffix = kind === 'header' ? headerCounter : footerCounter;
      const partName = `${kind}${suffix}.xml`;
      const relationshipId = `rIdFurniture${relationshipCounter += 1}`;
      const tag = kind === 'header' ? 'hdr' : 'ftr';
      files[`word/${partName}`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${tag} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${value.map((text) => paragraphXml(text, { font: 'Calibri', size: 9 })).join('')}</w:${tag}>`);
      relationships.push(`<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${partName}"/>`);
      contentOverrides.push(`<Override PartName="/word/${partName}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`);
      references.push(`<w:${kind}Reference w:type="${variant}" r:id="${relationshipId}"/>`);
    }
    return references;
  };

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex];
    const references = [
      ...registerFurniture('header', section.headers),
      ...registerFurniture('footer', section.footers),
    ];
    const properties = sectionPropertiesXml({ ...section, references });
    const content = [...(section.content ?? [])];
    if (sectionIndex === sections.length - 1) {
      body.push(...content, `<w:sectPr>${properties}</w:sectPr>`);
    } else {
      if (content.length === 0) content.push('<w:p></w:p>');
      const last = content.pop();
      if (last.trimEnd().endsWith('</w:tbl>')) {
        content.push(last, `<w:p><w:pPr><w:sectPr>${properties}</w:sectPr></w:pPr></w:p>`);
      } else {
        content.push(last.includes('<w:pPr>')
          ? last.replace('</w:pPr>', `<w:sectPr>${properties}</w:sectPr></w:pPr>`)
          : last.replace('<w:p>', `<w:p><w:pPr><w:sectPr>${properties}</w:sectPr></w:pPr>`));
      }
      body.push(...content);
    }
  }

  for (let imageIndex = 1; imageIndex <= images; imageIndex += 1) {
    const relationshipId = `rIdImage${imageIndex}`;
    relationships.push(`<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${imageIndex}.png"/>`);
    files[`word/media/image${imageIndex}.png`] = PNG_1X1;
  }

  files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>${contentOverrides.join('')}</Types>`);
  files['_rels/.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  files['word/_rels/document.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${relationships.join('')}</Relationships>`);
  files['word/document.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join('')}</w:body></w:document>`);
  files['word/styles.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`);
  files['word/settings.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${evenAndOddHeaders ? '<w:evenAndOddHeaders/>' : ''}<w:defaultTabStop w:val="720"/></w:settings>`);
  files['word/numbering.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  return zipSync(files);
}

function paragraphs(count, options = {}) {
  return Array.from({ length: count }, (_, index) => paragraphXml(
    `${options.prefix ?? 'Paragraph'} ${String(index + 1).padStart(3, '0')} — ${options.text ?? 'deterministic text for pagination measurement.'}`,
    options,
  ));
}

function obfuscateEmbeddedFont(bytes, key) {
  const hex = key.replace(/[{}-]/g, '');
  const keyBytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    keyBytes[index] = Number.parseInt(hex.slice((15 - index) * 2, (15 - index) * 2 + 2), 16);
  }
  const output = new Uint8Array(bytes);
  for (let index = 0; index < Math.min(32, output.length); index += 1) {
    output[index] ^= keyBytes[index % 16];
  }
  return output;
}

async function buildEmbeddedFontDocx(embedded = true, corrupt = false) {
  const family = 'FormFlow Embedded Test';
  const key = '{00112233-4455-6677-8899-AABBCCDDEEFF}';
  const font = corrupt
    ? strToU8('corrupted embedded font content')
    : embedded
      ? obfuscateEmbeddedFont(
        new Uint8Array(await readFile(path.join(root, 'node_modules', '@docx-editor.dev', 'fonts', 'assets', 'Carlito-Regular.ttf'))),
        key,
      )
      : new Uint8Array(0);
  const paragraphs = Array.from({ length: 40 }, (_, index) => (
    `<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${family}" w:hAnsi="${family}"/><w:sz w:val="24"/></w:rPr><w:t>Embedded font paragraph ${index + 1} with deterministic text for pagination.</w:t></w:r></w:p>`
  )).join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/><Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFontTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/><Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>'),
    'word/fontTable.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:font w:name="${family}">${embedded ? `<w:embedRegular r:id="rIdFont1" w:fontKey="${key}"/>` : ''}</w:font></w:fonts>`),
    'word/_rels/fontTable.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFont1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.odttf"/></Relationships>'),
    ...(embedded ? { 'word/fonts/font1.odttf': font } : {}),
    'word/theme/theme1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Corpus"><a:themeElements><a:fontScheme name="Corpus"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${family}"/><a:ea typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
  });
}

function inlinePictureXml(relationshipId, index, alt = '') {
  return `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="1828800" cy="1371600"/><wp:docPr id="${index}" name="image${index}" descr="${escapeXml(alt)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${index}" name="image${index}.png" descr="${escapeXml(alt)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

function buildTableImageDocx() {
  const imageParagraph = (relId, index, text) => `<w:p><w:r>${inlinePictureXml(relId, index, text)}</w:r></w:p>`;
  const nested = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc>${imageParagraph('rIdImg3', 3, 'Nested table image')}</w:tc><w:tc><w:p><w:r><w:t>Nested cell text</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/>`;
  const table = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4320"/><w:gridCol w:w="4320"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Table image cell one</w:t></w:r></w:p>${imageParagraph('rIdImg1', 1, 'Cell one image')}<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>Figure 4. Table cell caption</w:t></w:r></w:p>${nested}</w:tc><w:tc><w:p><w:r><w:t>Table image cell two</w:t></w:r></w:p>${imageParagraph('rIdImg2', 2, 'Cell two image')}</w:tc></w:tr></w:tbl>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rIdImg2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/><Relationship Id="rIdImg3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image3.png"/></Relationships>'),
    'word/styles.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/></w:style></w:styles>'),
    'word/media/image1.png': PNG_1X1,
    'word/media/image2.png': PNG_1X1,
    'word/media/image3.png': PNG_1X1,
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphXml('Table image introduction')}${table}${paragraphXml('Table image conclusion')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
  });
}

function buildHeaderFooterImageDocx() {
  const furnitureParagraphs = `<w:p><w:r><w:t>Header text</w:t></w:r></w:p><w:p><w:r>${inlinePictureXml('rIdHeaderImg', 1, 'Header logo')}</w:r></w:p>`;
  const footerParagraphs = `<w:p><w:r><w:t>Footer text</w:t></w:r></w:p><w:p><w:r>${inlinePictureXml('rIdFooterImg', 2, 'Footer logo')}</w:r></w:p>`;
  const body = Array.from({ length: 80 }, (_, index) => paragraphXml(`Header/footer image body paragraph ${index + 1} with deterministic text.`)).join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>'),
    'word/_rels/header1.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHeaderImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/header.png"/></Relationships>'),
    'word/_rels/footer1.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFooterImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/footer.png"/></Relationships>'),
    'word/header1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${furnitureParagraphs}</w:hdr>`),
    'word/footer1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${footerParagraphs}</w:ftr>`),
    'word/media/header.png': PNG_1X1,
    'word/media/footer.png': PNG_1X1,
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
  });
}

function corpus() {
  const fixtures = [];
  fixtures.push({
    name: 'normal-overflow',
    features: ['automatic paragraph overflow', 'Calibri 11', 'Letter 1in margins'],
    bytes: buildDocx({ sections: [{ content: paragraphs(120) }] }),
  });
  fixtures.push({
    name: 'explicit-breaks',
    features: ['explicit page breaks', 'pageBreakBefore'],
    bytes: buildDocx({ sections: [{ content: [
      ...paragraphs(7, { prefix: 'Break A' }),
      paragraphXml('Page break after this A line', { pageBreakAfter: true }),
      ...paragraphs(7, { prefix: 'Break B' }),
      paragraphXml('Page break before this C line', { pageBreakBefore: true }),
      ...paragraphs(7, { prefix: 'Break C' }),
    ] }] }),
  });
  fixtures.push({
    name: 'section-breaks',
    features: ['three next-page sections', 'section page setup'],
    bytes: buildDocx({ sections: [
      { content: paragraphs(10, { prefix: 'Section one' }) },
      { content: paragraphs(10, { prefix: 'Section two' }), margins: { top: 900, bottom: 900 } },
      { content: paragraphs(10, { prefix: 'Section three' }), type: 'nextPage' },
    ] }),
  });
  fixtures.push({
    name: 'portrait-landscape',
    features: ['portrait and landscape sections', 'page orientation transitions'],
    bytes: buildDocx({ sections: [
      { content: paragraphs(12, { prefix: 'Portrait one' }) },
      { content: paragraphs(12, { prefix: 'Landscape two' }), width: 15840, height: 12240, orientation: 'landscape' },
      { content: paragraphs(12, { prefix: 'Portrait three' }), width: 11906, height: 16838 },
    ] }),
  });
  fixtures.push({
    name: 'page-size-margins',
    features: ['Letter and A4 page sizes', 'different margins'],
    bytes: buildDocx({ sections: [
      { content: paragraphs(60, { prefix: 'Large margin A4' }), width: 11906, height: 16838, margins: { top: 2880, right: 2880, bottom: 2880, left: 2880 } },
      { content: paragraphs(60, { prefix: 'Small margin Letter' }), margins: { top: 720, right: 720, bottom: 720, left: 720 } },
    ] }),
  });
  fixtures.push({
    name: 'long-table',
    features: ['table spanning pages', 'table row pagination'],
    bytes: buildDocx({ sections: [{ content: [
      paragraphXml('Long table introduction'),
      tableXml(Array.from({ length: 60 }, (_, row) => [`R${row + 1}C1`, `R${row + 1}C2`, `R${row + 1}C3`])),
      paragraphXml('Long table conclusion'),
    ] }] }),
  });
  fixtures.push({
    name: 'table-header-repeat',
    features: ['repeating table header rows', 'table pagination'],
    bytes: buildDocx({ sections: [{ content: [
      paragraphXml('Repeating header table introduction'),
      tableXml([
        [{ text: 'Header A' }, { text: 'Header B' }, { text: 'Header C' }],
        ...Array.from({ length: 90 }, (_, row) => [`R${row + 1}C1`, `R${row + 1}C2`, `R${row + 1}C3`]),
      ].map((row, index) => Object.assign(row, { options: { header: index === 0 } }))),
    ] }] }),
  });
  fixtures.push({
    name: 'merged-cells',
    features: ['merged cells', 'gridSpan', 'vertical merge', 'table pagination'],
    bytes: buildDocx({ sections: [{ content: [
      paragraphXml('Merged cell table introduction'),
      tableXml([
        [{ text: 'Merged title', colSpan: 3 }],
        [{ text: 'Group', vMerge: 'restart' }, { text: 'Field' }, { text: 'Value' }],
        [{ text: '', vMerge: 'continue' }, { text: 'Degree' }, { text: 'B.Tech' }],
        ...Array.from({ length: 50 }, (_, row) => [`Merge ${row + 1}A`, `Merge ${row + 1}B`, `Merge ${row + 1}C`]),
      ], { columns: 3 }),
    ] }] }),
  });
  fixtures.push({
    name: 'keep-with-next',
    features: ['keep-with-next', 'keep-lines-together'],
    bytes: buildDocx({ sections: [{ content: [
      ...Array.from({ length: 18 }, (_, index) => [
        paragraphXml(`Keep heading ${index + 1}`, { font: 'Calibri', size: 13, bold: true, keepNext: true, after: 80 }),
        ...Array.from({ length: 5 }, (_, line) => paragraphXml(`Keep body ${index + 1}.${line + 1} with a line of deterministic text.`, { keepLines: true })),
      ]).flat(),
    ] }] }),
  });
  fixtures.push({
    name: 'widow-orphan',
    features: ['widow/orphan controls', 'long paragraphs'],
    bytes: buildDocx({ sections: [{ content: Array.from({ length: 40 }, (_, index) => paragraphXml(
      `Widow paragraph ${index + 1}. ${'A deterministic sentence that must wrap across several lines. '.repeat(5)}`,
      { widowControl: true },
    )) }] }),
  });
  fixtures.push({
    name: 'headers-footers',
    features: ['first-page header/footer', 'even/odd headers', 'linked-to-previous inheritance', 'page numbering'],
    evenAndOddHeaders: true,
    bytes: buildDocx({
      evenAndOddHeaders: true,
      sections: [
        {
          titlePage: true,
          pageNumberStart: 1,
          headers: { default: ['Corpus default header'], first: ['Corpus first-page header'], even: ['Corpus even header'] },
          footers: { default: ['Corpus footer page '], first: ['Corpus first footer'], even: ['Corpus even footer'] },
          content: paragraphs(80, { prefix: 'Header section one' }),
        },
        {
          headers: { default: ['Corpus section two header'] },
          pageNumberStart: 5,
          pageNumberFormat: 'upperRoman',
          content: paragraphs(30, { prefix: 'Header section two' }),
        },
      ],
    }),
  });
  fixtures.push({
    name: 'images-captions',
    features: ['inline images', 'captions', 'image pagination'],
    bytes: buildDocx({
      images: 6,
      sections: [{ content: Array.from({ length: 6 }, (_, index) => [
        imageXml(`rIdImage${index + 1}`, index + 1),
        paragraphXml(`Figure ${index + 1}. Corpus image caption with deterministic text.`, { alignment: 'center', size: 9, italic: true }),
      ]).flat() }],
    }),
  });
  fixtures.push({
    name: 'mixed-fonts',
    features: ['Calibri, Arial, Times New Roman', 'mixed font sizes'],
    bytes: buildDocx({ sections: [{ content: [
      ...Array.from({ length: 30 }, (_, index) => [
        paragraphXml(`Mixed heading ${index + 1}`, { font: index % 3 === 0 ? 'Calibri' : index % 3 === 1 ? 'Arial' : 'Times New Roman', size: 18, bold: true, after: 60 }),
        paragraphXml(`Mixed body ${index + 1} in ${index % 3 === 0 ? 'Calibri 11' : index % 3 === 1 ? 'Arial 10' : 'Times New Roman 12'}. ${'Deterministic sentence for mixed formatting measurement. '.repeat(2)}`, { font: index % 3 === 0 ? 'Calibri' : index % 3 === 1 ? 'Arial' : 'Times New Roman', size: index % 3 === 0 ? 11 : index % 3 === 1 ? 10 : 12 }),
      ]).flat(),
    ] }] }),
  });
  fixtures.push({
    name: 'columns',
    features: ['two-column layout', 'section columns'],
    bytes: buildDocx({ sections: [{ columns: 2, content: paragraphs(100, { prefix: 'Column paragraph' }) }] }),
  });
  fixtures.push({
    name: 'columns-complex',
    features: ['unequal columns', 'three columns', 'explicit column break', 'section column transitions'],
    bytes: buildDocx({ sections: [
      { content: paragraphs(10, { prefix: 'Single column' }) },
      {
        columns: 2,
        columnDefinitions: [2400, 4800],
        content: [
          ...paragraphs(12, { prefix: 'Unequal left' }),
          paragraphXml('Explicit column break after this line', { columnBreakAfter: true }),
          ...paragraphs(18, { prefix: 'Unequal right' }),
        ],
      },
      { columns: 3, content: paragraphs(60, { prefix: 'Three column' }) },
      { content: paragraphs(10, { prefix: 'Back to one column' }) },
    ] }),
  });
  fixtures.push({
    name: 'nested-tables',
    features: ['nested tables', 'table pagination'],
    bytes: buildDocx({ sections: [{ content: [
      paragraphXml('Nested table introduction'),
      `<w:tbl>${Array.from({ length: 18 }, (_, row) => `<w:tr>${[1, 2].map((column) => `<w:tc>${paragraphXml(`Outer ${row + 1}.${column}`, { size: 10 })}${column === 1 ? tableXml([[`Inner ${row + 1}A`, `Inner ${row + 1}B`], [`Inner ${row + 1}C`, `Inner ${row + 1}D`]], { columns: 2 }) : ''}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`,
      paragraphXml('Nested table conclusion'),
    ] }] }),
  });
  return fixtures;
}

async function readPdfReference(pdfPath, source) {
  const data = new Uint8Array(await readFile(pdfPath));
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data, useSystemFonts: false, disableFontFace: true });
  const document = await task.promise;
  const pages = [];
  const orientations = [];
  const imagePaints = [];
  const imageOperators = new Set([
    OPS.paintImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintJpegXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageXObjectRepeat,
  ]);
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str ?? '').join(' '));
    const [x0, y0, x1, y1] = page.view;
    orientations.push(x1 - x0 > y1 - y0 ? 'landscape' : 'portrait');
    const operators = await page.getOperatorList();
    imagePaints.push(operators.fnArray.filter((fn) => imageOperators.has(fn)).length);
  }
  await task.destroy();
  return {
    pageCount: document.numPages,
    pages,
    orientations,
    imagePaints,
    imagePaintsTotal: imagePaints.reduce((sum, count) => sum + count, 0),
    pdfPath,
    source,
  };
}

async function renderReference(docxPath) {
  const outDir = path.dirname(docxPath);
  await execFileAsync(sofficePath, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, docxPath], {
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return readPdfReference(docxPath.replace(/\.docx$/i, '.pdf'), 'libreoffice');
}

function normalizeText(value) {
  return String(value)
    .normalize('NFKC')
    .replace(/[\u00ad\u2010\u2011]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function segmentForLength(normalized, length, fromEnd) {
  const sliced = length < normalized.length;
  let segment = fromEnd ? normalized.slice(-Math.min(length, normalized.length)) : normalized.slice(0, Math.min(length, normalized.length));
  if (sliced) segment = fromEnd ? segment.replace(/^\S*\s+/, '') : segment.replace(/\s+\S*$/, '');
  segment = segment.trim();
  return segment.length >= 2 ? segment : (fromEnd ? normalized.slice(-Math.min(length, normalized.length)) : normalized.slice(0, Math.min(length, normalized.length)));
}

function pagesForText(referencePages, text, fromEnd = false) {
  const normalized = normalizeText(text);
  if (normalized.length < 4) return [];
  const normalizedPages = referencePages.map(normalizeText);
  let fallback = [];
  // Repeated boilerplate makes the shortest suffix ambiguous. Increase the
  // segment until it identifies one page, which keeps single-page blocks
  // honest without assuming the renderer's own page mapping.
  for (const length of [40, 80, 120, 160, 200, 240, 280, 320, 400, 480]) {
    const segment = segmentForLength(normalized, length, fromEnd);
    if (segment.length < 4) continue;
    const matches = [];
    const needle = ` ${segment} `;
    for (let index = 0; index < normalizedPages.length; index += 1) {
      if (` ${normalizedPages[index]} `.includes(needle)) matches.push(index + 1);
    }
    if (matches.length === 1) return matches;
    if (matches.length > 1 && fallback.length === 0) fallback = matches;
    if (normalized.length <= length) break;
  }
  return fallback;
}

function referenceRangeForBlock(block, byId, referencePages) {
  const texts = [];
  if (block.type === 'table') {
    const rows = (block.children ?? []).map((id) => byId.get(id)).filter(Boolean);
    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];
    for (const row of [firstRow, lastRow]) {
      for (const cellId of row?.children ?? []) {
        const cellText = byId.get(cellId)?.text ?? '';
        if (cellText.trim()) texts.push(cellText);
      }
    }
  } else if (block.type === 'list') {
    for (const itemId of [block.children?.[0], block.children?.[block.children.length - 1]]) {
      const item = itemId ? byId.get(itemId) : undefined;
      if (item?.text) texts.push(item.text);
    }
  } else {
    texts.push(block.text);
  }
  const firstText = texts[0] ?? block.text;
  const lastText = texts[texts.length - 1] ?? block.text;
  const startPages = pagesForText(referencePages, firstText, false);
  const endPages = pagesForText(referencePages, lastText, true);
  if (startPages.length === 0 || endPages.length === 0) return null;
  return { start: Math.min(...startPages), end: Math.max(...endPages) };
}

function compareFixture(fixture, reference, structure) {
  const pagination = structure.pagination;
  const byId = new Map(structure.blocks.map((block) => [block.blockId, block]));
  const blockPages = new Map((pagination?.blockPages ?? []).map((entry) => [entry.blockId, entry]));
  const topLevel = structure.readingOrder
    .map((id) => byId.get(id))
    .filter((block) => block && block.type !== 'header' && block.type !== 'footer');
  let compared = 0;
  let exact = 0;
  let startMatch = 0;
  let endMatch = 0;
  const mismatches = [];
  for (const block of topLevel) {
    const mapped = blockPages.get(block.blockId);
    if (!mapped) continue;
    const referenceRange = referenceRangeForBlock(block, byId, reference.pages);
    if (!referenceRange) continue;
    compared += 1;
    const mappedStart = mapped.startPageNumber;
    const mappedEnd = mapped.endPageNumber ?? mapped.startPageNumber;
    const startOk = mappedStart === referenceRange.start;
    const endOk = mappedEnd === referenceRange.end;
    if (startOk) startMatch += 1;
    if (endOk) endMatch += 1;
    if (startOk && endOk) exact += 1;
    else if (mismatches.length < 12) {
      mismatches.push({
        blockId: block.blockId,
        type: block.type,
        text: block.text.replace(/\s+/g, ' ').slice(0, 90),
        mapped: `${mappedStart}-${mappedEnd}`,
        reference: `${referenceRange.start}-${referenceRange.end}`,
        approximate: Boolean(mapped.approximate),
      });
    }
  }
  const orientationMatches = (pagination?.pages ?? []).filter((page, index) => page.orientation === reference.orientations[index]).length;
  return {
    referencePages: reference.pageCount,
    formflowPages: pagination?.pageCount ?? 0,
    difference: (pagination?.pageCount ?? 0) - reference.pageCount,
    status: pagination?.status ?? 'none',
    mechanism: pagination?.mechanism ?? 'none',
    compared,
    exact,
    startMatch,
    endMatch,
    exactRate: compared ? exact / compared : null,
    startRate: compared ? startMatch / compared : null,
    endRate: compared ? endMatch / compared : null,
    orientationMatches,
    orientationCompared: Math.min(pagination?.pages.length ?? 0, reference.orientations.length),
    mismatches,
  };
}

async function main() {
  if (!sofficePath) throw new Error('LibreOffice soffice was not found. Set SOFFICE_PATH.');
  if (!existsSync(extensionPath)) throw new Error('Build the extension before running the corpus validation.');
  await mkdir(workDir, { recursive: true });
  const filter = process.env.CORPUS_ONLY?.split(',').map((name) => name.trim()).filter(Boolean);
  const fixtures = corpus();
  fixtures.push({
    name: 'embedded-fonts',
    features: ['embedded regular font', 'theme font declarations', 'exact embedded face'],
    bytes: await buildEmbeddedFontDocx(true),
  });
  fixtures.push({
    name: 'font-substitution',
    features: ['missing exact font', 'deterministic fallback', 'theme declarations'],
    bytes: await buildEmbeddedFontDocx(false),
  });
  fixtures.push({
    name: 'corrupt-embedded-font',
    features: ['malformed embedded font', 'bounded font rejection', 'fallback'],
    bytes: await buildEmbeddedFontDocx(true, true),
  });
  fixtures.push({
    name: 'multi-font-paragraph',
    features: ['multiple font families inside one paragraph', 'mixed sizes'],
    bytes: buildDocx({ sections: [{ content: Array.from({ length: 40 }, (_, index) => paragraphXml(`Multi-font paragraph ${index + 1}`, {
      runs: [
        { text: `Calibri ${index + 1} `, font: 'Calibri', size: 11 },
        { text: 'Arial segment ', font: 'Arial', size: 10, bold: true },
        { text: 'Times segment with deterministic text.', font: 'Times New Roman', size: 13, italic: true },
      ],
    })) }] }),
  });
  fixtures.push({
    name: 'table-images',
    features: ['images in table cells', 'image in nested table', 'table-cell captions'],
    bytes: buildTableImageDocx(),
  });
  fixtures.push({
    name: 'header-footer-images',
    features: ['header image', 'footer image', 'inherited header/footer across pages'],
    bytes: buildHeaderFooterImageDocx(),
  });
  const selectedFixtures = fixtures.filter((fixture) => !filter?.length || filter.includes(fixture.name));
  if (selectedFixtures.length === 0) throw new Error('No corpus fixtures matched CORPUS_ONLY.');
  const wordReferenceDir = process.env.WORD_REFERENCE_DIR
    ? path.resolve(process.env.WORD_REFERENCE_DIR)
    : undefined;
  if (wordReferenceDir && !existsSync(wordReferenceDir)) {
    throw new Error(`WORD_REFERENCE_DIR does not exist: ${wordReferenceDir}`);
  }
  const wordReferences = [];
  const results = [];

  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(workDir, 'profile'), {
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-proxy-server',
        '--no-first-run',
      ],
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/dashboard.html#/setup`, { waitUntil: 'load' });
    await page.waitForSelector('input[placeholder="e.g. Personal applications"]');
    await page.fill('input[placeholder="e.g. Personal applications"]', 'Phase 4.1.4 reference corpus');
    await page.locator('input[type=password]').nth(0).fill(passphrase);
    await page.locator('input[type=password]').nth(1).fill(passphrase);
    await page.click('button:has-text("Create encrypted vault")');
    await page.waitForURL(/#\/dashboard$/);
    await page.waitForTimeout(500);

    const send = (requestId, operation, payload = {}, timeout = 300_000) => page.evaluate(
      ({ request, timeoutMs }) => new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs);
        chrome.runtime.sendMessage(request, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      }),
      { request: { protocol: 1, requestId, operation, payload }, timeoutMs: timeout },
    );

    for (const fixture of selectedFixtures) {
      const docxPath = path.join(workDir, `${fixture.name}.docx`);
      await writeFile(docxPath, fixture.bytes);
      const reference = await renderReference(docxPath);
      let wordReference;
      if (wordReferenceDir) {
        const wordPdfPath = path.join(wordReferenceDir, `${fixture.name}.pdf`);
        if (existsSync(wordPdfPath)) {
          wordReference = await readPdfReference(wordPdfPath, 'microsoft-word');
        }
        wordReferences.push({ name: fixture.name, supplied: Boolean(wordReference), path: wordPdfPath });
      }
      const imported = await send(`corpus_${fixture.name}`, 'IMPORT_DOCUMENT', {
        name: `${fixture.name}.docx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        dataBase64: Buffer.from(fixture.bytes).toString('base64'),
        importId: `corpus_${fixture.name}`,
      });
      if (!imported?.ok) {
        failures.push(`${fixture.name}: import failed: ${imported?.error ?? 'unknown'}`);
        results.push({ fixture, reference, wordReference, error: imported?.error ?? 'import failed' });
        continue;
      }
      const textResult = await send(`corpus_${fixture.name}_text`, 'GET_DOCUMENT_TEXT', { documentId: imported.data.document.id });
      if (!textResult?.ok || !textResult.data.structure) {
        failures.push(`${fixture.name}: extraction result unavailable: ${textResult?.error ?? 'no structure'}`);
        results.push({ fixture, reference, wordReference, error: textResult?.error ?? 'no structure' });
        continue;
      }
      const comparison = compareFixture(fixture, reference, textResult.data.structure);
      const wordComparison = wordReference
        ? compareFixture(fixture, wordReference, textResult.data.structure)
        : null;
      const layout = textResult.data.structure.docxLayout;
      if (process.env.CORPUS_DEBUG === '1') {
        const pagination = textResult.data.structure.pagination;
        console.log(`DEBUG_PAGES ${fixture.name}`, JSON.stringify((pagination?.pages ?? []).map((entry) => ({ page: entry.pageNumber, blocks: entry.blockIds.length }))));
        console.log(`DEBUG_BLOCKS ${fixture.name}`, JSON.stringify((pagination?.blockPages ?? []).slice(0, 12).map((entry) => ({ block: entry.blockId, start: entry.startPageNumber, end: entry.endPageNumber, fragments: entry.fragmentPages }))));
      }
      const inheritedHeaders = layout?.sections.reduce((count, section) => count + section.headers.filter((reference) => reference.inherited).length, 0) ?? 0;
      const inheritedFooters = layout?.sections.reduce((count, section) => count + section.footers.filter((reference) => reference.inherited).length, 0) ?? 0;
      const pagination = textResult.data.structure.pagination;
      const imageBlocks = textResult.data.structure.blocks.filter((block) => block.type === 'image');
      const tableImageBlocks = imageBlocks.filter((block) => block.image?.parentCellBlockId);
      const headerFooterImageBlocks = imageBlocks.filter((block) => block.image?.headerFooter);
      const imageAppearances = imageBlocks.reduce((count, block) => count + (block.image?.appearances?.length ?? 0), 0);
      const maxHeaderFooterAppearances = headerFooterImageBlocks.reduce((max, block) => Math.max(max, block.image?.appearances?.length ?? 0), 0);
      const geometry = pagination?.geometry;
      const columnBoxes = pagination?.pages.reduce((count, page) => count + (page.columns?.length ?? 0), 0) ?? 0;
      const columnWidths = [...new Set((pagination?.pages ?? []).flatMap((page) => (page.columns ?? []).map((column) => Math.round(column.widthPt))))];
      const columnCounts = [...new Set((pagination?.pages ?? []).map((page) => page.columns?.length ?? 0))];
      const fontSources = (layout?.fonts ?? []).map((font) => font.source);
      const requestedFontFamilies = (layout?.fonts ?? []).map((font) => font.requestedFamily);
      const columnBreaks = textResult.data.structure.blocks.filter((block) => block.columnBreakAfter === true).length;
      const pageSections = (pagination?.pages ?? []).map((page) => ({
        page: page.pageNumber,
        section: page.sectionIndex,
        approximate: page.sectionIndexApproximate === true,
      }));
      const result = {
        fixture,
        reference,
        wordReference,
        wordComparison,
        referenceImagePaints: reference.imagePaintsTotal,
        ...comparison,
        warnings: (textResult.data.structure.pagination?.warnings ?? []).map((warning) => warning.code),
        structureWarnings: (textResult.data.structure.warnings ?? []).map((warning) => warning.code),
        docxSections: layout?.sections.length ?? 0,
        sectionHeaders: layout?.sections.reduce((count, section) => count + section.headers.length, 0) ?? 0,
        inheritedHeaders,
        inheritedFooters,
        evenAndOddHeaders: layout?.evenAndOddHeaders ?? false,
        imageBlocks: imageBlocks.length,
        imagePages: imageBlocks.filter((block) => pagination?.blockPages.some((entry) => entry.blockId === block.blockId)).length,
        tableImageBlocks: tableImageBlocks.length,
        headerFooterImageBlocks: headerFooterImageBlocks.length,
        imageAppearances,
        maxHeaderFooterAppearances,
        geometry,
        columnBoxes,
        columnWidths,
        columnCounts,
        columnBreaks,
        pageSections,
        fontSources,
        requestedFontFamilies,
        embeddedFonts: layout?.embeddedFonts?.length ?? 0,
        themeFonts: layout?.themeFonts,
      };
      if (fixture.name === 'images-captions' && imageBlocks.length === 0) {
        failures.push(`${fixture.name}: no structured image blocks were produced.`);
      }
      if (fixture.name === 'table-images') {
        if (tableImageBlocks.length !== 3) {
          failures.push(`${fixture.name}: expected three table/nested-table image blocks, got ${tableImageBlocks.length}.`);
        }
        if (!tableImageBlocks.some((block) => block.image?.nestedTableDepth === 1)) {
          failures.push(`${fixture.name}: no nested-table image placement was recorded.`);
        }
        if (!tableImageBlocks.some((block) => block.image?.captionText)) {
          failures.push(`${fixture.name}: table-cell caption was not linked.`);
        }
        if (imageAppearances < tableImageBlocks.length) {
          failures.push(`${fixture.name}: table images were not mapped to physical pages.`);
        }
      }
      if (fixture.name === 'header-footer-images') {
        if (headerFooterImageBlocks.length !== 2) {
          failures.push(`${fixture.name}: expected one header and one footer image placement, got ${headerFooterImageBlocks.length}.`);
        }
        if (maxHeaderFooterAppearances < 2) {
          failures.push(`${fixture.name}: inherited header/footer image appearances were not repeated across pages.`);
        }
      }
      if ((fixture.name === 'columns' || fixture.name === 'columns-complex') && columnBoxes === 0) {
        failures.push(`${fixture.name}: no column geometry was produced.`);
      }
      if (fixture.name === 'columns' && !columnCounts.includes(2)) {
        failures.push(`${fixture.name}: expected two-column page geometry.`);
      }
      if (fixture.name === 'columns-complex') {
        if (!columnCounts.includes(2) || !columnCounts.includes(3)) {
          failures.push(`${fixture.name}: expected both two-column and three-column page geometry.`);
        }
        if (new Set(columnWidths).size < 2) {
          failures.push(`${fixture.name}: unequal columns were not preserved in geometry.`);
        }
        if (columnBreaks === 0) {
          failures.push(`${fixture.name}: explicit column break was not recorded.`);
        }
      }
      if (fixture.name === 'embedded-fonts' && !fontSources.includes('embedded')) {
        failures.push(`${fixture.name}: embedded font was not reported as an embedded direct face.`);
      }
      if (fixture.name === 'font-substitution' && fontSources.includes('embedded')) {
        failures.push(`${fixture.name}: a font was unexpectedly reported as embedded.`);
      }
      if (fixture.name === 'font-substitution'
        && !(textResult.data.structure.pagination?.warnings ?? []).some((warning) => warning.code === 'DOCX_PAGINATION_FONT_SUBSTITUTION')) {
        failures.push(`${fixture.name}: missing exact font did not produce a substitution warning.`);
      }
      if (fixture.name === 'corrupt-embedded-font'
        && !(textResult.data.structure.pagination?.warnings ?? []).some((warning) => [
          'DOCX_EMBEDDED_FONT_DROPPED',
          'DOCX_EMBEDDED_FONT_UNAVAILABLE',
          'DOCX_FONT_ORIGIN_FAILED',
        ].includes(warning.code))) {
        failures.push(`${fixture.name}: malformed embedded font did not produce explicit font failure evidence.`);
      }
      if (fixture.name === 'multi-font-paragraph' && requestedFontFamilies.length < 3) {
        failures.push(`${fixture.name}: expected at least three requested font families.`);
      }
      if (fixture.name === 'nested-tables' && !(geometry?.cellCount > 0)) {
        failures.push(`${fixture.name}: expected cell geometry for nested tables.`);
      }
      if ((fixture.name === 'columns' || fixture.name === 'columns-complex')
        && !pagination?.blockPages.some((entry) => (entry.lines?.length ?? 0) > 0)) {
        failures.push(`${fixture.name}: expected line geometry in a multi-column fixture.`);
      }
      if ((fixture.name === 'long-table' || fixture.name === 'nested-tables')
        && !pagination?.blockPages.some((entry) => entry.tableRows?.some((row) => (row.cells?.length ?? 0) > 0))) {
        failures.push(`${fixture.name}: expected row/cell geometry in a table fixture.`);
      }
      if (fixture.name === 'long-table'
        && !pagination?.blockPages.some((entry) => (entry.tableRows?.length ?? 0) > 0 && (entry.startPageNumber !== entry.endPageNumber))) {
        failures.push(`${fixture.name}: expected a table spanning pages with row geometry.`);
      }
      if (geometry && geometry.lineCount === 0) {
        failures.push(`${fixture.name}: renderer produced no line geometry.`);
      }
      results.push(result);
      console.log(`CORPUS ${fixture.name} :: ${JSON.stringify({
        referencePages: result.referencePages,
        formflowPages: result.formflowPages,
        difference: result.difference,
        exactRate: result.exactRate === null ? null : Number(result.exactRate.toFixed(3)),
        compared: result.compared,
        ...(wordComparison ? {
          wordPages: wordComparison.referencePages,
          wordDifference: wordComparison.difference,
          wordExactRate: wordComparison.exactRate === null ? null : Number(wordComparison.exactRate.toFixed(3)),
        } : {}),
        warnings: result.warnings,
      })}`);
    }
  } finally {
    if (context) await context.close().catch(() => undefined);
  }

  const lines = [];
  lines.push('# Phase 4.1.4.2 DOCX pagination fidelity and image validation');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Method: each fixture is converted to PDF by a locally installed LibreOffice (`soffice --headless --convert-to pdf`). The same DOCX is imported through the production extension in Chromium, and the renderer-derived pagination, font evidence, image blocks, line/cell boxes, and column geometry are read back from encrypted extraction. Reference page text is extracted with `pdfjs-dist`, and each top-level block is matched by normalized first/last text segments to estimate start/end page mapping. When `WORD_REFERENCE_DIR` is supplied, Word-exported PDFs are read through the same comparison path; no Word reference was supplied for this generated report unless the section below says otherwise.');
  lines.push('');
  lines.push(`Reference renderer: ${(await execFileAsync(sofficePath, ['--version'])).stdout.trim()}`);
  lines.push(`FormFlow renderer: @docx-editor.dev/core 2.38.0 with packaged Carlito/Liberation fonts and HarfBuzz.`);
  lines.push('');
  const percent = (value) => value === null ? '—' : `${Math.round(value * 100)}%`;
  lines.push('| Fixture | Features | Reference pages | FormFlow pages | Diff | Compared blocks | Exact mapping | Start page | End page | Orientation match |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const result of results) {
    if (result.error) {
      lines.push(`| ${result.fixture.name} | ${result.fixture.features.join('; ')} | ${result.reference.pageCount} | import failed | — | — | — | — | — | — |`);
      continue;
    }
    lines.push(`| ${result.fixture.name} | ${result.fixture.features.join('; ')} | ${result.referencePages} | ${result.formflowPages} | ${result.difference > 0 ? '+' : ''}${result.difference} | ${result.compared} | ${percent(result.exactRate)} (${result.exact}/${result.compared}) | ${percent(result.startRate)} | ${percent(result.endRate)} | ${result.orientationMatches}/${result.orientationCompared} |`);
  }
  lines.push('');
  const completed = results.filter((result) => !result.error);
  const exactPageFixtures = completed.filter((result) => result.referencePages === result.formflowPages).length;
  const comparedBlocks = completed.reduce((sum, result) => sum + (result.compared ?? 0), 0);
  const exactBlocks = completed.reduce((sum, result) => sum + (result.exact ?? 0), 0);
  const referencePages = completed.reduce((sum, result) => sum + (result.referencePages ?? 0), 0);
  const formflowPages = completed.reduce((sum, result) => sum + (result.formflowPages ?? 0), 0);
  lines.push(`Summary: ${completed.length} fixture(s); ${exactPageFixtures}/${completed.length} exact page counts; reference pages ${referencePages}, FormFlow pages ${formflowPages}; ${exactBlocks}/${comparedBlocks} comparable top-level block ranges exact.`);
  lines.push('');
  if (wordReferenceDir) {
    lines.push('## Microsoft Word reference comparison');
    lines.push('');
    const supplied = wordReferences.filter((entry) => entry.supplied).length;
    lines.push(`Word reference directory: \`${wordReferenceDir}\`. Supplied PDFs: ${supplied}/${wordReferences.length}.`);
    lines.push('');
    if (supplied > 0) {
      lines.push('| Fixture | Word pages | LibreOffice pages | FormFlow pages | FormFlow−Word | FormFlow−LibreOffice | Compared blocks | Exact mapping | Word image paints | FormFlow image appearances | Table images | Header/footer images |');
      lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
      for (const result of results) {
        if (!result.wordComparison) continue;
        lines.push(`| ${result.fixture.name} | ${result.wordComparison.referencePages} | ${result.referencePages} | ${result.wordComparison.formflowPages} | ${result.wordComparison.difference > 0 ? '+' : ''}${result.wordComparison.difference} | ${result.difference > 0 ? '+' : ''}${result.difference} | ${result.wordComparison.compared} | ${percent(result.wordComparison.exactRate)} (${result.wordComparison.exact}/${result.wordComparison.compared}) | ${result.referenceImagePaints} | ${result.imageAppearances} | ${result.tableImageBlocks} | ${result.headerFooterImageBlocks} |`);
      }
      lines.push('');
      for (const name of ['nested-tables', 'multi-font-paragraph', 'table-images', 'header-footer-images']) {
        const result = results.find((entry) => entry.fixture.name === name && entry.wordComparison);
        if (!result) continue;
        lines.push(`- \`${name}\`: Word ${result.wordComparison.referencePages} page(s), LibreOffice ${result.referencePages}, FormFlow ${result.wordComparison.formflowPages}; Word boundary mapping ${result.wordComparison.exact}/${result.wordComparison.compared} exact start/end ranges; Word image paints ${result.referenceImagePaints}, FormFlow appearances ${result.imageAppearances}.`);
      }
      lines.push('');
    }
    const missing = wordReferences.filter((entry) => !entry.supplied);
    if (missing.length) {
      lines.push(`Missing Word PDFs: ${missing.map((entry) => `\`${entry.name}.pdf\``).join(', ')}.`);
      lines.push('');
    }
  } else {
    lines.push('## Microsoft Word reference comparison');
    lines.push('');
    lines.push('No Microsoft Word reference PDFs were supplied. The harness accepts `WORD_REFERENCE_DIR` containing one PDF per fixture (`<fixture>.pdf`); see `docs/PHASE_4_1_4_1_WORD_REFERENCE.md` for the manual Word export procedure. No Microsoft Word compatibility is claimed.');
    lines.push('');
  }
  lines.push('## Per-fixture notes');
  for (const result of results) {
    lines.push(`### ${result.fixture.name}`);
    lines.push('');
    if (result.error) {
      lines.push(`- Error: ${result.error}`);
      continue;
    }
    lines.push(`- Status: \`${result.status}\` / \`${result.mechanism}\``);
    lines.push(`- Page count: reference ${result.referencePages}, FormFlow ${result.formflowPages}, difference ${result.difference > 0 ? '+' : ''}${result.difference}.`);
    lines.push(`- Block mapping: ${result.exact}/${result.compared} exact start/end ranges; start ${result.startMatch}/${result.compared}; end ${result.endMatch}/${result.compared}.`);
    if (result.wordComparison) {
      lines.push(`- Word reference: ${result.wordComparison.referencePages} pages, difference ${result.wordComparison.difference > 0 ? '+' : ''}${result.wordComparison.difference}; mapping ${result.wordComparison.exact}/${result.wordComparison.compared} exact start/end ranges; Word image paints ${result.referenceImagePaints}, FormFlow image appearances ${result.imageAppearances}.`);
    }
    lines.push(`- DOCX section metadata: ${result.docxSections} section(s), ${result.sectionHeaders} header reference(s), ${result.inheritedHeaders} inherited header reference(s), ${result.inheritedFooters} inherited footer reference(s), even/odd ${result.evenAndOddHeaders ? 'enabled' : 'disabled'}.`);
    lines.push(`- Structured images: ${result.imageBlocks} block(s), ${result.imagePages} page-mapped; ${result.tableImageBlocks} table cell placement(s), ${result.headerFooterImageBlocks} header/footer placement(s), ${result.imageAppearances} physical-page appearance(s); embedded font declarations: ${result.embeddedFonts}; font sources: ${result.fontSources.join(', ') || 'none'}.`);
    if (result.geometry) {
      lines.push(`- Geometry: ${result.geometry.lineCount} line record(s), ${result.geometry.cellCount} cell record(s), ${result.geometry.columnCount} column box(es), truncated ${result.geometry.truncated}.`);
    }
    if (result.columnBoxes) {
      lines.push(`- Column geometry: column counts ${result.columnCounts.join(', ')}; widths ${result.columnWidths.map((width) => `${width}pt`).join(', ')}.`);
    }
    lines.push(`- Explicit column breaks recorded: ${result.columnBreaks}.`);
    lines.push(`- Page-to-section mapping: ${result.pageSections.map((entry) => `${entry.page}→${entry.section}${entry.approximate ? ' (approx)' : ''}`).join(', ')}.`);
    if (result.themeFonts) {
      lines.push(`- Theme fonts: major ${result.themeFonts.major ?? '—'}, minor ${result.themeFonts.minor ?? '—'}.`);
    }
    if (result.mismatches.length) {
      lines.push('- Mapping mismatches (first 12):');
      for (const mismatch of result.mismatches) {
        lines.push(`  - \`${mismatch.blockId}\` ${mismatch.type} mapped ${mismatch.mapped}, reference ${mismatch.reference}${mismatch.approximate ? ' (approximate)' : ''}: ${mismatch.text}`);
      }
    }
    if (result.warnings.length) lines.push(`- Pagination warnings: ${result.warnings.join(', ')}`);
    if (result.structureWarnings.length) lines.push(`- Structure warnings: ${result.structureWarnings.join(', ')}`);
    lines.push('');
  }
  lines.push('## Interpretation');
  lines.push('');
  lines.push('- These are reference-rendered comparisons, not synthetic expected page counts.');
  lines.push('- A zero page-count difference does not by itself prove exact physical pagination; mapping rates and mismatches are reported separately.');
  lines.push('- LibreOffice is not Microsoft Word. Fonts, default styles, and unsupported OOXML features can produce legitimate reference differences.');
  lines.push('- If Word PDFs are supplied, they are read through the same harness; otherwise Word compatibility remains unvalidated and must not be claimed.');
  lines.push('- No fixture is marked `verified_physical`. Renderer-derived output is reported as `renderer_derived_physical`.');
  lines.push('');
  if (failures.length) {
    lines.push('## Failures');
    lines.push('');
    for (const failure of failures) lines.push(`- ${failure}`);
    lines.push('');
  }
  await writeFile(outputMarkdown, `${lines.join('\n')}\n`, 'utf8');
  console.log(`REPORT ${path.relative(root, outputMarkdown)}`);
  console.log(`FAILURES ${failures.length}`);
  if (failures.length) process.exitCode = 1;
}

try {
  await main();
  if (process.env.CORPUS_KEEP === '1') console.log(`WORKDIR ${workDir}`);
} finally {
  if (process.env.CORPUS_KEEP !== '1') await rm(workDir, { recursive: true, force: true });
}
