import {
  MAX_DOCUMENT_BYTES,
  MAX_EXTRACTED_TEXT_CHARS,
  MAX_EXTRACTION_WARNINGS,
  MAX_PDF_PAGES,
} from './constants';
import { FormFlowError } from './errors';
import type {
  DocumentExtractionMetadata,
  ExtractionWarning,
} from './types';

export const OFFSCREEN_PARSER_PORT = 'formflow-offscreen-parser';
export const OFFSCREEN_PARSER_DOCUMENT = 'offscreen-parser.html';
export const OFFSCREEN_PARSER_WORKER = 'document-parser.worker.js';
export const OFFSCREEN_PARSER_PROTOCOL_VERSION = 1;
export const OFFSCREEN_PARSER_VERSION = 1;
export const OFFSCREEN_PARSER_MAX_CONCURRENT = 2;

export function isOffscreenParserDocumentUrl(url: string | undefined, extensionId: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'chrome-extension:'
      && parsed.host === extensionId
      && parsed.pathname === `/${OFFSCREEN_PARSER_DOCUMENT}`;
  } catch {
    return false;
  }
}
/** text + pageTexts duplicate most PDF text in memory, so allow both sides. */
export const OFFSCREEN_PARSER_MAX_RESULT_CHARS = MAX_EXTRACTED_TEXT_CHARS * 2 + 100_000;

export type OffscreenParserFormat = 'pdf' | 'docx' | 'txt';
export type OffscreenParserOperation =
  | 'PARSE_DOCUMENT'
  | 'CANCEL_PARSE'
  | 'PARSE_PROGRESS'
  | 'PARSE_RESULT'
  | 'PARSE_ERROR';

export interface OffscreenParseRequest {
  type: 'PARSE_DOCUMENT';
  protocol: typeof OFFSCREEN_PARSER_PROTOCOL_VERSION;
  requestId: string;
  parserVersion: number;
  format: OffscreenParserFormat;
  fileName: string;
  sizeBytes: number;
  /** Chrome extension ports use JSON serialization; bytes travel as base64. */
  dataBase64: string;
}

export interface WorkerParseRequest {
  type: 'PARSE_DOCUMENT';
  protocol: typeof OFFSCREEN_PARSER_PROTOCOL_VERSION;
  requestId: string;
  parserVersion: number;
  format: OffscreenParserFormat;
  fileName: string;
  sizeBytes: number;
  bytes: ArrayBuffer;
}

export interface OffscreenCancelRequest {
  type: 'CANCEL_PARSE';
  protocol: typeof OFFSCREEN_PARSER_PROTOCOL_VERSION;
  requestId: string;
}

export interface OffscreenProgressMessage {
  type: 'PARSE_PROGRESS';
  protocol: typeof OFFSCREEN_PARSER_PROTOCOL_VERSION;
  requestId: string;
  progress: number;
  page?: number;
  totalPages?: number;
}

export interface OffscreenResultMessage {
  type: 'PARSE_RESULT';
  protocol: typeof OFFSCREEN_PARSER_PROTOCOL_VERSION;
  requestId: string;
  result: OffscreenParserResult;
}

export interface OffscreenErrorMessage {
  type: 'PARSE_ERROR';
  protocol: typeof OFFSCREEN_PARSER_PROTOCOL_VERSION;
  requestId: string;
  error: { code: string; message: string };
}

export interface OffscreenParserResult {
  text: string;
  pageTexts: string[];
  pageCount: number;
  method: 'pdf-text' | 'docx' | 'txt';
  version: number;
  ocrRequired: boolean;
  pagesNeedingOcr: number[];
  warnings: ExtractionWarning[];
  metadata: DocumentExtractionMetadata;
}

export type OffscreenInboundMessage = OffscreenParseRequest | OffscreenCancelRequest;
export type OffscreenOutboundMessage = OffscreenProgressMessage | OffscreenResultMessage | OffscreenErrorMessage;

