import type { DBSchema } from 'idb';
import type {
  ActivityRow,
  CollectionDocumentRow,
  CollectionRow,
  ConflictRecord,
  DocumentRecord,
  ExtractedValueRecord,
  FormHistoryRow,
  InstalledModelRecord,
  ModelLifecycleState,
  ProcessingJob,
  ProfileRecordRow,
  SettingRow,
  StoredDocumentFile,
  StoredDocumentText,
  VaultMeta,
  VaultProfile,
  VaultRecord,
  StoredVaultProfileRow,
  UnlockThrottleRecord,
} from '@shared/types';

export interface FormFlowDB extends DBSchema {
  vaults: { key: string; value: VaultRecord };
  vaultMeta: { key: string; value: VaultMeta };
  vaultProfile: { key: string; value: StoredVaultProfileRow };
  documents: {
    key: string;
    value: DocumentRecord;
    indexes: { 'by-checksum': string; 'by-status': string; 'by-created': string };
  };
  documentFiles: { key: string; value: StoredDocumentFile };
  documentText: { key: string; value: StoredDocumentText };
  extractedValues: {
    key: string;
    value: ExtractedValueRecord;
    indexes: { 'by-key': string; 'by-document': string; 'by-updated': string };
  };
  conflicts: {
    key: string;
    value: ConflictRecord;
    indexes: { 'by-key': string; 'by-status': string };
  };
  profileRecords: {
    key: string;
    value: ProfileRecordRow;
    indexes: { 'by-type': string };
  };
  collections: { key: string; value: CollectionRow };
  collectionDocuments: {
    key: string;
    value: CollectionDocumentRow;
    indexes: { 'by-collection': string; 'by-document': string };
  };
  formHistory: {
    key: string;
    value: FormHistoryRow;
    indexes: { 'by-created': string };
  };
  activity: {
    key: string;
    value: ActivityRow;
    indexes: { 'by-created': string };
  };
  settings: { key: string; value: SettingRow };
  processingJobs: {
    key: string;
    value: ProcessingJob;
    indexes: { 'by-document': string; 'by-status': string };
  };
  modelMetadata: { key: string; value: InstalledModelRecord };
  modelLifecycle: { key: string; value: ModelLifecycleState };
  securityState: { key: string; value: UnlockThrottleRecord };
}

export type { VaultProfile };
