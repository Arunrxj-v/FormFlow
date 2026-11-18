import type { FieldKind } from './form-fields';

export interface ScanFieldPayload {
  index: number;
  label: string;
  kind: FieldKind;
  confidence: number;
  sensitive: boolean;
  tag: string;
  type: string;
  questionType?: string;
  required: boolean;
  currentValue: string;
  options?: string[];
  unsupported?: boolean;
  unsupportedReason?: string;
}

export interface ScanUploadFieldPayload {
  index: number;
  label: string;
  name: string;
  id: string;
  accept: string;
  required: boolean;
}

export interface ScanPayload {
  url: string;
  /** Content-script instance token; fill must echo this exact scan. */
  scanToken?: string;
  title: string;
  adapter?: string;
  isGoogleForms?: boolean;
  isEditor?: boolean;
  editorMessage?: string;
  fields: ScanFieldPayload[];
  uploadFields?: ScanUploadFieldPayload[];
  forms: number;
}

export interface MatchSuggestion {
  index: number;
  fieldLabel: string;
  fieldKind: FieldKind;
  value: string;
  sourceDocumentId?: string;
  sourceDocumentName?: string;
  sourcePage?: number;
  recordId?: string;
  confidence: number;
  method: 'deterministic' | 'ai' | 'contextual';
  needsReview: boolean;
  reason: string;
  sensitive: boolean;
  conflict?: boolean;
  alternates?: Array<{ value: string; sourceDocumentName: string; confidence: number }>;
  options?: string[];
  unsupported?: boolean;
  unsupportedReason?: string;
}

export interface FormFlowRequest {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface FormFlowResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
  requestId?: string;
}

export const DOCUMENT_PROGRESS_EVENT = 'FORMFLOW_DOCUMENT_PROGRESS';

