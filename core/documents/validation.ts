import {
  INGESTIBLE_EXTENSIONS,
  MAX_DOCUMENT_BYTES,
  SUPPORTED_EXTENSIONS,
} from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type { FileKind } from '@shared/types';

export type DocumentFormat = 'pdf' | 'docx' | 'txt';

export interface DocumentDescriptor {
  file: File;
  fileType: FileKind;
  format: DocumentFormat;
  mimeType: string;
  extension: DocumentFormat;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

const ALLOWED_BROWSER_MIME: Record<DocumentFormat, Set<string>> = {
  pdf: new Set(['application/pdf', 'application/x-pdf', 'application/octet-stream']),
  docx: new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'application/octet-stream',
  ]),
  txt: new Set(['text/plain', 'application/octet-stream']),
};

export function inferFileKind(name: string): FileKind {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'docx') return 'docx';
  if (extension === 'txt') return 'txt';
  if (extension === 'jpg') return 'jpg';
  if (extension === 'jpeg') return 'jpeg';
  if (extension === 'png') return 'png';
  return 'other';
}

function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function normalizedMime(file: File): string {
  return (file.type || '').toLowerCase().split(';')[0]?.trim() ?? '';
}

/**
 * Validates the user-visible descriptor before any bytes are read.
 * The browser-provided MIME type is treated as a hint only; the content
 * signature is validated separately by `validateDocumentBytes`.
 */
export function validateDocumentFile(file: File): DocumentDescriptor {
  const extension = extensionOf(file.name);
  if (!INGESTIBLE_EXTENSIONS.includes(extension as (typeof INGESTIBLE_EXTENSIONS)[number])) {
    throw new FormFlowError(
      'UNSUPPORTED_FILE',
      `${file.name || 'This file'} is not a supported format. Use PDF, DOCX, or TXT.`,
    );
  }
  if (file.size <= 0) {
    throw new FormFlowError('EMPTY_DOCUMENT', `${file.name} is empty.`);
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new FormFlowError(
      'FILE_TOO_LARGE',
      `${file.name} is larger than the 20 MB local processing limit.`,
    );
  }
  const format = extension as DocumentFormat;
  const browserMime = normalizedMime(file);
  if (browserMime && !ALLOWED_BROWSER_MIME[format].has(browserMime)) {
    throw new FormFlowError(
      'UNSUPPORTED_FILE',
      `${file.name} reports a MIME type that does not match its ${format.toUpperCase()} extension.`,
    );
  }
  return {
    file,
    fileType: inferFileKind(file.name),
    format,
    mimeType: MIME_BY_EXTENSION[format] ?? 'application/octet-stream',
    extension: format,
  };
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function indexOfAscii(bytes: Uint8Array, text: string, limit = 1024): number {
  const needle = Array.from(text, (character) => character.charCodeAt(0));
  const end = Math.min(bytes.byteLength, limit);
  for (let index = 0; index <= end - needle.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

export function hasPdfSignature(bytes: Uint8Array): boolean {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return true;
  // Permit a small amount of leading whitespace before %PDF-, which some
  // generators emit while still producing a valid PDF.
  return indexOfAscii(bytes, '%PDF-') >= 0;
}

export function hasZipSignature(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
    || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
    || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
}

/** Content signature validation that does not need File/DOM APIs. */
export function validateDocumentContentSignature(
  bytes: Uint8Array,
  format: DocumentFormat,
  fileName = 'document',
): void {
  if (bytes.byteLength <= 0) {
    throw new FormFlowError('EMPTY_DOCUMENT', `${fileName} is empty.`);
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new FormFlowError('FILE_TOO_LARGE', `${fileName} exceeds the 20 MB local processing limit.`);
  }
  if (format === 'pdf') {
    if (!hasPdfSignature(bytes)) {
      throw new FormFlowError('UNSUPPORTED_FILE', `${fileName} does not contain a valid PDF signature.`);
    }
    return;
  }
  if (format === 'docx') {
    if (!hasZipSignature(bytes)) {
      throw new FormFlowError('UNSUPPORTED_FILE', `${fileName} does not contain a valid DOCX container signature.`);
    }
    return;
  }
  if (hasPdfSignature(bytes) || hasZipSignature(bytes)) {
    throw new FormFlowError('UNSUPPORTED_FILE', `${fileName} looks like a binary document, not UTF-8 text.`);
  }
  const prefix = bytes.subarray(0, Math.min(bytes.byteLength, 8192));
  if (prefix.includes(0)) {
    throw new FormFlowError('INVALID_ENCODING', `${fileName} contains binary data rather than UTF-8 text.`);
  }
}

/**
 * Content validation for the supported formats. Renaming a different file
 * type to .pdf/.docx/.txt is rejected here before parsing or persistence.
 */
export function validateDocumentBytes(bytes: Uint8Array, descriptor: DocumentDescriptor): void {
  validateDocumentContentSignature(bytes, descriptor.format, descriptor.file.name);
}

/** Kept for older callers that only need the legacy extension list. */
export function isLegacySupportedExtension(extension: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(extension as (typeof SUPPORTED_EXTENSIONS)[number]);
}

export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

export function isTextEmpty(text: string): boolean {
  return text.replace(/\s+/g, '').length < 12;
}
