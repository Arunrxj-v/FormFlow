import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DOCUMENT_BYTES, MAX_EXTRACTED_TEXT_CHARS } from '../../shared/constants';
import {
  OFFSCREEN_PARSER_PROTOCOL_VERSION,
  OFFSCREEN_PARSER_VERSION,
  parseOffscreenCancelRequest,
  parseOffscreenErrorMessage,
  parseOffscreenParseRequest,
  parseOffscreenParserResult,
  parseOffscreenProgressMessage,
  parseOffscreenResultMessage,
  parseWorkerParseRequest,
  parserErrorFromUnknown,
} from '../../shared/offscreen-parser-protocol';
import { FormFlowError } from '../../shared/errors';

const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

function request(overrides: Record<string, unknown> = {}) {
  const data = 'hello';
  return {
    type: 'PARSE_DOCUMENT',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: 'parse_12345678-abcd',
    parserVersion: OFFSCREEN_PARSER_VERSION,
    format: 'pdf',
    fileName: 'test.pdf',
    sizeBytes: data.length,
    ocrLanguage: 'eng',
    dataBase64: base64(data),
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    text: 'Extracted text',
    pageTexts: ['Extracted text'],
    pageCount: 1,
    method: 'pdf-text',
    version: OFFSCREEN_PARSER_VERSION,
    ocrRequired: false,
    pagesNeedingOcr: [],
    warnings: [],
    metadata: { title: 'Fixture' },
    ...overrides,
  };
}

function structure(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    extractionVersion: OFFSCREEN_PARSER_VERSION,
    documentFormat: 'pdf',
    pageSemantics: 'physical',
    pages: [{
      pageId: 'p1',
      pageNumber: 1,
      pageKind: 'physical',
      pageType: 'text',
      extractionMethod: 'pdf_native',
      blockIds: ['p1_b1'],
      pageBounds: { width: 612, height: 792, coordinateSpace: 'pdf_page_points' },
    }],
    blocks: [{
      blockId: 'p1_b1',
      type: 'paragraph',
      text: 'Extracted text',
      pageId: 'p1',
      pageNumber: 1,
      order: 0,
      provenance: 'pdf_native',
      boundingBox: { x0: 10, y0: 10, x1: 100, y1: 30, coordinateSpace: 'pdf_page_points', pageWidth: 612, pageHeight: 792 },
    }],
    sections: [],
    tables: [],
    readingOrder: ['p1_b1'],
    warnings: [],
    metadata: { pageCount: 1, blockCount: 1, sectionCount: 0, tableCount: 0, ocrPageCount: 0, truncated: false },
    pagination: {
      status: 'explicit_breaks',
      mechanism: 'wordprocessingml_breaks',
      pageCount: 1,
      pages: [{ pageNumber: 1, pageKind: 'explicit_break_segment', blockIds: ['p1_b1'], breakReason: 'document_start', pageWidthPt: 612, pageHeightPt: 792, orientation: 'portrait' }],
      blockPages: [{ blockId: 'p1_b1', startPageNumber: 1 }],
      warnings: [],
    },
    ...overrides,
  };
}

test('accepts a strict offscreen parse request', () => {
  const parsed = parseOffscreenParseRequest(request());
  assert.equal(parsed.format, 'pdf');
  assert.equal(parsed.sizeBytes, 5);
  assert.equal(parsed.dataBase64, base64('hello'));
});

test('rejects unexpected request fields and key-like smuggling', () => {
  assert.throws(() => parseOffscreenParseRequest(request({ dek: 'secret' })), /unexpected field/);
  assert.throws(() => parseOffscreenParseRequest(request({ bytes: new ArrayBuffer(5) })), /unexpected field/);
  assert.throws(() => parseOffscreenParseRequest(request({ operation: 'LIST_DOCUMENTS' })), /unexpected field/);
});

test('rejects malformed request identity and format fields', () => {
  assert.throws(() => parseOffscreenParseRequest(null), /object/);
  assert.throws(() => parseOffscreenParseRequest(request({ protocol: 2 })), /protocol/);
  assert.throws(() => parseOffscreenParseRequest(request({ requestId: 'short' })), /requestId/);
  assert.throws(() => parseOffscreenParseRequest(request({ requestId: 'bad id with spaces' })), /requestId/);
  assert.throws(() => parseOffscreenParseRequest(request({ parserVersion: 99 })), /Parser version/);
  assert.throws(() => parseOffscreenParseRequest(request({ format: 'jpg', fileName: 'test.jpg' })), /format/);
  assert.throws(() => parseOffscreenParseRequest(request({ fileName: 'test.txt' })), /fileName/);
  assert.throws(() => parseOffscreenParseRequest(request({ ocrLanguage: '' })), /ocrLanguage/);
  assert.throws(() => parseOffscreenParseRequest(request({ ocrLanguage: 'x'.repeat(41) })), /ocrLanguage/);
  assert.throws(() => parseOffscreenParseRequest(request({ ocrLanguage: 'eng+hin' })), /not bundled/);
});

