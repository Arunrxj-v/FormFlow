import { FormFlowError } from '@shared/errors';
import type { DocumentCategory, DocumentRecord, VaultDocument, DocumentStatus, FileKind } from '@shared/types';
import { MAX_DOCUMENT_BYTES, SUPPORTED_EXTENSIONS } from '@shared/constants';
import { sha256Hex } from '../encryption/crypto-service';
import { documentRepository, toVaultDocument, activityRepository } from '../database/repositories';
import { vaultRepository as vaultRecordRepository } from '../database/vault-repository';
import { documentStorage } from '../storage/document-storage';
import { inferFileKind, validateDocumentFile, formatSize, type ValidatedFile } from '../documents/validation';
import { asStorageError } from '../storage/storage-errors';

const MIME_ALIASES: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'text/plain': ['txt'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
};

const EXTENSION_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

export interface DocumentImportInput {
  file: File;
  category?: DocumentCategory;
  subcategory?: string;
  metadata?: Record<string, unknown>;
}

export function inferExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

function mimeMatchesExtension(mimeType: string, extension: string): boolean {
  const normalized = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (MIME_ALIASES[normalized]?.includes(extension)) return true;
  return EXTENSION_MIME[extension] === normalized;
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

export const documentService = {
  async list(): Promise<VaultDocument[]> {
    const rows = await documentRepository.list();
    return rows.map(({ row, name }) => toVaultDocument(row, name));
  },

  async get(documentId: string): Promise<VaultDocument | null> {
    const row = await documentRepository.get(documentId);
    return row ? toVaultDocument(row.row, row.name) : null;
  },

  async importDocument(input: DocumentImportInput): Promise<{ document: VaultDocument; duplicate: boolean }> {
    const validated = validateDocumentFile(input.file);
    const extension = inferExtension(validated.file.name);
    if (!SUPPORTED_EXTENSIONS.includes(extension as (typeof SUPPORTED_EXTENSIONS)[number])) {
      throw new FormFlowError('UNSUPPORTED_FILE', `${validated.file.name} is not a supported format.`);
    }
    if (validated.file.size > MAX_DOCUMENT_BYTES) {
      throw new FormFlowError('FILE_TOO_LARGE', `${validated.file.name} is larger than the 20 MB local limit.`);
    }
    if (!mimeMatchesExtension(validated.mimeType, extension)) {
      throw new FormFlowError('UNSUPPORTED_FILE', `${validated.file.name} has a mismatched MIME type.`);
    }

    const checksum = await sha256Hex(await validated.file.arrayBuffer());
    const duplicate = await documentRepository.findByChecksum(checksum);
    if (duplicate) {
      const vault = await vaultRecordRepository.getActive();
      const row = await documentRepository.get(duplicate.id);
      return {
        document: toVaultDocument(duplicate, row?.name ?? validated.file.name),
        duplicate: true,
      };
    }

    const vault = await vaultRecordRepository.getActive();
    if (!vault) throw new FormFlowError('VAULT_LOCKED', 'Create a local vault before importing documents.');
    const fileType = inferFileKind(validated.file.name);
    const category = input.category ?? inferCategoryFromName(validated.file.name);
    let row: DocumentRecord | null = null;
    try {
      row = await documentRepository.create(
        {
          vaultId: vault.id,
          mimeType: validated.mimeType,
          extension,
          category,
          subcategory: input.subcategory ?? '',
          status: 'selected',
          fileType: fileType as FileKind,
          sizeBytes: validated.file.size,
          sizeLabel: formatSize(validated.file.size),
          checksum,
          storageKey: '',
          source: 'device',
          ocrUsed: false,
          extractedTextStatus: 'pending',
          metadata: input.metadata,
        },
        validated.file.name,
      );

      const storageKey = `file_${row.id}`;
      await documentStorage.save(row.id, validated.file, validated.mimeType);
      await documentRepository.update(row.id, { storageKey, status: 'stored' });
      await activityRepository.record(
        'document_added',
        validated.file.name,
        `${category} · Imported from device`,
      );
    } catch (error) {
      // A quota or transaction failure must not leave a document without its
      // original file. Deletion is normally available even when writes fail.
      if (row) {
        try {
          await documentRepository.remove(row.id);
        } catch {
          // Preserve the original failure; the integrity checker will report
          // any orphan if deletion was also blocked.
        }
      }
      throw asStorageError(error);
    }
    if (!row) throw new FormFlowError('NOT_FOUND', 'Document was not created.');
    const saved = await documentRepository.get(row.id);
    if (!saved) throw new FormFlowError('NOT_FOUND', 'Document disappeared after storage.');
    return { document: toVaultDocument(saved.row, saved.name), duplicate: false };
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

export type { ValidatedFile };
