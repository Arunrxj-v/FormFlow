import type {
  DocumentExtractionDetails,
  DocumentExtractionMetadata,
  ExtractionWarning,
} from '@shared/types';

export type DocumentFormat = 'pdf' | 'docx' | 'txt';

export interface DocumentParseInput {
  format: DocumentFormat;
  bytes: ArrayBuffer;
  fileName: string;
  signal?: AbortSignal;
  onPage?: (page: number, total: number) => void;
}

export interface DocumentParseResult extends DocumentExtractionDetails {
  text: string;
  pageTexts: string[];
  pageCount: number;
  method: 'pdf-text' | 'docx' | 'txt';
}

export interface DocumentParser {
  (input: DocumentParseInput): Promise<DocumentParseResult>;
}

export function warning(code: string, message: string, page?: number): ExtractionWarning {
  return page === undefined ? { code, message } : { code, message, page };
}

export function emptyMetadata(): DocumentExtractionMetadata {
  return {};
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Document processing was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}