test('rejects oversized requests and base64/size mismatches', () => {
  assert.throws(() => parseOffscreenParseRequest(request({ sizeBytes: MAX_DOCUMENT_BYTES + 1 })), /sizeBytes/);
  assert.throws(() => parseOffscreenParseRequest(request({ sizeBytes: 6 })), /sizeBytes/);
  assert.throws(() => parseOffscreenParseRequest(request({ dataBase64: 'not base64!' })), /base64/);
  assert.throws(() => parseOffscreenParseRequest(request({ dataBase64: 'aGVsbG8' })), /base64/);
});

test('accepts worker requests with an ArrayBuffer of the declared size', () => {
  const bytes = new TextEncoder().encode('hello').buffer as ArrayBuffer;
  const parsed = parseWorkerParseRequest({
    type: 'PARSE_DOCUMENT',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: 'parse_12345678-abcd',
    parserVersion: OFFSCREEN_PARSER_VERSION,
    format: 'txt',
    fileName: 'test.txt',
    sizeBytes: bytes.byteLength,
    ocrLanguage: 'eng',
    bytes,
  });
  assert.equal(parsed.bytes.byteLength, 5);
  assert.throws(() => parseWorkerParseRequest({ ...parsed, sizeBytes: 6 }), /bytes/);
  assert.throws(() => parseWorkerParseRequest({ ...parsed, extra: true }), /unexpected field/);
});

test('validates cancel requests', () => {
  assert.deepEqual(parseOffscreenCancelRequest({
    type: 'CANCEL_PARSE',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: 'parse_12345678-abcd',
  }), {
    type: 'CANCEL_PARSE',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: 'parse_12345678-abcd',
  });
  assert.throws(() => parseOffscreenCancelRequest({ type: 'CANCEL_PARSE', protocol: 1, requestId: 'x' }), /requestId/);
  assert.throws(() => parseOffscreenCancelRequest({ type: 'CANCEL_PARSE', protocol: 1, requestId: 'parse_12345678-abcd', dek: 'x' }), /unexpected field/);
});

test('validates bounded progress messages', () => {
  assert.deepEqual(parseOffscreenProgressMessage({
    type: 'PARSE_PROGRESS',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: 'parse_12345678-abcd',
    progress: 50,
    page: 1,
    totalPages: 2,
  }), {
    type: 'PARSE_PROGRESS',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: 'parse_12345678-abcd',
    progress: 50,
    page: 1,
    totalPages: 2,
  });
  assert.throws(() => parseOffscreenProgressMessage({
    type: 'PARSE_PROGRESS', protocol: 1, requestId: 'parse_12345678-abcd', progress: 101,
  }), /progress/);
  assert.throws(() => parseOffscreenProgressMessage({
    type: 'PARSE_PROGRESS', protocol: 1, requestId: 'parse_12345678-abcd', progress: 10, page: 3, totalPages: 2,
  }), /exceeds/);
  assert.throws(() => parseOffscreenProgressMessage({
    type: 'PARSE_PROGRESS', protocol: 1, requestId: 'parse_12345678-abcd', progress: 10, page: 1,
  }), /together/);
  assert.throws(() => parseOffscreenProgressMessage({
    type: 'PARSE_PROGRESS', protocol: 1, requestId: 'parse_12345678-abcd', progress: 10, key: 'secret',
  }), /unexpected field/);
  assert.deepEqual(parseOffscreenProgressMessage({
    type: 'PARSE_PROGRESS',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: 'parse_12345678-abcd',
    progress: 75,
    page: 2,
    totalPages: 4,
    stage: 'ocr',
  }), {
    type: 'PARSE_PROGRESS',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: 'parse_12345678-abcd',
    progress: 75,
    page: 2,
    totalPages: 4,
    stage: 'ocr',
  });
  assert.throws(() => parseOffscreenProgressMessage({
    type: 'PARSE_PROGRESS', protocol: 1, requestId: 'parse_12345678-abcd', progress: 10, stage: 'other',
  }), /stage/);
});

