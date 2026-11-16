import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocx,
  buildPdf,
  buildTxt,
  pdfFixtures,
  toArrayBuffer,
} from '../helpers/document-fixtures';

const { parseDocument } = await import('../../core/documents/parsers');

function parse(bytes: Uint8Array, format: 'pdf' | 'docx' | 'txt', fileName: string) {
  return parseDocument({ format, bytes: toArrayBuffer(bytes), fileName });
}

function rejectsCode(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  };
}

test('PDF: extracts text, page count, and metadata', async () => {
  const result = await parse(pdfFixtures.normal(), 'pdf', 'fixture.pdf');
  assert.equal(result.method, 'pdf-text');
  assert.equal(result.pageCount, 1);
  assert.equal(result.pageTexts.length, 1);
  assert.match(result.text, /Hello FormFlow text extraction fixture/);
  assert.equal(result.ocrRequired, false);
  assert.equal(result.metadata.title, 'Fixture PDF');
  assert.equal(result.metadata.author, 'Fixture Author');
  assert.equal(result.version, 1);
});

test('PDF: preserves page boundaries for a multi-page document', async () => {
  const result = await parse(pdfFixtures.multiPage(), 'pdf', 'multi.pdf');
  assert.equal(result.pageCount, 2);
  assert.equal(result.pageTexts.length, 2);
  assert.match(result.pageTexts[0]!, /First page/);
  assert.match(result.pageTexts[1]!, /Second page/);
  assert.match(result.text, /First page[\s\S]*Second page/);
  assert.equal(result.pagesNeedingOcr.length, 0);
});

test('PDF: marks image-only pages as requiring OCR', async () => {
  const result = await parse(pdfFixtures.imageOnly(), 'pdf', 'scan.pdf');
  assert.equal(result.pageCount, 2);
  assert.equal(result.text, '');
  assert.equal(result.ocrRequired, true);
  assert.deepEqual(result.pagesNeedingOcr, [1, 2]);
  assert.ok(result.warnings.some((item) => item.code === 'OCR_REQUIRED'));
  assert.ok(result.warnings.some((item) => item.code === 'PAGE_REQUIRES_OCR' && item.page === 1));
});

test('PDF: detects mixed text and image-only pages', async () => {
  const result = await parse(pdfFixtures.mixed(), 'pdf', 'mixed.pdf');
  assert.equal(result.pageCount, 2);
  assert.match(result.text, /text page/);
  assert.equal(result.ocrRequired, true);
  assert.deepEqual(result.pagesNeedingOcr, [2]);
  assert.ok(result.warnings.some((item) => item.code === 'MIXED_TEXT_AND_IMAGE_PAGES'));
});

test('PDF: rejects an empty PDF', async () => {
  await assert.rejects(() => parse(pdfFixtures.empty(), 'pdf', 'empty.pdf'), rejectsCode('EMPTY_DOCUMENT'));
});

test('PDF: identifies password-protected files without decrypting them', async () => {
  await assert.rejects(
    () => parse(pdfFixtures.password(), 'pdf', 'protected.pdf'),
    rejectsCode('PASSWORD_PROTECTED'),
  );
});

test('PDF: rejects corrupted input', async () => {
  await assert.rejects(
    () => parse(pdfFixtures.corrupted(), 'pdf', 'broken.pdf'),
    rejectsCode('CORRUPTED_DOCUMENT'),
  );
});

test('PDF: rejects a PDF above the configured page limit', async () => {
  const pages = Array.from({ length: 1_001 }, (_, index) => ({ text: `Page ${index + 1} content` }));
  const bytes = buildPdf({ pages });
  await assert.rejects(() => parse(bytes, 'pdf', 'huge.pdf'), rejectsCode('EXTRACTION_TOO_LARGE'));
});

