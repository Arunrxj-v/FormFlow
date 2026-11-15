import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './security.mjs';

const path = process.env.DATABASE_PATH || new URL('./formflow.db', import.meta.url).pathname;
export const db = new DatabaseSync(path);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'Personal',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  file_type TEXT NOT NULL DEFAULT 'pdf',
  size_label TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'upload',
  source_file_id TEXT,
  source_modified_at TEXT,
  extracted_text TEXT,
  storage_path TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  processing_error TEXT NOT NULL DEFAULT '',
  processed_at TEXT NOT NULL DEFAULT '',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT,
  category TEXT NOT NULL,
  source_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  source_page INTEGER,
  confidence REAL NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'extracted',
  sensitive INTEGER NOT NULL DEFAULT 0,
  extracted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_fields_user ON fields(user_id);
CREATE TABLE IF NOT EXISTS field_conflicts (
  id TEXT PRIMARY KEY,
  field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  source_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  source_page INTEGER,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conflicts_field ON field_conflicts(field_id);
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id);
CREATE TABLE IF NOT EXISTS collection_documents (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, document_id)
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id);
CREATE TABLE IF NOT EXISTS preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS form_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  website TEXT NOT NULL,
  url TEXT NOT NULL,
  collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  detected INTEGER NOT NULL DEFAULT 0,
  filled INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON form_sessions(user_id);
CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS google_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expiry INTEGER,
  scope TEXT,
  email TEXT,
  account_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

// Safe schema migration for documents table
const documentColumns = [
  { name: 'storage_path', type: 'TEXT NOT NULL DEFAULT ""' },
  { name: 'mime_type', type: 'TEXT NOT NULL DEFAULT ""' },
  { name: 'size_bytes', type: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'sha256', type: 'TEXT NOT NULL DEFAULT ""' },
  { name: 'processing_error', type: 'TEXT NOT NULL DEFAULT ""' },
  { name: 'processed_at', type: 'TEXT NOT NULL DEFAULT ""' },
];
for (const col of documentColumns) {
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN ${col.name} ${col.type};`);
  } catch {
    // Column already exists
  }
}

export const defaultPreferences = {
  confirmBeforeAutofill: true,
  requireSensitiveReview: true,
  autoDownloadFiles: false,
  activityNotifications: true,
  productNotifications: false,
  compactMode: false,
};

function now() {
  return new Date().toISOString();
}

function insertDocument(document) {
  db.prepare(`INSERT INTO documents (id,user_id,name,category,subcategory,status,file_type,size_label,source,source_file_id,is_demo,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    document.id, document.userId, document.name, document.category, document.subcategory, document.status,
    document.fileType, document.sizeLabel, document.source, document.sourceFileId ?? null, document.isDemo ? 1 : 0, now(), now(),
  );
}

function insertField(field) {
  db.prepare(`INSERT INTO fields (id,user_id,field_key,label,value,normalized_value,category,source_document_id,source_page,confidence,verification_status,sensitive,extracted_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    field.id, field.userId, field.key, field.label, field.value, field.normalizedValue ?? field.value, field.category,
    field.sourceDocumentId ?? null, field.sourcePage ?? null, field.confidence, field.verificationStatus ?? 'extracted',
    field.sensitive ? 1 : 0, now(), now(),
  );
}

export function seed() {
  // No-op: automatic demo seeding removed. A fresh installation initializes an empty database.
}

export function resetForTests() {
  db.exec('DELETE FROM google_connections; DELETE FROM ai_usage; DELETE FROM form_sessions; DELETE FROM activity; DELETE FROM collection_documents; DELETE FROM collections; DELETE FROM field_conflicts; DELETE FROM fields; DELETE FROM documents; DELETE FROM preferences; DELETE FROM users;');
}
