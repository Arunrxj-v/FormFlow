export type DocumentStatus =
  | 'processed'
  | 'completed'
  | 'processing'
  | 'queued'
  | 'extracting_text'
  | 'extracting_information'
  | 'failed'
  | 'needs_attention'
  | 'unsupported'
  | 'uploading'
  | 'selected';

export type DocumentCategory =
  | 'Education'
  | 'Identity'
  | 'Employment'
  | 'Certifications'
  | 'Academic certificates'
  | 'Resumes'
  | 'Employment records'
  | 'Financial documents'
  | 'Address proofs'
  | 'Professional certificates'
  | 'Other'
  | (string & {});

export type FileKind = 'pdf' | 'docx' | 'txt' | 'jpg' | 'jpeg' | 'png' | 'other';

export interface User {
  id: string;
  name: string;
  firstName: string;
  email: string;
  avatarInitials: string;
  accountType: 'Personal' | 'Pro';
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
  source: 'google-drive' | 'device' | 'demo';
  drivePath: string;
  driveFileId?: string;
  driveModifiedAt?: string;
  outdated?: boolean;
  linkedRecordId?: string;
  linkedRecordTitle?: string;
  linkedRecordMeta?: string;
  pageCount?: number;
  confidence?: number;
  failureReason?: string;
  processingError?: string;
  extractedCount?: number;
  previewTone?: string;
  extractedText?: string;
  extractedEntities?: ExtractedFactEntity[];
  processingHistory?: DocumentHistoryEntry[];
  autofillRules?: string[];
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
  category:
    | 'personal'
    | 'contact'
    | 'education'
    | 'employment'
    | 'identification'
    | 'other';
  source: FieldSource;
  sourcePage?: number;
  confidence: number;
  verificationStatus?: 'extracted' | 'user_verified' | 'outdated';
  sensitive?: boolean;
  conflicts?: FieldConflict[];
  extractedAt?: string;
  lastUpdatedAt?: string;
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
  name: string;
  description: string;
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
    | 'document_removed';
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
  autoDownloadFiles: boolean;
  activityNotifications: boolean;
  productNotifications: boolean;
  compactMode: boolean;
}

export interface OnboardingState {
  completed: boolean;
  currentStep: number;
  selectedDriveFileIds: string[];
}