test('DOCX: extracts paragraphs, headings, tables, and line breaks in document order', async () => {
  const bytes = buildDocx({
    paragraphs: [
      { text: 'Admission Record', heading: 1 },
      { text: 'First paragraph line one\nline two' },
      { text: 'Second paragraph' },
    ],
    tables: [
      [
        ['Field', 'Value'],
        ['Degree', 'B.Tech Computer Science'],
      ],
    ],
    core: { title: 'DOCX Fixture', author: 'Fixture Author' },
  });
  const result = await parse(bytes, 'docx', 'fixture.docx');
  assert.equal(result.method, 'docx');
  assert.equal(result.pageCount, 1);
  assert.equal(result.ocrRequired, false);
  assert.match(result.text, /Admission Record/);
  assert.match(result.text, /First paragraph line one\nline two/);
  assert.match(result.text, /Field\tValue/);
  assert.match(result.text, /Degree\tB\.Tech Computer Science/);
  assert.ok(result.text.indexOf('Admission Record') < result.text.indexOf('Degree'));
  assert.equal(result.metadata.title, 'DOCX Fixture');
  assert.equal(result.metadata.author, 'Fixture Author');
  assert.deepEqual(result.metadata.headings?.map((heading) => heading.text), ['Admission Record']);
  assert.equal(result.metadata.tableCount, 1);
  assert.equal(result.metadata.rowCount, 2);
  assert.ok(result.warnings.some((item) => item.code === 'DOCX_PAGE_COUNT_UNAVAILABLE'));
});

test('DOCX: preserves meaningful line breaks', async () => {
  const bytes = buildDocx({ paragraphs: [{ text: 'Line one\nLine two\nLine three' }] });
  const result = await parse(bytes, 'docx', 'lines.docx');
  assert.match(result.text, /Line one\nLine two\nLine three/);
});

test('DOCX: rejects an empty document', async () => {
  await assert.rejects(
    () => parse(buildDocx({ empty: true }), 'docx', 'empty.docx'),
    rejectsCode('EMPTY_DOCUMENT'),
  );
});

test('DOCX: rejects malformed containers', async () => {
  await assert.rejects(
    () => parse(buildTxt('not a docx', { lineEndings: 'lf' }), 'docx', 'bad.docx'),
    rejectsCode('CORRUPTED_DOCUMENT'),
  );
});

test('DOCX: rejects a ZIP without word/document.xml', async () => {
  const { zipSync, strToU8 } = await import('fflate');
  const bytes = zipSync({ 'other.txt': strToU8('not a document') });
  await assert.rejects(() => parse(bytes, 'docx', 'missing.docx'), rejectsCode('CORRUPTED_DOCUMENT'));
});

test('TXT: decodes UTF-8, BOM, and CRLF while preserving paragraphs', async () => {
  const bytes = buildTxt('First paragraph\n\nSecond paragraph with café', {
    bom: true,
    lineEndings: 'crlf',
  });
  const result = await parse(bytes, 'txt', 'notes.txt');
  assert.equal(result.method, 'txt');
  assert.equal(result.text, 'First paragraph\n\nSecond paragraph with café');
  assert.equal(result.metadata.bom, true);
  assert.equal(result.metadata.encoding, 'utf-8');
  assert.equal(result.metadata.lineEndings, 'crlf');
  assert.equal(result.pageCount, 1);
});

test('TXT: records mixed line endings', async () => {
  const result = await parse(buildTxt('one\ntwo\nthree', { lineEndings: 'lf' }), 'txt', 'mixed.txt');
  assert.equal(result.metadata.lineEndings, 'lf');
});

test('TXT: rejects empty content', async () => {
  await assert.rejects(() => parse(buildTxt(''), 'txt', 'empty.txt'), rejectsCode('EMPTY_DOCUMENT'));
});

test('TXT: rejects invalid UTF-8', async () => {
  await assert.rejects(
    () => parse(new Uint8Array([0xff, 0xfe, 0x00, 0x41]), 'txt', 'invalid.txt'),
    rejectsCode('INVALID_ENCODING'),
  );
});

test('TXT: rejects binary control characters', async () => {
  await assert.rejects(
    () => parse(new Uint8Array([0x41, 0x00, 0x42]), 'txt', 'binary.txt'),
    rejectsCode('INVALID_ENCODING'),
  );
});
