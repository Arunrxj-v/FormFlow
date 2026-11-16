import type { DocumentIngestionProgress, VaultDocument } from '../../shared/types';

export * from '../../shared/types';

export interface DocumentUploadProgress extends DocumentIngestionProgress {
  importId: string;
  fileIndex: number;
  fileCount: number;
}

export interface DocumentUploadDuplicate {
  fileName: string;
  fileIndex: number;
  existingDocument: VaultDocument;
}

export interface DocumentUploadFailure {
  fileName: string;
  fileIndex: number;
  code: string;
  message: string;
}

export interface DocumentUploadResult {
  accepted: VaultDocument[];
  acceptedIndices: number[];
  duplicates: DocumentUploadDuplicate[];
  rejected: DocumentUploadFailure[];
  cancelled: boolean;
}
