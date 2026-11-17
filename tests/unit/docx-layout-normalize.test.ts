import assert from 'node:assert/strict';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { normalizeDocxTablesForLayout } from '../../extension/src/offscreen/docx-layout-normalize';
import { buildDocxWithTableImage } from '../helpers/document-fixtures';

function documentDocx(documentXml: string, stylesXml?: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    ...(stylesXml ? { 'word/styles.xml': strToU8(stylesXml) } : {}),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${documentXml}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
  });
}

test('table normalization synthesizes a grid and fixed width for an automatic table', () => {
  const input = documentDocx('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>One</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>');
  const result = normalizeDocxTablesForLayout(input, { contentWidthTwips: 9_360 });
  assert.equal(result.normalizedTables, 1);
  assert.notEqual(result.bytes.byteLength, 0);
  const archive = unzipSync(result.bytes);
  const xml = strFromU8(archive['word/document.xml']!);
  assert.match(xml, /<w:tblPr><w:tblW w:w="9360" w:type="dxa"\/><w:tblLayout w:type="fixed"\/><\/w:tblPr>/);
  assert.match(xml, /<w:tblGrid><w:gridCol w:w="4680"\/><w:gridCol w:w="4680"\/><\/w:tblGrid>/);
});

test('table normalization uses an authored grid and constrains nested tables to the parent cell', () => {
  const input = documentDocx('<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4320"/><w:gridCol w:w="4320"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Outer</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Inner</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>');
  const result = normalizeDocxTablesForLayout(input, { contentWidthTwips: 9_360 });
  assert.equal(result.normalizedTables, 2);
  const xml = strFromU8(unzipSync(result.bytes)['word/document.xml']!);
  assert.match(xml, /<w:gridCol w:w="4320"\/><w:gridCol w:w="4320"\/>/);
  assert.match(xml, /<w:tblW w:w="4104" w:type="dxa"\/>/);
});

test('table normalization leaves explicit fixed tables untouched', () => {
  const input = documentDocx('<w:tbl><w:tblPr><w:tblW w:w="8640" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="4320"/><w:gridCol w:w="4320"/></w:tblGrid><w:tr><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>');
  const result = normalizeDocxTablesForLayout(input, { contentWidthTwips: 9_360 });
  assert.equal(result.normalizedTables, 0);
  assert.equal(result.bytes.byteLength, input.byteLength);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.code, 'DOCX_TABLE_LAYOUT_SKIPPED');
});

test('table normalization is bounded and cancellable', () => {
  const input = documentDocx('<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>');
  const bounded = normalizeDocxTablesForLayout(input, { contentWidthTwips: 9_360, maxTables: 0 });
  assert.equal(bounded.normalizedTables, 0);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => normalizeDocxTablesForLayout(input, { signal: controller.signal }));
});

test('table normalization handles a real image-bearing table without dropping media', () => {
  const input = buildDocxWithTableImage({ nested: true });
  const result = normalizeDocxTablesForLayout(input, { contentWidthTwips: 9_360 });
  assert.ok(result.normalizedTables >= 2);
  const archive = unzipSync(result.bytes);
  assert.ok(archive['word/media/cell-1.png']);
  assert.ok(archive['word/media/cell-2.png']);
  const xml = strFromU8(archive['word/document.xml']!);
  assert.match(xml, /<w:tblLayout w:type="fixed"\/>/);
  assert.match(xml, /<w:gridCol w:w="4320"\/>/);
});
