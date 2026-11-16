export const APP_NAME = 'FormFlow';
export const APP_VERSION = '2.0.0';
export const DB_NAME = 'formflow-local';
export const DB_VERSION = 2;
export const VAULT_SCHEMA_VERSION = 2;
export const ENCRYPTION_FORMAT_VERSION = 2;

export const MODEL_CACHE_NAME = 'formflow-model-cache-v1';
export const MODEL_METADATA_ID = 'qwen3-0.6b-instruct';
export const MODEL_REPOSITORY = 'onnx-community/Qwen3-0.6B-Instruct-ONNX';
export const MODEL_REVISION = '54250909aca286a05b9d013c8af7a21859ee6ead';
export const MODEL_LICENSE = 'Apache-2.0';
export const MODEL_LICENSE_URL = 'https://huggingface.co/Qwen/Qwen3-0.6B/blob/main/LICENSE';

export const VAULT_STATE_KEY = 'formflow.vault.state';
/** Legacy Phase 3 key; removed from storage.session on startup. */
export const LEGACY_VAULT_SESSION_KEY = 'formflow.vault.session_key';
export const VAULT_ACTIVITY_KEY = 'formflow.vault.last_activity';
export const AUTO_LOCK_ALARM = 'formflow-auto-lock';
export const DEFAULT_AUTO_LOCK_MINUTES = 15;
export const PBKDF2_ITERATIONS = 600_000;

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
/** Formats the Phase 4.1 ingestion pipeline accepts from the UI. */
export const INGESTIBLE_EXTENSIONS = ['pdf', 'docx', 'txt'] as const;
export const INGESTIBLE_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
] as const;
/** Retained for reading older backups that may contain image documents. */
export const SUPPORTED_EXTENSIONS = ['pdf', 'docx', 'txt', 'jpg', 'jpeg', 'png'] as const;
export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'image/jpeg',
  'image/png',
] as const;

export const OCR_LANGUAGES = [
  { id: 'eng', label: 'English' },
  { id: 'eng+hin', label: 'English + Hindi' },
  { id: 'eng+mal', label: 'English + Malayalam' },
  { id: 'eng+tam', label: 'English + Tamil' },
] as const;

export const EXTRACTION_VERSION = 1;
export const MAX_PDF_PAGES = 1_000;
export const MAX_EXTRACTED_TEXT_CHARS = 10_000_000;
export const MAX_EXTRACTION_WARNINGS = 100;
export const MAX_EXTRACTION_TIMEOUT_MS = 60_000;
export const MAX_DOCX_XML_BYTES = 24 * 1024 * 1024;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 96 * 1024 * 1024;

export const MODEL_INFERENCE_TIMEOUT_MS = 120_000;
export const MODEL_SELF_TEST_TIMEOUT_MS = 180_000;
export const MODEL_MAX_OUTPUT_TOKENS = 320;
export const MODEL_MAX_CONTEXT_TOKENS = 3072;

export const BACKUP_FORMAT = 'formflow-encrypted-backup';
export const BACKUP_VERSION = 3;
export const MAX_BACKUP_BYTES = 200 * 1024 * 1024;
export const MAX_BACKUP_DOCUMENTS = 5000;
export const MAX_BACKUP_VALUES = 50000;
export const MAX_BACKUP_COLLECTIONS = 5000;
export const MAX_BACKUP_HISTORY = 50000;
export const MAX_BACKUP_PROFILE_RECORDS = 10000;
export const MAX_BACKUP_TEXT_RECORDS = 10000;