export const MESSAGE = {
  GET_STATE: 'GET_STATE',
  GET_SETUP_STATE: 'GET_SETUP_STATE',
  UPDATE_SETUP_STATE: 'UPDATE_SETUP_STATE',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  VAULT_STATUS: 'VAULT_STATUS',
  VAULT_CREATE: 'VAULT_CREATE',
  VAULT_UNLOCK: 'VAULT_UNLOCK',
  VAULT_LOCK: 'VAULT_LOCK',
  VAULT_SUMMARY: 'VAULT_SUMMARY',
  VAULT_TOUCH: 'VAULT_TOUCH',
  GET_PROFILE: 'GET_PROFILE',
  UPDATE_PROFILE: 'UPDATE_PROFILE',
  LIST_DOCUMENTS: 'LIST_DOCUMENTS',
  GET_DOCUMENT_METADATA: 'GET_DOCUMENT_METADATA',
  GET_DOCUMENT_TEXT: 'GET_DOCUMENT_TEXT',
  IMPORT_DOCUMENT: 'IMPORT_DOCUMENT',
  CANCEL_DOCUMENT_IMPORT: 'CANCEL_DOCUMENT_IMPORT',
  RETRY_DOCUMENT_EXTRACTION: 'RETRY_DOCUMENT_EXTRACTION',
  EXTRACT_DOCUMENT: 'EXTRACT_DOCUMENT',
  VERIFY_FIELD: 'VERIFY_FIELD',
  DELETE_DOCUMENT: 'DELETE_DOCUMENT',
  LIST_COLLECTIONS: 'LIST_COLLECTIONS',
  CREATE_COLLECTION: 'CREATE_COLLECTION',
  UPDATE_COLLECTION: 'UPDATE_COLLECTION',
  DELETE_COLLECTION: 'DELETE_COLLECTION',
  ASSIGN_DOCUMENT: 'ASSIGN_DOCUMENT',
  REMOVE_DOCUMENT: 'REMOVE_DOCUMENT',
  GET_DASHBOARD_STATS: 'GET_DASHBOARD_STATS',
  EXPORT_VAULT: 'EXPORT_VAULT',
  IMPORT_VAULT: 'IMPORT_VAULT',
  GET_HISTORY: 'GET_HISTORY',
  SCAN_ACTIVE_TAB: 'SCAN_ACTIVE_TAB',
  GET_FORM_SUGGESTIONS: 'GET_FORM_SUGGESTIONS',
  AI_MATCH_FIELDS: 'AI_MATCH_FIELDS',
  GENERATE_ANSWER: 'GENERATE_ANSWER',
  FILL_ACTIVE_TAB: 'FILL_ACTIVE_TAB',
  RECORD_HISTORY: 'RECORD_HISTORY',
  CLEAR_HISTORY: 'CLEAR_HISTORY',
  OPEN_TAB: 'OPEN_TAB',
  OPEN_DASHBOARD: 'OPEN_DASHBOARD',
  GET_STORAGE_STATUS: 'GET_STORAGE_STATUS',
  GET_ENCRYPTION_STATUS: 'GET_ENCRYPTION_STATUS',
  MIGRATE_ENCRYPTION: 'MIGRATE_ENCRYPTION',
  CHECK_VAULT_INTEGRITY: 'CHECK_VAULT_INTEGRITY',
  CHANGE_PASSPHRASE: 'CHANGE_PASSPHRASE',
  GET_DASHBOARD_DATA: 'GET_DASHBOARD_DATA',
  LIST_FIELDS: 'LIST_FIELDS',
  ADD_FIELD: 'ADD_FIELD',
  UPDATE_FIELD: 'UPDATE_FIELD',
  DELETE_FIELD: 'DELETE_FIELD',
  RESOLVE_CONFLICT: 'RESOLVE_CONFLICT',
  GET_ACTIVITY: 'GET_ACTIVITY',
  RECORD_ACTIVITY: 'RECORD_ACTIVITY',
  GET_ACTIVE_VAULT: 'GET_ACTIVE_VAULT',
  UPDATE_VAULT: 'UPDATE_VAULT',
  TOUCH_VAULT: 'TOUCH_VAULT',
  LIST_PROFILE_RECORDS: 'LIST_PROFILE_RECORDS',
  SAVE_PROFILE_RECORD: 'SAVE_PROFILE_RECORD',
  REMOVE_PROFILE_RECORD: 'REMOVE_PROFILE_RECORD',
  RENAME_DOCUMENT: 'RENAME_DOCUMENT',
  GET_DOCUMENT_BLOB: 'GET_DOCUMENT_BLOB',
  DESTROY_VAULT: 'DESTROY_VAULT',
  MIGRATE_PLAINTEXT_VAULT: 'MIGRATE_PLAINTEXT_VAULT',
  GET_PREFERENCES: 'GET_PREFERENCES',
  UPDATE_PREFERENCES: 'UPDATE_PREFERENCES',
  LEGACY_BACKEND_STATUS: 'LEGACY_BACKEND_STATUS',
  LEGACY_BACKEND_MIGRATE: 'LEGACY_BACKEND_MIGRATE',
  MODEL_STATUS: 'MODEL_STATUS',
  MODEL_INSTALL: 'MODEL_INSTALL',
  MODEL_CANCEL: 'MODEL_CANCEL',
  MODEL_REMOVE: 'MODEL_REMOVE',
  MODEL_SELF_TEST: 'MODEL_SELF_TEST',
  MODEL_UPGRADE: 'MODEL_UPGRADE',
  MODEL_UPGRADE_CANCEL: 'MODEL_UPGRADE_CANCEL',
  MODEL_ROLLBACK: 'MODEL_ROLLBACK',
  MODEL_PRUNE_PREVIOUS: 'MODEL_PRUNE_PREVIOUS',
  MODEL_PROGRESS: 'MODEL_PROGRESS',
  MODEL_READY: 'MODEL_READY',
  MODEL_ERROR: 'MODEL_ERROR',
  INFER: 'INFER',
  INFER_CANCEL: 'INFER_CANCEL',
  INFER_PROGRESS: 'INFER_PROGRESS',
  VAULT_LOCKED: 'VAULT_LOCKED',
  VAULT_UNLOCKED: 'VAULT_UNLOCKED',
} as const;
