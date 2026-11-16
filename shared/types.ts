export type DocumentStatus =
  | 'selected'
  | 'validating'
  | 'storing'
  | 'stored'
  | 'extracting_text'
  | 'running_ocr'
  | 'extracting_information'
  | 'validating_results'
  | 'review_required'
  | 'completed'
  | 'failed';

export type DocumentCategory =
  | 'Education'
  | 'Identity'
  | 'Employment'
  | 'Certifications'
  | 'Resumes'
  | 'Address proofs'
  | 'Financial'
  | 'Other'
  | (string & {});

export type FileKind = 'pdf' | 'docx' | 'txt' | 'jpg' | 'jpeg' | 'png' | 'other';

export type VaultCategory =
  | 'personal'
  | 'contact'
  | 'address'
  | 'education'
  | 'employment'
  | 'skills'
  | 'certifications'
  | 'projects'
  | 'identification'
  | 'other';

export type VerificationStatus = 'extracted' | 'user_verified' | 'outdated';
export type ExtractionMethod = 'deterministic' | 'ai' | 'manual' | 'derived';

export interface User {
  id: string;
  name: string;
  firstName: string;
  email: string;
  avatarInitials: string;
  accountType: 'Personal' | 'Pro' | 'Local';
}

export interface DocumentHistoryEntry {
  id: string;
  timestamp: string;
  action: string;
  detail: string;
}

export interface ExtractedFactEntity {
  key: string;
  label: string;
  value: string;
  page?: number;
  confidence?: number;
}

export interface VaultDocument {
  id: string;
  name: string;
  category: DocumentCategory;
  subcategory: string;
  status: DocumentStatus;
  fileType: FileKind;
  mimeType: string;
  sizeBytes: number;
  sizeLabel: string;
  uploadedAt: string;
  modifiedAt: string;
  source: 'device' | 'legacy-import';
  pageCount?: number;
  confidence?: number;
  failureReason?: string;
  processingError?: string;
  extractedCount?: number;
  previewTone?: string;
  checksum?: string;
  ocrUsed?: boolean;
  extractedText?: string;
  extractedEntities?: ExtractedFactEntity[];
  processingHistory?: DocumentHistoryEntry[];
  autofillRules?: string[];
  linkedRecordId?: string;
  linkedRecordTitle?: string;
  linkedRecordMeta?: string;
}

export interface FieldSource {
  documentId: string;
  documentName: string;
  page?: number;
  extractedAt?: string;
}

export interface FieldConflict {
  value: string;
  source: FieldSource;
  confidence: number;
  sourcePage?: number;
  documentDate?: string;
}

export interface VaultField {
  id: string;
  key: string;
  label: string;
  value: string;
  normalizedValue?: string;
  category: VaultCategory;
  source: FieldSource;
  sourcePage?: number;
  confidence: number;
  verificationStatus?: VerificationStatus;
  sensitive?: boolean;
  conflicts?: FieldConflict[];
  extractedAt?: string;
  lastUpdatedAt?: string;
  extractionMethod?: ExtractionMethod;
  userModified?: boolean;
}

export interface EducationRecord {
  id: string;
  level: string;
  degree: string;
  institution: string;
  university: string;
  period: string;
  status: 'Completed' | 'In progress';
  metrics: { label: string; value: string }[];
  documentId?: string;
  registrationNo: string;
  gpa: string;
  specialization: string;
  autofillTag: string;
  createdAt: string;
  lastSynced: string;
  sourceNote: string;
}

export interface EmploymentRecord {
  id: string;
  role: string;
  company: string;
  period: string;
  location: string;
  status: 'Current' | 'Completed';
  skills: string[];
  documentId?: string;
}

