import type {
  ActivityItem,
  Collection,
  DocumentIngestionProgress,
  DocumentTextResult,
  FormHistoryItem,
  Preferences,
  StorageEstimate,
  VaultDocument,
  VaultField,
  VaultFieldInput,
  VaultProfile,
  VaultRecord,
} from '@shared/types';


export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  encrypted: boolean;
  requiresEncryptionMigration: boolean;
  requiresEncryptionUpgrade: boolean;
  encryptionFormat?: number;
  createdAt?: string;
  passwordUpdatedAt?: string;
  kdf?: string;
  iterations?: number;
}

export interface IntegrityIssue {
  severity: 'error' | 'warning';
  code: string;
  recordType: string;
  recordId?: string;
  message: string;
}

export interface VaultIntegrityReport {
  ok: boolean;
  checkedAt: string;
  encryptionFormat: number;
  counts: {
    documents: number;
    files: number;
    values: number;
    conflicts: number;
    profileRecords: number;
    collections: number;
    memberships: number;
    activity: number;
    history: number;
    text: number;
  };
  issues: IntegrityIssue[];
}

export interface DashboardStats {
  totalDocuments: number;
  totalValues: number;
  verifiedValues: number;
  pendingReview: number;
  openConflicts: number;
  totalCollections: number;
  completedForms: number;
  processedDocuments: number;
  documentStorageBytes: number;
}

export interface DashboardPayload {
  vault: VaultRecord | null;
  profile: VaultProfile;
  documents: VaultDocument[];
  fields: VaultField[];
  activity: ActivityItem[];
  stats: DashboardStats;
}

export interface DocumentImportResult {
  document: VaultDocument;
  duplicate: boolean;
}

export interface DocumentProgressEvent extends DocumentIngestionProgress {
  importId: string;
  fileIndex: number;
  fileCount: number;
}

export interface DocumentImportOptions {
  importId?: string;
  fileIndex?: number;
  fileCount?: number;
  onProgress?: (event: DocumentProgressEvent) => void;
}

export interface VaultImportResult {
  imported: boolean;
  documents: number;
  values: number;
  collections: number;
}

export interface EncryptionStatus {
  encryptionFormat: number;
  needsMigration: boolean;
  journal: {
    version: 2;
    status: 'in_progress' | 'complete' | 'failed';
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    migrated: Record<string, number>;
    lastError?: string;
  } | null;
}

export type ProfileRecordType = 'education' | 'employment' | 'skill' | 'certification' | 'project' | 'address';

export interface LegacyMigrationSummary {
  documents: { imported: number; skipped: number; failed: number };
  values: { imported: number; skipped: number; conflictsCreated: number };
  collections: { imported: number; skipped: number };
  history: { imported: number; skipped: number };
}

export interface VaultStateEvent {
  state: 'locked' | 'unlocked' | 'locking';
  generation: number;
  updatedAt: string;
}

export interface VaultClientApi {
  status(): Promise<VaultStatus>;
  createVault(input: { name: string; passphrase: string }): Promise<{ vault: VaultRecord; status: VaultStatus }>;
  migratePlaintextVault(passphrase: string): Promise<VaultRecord | null>;
  unlock(passphrase: string): Promise<VaultStatus>;
  lock(): Promise<VaultStatus>;
  destroy(): Promise<void>;
  changePassphrase(currentPassphrase: string, newPassphrase: string): Promise<void>;
  getActiveVault(): Promise<VaultRecord | null>;
  updateVault(patch: Partial<Omit<VaultRecord, 'id' | 'createdAt'>>): Promise<VaultRecord | null>;
  touch(): Promise<void>;
  getProfile(): Promise<VaultProfile>;
  updateProfile(patch: Partial<Omit<VaultProfile, 'id'>>): Promise<VaultProfile>;
  getDashboardData(): Promise<DashboardPayload>;
  listFields(): Promise<VaultField[]>;
  addField(field: VaultFieldInput): Promise<{ field: VaultField; conflictCreated: boolean }>;
  updateField(id: string, value: string): Promise<VaultField>;
  deleteField(id: string): Promise<void>;
  resolveConflict(id: string, value: string): Promise<VaultField>;
  listDocuments(): Promise<VaultDocument[]>;
  getDocument(id: string): Promise<VaultDocument | null>;
  importDocument(
    file: File,
    category?: VaultDocument['category'],
    subcategory?: string,
    options?: DocumentImportOptions,
  ): Promise<DocumentImportResult>;
  cancelDocumentImport(importId: string): Promise<{ cancelled: boolean }>;
  retryDocumentExtraction(
    id: string,
    options?: DocumentImportOptions,
  ): Promise<{ document: VaultDocument }>;
  getDocumentText(id: string, maxChars?: number): Promise<DocumentTextResult | null>;
  renameDocument(id: string, name: string): Promise<VaultDocument>;
  deleteDocument(id: string): Promise<void>;
  getDocumentBlob(id: string): Promise<{ blob: Blob; mimeType: string } | null>;
  listCollections(): Promise<Collection[]>;
  createCollection(input: { name: string; description?: string; notes?: string; color?: string; documentIds?: string[] }): Promise<Collection>;
  updateCollection(id: string, patch: { name?: string; description?: string; notes?: string; color?: string; documentIds?: string[] }): Promise<Collection | null>;
  deleteCollection(id: string): Promise<void>;
  listActivity(): Promise<ActivityItem[]>;
  recordActivity(item: Omit<ActivityItem, 'id' | 'timestamp' | 'relativeTime'>): Promise<void>;
  getHistory(): Promise<FormHistoryItem[]>;
  recordHistory(entry: {
    website: string;
    url: string;
    detected: number;
    filled: number;
    review: number;
    status: FormHistoryItem['status'];
    durationMs: number;
  }): Promise<void>;
  clearHistory(): Promise<void>;
  getPreferences(): Promise<Preferences>;
  updatePreferences(preferences: Preferences): Promise<Preferences>;
  listProfileRecords<T>(type: ProfileRecordType): Promise<T[]>;
  saveProfileRecord<T>(type: ProfileRecordType, record: T, documentId?: string): Promise<T>;
  removeProfileRecord(id: string): Promise<void>;
  exportVault(passphrase: string): Promise<Blob>;
  importVault(file: Blob, passphrase: string): Promise<VaultImportResult>;
  storageEstimate(): Promise<StorageEstimate>;
  encryptionStatus(): Promise<EncryptionStatus>;
  migrateEncryption(): Promise<EncryptionStatus>;
  checkIntegrity(): Promise<VaultIntegrityReport>;
  subscribeState(listener: (state: VaultStateEvent) => void): () => void;
  keepAlive(): () => void;
  legacyBackendStatus(): Promise<{ user: { email: string } | null }>;
  legacyBackendMigrate(email: string, password: string): Promise<LegacyMigrationSummary>;
}
