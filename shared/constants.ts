export const APP_NAME = 'FormFlow';
export const APP_VERSION = '2.0.0';
export const DB_NAME = 'formflow-local';
export const DB_VERSION = 4;
export const VAULT_SCHEMA_VERSION = 2;
export const ENCRYPTION_FORMAT_VERSION = 2;

export const MODEL_CACHE_NAME = 'formflow-model-cache-v1';
export const MODEL_METADATA_ID = 'qwen3-0.6b-instruct';
export const MODEL_REPOSITORY = 'onnx-community/Qwen3-0.6B-Instruct-ONNX';
export const MODEL_REVISION = '54250909aca286a05b9d013c8af7a21859ee6ead';
export const MODEL_MANIFEST_VERSION = 1 as const;
export const MODEL_RELEASE_ID = 'qwen3-0.6b-int8-2026-11';
export const MODEL_VERSION = '0.6.0-int8-r1';
export const MODEL_LICENSE = 'Apache-2.0';
export const MODEL_LICENSE_URL = 'https://huggingface.co/Qwen/Qwen3-0.6B/blob/main/LICENSE';
/** Single journal record for the active/rollback model lifecycle. */
export const MODEL_LIFECYCLE_ID = 'active';

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

export const OCR_ENGINE = 'tesseract.js' as const;
export const OCR_ENGINE_VERSION = '7.0.0' as const;
export const OCR_CORE_VERSION = '7.0.0' as const;
export const OCR_LANGUAGES = [
  { id: 'eng', label: 'English' },
] as const;
export const OCR_LANGUAGE_ASSETS: Record<string, { file: string; sha256: string; bytes: number }> = {
  eng: {
    file: 'tessdata/eng.traineddata.gz',
    sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
    bytes: 2_952_873,
  },
};
export const OCR_ASSETS = {
  worker: {
    file: 'tesseract/worker.min.js',
    sha256: '576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d',
  },
  core: {
    jsFile: 'tesseract/tesseract-core-simd-lstm.wasm.js',
    jsSha256: 'c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38',
    wasmFile: 'tesseract/tesseract-core-simd-lstm.wasm',
    wasmSha256: '34e8d50cac216427d86bf397d610fdd9f49492539bbcdfbfccc4eda20c810bea',
  },
} as const;
export const OCR_RENDER_DPI = 200;
export const OCR_MAX_PAGE_PIXELS = 12_000_000;
export const OCR_MAX_RENDER_SCALE = 3;
export const OCR_MAX_PAGES = 100;
export const OCR_PAGE_TIMEOUT_MS = 30_000;
export const OCR_LOW_CONFIDENCE = 55;
export const OCR_FAILED_CONFIDENCE = 20;
export const OCR_MAX_WORDS_PER_PAGE = 500;
export const OCR_MAX_WORDS_TOTAL = 5_000;
export const OCR_MAX_LINES_PER_PAGE = 200;

export const DOCUMENT_STRUCTURE_SCHEMA_VERSION = 1 as const;
export const MAX_STRUCTURE_BLOCKS = 20_000;
export const MAX_STRUCTURE_SECTIONS = 2_000;
export const MAX_STRUCTURE_TABLES = 1_000;
export const MAX_STRUCTURE_TABLE_ROWS = 5_000;
export const MAX_STRUCTURE_TABLE_CELLS = 20_000;
export const MAX_STRUCTURE_DEPTH = 32;
export const MAX_STRUCTURE_TEXT_CHARS = 2_000_000;
export const MAX_STRUCTURE_BLOCK_TEXT_CHARS = 100_000;
export const MAX_STRUCTURE_BOUNDING_BOXES = 20_000;
export const MAX_STRUCTURE_READING_ORDER = 20_000;
export const MAX_STRUCTURE_SERIALIZED_CHARS = 2_500_000;

export const EXTRACTION_VERSION = 1;
export const MAX_PDF_PAGES = 1_000;
export const MAX_EXTRACTED_TEXT_CHARS = 10_000_000;
export const MAX_EXTRACTION_WARNINGS = 100;
export const MAX_EXTRACTION_TIMEOUT_MS = 300_000;
export const MAX_DOCX_XML_BYTES = 24 * 1024 * 1024;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 96 * 1024 * 1024;
export const MAX_DOCX_IMAGES = 200;
export const MAX_DOCX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_DOCX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_DOCX_IMAGE_PIXELS = 40_000_000;
export const MAX_DOCX_IMAGE_DIMENSION = 12_000;
export const MAX_DOCX_EMBEDDED_FONTS = 64;
export const MAX_DOCX_EMBEDDED_FONT_BYTES = 16 * 1024 * 1024;
export const MAX_STRUCTURE_IMAGES = 500;
export const MAX_IMAGE_APPEARANCES = 1_000;
export const MAX_IMAGE_APPEARANCES_TOTAL = 20_000;
export const MAX_IMAGE_NESTED_TABLE_DEPTH = 32;
export const MAX_PAGINATION_GEOMETRY_ENTRIES = 60_000;
export const MAX_PAGINATION_GEOMETRY_CHARS = 300_000;
export const MAX_PAGINATION_LINES_PER_BLOCK = 2_000;
export const MAX_PAGINATION_COLUMNS = 16;

/** Loading is separate from generation; a cold WASM model can take minutes. */
export const MODEL_LOAD_TIMEOUT_MS = 240_000;
/** Base generation budget; scaled by output tokens for slower hosts. */
export const MODEL_INFERENCE_TIMEOUT_MS = 300_000;
export const MODEL_INFERENCE_TIMEOUT_PER_TOKEN_MS = 1_500;
export const MODEL_INFERENCE_TIMEOUT_MAX_MS = 600_000;
export const MODEL_SELF_TEST_TIMEOUT_MS = 180_000;
export const MODEL_MAX_OUTPUT_TOKENS = 160;
export const MODEL_MAX_CONTEXT_TOKENS = 3072;

export const BACKUP_FORMAT = 'formflow-encrypted-backup';
export const BACKUP_VERSION = 3;
export const BACKUP_PASSPHRASE_MIN_LENGTH = 12;
export const MAX_BACKUP_BYTES = 200 * 1024 * 1024;
export const MAX_BACKUP_DOCUMENTS = 5000;
export const MAX_BACKUP_VALUES = 50000;
export const MAX_BACKUP_COLLECTIONS = 5000;
export const MAX_BACKUP_HISTORY = 50000;
export const MAX_BACKUP_PROFILE_RECORDS = 10000;
export const MAX_BACKUP_TEXT_RECORDS = 10000;