const FORMATS = new Set<OffscreenParserFormat>(['pdf', 'docx', 'txt']);
const METHODS: Record<OffscreenParserFormat, OffscreenParserResult['method']> = {
  pdf: 'pdf-text',
  docx: 'docx',
  txt: 'txt',
};
const ERROR_CODES = new Set([
  'CANCELLED',
  'EXTRACTION_FAILED',
  'EXTRACTION_TIMEOUT',
  'EXTRACTION_TOO_LARGE',
  'EMPTY_DOCUMENT',
  'CORRUPTED_DOCUMENT',
  'PASSWORD_PROTECTED',
  'INVALID_ENCODING',
  'PARSER_UNAVAILABLE',
  'PARSER_BUSY',
  'PARSER_PROTOCOL_ERROR',
  'UNSUPPORTED_FILE',
  'UNKNOWN',
]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,120}$/;
const REQUEST_KEYS = ['type', 'protocol', 'requestId', 'parserVersion', 'format', 'fileName', 'sizeBytes', 'dataBase64'];
const CANCEL_KEYS = ['type', 'protocol', 'requestId'];
const PROGRESS_KEYS = ['type', 'protocol', 'requestId', 'progress', 'page', 'totalPages'];
const RESULT_MESSAGE_KEYS = ['type', 'protocol', 'requestId', 'result'];
const ERROR_MESSAGE_KEYS = ['type', 'protocol', 'requestId', 'error'];
const RESULT_KEYS = ['text', 'pageTexts', 'pageCount', 'method', 'version', 'ocrRequired', 'pagesNeedingOcr', 'warnings', 'metadata'];
const WARNING_KEYS = ['code', 'message', 'page'];
const METADATA_KEYS = ['title', 'author', 'subject', 'keywords', 'creator', 'producer', 'creationDate', 'modDate', 'headings', 'tableCount', 'rowCount', 'encoding', 'bom', 'lineEndings'];
const HEADING_KEYS = ['level', 'text'];

function protocolError(message: string): FormFlowError {
  return new FormFlowError('PARSER_PROTOCOL_ERROR', message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw protocolError(`${label} contains an unexpected field.`);
  }
}

function assertString(value: unknown, label: string, min = 1, max = 10_000_000): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw protocolError(`${label} is invalid.`);
  }
  return value;
}

function assertInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw protocolError(`${label} is out of range.`);
  }
  return value;
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw protocolError(`${label} must be a boolean.`);
  return value;
}

function assertFormat(value: unknown): OffscreenParserFormat {
  if (typeof value !== 'string' || !FORMATS.has(value as OffscreenParserFormat)) {
    throw protocolError('Document format is not supported.');
  }
  return value as OffscreenParserFormat;
}

function assertRequestId(value: unknown): string {
  const requestId = assertString(value, 'requestId', 8, 120);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw protocolError('requestId has an invalid format.');
  return requestId;
}

function assertProtocol(value: unknown): void {
  if (value !== OFFSCREEN_PARSER_PROTOCOL_VERSION) throw protocolError('Parser protocol version is unsupported.');
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

export function parseOffscreenParseRequest(value: unknown): OffscreenParseRequest {
  if (!isObject(value)) throw protocolError('Parser request must be an object.');
  assertExactKeys(value, REQUEST_KEYS, 'Parser request');
  if (value.type !== 'PARSE_DOCUMENT') throw protocolError('Parser request operation is unsupported.');
  assertProtocol(value.protocol);
  const requestId = assertRequestId(value.requestId);
  if (value.parserVersion !== OFFSCREEN_PARSER_VERSION) throw protocolError('Parser version is unsupported.');
  const format = assertFormat(value.format);
  const fileName = assertString(value.fileName, 'fileName', 1, 255);
  if (fileName.split('.').pop()?.toLowerCase() !== format) {
    throw protocolError('fileName does not match the document format.');
  }
  const sizeBytes = assertInteger(value.sizeBytes, 'sizeBytes', 1, MAX_DOCUMENT_BYTES);
  const dataBase64 = assertString(
    value.dataBase64,
    'dataBase64',
    1,
    Math.ceil(MAX_DOCUMENT_BYTES * 4 / 3) + 16,
  );
  if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    throw protocolError('dataBase64 is not valid base64.');
  }
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0;
  const decodedBytes = (dataBase64.length / 4) * 3 - padding;
  if (decodedBytes !== sizeBytes) throw protocolError('Document bytes do not match sizeBytes.');
  return {
    type: 'PARSE_DOCUMENT',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId,
    parserVersion: OFFSCREEN_PARSER_VERSION,
    format,
    fileName,
    sizeBytes,
    dataBase64,
  };
}