export interface Collection {
  id: string;
  vaultId: string;
  name: string;
  description: string;
  color: string;
  documentIds: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityItem {
  id: string;
  type:
    | 'document_added'
    | 'document_processed'
    | 'form_detected'
    | 'form_filled'
    | 'document_updated'
    | 'document_removed'
    | 'vault_created'
    | 'model_installed';
  title: string;
  detail: string;
  timestamp: string;
  relativeTime: string;
}

export interface FormHistoryItem {
  id: string;
  website: string;
  url: string;
  timestamp: string;
  dateLabel: string;
  fieldsDetected: number;
  fieldsFilled: number;
  fieldsReview: number;
  status: 'Completed' | 'Partially completed' | 'Cancelled' | 'Failed';
  documentsUsed: string[];
  duration: string;
}

export interface DriveConnection {
  connected: boolean;
  accountEmail: string;
  targetFolder: string;
  storageUsed: string;
  storageTotal: string;
  lastSync: string;
  permissions: string[];
  isDemo: boolean;
  accountName?: string;
}

export interface ExtensionConnection {
  installed: boolean;
  connected: boolean;
  version: string;
  browser: string;
  lastSync: string;
  shortcut: string;
}

export interface Preferences {
  confirmBeforeAutofill: boolean;
  requireSensitiveReview: boolean;
  allowLongAnswers: boolean;
  autoDownloadFiles: boolean;
  productNotifications: boolean;
  activityNotifications: boolean;
  compactMode: boolean;
  autoLockMinutes: number;
  ocrLanguage: string;
}

export interface OnboardingState {
  completed: boolean;
  currentStep: number;
  vaultCreatedAt?: string;
}

export interface VaultRecord {
  id: string;
  /** Decrypted display name. New rows store this encrypted in nameEnc. */
  name: string;
  /** Encrypted vault display name; absent only in legacy rows awaiting migration. */
  nameEnc?: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  setupCompleted: boolean;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  fileType: FileKind;
  sizeLabel: string;
  modifiedAt: string;
  category: DocumentCategory;
  subcategory: string;
}

export interface VaultProfile {
  id: 'me';
  name: string;
  email: string;
  accountType: 'Personal' | 'Pro' | 'Local';
  createdAt: string;
  updatedAt: string;
}

export interface AddressRecord {
  id: string;
  label: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  district?: string;
  state: string;
  country: string;
  postalCode: string;
  isPrimary: boolean;
  sourceDocumentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillRecord {
  id: string;
  name: string;
  category: 'Technical' | 'Tools' | 'Languages' | 'Certification';
  level: number;
  source: string;
  sourceDocumentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CertificationRecord {
  id: string;
  name: string;
  issuer: string;
  issueDate?: string;
  expiryDate?: string;
  sourceDocumentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  title: string;
  description?: string;
  technologies?: string[];
  role?: string;
  duration?: string;
  sourceDocumentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredVaultProfileRow {
  id: 'me';
  profileEnc: string;
  updatedAt: string;
}

export interface VaultFieldInput {
  key: string;
  label: string;
  value: string;
  normalizedValue?: string;
  category: VaultCategory;
  source: FieldSource;
  sourcePage?: number;
  confidence: number;
  verificationStatus?: VerificationStatus;
  sensitive?: boolean;
  extractionMethod?: ExtractionMethod;
  userModified?: boolean;
}

export interface DocumentRecord {
  id: string;
  vaultId: string;
  nameEnc: string;
  originalFilenameEnc: string;
  mimeType: string;
  extension: string;
  category: DocumentCategory;
  subcategory: string;
  status: DocumentStatus;
  fileType: FileKind;
  sizeBytes: number;
  sizeLabel: string;
  checksum: string;
  storageKey: string;
  source: 'device' | 'legacy-import';
  pageCount?: number;
  ocrUsed: boolean;
  extractedTextStatus: 'pending' | 'extracted' | 'failed';
  metadata?: Record<string, unknown>;
  confidence?: number;
  failureReason?: string;
  processingError?: string;
  stageDetail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractedValueRecord {
  id: string;
  key: string;
  /** Plaintext label exists only in pre-3.1 rows until the v2 migration encrypts it. */
  label: string;
  labelEnc?: string;
  valueEnc: string;
  normalizedValueEnc: string;
  category: VaultCategory;
  sourceDocumentId: string;
  sourcePage?: number;
  confidence: number;
  extractionMethod: ExtractionMethod;
  verificationStatus: VerificationStatus;
  sensitive: boolean;
  userModified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConflictRecord {
  id: string;
  key: string;
  /** Plaintext label exists only in pre-3.1 rows until the v2 migration encrypts it. */
  label: string;
  labelEnc?: string;
  existingValueEnc: string;
  existingSourceDocumentId: string;
  existingConfidence: number;
  newValueEnc: string;
  newSourceDocumentId: string;
  newConfidence: number;
  page?: number;
  status: 'open' | 'resolved';
  resolution?: 'kept_existing' | 'used_new' | 'edited' | 'outdated' | 'kept_both';
  createdAt: string;
  resolvedAt?: string;
}

export interface StoredDocumentText {
  documentId: string;
  textEnc: string;
  pageTextsEnc: string;
  pageCount: number;
  method: 'pdf-text' | 'docx' | 'ocr' | 'txt' | 'mixed';
  createdAt: string;
}

export interface StoredDocumentFile {
  documentId: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  ciphertext: Blob;
  iv: string;
  version: 2;
  /** AAD format used for the blob. Missing means legacy vault-wide AAD. */
  aadVersion?: 1 | 2;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessingJob {
  id: string;
  documentId: string;
  status: DocumentStatus;
  detail: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

export interface ProfileRecordRow {
  id: string;
  type: 'education' | 'employment' | 'skill' | 'certification' | 'project' | 'address';
  dataEnc: string;
  documentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionRow {
  id: string;
  vaultId: string;
  nameEnc: string;
  descriptionEnc: string;
  notesEnc: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionDocumentRow {
  id: string;
  collectionId: string;
  documentId: string;
}

export interface FormHistoryRow {
  id: string;
  websiteEnc: string;
  urlEnc: string;
  documentsUsedEnc: string;
  fieldsDetected: number;
  fieldsFilled: number;
  fieldsReview: number;
  status: 'Completed' | 'Partially completed' | 'Cancelled' | 'Failed';
  durationMs: number;
  createdAt: string;
}

export interface ActivityRow {
  id: string;
  type: ActivityItem['type'];
  titleEnc: string;
  detailEnc: string;
  createdAt: string;
}

export interface SettingRow {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface VaultMeta {
  id: 'meta';
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  wrappedDataKey: string;
  /** 1 or missing = Phase 3 vault-wide AAD; 2 = per-record AAD. */
  encryptionFormat?: 1 | 2;
  /** 2 = vault display name is encrypted with per-record AAD. */
  nameFormat?: 1 | 2;
  createdAt: string;
  passwordUpdatedAt: string;
}

export type ModelRuntime = 'webgpu' | 'wasm';
export type ModelStatus = 'not_installed' | 'downloading' | 'verifying' | 'installed' | 'initializing' | 'ready' | 'failed' | 'corrupt';

export interface InstalledModelRecord {
  id: string;
  modelId: string;
  revision: string;
  dtype: string;
  runtime: ModelRuntime;
  status: ModelStatus;
  expectedBytes: number;
  downloadedBytes: number;
  files: Array<{ path: string; size: number; sha256?: string; sha256Computed?: string }>;
  installedAt?: string;
  lastVerifiedAt?: string;
  lastInitializedAt?: string;
  error?: string;
  selfTestLatencyMs?: number;
}

export interface StorageEstimate {
  usageBytes: number;
  quotaBytes: number;
  availableBytes: number;
  documentsBytes: number;
  modelBytes: number;
  persisted: boolean;
}

export interface ModelCapabilities {
  webgpu: boolean;
  webgpuAdapter?: string;
  wasm: boolean;
  hardwareConcurrency: number;
  deviceMemoryGb?: number;
}
