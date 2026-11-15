import { FormFlowError } from '@shared/errors';
import { documentRepository } from '../database/repositories';
import { getDb } from '../database/database';
import { quotaManager } from './quota-manager';

export interface StoredDocument {
  id: string;
  blob: Blob;
  mimeType: string;
  size: number;
}

export const documentStorage = {
  async save(documentId: string, blob: Blob, mimeType: string): Promise<void> {
    await documentRepository.saveOriginalFile(documentId, mimeType, blob);
  },

  async get(documentId: string): Promise<Blob | null> {
    return documentRepository.getOriginalFile(documentId);
  },

  async delete(documentId: string): Promise<void> {
    const db = await getDb();
    await db.delete('documentFiles', documentId);
  },

  async estimate(): Promise<{ usageBytes: number; quotaBytes: number; availableBytes: number; persisted: boolean }> {
    const estimate = await quotaManager.estimate();
    return {
      usageBytes: estimate.usageBytes,
      quotaBytes: estimate.quotaBytes,
      availableBytes: estimate.availableBytes,
      persisted: estimate.persisted,
    };
  },
};

export async function requireDocumentBlob(documentId: string): Promise<Blob> {
  const blob = await documentRepository.getOriginalFile(documentId);
  if (!blob) throw new FormFlowError('NOT_FOUND', 'The original document file is not available in local storage.');
  return blob;
}
