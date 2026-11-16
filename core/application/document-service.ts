import { FormFlowError } from '@shared/errors';
import type { DocumentStatus, VaultDocument } from '@shared/types';
import { documentRepository, toVaultDocument, activityRepository } from '../database/repositories';
import { documentStorage } from '../storage/document-storage';
import {
  ingestDocument,
  retryDocumentExtraction,
  type DocumentImportInput,
  type DocumentImportOutcome,
  type DocumentIngestionDependencies,
} from './document-ingestion-service';

export type { DocumentImportInput, DocumentImportOutcome };
export type { DocumentIngestionDependencies } from './document-ingestion-service';

export function inferExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

export const documentService = {
  async list(): Promise<VaultDocument[]> {
    const rows = await documentRepository.list();
    return rows.map(({ row, name }) => toVaultDocument(row, name));
  },

  async get(documentId: string): Promise<VaultDocument | null> {
    const row = await documentRepository.get(documentId);
    return row ? toVaultDocument(row.row, row.name) : null;
  },

  async importDocument(
    input: DocumentImportInput,
    dependencies: DocumentIngestionDependencies = {},
  ): Promise<DocumentImportOutcome> {
    return ingestDocument(input, dependencies);
  },

  async getText(documentId: string) {
    const row = await documentRepository.get(documentId);
    if (!row) return null;
    const text = await documentRepository.getText(documentId);
    if (!text) return null;
    return {
      documentId,
      text: text.text,
      pageTexts: text.pageTexts,
      pageCount: row.row.pageCount ?? text.pageTexts.length,
      method: text.method,
      warnings: text.extraction?.warnings ?? [],
      metadata: text.extraction?.metadata ?? {},
      ...(text.extraction?.ocr ? { ocr: text.extraction.ocr } : {}),
      ocrRequired: row.row.ocrRequired ?? text.extraction?.ocrRequired ?? false,
      pagesNeedingOcr: row.row.ocrRequired === false ? [] : (text.extraction?.pagesNeedingOcr ?? []),
      extractionVersion: row.row.extractionVersion ?? text.extraction?.version,
      extractedAt: row.row.extractedAt,
    };
  },

  async retryExtraction(
    documentId: string,
    dependencies: DocumentIngestionDependencies = {},
  ): Promise<{ document: VaultDocument }> {
    return retryDocumentExtraction(documentId, dependencies);
  },

  async getBlob(documentId: string): Promise<Blob | null> {
    return documentStorage.get(documentId);
  },

  async rename(documentId: string, name: string): Promise<VaultDocument> {
    await documentRepository.rename(documentId, name.trim());
    const row = await documentRepository.get(documentId);
    if (!row) throw new FormFlowError('NOT_FOUND', 'Document not found after rename.');
    return toVaultDocument(row.row, row.name);
  },

  async remove(documentId: string): Promise<void> {
    await documentRepository.remove(documentId);
    await documentStorage.delete(documentId);
    await activityRepository.record('document_removed', 'Document removed', 'Local document and file removed.');
  },

  async updateStatus(documentId: string, status: DocumentStatus, detail: string, error?: string): Promise<void> {
    await documentRepository.updateStatus(documentId, status, detail, error);
  },

  async getStorageEstimate() {
    return documentStorage.estimate();
  },
};