test('validates result structure, page boundaries, warnings, and metadata', () => {
  const parsed = parseOffscreenParserResult(result(), 'pdf');
  assert.equal(parsed.pageCount, 1);
  assert.equal(parsed.metadata.title, 'Fixture');
  assert.throws(() => parseOffscreenParserResult(result({ pageCount: 2 })), /page count/);
  assert.throws(() => parseOffscreenParserResult(result({ method: 'docx' }), 'pdf'), /method/);
  assert.throws(() => parseOffscreenParserResult(result({ extra: true })), /unexpected field/);
  assert.throws(() => parseOffscreenParserResult(result({ metadata: { extra: 'x' } })), /unexpected field/);
  assert.throws(() => parseOffscreenParserResult(result({ warnings: Array.from({ length: 101 }, () => ({ code: 'X', message: 'warning' })) })), /warnings/);
  assert.throws(() => parseOffscreenParserResult(result({ ocrRequired: true, pagesNeedingOcr: [] })), /OCR/);
  assert.throws(() => parseOffscreenParserResult(result({ text: '', pageTexts: [''], warnings: [] })), /empty text/);
  assert.throws(() => parseOffscreenParserResult(result({ text: 'x'.repeat(MAX_EXTRACTED_TEXT_CHARS + 1) })), /text/);
});

test('validates structured extraction payloads exactly', () => {
  const parsed = parseOffscreenParserResult(result({ structure: structure() }), 'pdf');
  assert.equal(parsed.structure?.schemaVersion, 1);
  assert.equal(parsed.structure?.blocks[0]?.provenance, 'pdf_native');
  assert.equal(parsed.structure?.pagination?.status, 'explicit_breaks');
  assert.throws(() => parseOffscreenParserResult(result({ structure: structure({ extra: true }) }), 'pdf'), /unexpected property/);
  assert.throws(() => parseOffscreenParserResult(result({ structure: structure({ metadata: { ...structure().metadata, blockCount: 2 } }) }), 'pdf'), /counts/);
  assert.throws(() => parseOffscreenParserResult(result({
    structure: structure({
      blocks: [{ ...structure().blocks[0], blockId: 'p1_b1' }, structure().blocks[0]],
    }),
  }), 'pdf'), /duplicate block/);
  assert.throws(() => parseOffscreenParserResult(result({
    structure: structure({ readingOrder: ['missing'] }),
  }), 'pdf'), /unknown block/);
});

test('rejects oversized parser result messages', () => {
  const huge = 'x'.repeat(MAX_EXTRACTED_TEXT_CHARS);
  const message = {
    type: 'PARSE_RESULT',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: 'parse_12345678-abcd',
    result: result({ text: huge, pageTexts: [huge, huge], pageCount: 2 }),
  };
  assert.throws(() => parseOffscreenResultMessage(message, 'pdf'), /response size/);
});

test('validates parser result and error messages exactly', () => {
  const message = {
    type: 'PARSE_RESULT',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: 'parse_12345678-abcd',
    result: result(),
  };
  assert.equal(parseOffscreenResultMessage(message, 'pdf').result.pageCount, 1);
  assert.throws(() => parseOffscreenResultMessage({ ...message, extra: true }, 'pdf'), /unexpected field/);
  assert.throws(() => parseOffscreenResultMessage({ ...message, result: result({ text: '' , pageTexts: [''] }) }, 'pdf'), /empty text/);
  assert.deepEqual(parseOffscreenErrorMessage({
    type: 'PARSE_ERROR',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: 'parse_12345678-abcd',
    error: { code: 'CANCELLED', message: 'Cancelled' },
  }), {
    type: 'PARSE_ERROR',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: 'parse_12345678-abcd',
    error: { code: 'CANCELLED', message: 'Cancelled' },
  });
  assert.throws(() => parseOffscreenErrorMessage({
    type: 'PARSE_ERROR', protocol: 1, requestId: 'parse_12345678-abcd', error: { code: 'NOT_A_CODE', message: 'x' },
  }), /error code/);
  assert.throws(() => parseOffscreenErrorMessage({
    type: 'PARSE_ERROR', protocol: 1, requestId: 'parse_12345678-abcd', error: { code: 'CANCELLED', message: 'x', dek: 'secret' },
  }), /unexpected field/);
});

test('maps parser failures without leaking arbitrary objects', () => {
  const known = new FormFlowError('PASSWORD_PROTECTED', 'Protected');
  assert.deepEqual(parserErrorFromUnknown(known), { code: 'PASSWORD_PROTECTED', message: 'Protected' });
  const unknown = new FormFlowError('BACKUP_INVALID' as never, 'x');
  assert.equal(parserErrorFromUnknown(unknown).code, 'EXTRACTION_FAILED');
});