export function parseWorkerParseRequest(value: unknown): WorkerParseRequest {
  if (!isObject(value)) throw protocolError('Worker parser request must be an object.');
  assertExactKeys(value, ['type', 'protocol', 'requestId', 'parserVersion', 'format', 'fileName', 'sizeBytes', 'bytes'], 'Worker parser request');
  if (value.type !== 'PARSE_DOCUMENT') throw protocolError('Worker parser operation is unsupported.');
  assertProtocol(value.protocol);
  const requestId = assertRequestId(value.requestId);
  if (value.parserVersion !== OFFSCREEN_PARSER_VERSION) throw protocolError('Parser version is unsupported.');
  const format = assertFormat(value.format);
  const fileName = assertString(value.fileName, 'fileName', 1, 255);
  if (fileName.split('.').pop()?.toLowerCase() !== format) {
    throw protocolError('fileName does not match the document format.');
  }
  const sizeBytes = assertInteger(value.sizeBytes, 'sizeBytes', 1, MAX_DOCUMENT_BYTES);
  if (!isArrayBuffer(value.bytes) || value.bytes.byteLength !== sizeBytes) {
    throw protocolError('Worker document bytes do not match sizeBytes.');
  }
  return {
    type: 'PARSE_DOCUMENT',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId,
    parserVersion: OFFSCREEN_PARSER_VERSION,
    format,
    fileName,
    sizeBytes,
    bytes: value.bytes,
  };
}

export function parseOffscreenCancelRequest(value: unknown): OffscreenCancelRequest {
  if (!isObject(value)) throw protocolError('Cancel request must be an object.');
  assertExactKeys(value, CANCEL_KEYS, 'Cancel request');
  if (value.type !== 'CANCEL_PARSE') throw protocolError('Cancel operation is unsupported.');
  assertProtocol(value.protocol);
  return {
    type: 'CANCEL_PARSE',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: assertRequestId(value.requestId),
  };
}

export function parseOffscreenProgressMessage(value: unknown): OffscreenProgressMessage {
  if (!isObject(value)) throw protocolError('Progress message must be an object.');
  assertExactKeys(value, PROGRESS_KEYS, 'Progress message');
  if (value.type !== 'PARSE_PROGRESS') throw protocolError('Progress operation is unsupported.');
  assertProtocol(value.protocol);
  const requestId = assertRequestId(value.requestId);
  const progress = assertInteger(value.progress, 'progress', 0, 100);
  const hasPage = value.page !== undefined;
  const hasTotal = value.totalPages !== undefined;
  if (hasPage !== hasTotal) throw protocolError('Progress page and totalPages must be supplied together.');
  if (hasPage) {
    const page = assertInteger(value.page, 'page', 1, MAX_PDF_PAGES);
    const totalPages = assertInteger(value.totalPages, 'totalPages', 1, MAX_PDF_PAGES);
    if (page > totalPages) throw protocolError('Progress page exceeds totalPages.');
    return {
      type: 'PARSE_PROGRESS',
      protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
      requestId,
      progress,
      page,
      totalPages,
    };
  }
  return {
    type: 'PARSE_PROGRESS',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId,
    progress,
  };
}

