import { MAX_DOCUMENT_BYTES, SUPPORTED_EXTENSIONS } from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type { FileKind } from '@shared/types';

export interface ValidatedFile {
  file: File;
  fileType: FileKind;
  mimeType: string;
  extension: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
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

export function validateDocumentFile(file: File): ValidatedFile {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!SUPPORTED_EXTENSIONS.includes(extension as (typeof SUPPORTED_EXTENSIONS)[number])) {
    throw new FormFlowError('UNSUPPORTED_FILE', `${file.name} is not a supported format. Use PDF, DOCX, TXT, JPG, or PNG.`);
  }
  if (file.size <= 0) {
    throw new FormFlowError('UNSUPPORTED_FILE', `${file.name} is empty.`);
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new FormFlowError('FILE_TOO_LARGE', `${file.name} is larger than the 20 MB local processing limit.`);
  }
  const mimeType = MIME_BY_EXTENSION[extension] ?? file.type ?? 'application/octet-stream';
  return { file, fileType: inferFileKind(file.name), mimeType, extension };
}

export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

export function isTextEmpty(text: string): boolean {
  return text.replace(/\s+/g, '').length < 12;
}
