import { EXTRACTION_VERSION, MAX_EXTRACTED_TEXT_CHARS, MAX_EXTRACTION_TIMEOUT_MS } from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type {
  DocumentCategory,
  DocumentExtractionDetails,
  DocumentRecord,
  ExtractionWarning,
  VaultDocument,
} from '@shared/types';
import { documentRepository, toVaultDocument } from '../database/repositories';
import { vaultRepository as vaultRecordRepository } from '../database/vault-repository';
import { activityRepository } from '../database/repositories';
import { sha256Hex } from '../encryption/crypto-service';
import { asStorageError } from '../storage/storage-errors';
import {
  formatSize,
  validateDocumentBytes,
  validateDocumentFile,
  type DocumentDescriptor,
} from '../documents/validation';
import type { DocumentParseResult, DocumentParser } from '../documents/parsers/types';
import { sanitizeMetadata, sanitizeWarnings } from '../documents/text-utils';

export type DocumentIngestionStage =
  | 'validating'
  | 'checksumming'
  | 'duplicate'
  | 'encrypting'
  | 'extracting_text'
  | 'running_ocr'
  | 'encrypting_text'
  | 'storing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DocumentIngestionProgress {
  stage: DocumentIngestionStage;
  progress: number;
  message: string;
  page?: number;
  totalPages?: number;
}

export interface DocumentImportInput {
  file: File;
  category?: DocumentCategory;
  subcategory?: string;
  ocrLanguage?: string;
  signal?: AbortSignal;
  onProgress?: (event: DocumentIngestionProgress) => void;
}

export interface DocumentIngestionDependencies {
  parse?: DocumentParser;
  signal?: AbortSignal;
  onProgress?: (event: DocumentIngestionProgress) => void;
  ocrLanguage?: string;
  /** Test/administrative override for the bounded local parser timeout. */
  timeoutMs?: number;
}

export interface DocumentImportOutcome {
  document: VaultDocument;
  duplicate: boolean;
}

function report(
  callback: DocumentIngestionDependencies['onProgress'],
  stage: DocumentIngestionStage,
  progress: number,
  message: string,
  extra: { page?: number; totalPages?: number } = {},
): void {
  callback?.({ stage, progress: Math.max(0, Math.min(100, Math.round(progress))), message, ...extra });
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FormFlowError('CANCELLED', 'Document processing was cancelled.');
}

function inferCategoryFromName(name: string): DocumentCategory {
  const lower = name.toLowerCase();
  if (/degree|certificate|mark|school|college|university|transcript/.test(lower)) return 'Education';
  if (/passport|aadhaar|aadhar|pan|licen|id|voter/.test(lower)) return 'Identity';
  if (/resume|offer|employ|intern|cv|recommendation/.test(lower)) return 'Employment';
  if (/bill|utility|statement|invoice|tax/.test(lower)) return 'Financial';
  if (/address|proof|residence/.test(lower)) return 'Address proofs';
  return 'Other';
}

function validateParseResult(result: DocumentParseResult, descriptor: DocumentDescriptor): DocumentParseResult {
  if (!result || typeof result !== 'object') {
    throw new FormFlowError('EXTRACTION_FAILED', 'The parser returned an invalid result.');
  }
  if (!Array.isArray(result.pageTexts) || result.pageTexts.some((page) => typeof page !== 'string')) {
    throw new FormFlowError('EXTRACTION_FAILED', 'The parser returned invalid page text.');
  }
  if (!Number.isInteger(result.pageCount) || result.pageCount < 1) {
    throw new FormFlowError('EXTRACTION_FAILED', 'The parser returned an invalid page count.');
  }
  if (result.pageCount !== result.pageTexts.length) {
    throw new FormFlowError('EXTRACTION_FAILED', 'The parser returned inconsistent page boundaries.');
  }
  if (typeof result.text !== 'string') {
    throw new FormFlowError('EXTRACTION_FAILED', 'The parser returned invalid text.');
  }
  if (result.text.length > MAX_EXTRACTED_TEXT_CHARS) {
    throw new FormFlowError(
      'EXTRACTION_TOO_LARGE',
      `Extracted text exceeds the ${(MAX_EXTRACTED_TEXT_CHARS / 1_000_000).toFixed(0)} million character local limit.`,
    );
  }
  const method: string = result.method;
  if (descriptor.format === 'pdf') {
    if (!['pdf-text', 'ocr', 'mixed'].includes(method)) {
      throw new FormFlowError('EXTRACTION_FAILED', 'The parser method does not match the document format.');
    }
  } else if (method !== descriptor.format) {
    throw new FormFlowError('EXTRACTION_FAILED', 'The parser method does not match the document format.');
  }
  if (result.ocr) {
    if (result.ocr.status === 'completed' && (result.ocrRequired || result.pagesNeedingOcr.length > 0)) {
      throw new FormFlowError('EXTRACTION_FAILED', 'OCR completed but still reports pages requiring OCR.');
    }
    if ((result.ocr.status === 'partial' || result.ocr.status === 'failed') && !result.ocrRequired) {
      throw new FormFlowError('EXTRACTION_FAILED', 'Incomplete OCR must report pages requiring OCR.');
    }
  }
  if (!result.ocrRequired && !result.text.trim()) {
    throw new FormFlowError('EMPTY_DOCUMENT', 'No extractable text was found in this document.');
  }
  const warnings = sanitizeWarnings(Array.isArray(result.warnings) ? result.warnings : []);
  const pagesNeedingOcr = Array.from(new Set(result.pagesNeedingOcr ?? []))
    .filter((page) => Number.isInteger(page) && page >= 1 && page <= result.pageCount)
    .sort((a, b) => a - b);
  return {
    ...result,
    warnings,
    pagesNeedingOcr,
    ocrRequired: Boolean(result.ocrRequired) && pagesNeedingOcr.length > 0,
    version: Number.isInteger(result.version) ? result.version : EXTRACTION_VERSION,
    metadata: sanitizeMetadata(result.metadata ?? {}),
  };
}