function parseWarning(value: unknown, pageCount: number): ExtractionWarning {
  if (!isObject(value)) throw protocolError('Parser warning is invalid.');
  assertExactKeys(value, WARNING_KEYS, 'Parser warning');
  const warning: ExtractionWarning = {
    code: assertString(value.code, 'warning code', 1, 80),
    message: assertString(value.message, 'warning message', 1, 500),
  };
  if (value.page !== undefined) {
    warning.page = assertInteger(value.page, 'warning page', 1, pageCount);
  }
  return warning;
}

function parseMetadata(value: unknown): DocumentExtractionMetadata {
  if (!isObject(value)) throw protocolError('Parser metadata is invalid.');
  assertExactKeys(value, METADATA_KEYS, 'Parser metadata');
  const metadata: DocumentExtractionMetadata = {};
  const textFields: Array<[keyof DocumentExtractionMetadata, number]> = [
    ['title', 500],
    ['author', 300],
    ['subject', 1000],
    ['keywords', 1000],
    ['creator', 300],
    ['producer', 300],
    ['creationDate', 80],
    ['modDate', 80],
    ['encoding', 40],
  ];
  for (const [key, max] of textFields) {
    if (value[key] !== undefined) metadata[key] = assertString(value[key], `metadata ${String(key)}`, 0, max) as never;
  }
  if (value.headings !== undefined) {
    if (!Array.isArray(value.headings) || value.headings.length > 200) throw protocolError('Parser headings are oversized.');
    metadata.headings = value.headings.map((entry, index) => {
      if (!isObject(entry)) throw protocolError(`Parser heading ${index} is invalid.`);
      assertExactKeys(entry, HEADING_KEYS, `Parser heading ${index}`);
      return {
        level: assertInteger(entry.level, `heading ${index} level`, 1, 9),
        text: assertString(entry.text, `heading ${index} text`, 0, 500),
      };
    });
  }
  if (value.tableCount !== undefined) metadata.tableCount = assertInteger(value.tableCount, 'metadata tableCount', 0, 100_000);
  if (value.rowCount !== undefined) metadata.rowCount = assertInteger(value.rowCount, 'metadata rowCount', 0, 1_000_000);
  if (value.bom !== undefined) metadata.bom = assertBoolean(value.bom, 'metadata bom');
  if (value.lineEndings !== undefined) {
    if (value.lineEndings !== 'lf' && value.lineEndings !== 'crlf' && value.lineEndings !== 'mixed') {
      throw protocolError('metadata lineEndings is invalid.');
    }
    metadata.lineEndings = value.lineEndings;
  }
  return metadata;
}

export function parseOffscreenParserResult(value: unknown, expectedFormat?: OffscreenParserFormat): OffscreenParserResult {
  if (!isObject(value)) throw protocolError('Parser result must be an object.');
  assertExactKeys(value, RESULT_KEYS, 'Parser result');
  const text = assertString(value.text, 'Parser text', 0, MAX_EXTRACTED_TEXT_CHARS);
  if (!Array.isArray(value.pageTexts) || value.pageTexts.length < 1 || value.pageTexts.length > MAX_PDF_PAGES) {
    throw protocolError('Parser pageTexts is invalid.');
  }
  const pageTexts = value.pageTexts.map((page, index) => assertString(page, `pageTexts[${index}]`, 0, MAX_EXTRACTED_TEXT_CHARS));
  const pageCount = assertInteger(value.pageCount, 'pageCount', 1, MAX_PDF_PAGES);
  if (pageCount !== pageTexts.length) throw protocolError('Parser page count does not match pageTexts.');
  const totalChars = text.length + pageTexts.reduce((sum, page) => sum + page.length, 0);
  if (totalChars > OFFSCREEN_PARSER_MAX_RESULT_CHARS) throw protocolError('Parser result exceeds the response size limit.');
  const method = value.method;
  if (method !== 'pdf-text' && method !== 'docx' && method !== 'txt') throw protocolError('Parser method is invalid.');
  if (expectedFormat && method !== METHODS[expectedFormat]) throw protocolError('Parser method does not match the requested format.');
  if (value.version !== OFFSCREEN_PARSER_VERSION) throw protocolError('Parser result version is unsupported.');
  const ocrRequired = assertBoolean(value.ocrRequired, 'ocrRequired');
  if (!Array.isArray(value.pagesNeedingOcr) || value.pagesNeedingOcr.length > pageCount) {
    throw protocolError('Parser OCR page list is invalid.');
  }
  const pagesNeedingOcr = value.pagesNeedingOcr.map((page, index) => assertInteger(page, `pagesNeedingOcr[${index}]`, 1, pageCount));
  if (new Set(pagesNeedingOcr).size !== pagesNeedingOcr.length) throw protocolError('Parser OCR page list contains duplicates.');
  if (ocrRequired && pagesNeedingOcr.length === 0) throw protocolError('Parser marked OCR required without pages.');
  if (!ocrRequired && text.length === 0) throw protocolError('Parser returned empty text without OCR-required state.');
  if (!Array.isArray(value.warnings) || value.warnings.length > MAX_EXTRACTION_WARNINGS) {
    throw protocolError('Parser warnings are oversized.');
  }
  const warnings = value.warnings.map((warning) => parseWarning(warning, pageCount));
  const metadata = parseMetadata(value.metadata);
  return {
    text,
    pageTexts,
    pageCount,
    method,
    version: OFFSCREEN_PARSER_VERSION,
    ocrRequired,
    pagesNeedingOcr,
    warnings,
    metadata,
  };
}

export function parseOffscreenResultMessage(value: unknown, expectedFormat?: OffscreenParserFormat): OffscreenResultMessage {
  if (!isObject(value)) throw protocolError('Parser result message must be an object.');
  assertExactKeys(value, RESULT_MESSAGE_KEYS, 'Parser result message');
  if (value.type !== 'PARSE_RESULT') throw protocolError('Parser result operation is unsupported.');
  assertProtocol(value.protocol);
  return {
    type: 'PARSE_RESULT',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: assertRequestId(value.requestId),
    result: parseOffscreenParserResult(value.result, expectedFormat),
  };
}

export function parseOffscreenErrorMessage(value: unknown): OffscreenErrorMessage {
  if (!isObject(value)) throw protocolError('Parser error message must be an object.');
  assertExactKeys(value, ERROR_MESSAGE_KEYS, 'Parser error message');
  if (value.type !== 'PARSE_ERROR') throw protocolError('Parser error operation is unsupported.');
  assertProtocol(value.protocol);
  if (!isObject(value.error)) throw protocolError('Parser error payload is invalid.');
  assertExactKeys(value.error, ['code', 'message'], 'Parser error payload');
  const code = assertString(value.error.code, 'Parser error code', 1, 80);
  if (!ERROR_CODES.has(code)) throw protocolError('Parser error code is unsupported.');
  return {
    type: 'PARSE_ERROR',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId: assertRequestId(value.requestId),
    error: {
      code,
      message: assertString(value.error.message, 'Parser error message', 1, 500),
    },
  };
}

export function parserErrorFromUnknown(error: unknown): { code: string; message: string } {
  if (error instanceof FormFlowError) {
    return {
      code: ERROR_CODES.has(error.code) ? error.code : 'EXTRACTION_FAILED',
      message: error.message.slice(0, 500),
    };
  }
  if (error instanceof Error) {
    return {
      code: error.name === 'AbortError' ? 'CANCELLED' : 'EXTRACTION_FAILED',
      message: (error.message || 'Document parsing failed.').slice(0, 500),
    };
  }
  return { code: 'EXTRACTION_FAILED', message: 'Document parsing failed.' };
}