function extractionDetails(result: DocumentParseResult): DocumentExtractionDetails {
  return {
    version: result.version,
    ocrRequired: result.ocrRequired,
    pagesNeedingOcr: result.pagesNeedingOcr,
    warnings: result.warnings,
    metadata: result.metadata,
    ...(result.ocr ? { ocr: result.ocr } : {}),
  };
}

function previewDocument(
  row: DocumentRecord,
  name: string,
  result: DocumentParseResult,
): VaultDocument {
  const document = toVaultDocument(row, name);
  return {
    ...document,
    extractedText: result.text.slice(0, 2_000),
    extractionWarnings: result.warnings,
  };
}

async function duplicateOutcome(existing: DocumentRecord): Promise<DocumentImportOutcome> {
  const saved = await documentRepository.get(existing.id);
  if (!saved) throw new FormFlowError('NOT_FOUND', 'The duplicate document record could not be read.');
  return { document: toVaultDocument(saved.row, saved.name), duplicate: true };
}

async function parseForDocument(
  descriptor: DocumentDescriptor,
  bytes: ArrayBuffer,
  deps: DocumentIngestionDependencies,
): Promise<DocumentParseResult> {
  const parser = deps.parse;
  if (!parser) {
    throw new FormFlowError(
      'PARSER_UNAVAILABLE',
      'No isolated document parser is configured. The background must route parsing through the offscreen parser.',
    );
  }
  const timeoutMs = Math.max(1, deps.timeoutMs ?? MAX_EXTRACTION_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onExternalAbort = () => controller.abort();
  if (deps.signal?.aborted) controller.abort();
  else deps.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new FormFlowError(
        'EXTRACTION_TIMEOUT',
        'Document extraction took too long and was stopped. The file was not imported.',
      ));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      parser({
        format: descriptor.format,
        bytes,
        fileName: descriptor.file.name,
        signal: controller.signal,
        ocrLanguage: deps.ocrLanguage ?? 'eng',
        onPage: (page, total) => {
          report(
            deps.onProgress,
            'extracting_text',
            25 + (page / Math.max(1, total)) * 35,
            `Extracting text locally (page ${page} of ${total})…`,
            { page, totalPages: total },
          );
        },
        onOcrProgress: (page, total) => {
          report(
            deps.onProgress,
            'running_ocr',
            page > 0 && total > 0 ? 62 + (page / total) * 16 : 60,
            page > 0 && total > 0
              ? `Running local OCR (page ${page} of ${total})…`
              : 'Preparing local OCR engine…',
            page > 0 && total > 0 ? { page, totalPages: total } : {},
          );
        },
      }),
      timeout,
    ]);
    return validateParseResult(result, descriptor);
  } catch (error) {
    if (timedOut) {
      throw new FormFlowError(
        'EXTRACTION_TIMEOUT',
        'Document extraction took too long and was stopped. The file was not imported.',
        { cause: error },
      );
    }
    if (deps.signal?.aborted || controller.signal.aborted) {
      throw new FormFlowError('CANCELLED', 'Document processing was cancelled.', { cause: error });
    }
    if (error instanceof FormFlowError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FormFlowError('CANCELLED', 'Document processing was cancelled.', { cause: error });
    }
    throw new FormFlowError(
      'EXTRACTION_FAILED',
      error instanceof Error ? error.message : 'Document text extraction failed.',
      { cause: error },
    );
  } finally {
    if (timer) clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function ingestDocument(
  input: DocumentImportInput,
  deps: DocumentIngestionDependencies = {},
): Promise<DocumentImportOutcome> {
  const progress = deps.onProgress ?? input.onProgress;
  const signal = deps.signal ?? input.signal;
  try {
    checkAborted(signal);
    report(progress, 'validating', 2, 'Validating file type, size, and content signature…');
    const descriptor = validateDocumentFile(input.file);

    const vault = await vaultRecordRepository.getActive();
    if (!vault) throw new FormFlowError('VAULT_LOCKED', 'Create a local vault before importing documents.');
    checkAborted(signal);

    const bytes = await input.file.arrayBuffer();
    validateDocumentBytes(new Uint8Array(bytes), descriptor);
    checkAborted(signal);

    report(progress, 'checksumming', 8, 'Calculating the SHA-256 content digest…');
    const checksum = await sha256Hex(bytes);
    checkAborted(signal);

    report(progress, 'duplicate', 15, 'Checking for an identical document in the vault…');
    const existing = await documentRepository.findByChecksum(checksum);
    if (existing) {
      if (existing.vaultId !== vault.id) {
        throw new FormFlowError('DUPLICATE_DOCUMENT', 'This file matches a record in a different vault.');
      }
      report(progress, 'duplicate', 100, 'This exact file is already in the vault.');
      return duplicateOutcome(existing);
    }

    const documentId = `doc_${crypto.randomUUID()}`;
    const fileName = input.file.name;
    const category = input.category ?? inferCategoryFromName(fileName);

    report(progress, 'encrypting', 20, 'Encrypting the original document bytes…');
    const storedFile = await documentRepository.prepareOriginalFile(documentId, descriptor.mimeType, input.file);
    checkAborted(signal);

    const result = await parseForDocument(descriptor, bytes, {
      ...deps,
      signal,
      onProgress: progress,
      ocrLanguage: input.ocrLanguage ?? deps.ocrLanguage,
    });
    checkAborted(signal);

    report(progress, 'encrypting_text', 80, 'Encrypting extracted text and extraction details…');
    const details = extractionDetails(result);
    const now = new Date().toISOString();
    const row = await documentRepository.prepare(
      documentId,
      {
        vaultId: vault.id,
        mimeType: descriptor.mimeType,
        extension: descriptor.extension,
        category,
        subcategory: input.subcategory ?? '',
        status: result.ocrRequired ? 'review_required' : 'stored',
        ocrStatus: result.ocr?.status ?? 'not_required',
        ...(result.ocr?.language ? { ocrLanguage: result.ocr.language } : {}),
        ...(typeof result.ocr?.averageConfidence === 'number' ? { ocrConfidence: result.ocr.averageConfidence } : {}),
        ...(typeof result.ocr?.pagesAttempted === 'number' ? { ocrPagesTotal: result.ocr.pagesAttempted } : {}),
        ...(typeof result.ocr?.pagesCompleted === 'number' ? { ocrPagesCompleted: result.ocr.pagesCompleted } : {}),
        fileType: descriptor.fileType,
        sizeBytes: input.file.size,
        sizeLabel: formatSize(input.file.size),
        checksum,
        storageKey: `file_${documentId}`,
        source: 'device',
        pageCount: result.pageCount,
        ocrUsed: Boolean(result.ocr && result.ocr.status !== 'not_required'),
        extractedTextStatus: result.ocr?.status === 'failed' && !result.text.trim() ? 'failed' : 'extracted',
        extractionVersion: result.version,
        extractedAt: now,
        ocrRequired: result.ocrRequired,
        stageDetail: result.ocr?.status === 'completed'
          ? 'Text extracted locally with local OCR.'
          : result.ocr?.status === 'partial'
            ? 'Text partially extracted; some OCR pages failed and require review.'
            : result.ocrRequired
              ? 'Text extraction incomplete; one or more pages require OCR.'
              : 'Text extracted locally.',
      },
      fileName,
    );
    const storedText = await documentRepository.prepareText(
      documentId,
      result.text,
      result.pageTexts,
      result.method,
      details,
    );
    checkAborted(signal);

    report(progress, 'storing', 95, 'Committing the encrypted file and text in one transaction…');
    try {
      await documentRepository.commitIngested(row, storedFile, storedText);
    } catch (error) {
      if (error instanceof FormFlowError && error.code === 'DUPLICATE_DOCUMENT') {
        const raced = await documentRepository.findByChecksum(checksum);
        if (raced) return duplicateOutcome(raced);
      }
      throw asStorageError(error);
    }

    try {
      await activityRepository.record(
        result.ocrRequired ? 'document_processed' : 'document_added',
        fileName,
        result.ocr?.status === 'completed'
          ? `${category} · Stored locally · OCR completed (${result.ocr.language})`
          : result.ocrRequired
            ? `${category} · Stored locally · OCR ${result.ocr?.status ?? 'required'}`
            : `${category} · ${result.pageCount} page(s) · Text extracted locally`,
      );
    } catch {
      // The document and text are already committed. Activity is secondary.
    }

    report(progress, 'completed', 100, result.ocrRequired
      ? 'Document stored. Some pages still require OCR.'
      : result.ocr?.status === 'completed'
        ? 'Document, recognized text, and OCR details stored securely.'
        : 'Document and extracted text stored securely.');
    return { document: previewDocument(row, fileName, result), duplicate: false };
  } catch (error) {
    if (signal?.aborted) {
      report(progress, 'cancelled', 0, 'Document processing was cancelled.');
      throw new FormFlowError('CANCELLED', 'Document processing was cancelled.', { cause: error });
    }
    const message = error instanceof Error ? error.message : 'Document import failed.';
    report(progress, 'failed', 0, message);
    if (error instanceof FormFlowError) throw error;
    throw new FormFlowError('EXTRACTION_FAILED', message, { cause: error });
  }
}

export async function retryDocumentExtraction(
  documentId: string,
  deps: DocumentIngestionDependencies = {},
): Promise<{ document: VaultDocument }> {
  const signal = deps.signal;
  const progress = deps.onProgress;
  try {
    checkAborted(signal);
    report(progress, 'validating', 2, 'Loading the encrypted original document…');
    const current = await documentRepository.get(documentId);
    if (!current) throw new FormFlowError('NOT_FOUND', 'Document not found.');
    const blob = await documentRepository.getOriginalFile(documentId);
    if (!blob) throw new FormFlowError('NOT_FOUND', 'The encrypted original file is not available.');
    const file = new File([blob], current.name, { type: current.row.mimeType });
    const descriptor = validateDocumentFile(file);
    const bytes = await file.arrayBuffer();
    validateDocumentBytes(new Uint8Array(bytes), descriptor);
    checkAborted(signal);

    const result = await parseForDocument(descriptor, bytes, {
      ...deps,
      signal,
      onProgress: progress,
      ocrLanguage: deps.ocrLanguage,
    });
    checkAborted(signal);

    report(progress, 'encrypting_text', 80, 'Encrypting refreshed extraction output…');
    const updated = await documentRepository.replaceExtraction(
      documentId,
      result.text,
      result.pageTexts,
      result.method,
      extractionDetails(result),
      {
        status: result.ocrRequired ? 'review_required' : 'stored',
        ocrStatus: result.ocr?.status ?? 'not_required',
        ...(result.ocr?.language ? { ocrLanguage: result.ocr.language } : {}),
        ...(typeof result.ocr?.averageConfidence === 'number' ? { ocrConfidence: result.ocr.averageConfidence } : {}),
        ...(typeof result.ocr?.pagesAttempted === 'number' ? { ocrPagesTotal: result.ocr.pagesAttempted } : {}),
        ...(typeof result.ocr?.pagesCompleted === 'number' ? { ocrPagesCompleted: result.ocr.pagesCompleted } : {}),
        pageCount: result.pageCount,
        extractedTextStatus: result.ocr?.status === 'failed' && !result.text.trim() ? 'failed' : 'extracted',
        extractionVersion: result.version,
        extractedAt: new Date().toISOString(),
        ocrRequired: result.ocrRequired,
        failureReason: undefined,
        processingError: undefined,
        stageDetail: result.ocr?.status === 'completed'
          ? 'Text extracted locally with local OCR.'
          : result.ocr?.status === 'partial'
            ? 'Text partially extracted; some OCR pages failed and require review.'
            : result.ocrRequired
              ? 'Text extraction incomplete; one or more pages require OCR.'
              : 'Text extracted locally.',
      },
    );
    report(progress, 'completed', 100, result.ocrRequired
      ? 'Extraction refreshed. Some pages still require OCR.'
      : result.ocr?.status === 'completed'
        ? 'Extraction refreshed with local OCR and stored.'
        : 'Extraction refreshed and stored.');
    return { document: previewDocument(updated, current.name, result) };
  } catch (error) {
    if (signal?.aborted) {
      report(progress, 'cancelled', 0, 'Document processing was cancelled.');
      throw new FormFlowError('CANCELLED', 'Document processing was cancelled.', { cause: error });
    }
    const message = error instanceof Error ? error.message : 'Document extraction failed.';
    report(progress, 'failed', 0, message);
    if (error instanceof FormFlowError) throw error;
    throw new FormFlowError('EXTRACTION_FAILED', message, { cause: error });
  }
}
