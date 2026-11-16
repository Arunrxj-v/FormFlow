import { FormFlowError } from '@shared/errors';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  MAX_BACKUP_COLLECTIONS,
  MAX_BACKUP_DOCUMENTS,
  MAX_BACKUP_HISTORY,
  MAX_BACKUP_PROFILE_RECORDS,
  MAX_BACKUP_TEXT_RECORDS,
  MAX_BACKUP_VALUES,
  MAX_DOCUMENT_BYTES,
  MAX_EXTRACTED_TEXT_CHARS,
  PBKDF2_ITERATIONS,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_MIME_TYPES,
} from '@shared/constants';
import type {
  ActivityRow,
  CollectionDocumentRow,
  CollectionRow,
  ConflictRecord,
  DocumentExtractionDetails,
  DocumentRecord,
  ExtractedValueRecord,
  FormHistoryRow,
  ProfileRecordRow,
  StoredDocumentFile,
  StoredDocumentText,
  StoredVaultProfileRow,
  VaultProfile,
} from '@shared/types';
import { getDb } from '../database/database';
import { vaultRepository as vaultRecordRepository } from '../database/vault-repository';
import {
  BACKUP_AAD,
  base64ToArrayBuffer,
  bufferToBase64,
  canonicalLengthPrefixed,
  decryptBytesWithKey,
  decryptBytesWithLegacyAad,
  decryptBytesWithRawAad,
  decryptJsonWithKey,
  deriveKeyFromPassword,
  encryptBytesWithKey,
  encryptBytesWithRawAad,
  encryptJsonWithKey,
  randomBytes,
  sha256Hex,
  type RecordAad,
} from '../encryption/crypto-service';
import { vaultSession } from '../vault/vault-session';
import { checkVaultIntegrity } from '../vault/vault-integrity';
import { asStorageError } from './storage-errors';
import { inferFileKind } from '../documents/validation';

export interface PortableDocument {
  record: Omit<DocumentRecord, 'nameEnc' | 'originalFilenameEnc'>;
  name: string;
  originalFilename: string;
}

export interface PortableFile {
  documentId: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
}

export interface PortableValue {
  record: Omit<ExtractedValueRecord, 'valueEnc' | 'normalizedValueEnc' | 'labelEnc'>;
  value: string;
  normalizedValue: string;
}

export interface PortableConflict {
  record: Omit<ConflictRecord, 'existingValueEnc' | 'newValueEnc' | 'labelEnc'>;
  existingValue: string;
  newValue: string;
}

export interface PortableProfileRecord {
  record: Omit<ProfileRecordRow, 'dataEnc'>;
  data: unknown;
}

export interface PortableCollection {
  record: Omit<CollectionRow, 'nameEnc' | 'descriptionEnc' | 'notesEnc'>;
  name: string;
  description: string;
  notes: string;
}

export interface PortableActivity {
  record: Omit<ActivityRow, 'titleEnc' | 'detailEnc'>;
  title: string;
  detail: string;
}

export interface PortableHistory {
  record: Omit<FormHistoryRow, 'websiteEnc' | 'urlEnc' | 'documentsUsedEnc'>;
  website: string;
  url: string;
  documentsUsed: string[];
}

export interface PortableText {
  record: Omit<StoredDocumentText, 'textEnc' | 'pageTextsEnc' | 'extractionEnc'>;
  text: string;
  pageTexts: string[];
  extraction?: DocumentExtractionDetails | null;
}

export interface PortableVaultPayload {
  format: 'formflow-portable-vault';
  schemaVersion: 3;
  exportedAt: string;
  profile: VaultProfile | null;
  documents: PortableDocument[];
  files: PortableFile[];
  values: PortableValue[];
  conflicts: PortableConflict[];
  profileRecords: PortableProfileRecord[];
  collections: PortableCollection[];
  collectionDocuments: CollectionDocumentRow[];
  activity: PortableActivity[];
  history: PortableHistory[];
  text: PortableText[];
}

export interface AuthenticatedBackupHeaderV3 {
  application: 'FormFlow';
  backupFormat: 3;
  cipher: 'AES-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  nonce: string;
  encryptionFormat: number;
  schemaVersion: 3;
  manifestVersion: 1;
  documentCount: number;
  valueCount: number;
  collectionCount: number;
  conflictCount: number;
  profileRecordCount: number;
  activityCount: number;
  historyCount: number;
  textCount: number;
  totalBytes: number;
  payloadBytes: number;
  createdAt: string;
}

export interface EncryptedBackupEnvelopeV3 {
  format: 'formflow-encrypted-backup';
  version: 3;
  header: AuthenticatedBackupHeaderV3;
  payload: string;
}

/** Canonical, length-prefixed AAD for the complete backup v3 header. */
export function authenticatedBackupHeaderAad(header: AuthenticatedBackupHeaderV3): Uint8Array {
  return canonicalLengthPrefixed([
    'formflow',
    'backup-header',
    '3',
    'application', header.application,
    'backupFormat', String(header.backupFormat),
    'cipher', header.cipher,
    'kdf', header.kdf,
    'iterations', String(header.iterations),
    'salt', header.salt,
    'nonce', header.nonce,
    'encryptionFormat', String(header.encryptionFormat),
    'schemaVersion', String(header.schemaVersion),
    'manifestVersion', String(header.manifestVersion),
    'documentCount', String(header.documentCount),
    'valueCount', String(header.valueCount),
    'collectionCount', String(header.collectionCount),
    'conflictCount', String(header.conflictCount),
    'profileRecordCount', String(header.profileRecordCount),
    'activityCount', String(header.activityCount),
    'historyCount', String(header.historyCount),
    'textCount', String(header.textCount),
    'totalBytes', String(header.totalBytes),
    'payloadBytes', String(header.payloadBytes),
    'createdAt', header.createdAt,
  ]);
}

export interface EncryptedBackupEnvelope {
  format: 'formflow-encrypted-backup';
  version: 1 | 2;
  createdAt: string;
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  manifest: {
    schemaVersion: number;
    documentCount: number;
    valueCount: number;
    collectionCount: number;
    conflictCount: number;
    totalBytes: number;
  };
  payload: string;
}

interface ArchiveLimits {
  documents: number;
  values: number;
  collections: number;
  conflicts: number;
  profileRecords: number;
  history: number;
  text: number;
}

/** The documented limit is 200 × 1024 × 1024 bytes (209,715,200 bytes). */
export const BACKUP_SIZE_LIMIT_BYTES = MAX_BACKUP_BYTES;

export function assertBackupSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new FormFlowError('BACKUP_INVALID', 'The backup file is empty.');
  }
  if (sizeBytes > MAX_BACKUP_BYTES) {
    throw new FormFlowError('BACKUP_INVALID', 'Backup file is larger than the 200 MB local import limit.');
  }
}

const LIMITS: ArchiveLimits = {
  documents: MAX_BACKUP_DOCUMENTS,
  values: MAX_BACKUP_VALUES,
  collections: MAX_BACKUP_COLLECTIONS,
  conflicts: MAX_BACKUP_VALUES,
  profileRecords: MAX_BACKUP_PROFILE_RECORDS,
  history: MAX_BACKUP_HISTORY,
  text: MAX_BACKUP_TEXT_RECORDS,
};

const DOCUMENT_STATUSES = new Set([
  'selected', 'validating', 'storing', 'stored', 'extracting_text', 'running_ocr',
  'extracting_information', 'validating_results', 'review_required', 'completed', 'failed',
]);
const EXTRACTION_METHODS = new Set(['deterministic', 'ai', 'manual', 'derived']);
const VERIFICATION_STATUSES = new Set(['extracted', 'user_verified', 'outdated']);
const HISTORY_STATUSES = new Set(['Completed', 'Partially completed', 'Cancelled', 'Failed']);
const PROFILE_TYPES = new Set(['education', 'employment', 'skill', 'certification', 'project', 'address']);
const ACTIVITY_TYPES = new Set([
  'document_added', 'document_processed', 'form_detected', 'form_filled',
  'document_updated', 'document_removed', 'vault_created', 'model_installed',
]);
const CATEGORY_VALUES = new Set([
  'personal', 'contact', 'address', 'education', 'employment', 'skills',
  'certifications', 'projects', 'identification', 'other',
]);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

type JsonObject = Record<string, unknown>;

function invalid(message: string): never {
  throw new FormFlowError('BACKUP_INVALID', message);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, label: string): JsonObject {
  if (!isObject(value)) invalid(`${label} must be an object.`);
  return value;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`);
  if (value.length > max) invalid(`${label} exceeds the supported record count.`);
  return value;
}

function allowedKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) invalid(`${label} contains a forbidden property.`);
    if (!allowed.includes(key)) invalid(`${label} contains an unexpected property.`);
  }
}

function string(value: unknown, label: string, max: number, min = 0): string {
  if (typeof value !== 'string') invalid(`${label} must be a string.`);
  if (value.length < min) invalid(`${label} is empty.`);
  if (value.length > max) invalid(`${label} is too long.`);
  return value;
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return string(value, label, max);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean.`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  return boolean(value, label);
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    invalid(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

function optionalInteger(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  return integer(value, label, min, max);
}

function optionalNumber(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(`${label} is outside the supported range.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = string(value, label, 64, 1);
  if (Number.isNaN(Date.parse(text))) invalid(`${label} is not a valid timestamp.`);
  return text;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return timestamp(value, label);
}

function enumeration(value: unknown, label: string, allowed: Set<string>): string {
  const text = string(value, label, 80, 1);
  if (!allowed.has(text)) invalid(`${label} is not supported.`);
  return text;
}

function base64(value: unknown, label: string, expectedBytes?: number): Uint8Array {
  const text = string(value, label, Math.ceil(MAX_BACKUP_BYTES * 4 / 3) + 1024, 1);
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) invalid(`${label} is not valid base64.`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(base64ToArrayBuffer(text));
  } catch {
    invalid(`${label} is not valid base64.`);
  }
  if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) invalid(`${label} has an unexpected length.`);
  return bytes;
}

function assertJsonValue(value: unknown, label: string, depth = 0, budget = { nodes: 0 }): void {
  if (depth > 8) invalid(`${label} is nested too deeply.`);
  budget.nodes += 1;
  if (budget.nodes > 20_000) invalid(`${label} is too complex.`);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) invalid(`${label} contains an invalid number.`);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 20_000) invalid(`${label} contains an oversized string.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 5_000) invalid(`${label} contains too many array entries.`);
    for (const item of value) assertJsonValue(item, label, depth + 1, budget);
    return;
  }
  if (!isObject(value)) invalid(`${label} contains an unsupported value.`);
  const keys = Object.keys(value);
  if (keys.length > 1_000) invalid(`${label} contains too many properties.`);
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) invalid(`${label} contains a forbidden property.`);
    assertJsonValue(value[key], label, depth + 1, budget);
  }
}

function validateProfile(value: unknown): VaultProfile {
  const profile = object(value, 'Backup profile');
  allowedKeys(profile, ['id', 'name', 'email', 'accountType', 'createdAt', 'updatedAt'], 'Backup profile');
  if (profile.id !== 'me') invalid('Backup profile has an invalid identifier.');
  return {
    id: 'me',
    name: string(profile.name, 'Backup profile name', 200),
    email: string(profile.email, 'Backup profile email', 320),
    accountType: enumeration(profile.accountType, 'Backup profile account type', new Set(['Personal', 'Pro', 'Local'])) as VaultProfile['accountType'],
    createdAt: timestamp(profile.createdAt, 'Backup profile createdAt'),
    updatedAt: timestamp(profile.updatedAt, 'Backup profile updatedAt'),
  };
}

const DOCUMENT_KEYS = [
  'id', 'vaultId', 'mimeType', 'extension', 'category', 'subcategory', 'status', 'fileType',
  'sizeBytes', 'sizeLabel', 'checksum', 'storageKey', 'source', 'pageCount', 'ocrUsed',
  'extractedTextStatus', 'extractionVersion', 'extractedAt', 'ocrRequired', 'metadata',
  'confidence', 'failureReason', 'processingError', 'stageDetail', 'createdAt', 'updatedAt',
] as const;

function validateDocumentRecord(value: unknown): Omit<DocumentRecord, 'nameEnc' | 'originalFilenameEnc'> {
  const record = object(value, 'Backup document record');
  allowedKeys(record, DOCUMENT_KEYS, 'Backup document record');
  const extension = string(record.extension, 'Backup document extension', 16, 1).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(extension as (typeof SUPPORTED_EXTENSIONS)[number])) {
    invalid('Backup document uses an unsupported extension.');
  }
  const fileType = string(record.fileType, 'Backup document file type', 16, 1);
  if (fileType !== inferFileKind(`document.${extension}`)) invalid('Backup document file type does not match its extension.');
  const mimeType = string(record.mimeType, 'Backup document MIME type', 160, 1);
  if (!SUPPORTED_MIME_TYPES.includes(mimeType as (typeof SUPPORTED_MIME_TYPES)[number])) {
    invalid('Backup document uses an unsupported MIME type.');
  }
  const metadata = record.metadata;
  if (metadata !== undefined) {
    if (!isObject(metadata)) invalid('Backup document metadata must be an object.');
    assertJsonValue(metadata, 'Backup document metadata');
  }
  return {
    id: string(record.id, 'Backup document id', 160, 1),
    vaultId: string(record.vaultId, 'Backup document vault id', 160, 1),
    mimeType,
    extension,
    category: string(record.category, 'Backup document category', 100),
    subcategory: string(record.subcategory, 'Backup document subcategory', 200),
    status: enumeration(record.status, 'Backup document status', DOCUMENT_STATUSES) as DocumentRecord['status'],
    fileType: fileType as DocumentRecord['fileType'],
    sizeBytes: integer(record.sizeBytes, 'Backup document size', 1, MAX_DOCUMENT_BYTES),
    sizeLabel: string(record.sizeLabel, 'Backup document size label', 30),
    checksum: string(record.checksum, 'Backup document checksum', 64, 64),
    storageKey: string(record.storageKey, 'Backup document storage key', 200),
    source: enumeration(record.source, 'Backup document source', new Set(['device', 'legacy-import'])) as DocumentRecord['source'],
    pageCount: optionalInteger(record.pageCount, 'Backup document page count', 0, 100_000),
    ocrUsed: boolean(record.ocrUsed, 'Backup document OCR flag'),
    extractedTextStatus: enumeration(record.extractedTextStatus, 'Backup document text status', new Set(['pending', 'extracted', 'failed'])) as DocumentRecord['extractedTextStatus'],
    extractionVersion: optionalInteger(record.extractionVersion, 'Backup document extraction version', 1, 1_000),
    extractedAt: optionalTimestamp(record.extractedAt, 'Backup document extraction timestamp'),
    ocrRequired: record.ocrRequired === undefined
      ? undefined
      : boolean(record.ocrRequired, 'Backup document OCR-required flag'),
    metadata: metadata as Record<string, unknown> | undefined,
    confidence: optionalNumber(record.confidence, 'Backup document confidence', 0, 100),
    failureReason: optionalString(record.failureReason, 'Backup document failure reason', 2_000),
    processingError: optionalString(record.processingError, 'Backup document processing error', 2_000),
    stageDetail: optionalString(record.stageDetail, 'Backup document stage detail', 2_000),
    createdAt: timestamp(record.createdAt, 'Backup document createdAt'),
    updatedAt: timestamp(record.updatedAt, 'Backup document updatedAt'),
  };
}

const VALUE_KEYS = [
  'id', 'key', 'label', 'category', 'sourceDocumentId', 'sourcePage', 'confidence',
  'extractionMethod', 'verificationStatus', 'sensitive', 'userModified', 'createdAt', 'updatedAt',
] as const;

function validateValueRecord(value: unknown): Omit<ExtractedValueRecord, 'valueEnc' | 'normalizedValueEnc' | 'labelEnc'> {
  const record = object(value, 'Backup value record');
  allowedKeys(record, VALUE_KEYS, 'Backup value record');
  return {
    id: string(record.id, 'Backup value id', 160, 1),
    key: string(record.key, 'Backup value key', 200, 1),
    label: string(record.label, 'Backup value label', 300),
    category: enumeration(record.category, 'Backup value category', CATEGORY_VALUES) as ExtractedValueRecord['category'],
    sourceDocumentId: string(record.sourceDocumentId, 'Backup value source document', 200),
    sourcePage: optionalInteger(record.sourcePage, 'Backup value source page', 0, 100_000),
    confidence: integer(record.confidence, 'Backup value confidence', 0, 100),
    extractionMethod: enumeration(record.extractionMethod, 'Backup value extraction method', EXTRACTION_METHODS) as ExtractedValueRecord['extractionMethod'],
    verificationStatus: enumeration(record.verificationStatus, 'Backup value verification status', VERIFICATION_STATUSES) as ExtractedValueRecord['verificationStatus'],
    sensitive: boolean(record.sensitive, 'Backup value sensitive flag'),
    userModified: boolean(record.userModified, 'Backup value modified flag'),
    createdAt: timestamp(record.createdAt, 'Backup value createdAt'),
    updatedAt: timestamp(record.updatedAt, 'Backup value updatedAt'),
  };
}

const CONFLICT_KEYS = [
  'id', 'key', 'label', 'existingSourceDocumentId', 'existingConfidence',
  'newSourceDocumentId', 'newConfidence', 'page', 'status', 'resolution', 'createdAt', 'resolvedAt',
] as const;

function validateConflictRecord(value: unknown): Omit<ConflictRecord, 'existingValueEnc' | 'newValueEnc' | 'labelEnc'> {
  const record = object(value, 'Backup conflict record');
  allowedKeys(record, CONFLICT_KEYS, 'Backup conflict record');
  return {
    id: string(record.id, 'Backup conflict id', 160, 1),
    key: string(record.key, 'Backup conflict key', 200, 1),
    label: string(record.label, 'Backup conflict label', 300),
    existingSourceDocumentId: string(record.existingSourceDocumentId, 'Backup conflict existing source', 200),
    existingConfidence: integer(record.existingConfidence, 'Backup conflict existing confidence', 0, 100),
    newSourceDocumentId: string(record.newSourceDocumentId, 'Backup conflict new source', 200),
    newConfidence: integer(record.newConfidence, 'Backup conflict new confidence', 0, 100),
    page: optionalInteger(record.page, 'Backup conflict page', 0, 100_000),
    status: enumeration(record.status, 'Backup conflict status', new Set(['open', 'resolved'])) as ConflictRecord['status'],
    resolution: record.resolution === undefined
      ? undefined
      : enumeration(record.resolution, 'Backup conflict resolution', new Set(['kept_existing', 'used_new', 'edited', 'outdated', 'kept_both'])) as ConflictRecord['resolution'],
    createdAt: timestamp(record.createdAt, 'Backup conflict createdAt'),
    resolvedAt: optionalTimestamp(record.resolvedAt, 'Backup conflict resolvedAt'),
  };
}

function validateProfileRecord(value: unknown): Omit<ProfileRecordRow, 'dataEnc'> {
  const record = object(value, 'Backup profile record');
  allowedKeys(record, ['id', 'type', 'documentId', 'createdAt', 'updatedAt'], 'Backup profile record');
  return {
    id: string(record.id, 'Backup profile record id', 160, 1),
    type: enumeration(record.type, 'Backup profile record type', PROFILE_TYPES) as ProfileRecordRow['type'],
    documentId: optionalString(record.documentId, 'Backup profile record document', 200),
    createdAt: timestamp(record.createdAt, 'Backup profile record createdAt'),
    updatedAt: timestamp(record.updatedAt, 'Backup profile record updatedAt'),
  };
}

function validateCollectionRecord(value: unknown): Omit<CollectionRow, 'nameEnc' | 'descriptionEnc' | 'notesEnc'> {
  const record = object(value, 'Backup collection record');
  allowedKeys(record, ['id', 'vaultId', 'color', 'createdAt', 'updatedAt'], 'Backup collection record');
  const color = string(record.color, 'Backup collection color', 20, 1);
  if (!/^#[0-9a-f]{6}$/i.test(color)) invalid('Backup collection color is invalid.');
  return {
    id: string(record.id, 'Backup collection id', 160, 1),
    vaultId: string(record.vaultId, 'Backup collection vault id', 160, 1),
    color,
    createdAt: timestamp(record.createdAt, 'Backup collection createdAt'),
    updatedAt: timestamp(record.updatedAt, 'Backup collection updatedAt'),
  };
}

function validateCollectionMembership(value: unknown): CollectionDocumentRow {
  const membership = object(value, 'Backup collection membership');
  allowedKeys(membership, ['id', 'collectionId', 'documentId'], 'Backup collection membership');
  return {
    id: string(membership.id, 'Backup membership id', 160, 1),
    collectionId: string(membership.collectionId, 'Backup membership collection', 160, 1),
    documentId: string(membership.documentId, 'Backup membership document', 160, 1),
  };
}

function validateActivityRecord(value: unknown): Omit<ActivityRow, 'titleEnc' | 'detailEnc'> {
  const record = object(value, 'Backup activity record');
  allowedKeys(record, ['id', 'type', 'createdAt'], 'Backup activity record');
  return {
    id: string(record.id, 'Backup activity id', 160, 1),
    type: enumeration(record.type, 'Backup activity type', ACTIVITY_TYPES) as ActivityRow['type'],
    createdAt: timestamp(record.createdAt, 'Backup activity createdAt'),
  };
}

function validateHistoryRecord(value: unknown): Omit<FormHistoryRow, 'websiteEnc' | 'urlEnc' | 'documentsUsedEnc'> {
  const record = object(value, 'Backup history record');
  allowedKeys(record, ['id', 'fieldsDetected', 'fieldsFilled', 'fieldsReview', 'status', 'durationMs', 'createdAt'], 'Backup history record');
  return {
    id: string(record.id, 'Backup history id', 160, 1),
    fieldsDetected: integer(record.fieldsDetected, 'Backup history detected count', 0, 1_000_000),
    fieldsFilled: integer(record.fieldsFilled, 'Backup history filled count', 0, 1_000_000),
    fieldsReview: integer(record.fieldsReview, 'Backup history review count', 0, 1_000_000),
    status: enumeration(record.status, 'Backup history status', HISTORY_STATUSES) as FormHistoryRow['status'],
    durationMs: integer(record.durationMs, 'Backup history duration', 0, 1_000_000_000),
    createdAt: timestamp(record.createdAt, 'Backup history createdAt'),
  };
}

function validateTextRecord(value: unknown): Omit<StoredDocumentText, 'textEnc' | 'pageTextsEnc' | 'extractionEnc'> {
  const record = object(value, 'Backup text record');
  allowedKeys(record, ['documentId', 'pageCount', 'method', 'createdAt'], 'Backup text record');
  return {
    documentId: string(record.documentId, 'Backup text document id', 160, 1),
    pageCount: integer(record.pageCount, 'Backup text page count', 0, 100_000),
    method: enumeration(record.method, 'Backup text method', new Set(['pdf-text', 'docx', 'ocr', 'txt', 'mixed'])) as StoredDocumentText['method'],
    createdAt: timestamp(record.createdAt, 'Backup text createdAt'),
  };
}

function validateExtractionDetails(value: unknown): DocumentExtractionDetails {
  const details = object(value, 'Backup extraction details');
  allowedKeys(details, ['version', 'ocrRequired', 'pagesNeedingOcr', 'warnings', 'metadata'], 'Backup extraction details');
  const warnings = array(details.warnings, 'Backup extraction warnings', 100).map((entry, index) => {
    const item = object(entry, `Backup extraction warning ${index}`);
    allowedKeys(item, ['code', 'message', 'page'], `Backup extraction warning ${index}`);
    return {
      code: string(item.code, `Backup extraction warning ${index} code`, 80, 1),
      message: string(item.message, `Backup extraction warning ${index} message`, 500, 1),
      ...(item.page === undefined ? {} : { page: integer(item.page, `Backup extraction warning ${index} page`, 1, 100_000) }),
    };
  });
  const metadata = object(details.metadata, 'Backup extraction metadata');
  allowedKeys(
    metadata,
    ['title', 'author', 'subject', 'keywords', 'creator', 'producer', 'creationDate', 'modDate', 'headings', 'tableCount', 'rowCount', 'encoding', 'bom', 'lineEndings'],
    'Backup extraction metadata',
  );
  const optionalText = (key: string, max: number): string | undefined =>
    metadata[key] === undefined ? undefined : string(metadata[key], `Backup extraction metadata ${key}`, max);
  const headings = metadata.headings === undefined
    ? undefined
    : array(metadata.headings, 'Backup extraction headings', 200).map((entry, index) => {
      const heading = object(entry, `Backup extraction heading ${index}`);
      allowedKeys(heading, ['level', 'text'], `Backup extraction heading ${index}`);
      return {
        level: integer(heading.level, `Backup extraction heading ${index} level`, 1, 9),
        text: string(heading.text, `Backup extraction heading ${index} text`, 500),
      };
    });
  const lineEndings = metadata.lineEndings === undefined
    ? undefined
    : enumeration(metadata.lineEndings, 'Backup extraction line endings', new Set(['lf', 'crlf', 'mixed'])) as 'lf' | 'crlf' | 'mixed';
  return {
    version: integer(details.version, 'Backup extraction version', 1, 1_000),
    ocrRequired: boolean(details.ocrRequired, 'Backup extraction OCR flag'),
    pagesNeedingOcr: array(details.pagesNeedingOcr, 'Backup extraction OCR pages', 100_000)
      .map((page, index) => integer(page, `Backup extraction OCR page ${index}`, 1, 100_000)),
    warnings,
    metadata: {
      ...(optionalText('title', 500) !== undefined ? { title: optionalText('title', 500) } : {}),
      ...(optionalText('author', 300) !== undefined ? { author: optionalText('author', 300) } : {}),
      ...(optionalText('subject', 1000) !== undefined ? { subject: optionalText('subject', 1000) } : {}),
      ...(optionalText('keywords', 1000) !== undefined ? { keywords: optionalText('keywords', 1000) } : {}),
      ...(optionalText('creator', 300) !== undefined ? { creator: optionalText('creator', 300) } : {}),
      ...(optionalText('producer', 300) !== undefined ? { producer: optionalText('producer', 300) } : {}),
      ...(optionalText('creationDate', 80) !== undefined ? { creationDate: optionalText('creationDate', 80) } : {}),
      ...(optionalText('modDate', 80) !== undefined ? { modDate: optionalText('modDate', 80) } : {}),
      ...(optionalText('encoding', 40) !== undefined ? { encoding: optionalText('encoding', 40) } : {}),
      ...(headings !== undefined ? { headings } : {}),
      ...(metadata.tableCount === undefined ? {} : { tableCount: integer(metadata.tableCount, 'Backup extraction table count', 0, 100_000) }),
      ...(metadata.rowCount === undefined ? {} : { rowCount: integer(metadata.rowCount, 'Backup extraction row count', 0, 1_000_000) }),
      ...(metadata.bom === undefined ? {} : { bom: boolean(metadata.bom, 'Backup extraction BOM flag') }),
      ...(lineEndings !== undefined ? { lineEndings } : {}),
    },
  };
}

function checkedBase64(value: unknown, label: string, expectedBytes?: number): { text: string; bytes: Uint8Array } {
  const text = String(value);
  const bytes = base64(value, label, expectedBytes);
  return { text, bytes };
}

function validatePayload(value: unknown, envelope: EncryptedBackupEnvelope): PortableVaultPayload {
  const payload = object(value, 'Backup payload');
  allowedKeys(
    payload,
    ['format', 'schemaVersion', 'exportedAt', 'profile', 'documents', 'files', 'values', 'conflicts', 'profileRecords', 'collections', 'collectionDocuments', 'activity', 'history', 'text'],
    'Backup payload',
  );
  if (payload.format !== 'formflow-portable-vault' || payload.schemaVersion !== 3) {
    throw new FormFlowError('BACKUP_VERSION_UNSUPPORTED', 'Unsupported portable vault schema.');
  }
  const exportedAt = timestamp(payload.exportedAt, 'Backup export timestamp');
  const profile = payload.profile === null ? null : validateProfile(payload.profile);
  const documentsRaw = array(payload.documents, 'Backup documents', LIMITS.documents);
  const filesRaw = array(payload.files, 'Backup files', LIMITS.documents);
  const valuesRaw = array(payload.values, 'Backup values', LIMITS.values);
  const conflictsRaw = array(payload.conflicts, 'Backup conflicts', LIMITS.conflicts);
  const profileRecordsRaw = array(payload.profileRecords, 'Backup profile records', LIMITS.profileRecords);
  const collectionsRaw = array(payload.collections, 'Backup collections', LIMITS.collections);
  const membershipsRaw = array(payload.collectionDocuments, 'Backup collection memberships', LIMITS.documents * 100);
  const activityRaw = array(payload.activity, 'Backup activity', LIMITS.history);
  const historyRaw = array(payload.history, 'Backup history', LIMITS.history);
  const textRaw = array(payload.text, 'Backup text', LIMITS.text);

  const documents: PortableDocument[] = documentsRaw.map((entry, index) => {
    const item = object(entry, `Backup document ${index}`);
    allowedKeys(item, ['record', 'name', 'originalFilename'], `Backup document ${index}`);
    const record = validateDocumentRecord(item.record);
    const name = string(item.name, 'Backup document name', 255, 1);
    const originalFilename = string(item.originalFilename, 'Backup document original filename', 255, 1);
    const extension = name.split('.').pop()?.toLowerCase() ?? '';
    const originalExtension = originalFilename.split('.').pop()?.toLowerCase() ?? '';
    if (extension !== record.extension || originalExtension !== record.extension) {
      invalid(`Backup document "${name}" has inconsistent extension metadata.`);
    }
    return { record, name, originalFilename };
  });

  const files: PortableFile[] = filesRaw.map((entry, index) => {
    const item = object(entry, `Backup file ${index}`);
    allowedKeys(item, ['documentId', 'mimeType', 'sizeBytes', 'dataBase64'], `Backup file ${index}`);
    const documentId = string(item.documentId, 'Backup file document id', 160, 1);
    const mimeType = string(item.mimeType, 'Backup file MIME type', 160, 1);
    const sizeBytes = integer(item.sizeBytes, `Backup file ${documentId} size`, 1, MAX_DOCUMENT_BYTES);
    const encoded = string(
      item.dataBase64,
      `Backup file ${documentId} payload`,
      Math.ceil(MAX_DOCUMENT_BYTES * 4 / 3) + 16,
      1,
    );
    const dataBase64 = checkedBase64(encoded, `Backup file ${documentId} payload`, sizeBytes).text;
    return { documentId, mimeType, sizeBytes, dataBase64 };
  });

  const values: PortableValue[] = valuesRaw.map((entry, index) => {
    const item = object(entry, `Backup value ${index}`);
    allowedKeys(item, ['record', 'value', 'normalizedValue'], `Backup value ${index}`);
    return {
      record: validateValueRecord(item.record),
      value: string(item.value, 'Backup value', 100_000),
      normalizedValue: string(item.normalizedValue, 'Backup normalized value', 100_000),
    };
  });

  const conflicts: PortableConflict[] = conflictsRaw.map((entry, index) => {
    const item = object(entry, `Backup conflict ${index}`);
    allowedKeys(item, ['record', 'existingValue', 'newValue'], `Backup conflict ${index}`);
    return {
      record: validateConflictRecord(item.record),
      existingValue: string(item.existingValue, 'Backup conflict existing value', 100_000),
      newValue: string(item.newValue, 'Backup conflict new value', 100_000),
    };
  });

  const profileRecords: PortableProfileRecord[] = profileRecordsRaw.map((entry, index) => {
    const item = object(entry, `Backup profile record ${index}`);
    allowedKeys(item, ['record', 'data'], `Backup profile record ${index}`);
    assertJsonValue(item.data, 'Backup profile record data');
    return { record: validateProfileRecord(item.record), data: item.data };
  });

  const collections: PortableCollection[] = collectionsRaw.map((entry, index) => {
    const item = object(entry, `Backup collection ${index}`);
    allowedKeys(item, ['record', 'name', 'description', 'notes'], `Backup collection ${index}`);
    return {
      record: validateCollectionRecord(item.record),
      name: string(item.name, 'Backup collection name', 200),
      description: string(item.description, 'Backup collection description', 5_000),
      notes: string(item.notes, 'Backup collection notes', 20_000),
    };
  });

  const collectionDocuments = membershipsRaw.map(validateCollectionMembership);

  const activity: PortableActivity[] = activityRaw.map((entry, index) => {
    const item = object(entry, `Backup activity ${index}`);
    allowedKeys(item, ['record', 'title', 'detail'], `Backup activity ${index}`);
    return {
      record: validateActivityRecord(item.record),
      title: string(item.title, 'Backup activity title', 5_000),
      detail: string(item.detail, 'Backup activity detail', 20_000),
    };
  });

  const history: PortableHistory[] = historyRaw.map((entry, index) => {
    const item = object(entry, `Backup history ${index}`);
    allowedKeys(item, ['record', 'website', 'url', 'documentsUsed'], `Backup history ${index}`);
    const documentsUsed = array(item.documentsUsed, 'Backup history documents used', 200).map((document, docIndex) =>
      string(document, `Backup history document ${docIndex}`, 255),
    );
    return {
      record: validateHistoryRecord(item.record),
      website: string(item.website, 'Backup history website', 300),
      url: string(item.url, 'Backup history URL', 4_096),
      documentsUsed,
    };
  });

  const text: PortableText[] = textRaw.map((entry, index) => {
    const item = object(entry, `Backup text ${index}`);
    allowedKeys(item, ['record', 'text', 'pageTexts', 'extraction'], `Backup text ${index}`);
    const record = validateTextRecord(item.record);
    const pageTexts = array(item.pageTexts, 'Backup page texts', 100_000).map((page, pageIndex) =>
      string(page, `Backup page text ${pageIndex}`, MAX_EXTRACTED_TEXT_CHARS),
    );
    if (pageTexts.length !== record.pageCount) invalid('Backup page text count does not match its metadata.');
    return {
      record,
      text: string(item.text, 'Backup text', MAX_EXTRACTED_TEXT_CHARS),
      pageTexts,
      ...(item.extraction === undefined ? {} : { extraction: validateExtractionDetails(item.extraction) }),
    };
  });

  if (envelope.manifest.schemaVersion !== 3) invalid('Backup manifest schema version is unsupported.');
  if (envelope.manifest.documentCount !== documents.length) invalid('Backup document count does not match the manifest.');
  if (envelope.manifest.valueCount !== values.length) invalid('Backup value count does not match the manifest.');
  if (envelope.manifest.collectionCount !== collections.length) invalid('Backup collection count does not match the manifest.');
  if (envelope.manifest.conflictCount !== conflicts.length) invalid('Backup conflict count does not match the manifest.');
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (envelope.manifest.totalBytes !== totalBytes) invalid('Backup total size does not match the manifest.');

  const documentIds = new Set<string>();
  for (const document of documents) {
    if (documentIds.has(document.record.id)) invalid('Backup contains duplicate document identifiers.');
    documentIds.add(document.record.id);
  }
  const fileIds = new Set<string>();
  for (const file of files) {
    if (fileIds.has(file.documentId)) invalid('Backup contains duplicate file identifiers.');
    fileIds.add(file.documentId);
  }
  const filesById = new Map(files.map((file) => [file.documentId, file]));
  for (const document of documents) {
    const file = filesById.get(document.record.id);
    if (!file) invalid(`Backup is missing the file for "${document.name}".`);
    if (file.mimeType !== document.record.mimeType) invalid(`Backup file MIME type does not match "${document.name}".`);
  }
  for (const file of files) {
    if (!documentIds.has(file.documentId)) invalid('Backup contains a file without a document record.');
  }

  const collectionIds = new Set<string>();
  for (const collection of collections) {
    if (collectionIds.has(collection.record.id)) invalid('Backup contains duplicate collection identifiers.');
    collectionIds.add(collection.record.id);
  }
  const membershipIds = new Set<string>();
  const membershipPairs = new Set<string>();
  for (const membership of collectionDocuments) {
    if (membershipIds.has(membership.id)) invalid('Backup contains duplicate collection membership identifiers.');
    membershipIds.add(membership.id);
    if (!collectionIds.has(membership.collectionId)) invalid('Backup contains a collection membership referencing a missing collection.');
    if (!documentIds.has(membership.documentId)) invalid('Backup contains a collection membership referencing a missing document.');
    const pair = `${membership.collectionId}\u0000${membership.documentId}`;
    if (membershipPairs.has(pair)) invalid('Backup contains a duplicate collection membership.');
    membershipPairs.add(pair);
  }

  const uniqueIds = (items: Array<{ id: string }>, label: string) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) invalid(`Backup contains duplicate ${label} identifiers.`);
      seen.add(item.id);
    }
  };
  uniqueIds(values.map((item) => item.record), 'value');
  uniqueIds(conflicts.map((item) => item.record), 'conflict');
  uniqueIds(profileRecords.map((item) => item.record), 'profile record');
  uniqueIds(activity.map((item) => item.record), 'activity');
  uniqueIds(history.map((item) => item.record), 'history');
  const textIds = new Set<string>();
  for (const item of text) {
    if (textIds.has(item.record.documentId)) invalid('Backup contains duplicate text record identifiers.');
    textIds.add(item.record.documentId);
  }

  return {
    format: 'formflow-portable-vault',
    schemaVersion: 3,
    exportedAt,
    profile,
    documents,
    files,
    values,
    conflicts,
    profileRecords,
    collections,
    collectionDocuments,
    activity,
    history,
    text,
  };
}

async function targetVaultIsEmpty(): Promise<boolean> {
  const db = await getDb();
  const [documents, values, collections, profileRow, activeVault] = await Promise.all([
    db.getAll('documents'),
    db.getAll('extractedValues'),
    db.getAll('collections'),
    db.get('vaultProfile', 'me'),
    vaultRecordRepository.getActive(),
  ]);
  if (documents.length > 0 || values.length > 0 || collections.length > 0) return false;
  if (profileRow && activeVault) {
    try {
      const profile = await decryptJsonWithKey<VaultProfile>(
        await vaultSession.getDataKey(),
        profileRow.profileEnc,
        {
          vaultId: activeVault.id,
          recordType: 'profile',
          recordId: 'me',
          field: 'profile',
          schemaVersion: activeVault.schemaVersion ?? 2,
        },
      );
      const defaultProfile = profile.name === activeVault.name && !profile.email;
      if (!defaultProfile) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function contextFor(vault: { id: string; schemaVersion?: number }, recordType: string, recordId: string, field: string): RecordAad {
  return {
    vaultId: vault.id,
    recordType,
    recordId,
    field,
    schemaVersion: vault.schemaVersion ?? 2,
  };
}

const V3_ENVELOPE_KEYS = ['format', 'version', 'header', 'payload'] as const;
const V3_HEADER_KEYS = [
  'application', 'backupFormat', 'cipher', 'kdf', 'iterations', 'salt', 'nonce',
  'encryptionFormat', 'schemaVersion', 'manifestVersion',
  'documentCount', 'valueCount', 'collectionCount', 'conflictCount',
  'profileRecordCount', 'activityCount', 'historyCount', 'textCount',
  'totalBytes', 'payloadBytes', 'createdAt',
] as const;

const V3_DUPLICATE_CHECK_KEYS = [
  'format', 'version', 'header', 'payload', 'application', 'backupFormat', 'cipher', 'kdf',
  'iterations', 'salt', 'nonce', 'encryptionFormat', 'schemaVersion', 'manifestVersion',
  'documentCount', 'valueCount', 'collectionCount', 'conflictCount', 'profileRecordCount',
  'activityCount', 'historyCount', 'textCount', 'totalBytes', 'payloadBytes', 'createdAt',
] as const;

/** JSON.parse is last-wins for duplicate keys. Reject duplicates in the v3 header. */
function rejectDuplicateV3Keys(rawText: string): void {
  for (const key of V3_DUPLICATE_CHECK_KEYS) {
    const count = rawText.match(new RegExp(`"${key}"\\s*:`, 'g'))?.length ?? 0;
    if (count > 1) invalid(`Backup contains duplicate "${key}" fields.`);
  }
}

async function decryptV3Archive(
  envelopeObject: JsonObject,
  rawText: string,
  passphrase: string,
): Promise<PortableVaultPayload> {
  rejectDuplicateV3Keys(rawText);
  allowedKeys(envelopeObject, V3_ENVELOPE_KEYS, 'Backup');
  if (envelopeObject.format !== BACKUP_FORMAT) {
    throw new FormFlowError('BACKUP_VERSION_UNSUPPORTED', 'This is not a supported FormFlow encrypted backup.');
  }
  if (envelopeObject.version !== 3) {
    throw new FormFlowError('BACKUP_VERSION_UNSUPPORTED', 'Unsupported backup envelope version.');
  }
  const headerObject = object(envelopeObject.header, 'Backup header');
  allowedKeys(headerObject, V3_HEADER_KEYS, 'Backup header');
  if (headerObject.application !== 'FormFlow') invalid('Backup application identifier is not supported.');
  if (headerObject.backupFormat !== 3) invalid('Backup header format is not supported.');
  if (headerObject.cipher !== 'AES-GCM') invalid('Unsupported backup cipher.');
  if (headerObject.kdf !== 'PBKDF2-SHA256') invalid('Unsupported backup key derivation.');
  if (headerObject.iterations !== PBKDF2_ITERATIONS) invalid('Backup key derivation parameters are not supported.');
  base64(headerObject.salt, 'Backup salt', 16);
  base64(headerObject.nonce, 'Backup nonce', 12);
  const encryptionFormat = integer(headerObject.encryptionFormat, 'Backup encryption format', 1, 2);
  if (headerObject.schemaVersion !== 3) invalid('Unsupported backup payload schema.');
  if (headerObject.manifestVersion !== 1) invalid('Unsupported backup manifest version.');
  const documentCount = integer(headerObject.documentCount, 'Backup document count', 0, LIMITS.documents);
  const valueCount = integer(headerObject.valueCount, 'Backup value count', 0, LIMITS.values);
  const collectionCount = integer(headerObject.collectionCount, 'Backup collection count', 0, LIMITS.collections);
  const conflictCount = integer(headerObject.conflictCount, 'Backup conflict count', 0, LIMITS.conflicts);
  const profileRecordCount = integer(headerObject.profileRecordCount, 'Backup profile record count', 0, LIMITS.profileRecords);
  const activityCount = integer(headerObject.activityCount, 'Backup activity count', 0, LIMITS.history);
  const historyCount = integer(headerObject.historyCount, 'Backup history count', 0, LIMITS.history);
  const textCount = integer(headerObject.textCount, 'Backup text count', 0, LIMITS.text);
  const totalBytes = integer(headerObject.totalBytes, 'Backup total bytes', 0, MAX_BACKUP_BYTES);
  const payloadBytes = integer(headerObject.payloadBytes, 'Backup payload size', 17, MAX_BACKUP_BYTES + 16);
  const createdAt = timestamp(headerObject.createdAt, 'Backup createdAt');
  const payloadText = string(
    envelopeObject.payload,
    'Backup payload',
    Math.ceil(MAX_BACKUP_BYTES * 4 / 3) + 1024,
    1,
  );
  const ciphertext = base64(payloadText, 'Backup payload');
  if (ciphertext.byteLength !== payloadBytes) invalid('Backup payload size does not match the authenticated header.');

  const header: AuthenticatedBackupHeaderV3 = {
    application: 'FormFlow',
    backupFormat: 3,
    cipher: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: headerObject.salt as string,
    nonce: headerObject.nonce as string,
    encryptionFormat,
    schemaVersion: 3,
    manifestVersion: 1,
    documentCount,
    valueCount,
    collectionCount,
    conflictCount,
    profileRecordCount,
    activityCount,
    historyCount,
    textCount,
    totalBytes,
    payloadBytes,
    createdAt,
  };

  let plaintext: ArrayBuffer;
  try {
    const backupKey = await deriveKeyFromPassword(
      passphrase,
      new Uint8Array(base64ToArrayBuffer(header.salt)),
      header.iterations,
    );
    plaintext = await decryptBytesWithRawAad(
      backupKey,
      header.nonce,
      ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer,
      authenticatedBackupHeaderAad(header),
    );
  } catch (error) {
    throw new FormFlowError('BACKUP_PASSWORD_INVALID', 'The backup passphrase is incorrect or the archive is corrupted.', { cause: error });
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    throw new FormFlowError('BACKUP_INVALID', 'The backup payload is not valid UTF-8.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new FormFlowError('BACKUP_INVALID', 'The decrypted backup payload is not valid JSON.');
  }

  const pseudoEnvelope: EncryptedBackupEnvelope = {
    format: BACKUP_FORMAT,
    version: 2,
    createdAt: header.createdAt,
    kdf: { name: 'PBKDF2-SHA256', iterations: header.iterations, salt: header.salt },
    cipher: { name: 'AES-GCM', iv: header.nonce },
    manifest: {
      schemaVersion: 3,
      documentCount: header.documentCount,
      valueCount: header.valueCount,
      collectionCount: header.collectionCount,
      conflictCount: header.conflictCount,
      totalBytes: header.totalBytes,
    },
    payload: payloadText,
  };
  const payload = validatePayload(parsed, pseudoEnvelope);
  if (
    payload.profileRecords.length !== header.profileRecordCount ||
    payload.activity.length !== header.activityCount ||
    payload.history.length !== header.historyCount ||
    payload.text.length !== header.textCount
  ) {
    invalid('Backup record counts do not match the authenticated header.');
  }
  return payload;
}

export type RestoreJournalStatus = 'validating' | 'ready' | 'activating' | 'complete' | 'failed';

export interface RestoreJournal {
  restoreId: string;
  status: RestoreJournalStatus;
  targetVaultId: string;
  archiveVersion: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  counts: { documents: number; values: number; collections: number };
  error?: string;
}

interface RestoreActivation {
  restoreId: string;
  targetVaultId: string;
  completedAt: string;
  counts: { documents: number; values: number; collections: number };
}

const RESTORE_JOURNAL_KEY = 'vaultRestoreJournal';
const RESTORE_ACTIVATION_KEY = 'vaultRestoreActivation';
let restoreInProgress = false;

async function writeRestoreJournal(journal: RestoreJournal): Promise<void> {
  const db = await getDb();
  await db.put('settings', { key: RESTORE_JOURNAL_KEY, value: journal, updatedAt: journal.updatedAt });
}

async function readRestoreJournal(): Promise<RestoreJournal | null> {
  const db = await getDb();
  const row = await db.get('settings', RESTORE_JOURNAL_KEY);
  return (row?.value as RestoreJournal | undefined) ?? null;
}

async function readRestoreActivation(): Promise<RestoreActivation | null> {
  const db = await getDb();
  const row = await db.get('settings', RESTORE_ACTIVATION_KEY);
  return (row?.value as RestoreActivation | undefined) ?? null;
}

async function targetCounts(): Promise<{ documents: number; values: number; collections: number }> {
  const db = await getDb();
  const [documents, values, collections] = await Promise.all([
    db.count('documents'),
    db.count('extractedValues'),
    db.count('collections'),
  ]);
  return { documents, values, collections };
}

async function markRestoreComplete(journal: RestoreJournal, activation: RestoreActivation): Promise<void> {
  const complete: RestoreJournal = {
    ...journal,
    status: 'complete',
    completedAt: activation.completedAt,
    updatedAt: new Date().toISOString(),
    error: undefined,
  };
  await writeRestoreJournal(complete);
}

/**
 * Inspect the actual database state, not only the journal. This runs on worker
 * startup and after unlock. It never deletes records.
 */
async function recoverInterruptedRestore(): Promise<RestoreJournal | null> {
  const journal = await readRestoreJournal();
  if (!journal) return null;
  if (journal.status === 'complete') return journal;
  const activation = await readRestoreActivation();
  const counts = await targetCounts();
  if (activation && activation.restoreId === journal.restoreId) {
    if (
      activation.targetVaultId === journal.targetVaultId &&
      counts.documents === activation.counts.documents &&
      counts.values === activation.counts.values &&
      counts.collections === activation.counts.collections
    ) {
      await markRestoreComplete(journal, activation);
      return { ...journal, status: 'complete', completedAt: activation.completedAt };
    }
    const failed: RestoreJournal = {
      ...journal,
      status: 'failed',
      updatedAt: new Date().toISOString(),
      error: 'The activation marker exists but the active record counts do not match. Records were preserved for inspection.',
    };
    await writeRestoreJournal(failed);
    return failed;
  }
  const isTargetEmpty = counts.documents === 0 && counts.values === 0 && counts.collections === 0;
  const failed: RestoreJournal = {
    ...journal,
    status: 'failed',
    updatedAt: new Date().toISOString(),
    error: isTargetEmpty
      ? 'The restore did not activate. The target vault is unchanged and the staged restore can be retried.'
      : 'The restore state is ambiguous; the target contains records but no matching activation marker. Records were preserved.',
  };
  await writeRestoreJournal(failed);
  return failed;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function verifyPreparedImport(
  key: CryptoKey,
  activeVault: { id: string; schemaVersion?: number },
  payload: PortableVaultPayload,
  prepared: {
    profile: { profileEnc: string; updatedAt: string } | null;
    documents: DocumentRecord[];
    files: StoredDocumentFile[];
    values: ExtractedValueRecord[];
    conflicts: ConflictRecord[];
    profileRecords: ProfileRecordRow[];
    collections: CollectionRow[];
    activity: ActivityRow[];
    history: FormHistoryRow[];
    text: StoredDocumentText[];
  },
): Promise<void> {
  const context = (recordType: string, recordId: string, field: string) => contextFor(activeVault, recordType, recordId, field);
  const checkJson = async (encrypted: string, expected: unknown, recordType: string, recordId: string, field: string) => {
    const decoded = await decryptJsonWithKey<unknown>(key, encrypted, context(recordType, recordId, field));
    if (!sameJson(decoded, expected)) {
      throw new FormFlowError('VALIDATION_FAILED', `Pre-activation verification failed for ${recordType} ${recordId} (${field}).`);
    }
  };

  if (prepared.profile && payload.profile) await checkJson(prepared.profile.profileEnc, payload.profile, 'profile', 'me', 'profile');
  const documentNames = new Map(payload.documents.map((document) => [document.record.id, document]));
  const fileById = new Map(prepared.files.map((file) => [file.documentId, file]));
  for (const document of prepared.documents) {
    const source = documentNames.get(document.id);
    if (!source) invalid('Prepared document is missing its source representation.');
    await checkJson(document.nameEnc, source.name, 'document', document.id, 'name');
    await checkJson(document.originalFilenameEnc, source.originalFilename, 'document', document.id, 'originalFilename');
    const file = fileById.get(document.id);
    if (!file) throw new FormFlowError('VALIDATION_FAILED', `Prepared file is missing for ${document.id}.`);
    const plaintext = await decryptBytesWithKey(
      key,
      file.iv,
      await file.ciphertext.arrayBuffer(),
      context('documentFile', document.id, 'file'),
    );
    if (plaintext.byteLength !== document.sizeBytes) {
      throw new FormFlowError('VALIDATION_FAILED', `Prepared file size mismatch for ${document.id}.`);
    }
    if (await sha256Hex(plaintext) !== document.checksum) {
      throw new FormFlowError('VALIDATION_FAILED', `Prepared file checksum mismatch for ${document.id}.`);
    }
  }
  const valueById = new Map(payload.values.map((entry) => [entry.record.id, entry]));
  for (const value of prepared.values) {
    const source = valueById.get(value.id);
    if (!source) invalid('Prepared value is missing its source representation.');
    await checkJson(value.valueEnc, source.value, 'value', value.id, 'value');
    await checkJson(value.normalizedValueEnc, source.normalizedValue, 'value', value.id, 'normalizedValue');
    await checkJson(value.labelEnc ?? '', source.record.label, 'value', value.id, 'label');
  }
  const conflictById = new Map(payload.conflicts.map((entry) => [entry.record.id, entry]));
  for (const conflict of prepared.conflicts) {
    const source = conflictById.get(conflict.id);
    if (!source) invalid('Prepared conflict is missing its source representation.');
    await checkJson(conflict.existingValueEnc, source.existingValue, 'conflict', conflict.id, 'existingValue');
    await checkJson(conflict.newValueEnc, source.newValue, 'conflict', conflict.id, 'newValue');
    await checkJson(conflict.labelEnc ?? '', source.record.label, 'conflict', conflict.id, 'label');
  }
  const profileRecordById = new Map(payload.profileRecords.map((entry) => [entry.record.id, entry]));
  for (const record of prepared.profileRecords) {
    const source = profileRecordById.get(record.id);
    if (!source) invalid('Prepared profile record is missing its source representation.');
    await checkJson(record.dataEnc, source.data, `profileRecord:${record.type}`, record.id, 'data');
  }
  const collectionById = new Map(payload.collections.map((entry) => [entry.record.id, entry]));
  for (const collection of prepared.collections) {
    const source = collectionById.get(collection.id);
    if (!source) invalid('Prepared collection is missing its source representation.');
    await checkJson(collection.nameEnc, source.name, 'collection', collection.id, 'name');
    await checkJson(collection.descriptionEnc, source.description, 'collection', collection.id, 'description');
    await checkJson(collection.notesEnc, source.notes, 'collection', collection.id, 'notes');
  }
  const activityById = new Map(payload.activity.map((entry) => [entry.record.id, entry]));
  for (const item of prepared.activity) {
    const source = activityById.get(item.id);
    if (!source) invalid('Prepared activity is missing its source representation.');
    await checkJson(item.titleEnc, source.title, 'activity', item.id, 'title');
    await checkJson(item.detailEnc, source.detail, 'activity', item.id, 'detail');
  }
  const historyById = new Map(payload.history.map((entry) => [entry.record.id, entry]));
  for (const item of prepared.history) {
    const source = historyById.get(item.id);
    if (!source) invalid('Prepared history is missing its source representation.');
    await checkJson(item.websiteEnc, source.website, 'formHistory', item.id, 'website');
    await checkJson(item.urlEnc, source.url, 'formHistory', item.id, 'url');
    await checkJson(item.documentsUsedEnc, source.documentsUsed, 'formHistory', item.id, 'documentsUsed');
  }
  const textById = new Map(payload.text.map((entry) => [entry.record.documentId, entry]));
  for (const item of prepared.text) {
    const source = textById.get(item.documentId);
    if (!source) invalid('Prepared text is missing its source representation.');
    await checkJson(item.textEnc, source.text, 'documentText', item.documentId, 'text');
    await checkJson(item.pageTextsEnc, source.pageTexts, 'documentText', item.documentId, 'pageTexts');
    if (source.extraction !== undefined) {
      if (!item.extractionEnc) invalid('Prepared text is missing its encrypted extraction details.');
      await checkJson(item.extractionEnc, source.extraction, 'documentText', item.documentId, 'extraction');
    } else if (item.extractionEnc) {
      invalid('Prepared text contains extraction details that were not in the backup.');
    }
  }
}

export const vaultExportService = {
  async hasPortableData(): Promise<boolean> {
    return !(await targetVaultIsEmpty());
  },

  async exportEncrypted(passphrase: string): Promise<Blob> {
    if (!(await vaultSession.isUnlocked())) throw new FormFlowError('VAULT_LOCKED', 'Unlock the vault before exporting.');
    if (!passphrase || passphrase.length < 8) throw new FormFlowError('WEAK_PASSWORD', 'Use a backup passphrase of at least 8 characters.');
    const activeVault = await vaultRecordRepository.getActive();
    if (!activeVault) throw new FormFlowError('VAULT_NOT_FOUND', 'Create a local vault before exporting.');

    const db = await getDb();
    const [profileRow, documents, files, values, conflicts, profileRecords, collections, collectionDocuments, activity, history, text] = await Promise.all([
      db.get('vaultProfile', 'me'),
      db.getAll('documents'),
      db.getAll('documentFiles'),
      db.getAll('extractedValues'),
      db.getAll('conflicts'),
      db.getAll('profileRecords'),
      db.getAll('collections'),
      db.getAll('collectionDocuments'),
      db.getAll('activity'),
      db.getAll('formHistory'),
      db.getAll('documentText'),
    ]);

    const profile = profileRow
      ? await decryptJsonWithKey<VaultProfile>(
        await vaultSession.getDataKey(),
        profileRow.profileEnc,
        contextFor(activeVault, 'profile', 'me', 'profile'),
      )
      : null;

    const portableDocuments: PortableDocument[] = [];
    for (const record of documents as DocumentRecord[]) {
      const name = await decryptJsonWithKey<string>(
        await vaultSession.getDataKey(),
        record.nameEnc,
        contextFor(activeVault, 'document', record.id, 'name'),
      );
      const originalFilename = await decryptJsonWithKey<string>(
        await vaultSession.getDataKey(),
        record.originalFilenameEnc,
        contextFor(activeVault, 'document', record.id, 'originalFilename'),
      );
      const { nameEnc: _nameEnc, originalFilenameEnc: _originalFilenameEnc, ...rest } = record;
      portableDocuments.push({ record: rest, name, originalFilename });
    }

    const portableFiles: PortableFile[] = [];
    for (const file of files as StoredDocumentFile[]) {
      const plaintext = file.aadVersion === 2
        ? await decryptBytesWithKey(
          await vaultSession.getDataKey(),
          file.iv,
          await file.ciphertext.arrayBuffer(),
          contextFor(activeVault, 'documentFile', file.documentId, 'file'),
        )
        : await decryptBytesWithLegacyAad(
          await vaultSession.getDataKey(),
          file.iv,
          await file.ciphertext.arrayBuffer(),
        );
      portableFiles.push({
        documentId: file.documentId,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        dataBase64: await blobToBase64(new Blob([plaintext], { type: file.mimeType })),
      });
    }

    const portableValues: PortableValue[] = [];
    for (const record of values as ExtractedValueRecord[]) {
      const { valueEnc, normalizedValueEnc, labelEnc, ...rest } = record;
      const label = labelEnc
        ? await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          labelEnc,
          contextFor(activeVault, 'value', record.id, 'label'),
        )
        : record.label;
      portableValues.push({
        record: { ...rest, label },
        value: await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          valueEnc,
          contextFor(activeVault, 'value', record.id, 'value'),
        ),
        normalizedValue: await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          normalizedValueEnc,
          contextFor(activeVault, 'value', record.id, 'normalizedValue'),
        ),
      });
    }

    const portableConflicts: PortableConflict[] = [];
    for (const record of conflicts as ConflictRecord[]) {
      const { existingValueEnc, newValueEnc, labelEnc, ...rest } = record;
      const label = labelEnc
        ? await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          labelEnc,
          contextFor(activeVault, 'conflict', record.id, 'label'),
        )
        : record.label;
      portableConflicts.push({
        record: { ...rest, label },
        existingValue: await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          existingValueEnc,
          contextFor(activeVault, 'conflict', record.id, 'existingValue'),
        ),
        newValue: await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          newValueEnc,
          contextFor(activeVault, 'conflict', record.id, 'newValue'),
        ),
      });
    }

    const portableProfileRecords: PortableProfileRecord[] = [];
    for (const record of profileRecords as ProfileRecordRow[]) {
      const { dataEnc, ...rest } = record;
      portableProfileRecords.push({
        record: rest,
        data: await decryptJsonWithKey<unknown>(
          await vaultSession.getDataKey(),
          dataEnc,
          contextFor(activeVault, `profileRecord:${record.type}`, record.id, 'data'),
        ),
      });
    }

    const portableCollections: PortableCollection[] = [];
    for (const record of collections as CollectionRow[]) {
      const { nameEnc, descriptionEnc, notesEnc, ...rest } = record;
      portableCollections.push({
        record: rest,
        name: await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          nameEnc,
          contextFor(activeVault, 'collection', record.id, 'name'),
        ),
        description: await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          descriptionEnc,
          contextFor(activeVault, 'collection', record.id, 'description'),
        ),
        notes: await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          notesEnc,
          contextFor(activeVault, 'collection', record.id, 'notes'),
        ),
      });
    }

    const portableActivity: PortableActivity[] = [];
    for (const record of activity as ActivityRow[]) {
      const { titleEnc, detailEnc, ...rest } = record;
      portableActivity.push({
        record: rest,
        title: await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          titleEnc,
          contextFor(activeVault, 'activity', record.id, 'title'),
        ),
        detail: await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          detailEnc,
          contextFor(activeVault, 'activity', record.id, 'detail'),
        ),
      });
    }

    const portableHistory: PortableHistory[] = [];
    for (const record of history as FormHistoryRow[]) {
      const { websiteEnc, urlEnc, documentsUsedEnc, ...rest } = record;
      portableHistory.push({
        record: rest,
        website: await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          websiteEnc,
          contextFor(activeVault, 'formHistory', record.id, 'website'),
        ),
        url: await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          urlEnc,
          contextFor(activeVault, 'formHistory', record.id, 'url'),
        ),
        documentsUsed: await decryptJsonWithKey<string[]>(
          await vaultSession.getDataKey(),
          documentsUsedEnc,
          contextFor(activeVault, 'formHistory', record.id, 'documentsUsed'),
        ),
      });
    }

    const portableText: PortableText[] = [];
    for (const record of text as StoredDocumentText[]) {
      const { textEnc, pageTextsEnc, extractionEnc, ...rest } = record;
      portableText.push({
        record: rest,
        text: await decryptJsonWithKey<string>(
          await vaultSession.getDataKey(),
          textEnc,
          contextFor(activeVault, 'documentText', record.documentId, 'text'),
        ),
        pageTexts: await decryptJsonWithKey<string[]>(
          await vaultSession.getDataKey(),
          pageTextsEnc,
          contextFor(activeVault, 'documentText', record.documentId, 'pageTexts'),
        ),
        ...(extractionEnc
          ? {
            extraction: await decryptJsonWithKey<DocumentExtractionDetails>(
              await vaultSession.getDataKey(),
              extractionEnc,
              contextFor(activeVault, 'documentText', record.documentId, 'extraction'),
            ),
          }
          : {}),
      });
    }

    const payload: PortableVaultPayload = {
      format: 'formflow-portable-vault',
      schemaVersion: 3,
      exportedAt: new Date().toISOString(),
      profile,
      documents: portableDocuments,
      files: portableFiles,
      values: portableValues,
      conflicts: portableConflicts,
      profileRecords: portableProfileRecords,
      collections: portableCollections,
      collectionDocuments,
      activity: portableActivity,
      history: portableHistory,
      text: portableText,
    };

    const salt = randomBytes(16);
    const backupKey = await deriveKeyFromPassword(passphrase, salt, PBKDF2_ITERATIONS);
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const nonce = randomBytes(12);
    const meta = await getDb().then((db) => db.get('vaultMeta', 'meta'));
    const header: AuthenticatedBackupHeaderV3 = {
      application: 'FormFlow',
      backupFormat: 3,
      cipher: 'AES-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: PBKDF2_ITERATIONS,
      salt: bufferToBase64(salt),
      nonce: bufferToBase64(nonce),
      encryptionFormat: meta?.encryptionFormat ?? 1,
      schemaVersion: 3,
      manifestVersion: 1,
      documentCount: portableDocuments.length,
      valueCount: portableValues.length,
      collectionCount: portableCollections.length,
      conflictCount: portableConflicts.length,
      profileRecordCount: portableProfileRecords.length,
      activityCount: portableActivity.length,
      historyCount: portableHistory.length,
      textCount: portableText.length,
      totalBytes: portableFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
      payloadBytes: plaintext.byteLength + 16,
      createdAt: new Date().toISOString(),
    };
    const encrypted = await encryptBytesWithRawAad(
      backupKey,
      plaintext,
      authenticatedBackupHeaderAad(header),
      header.nonce,
    );
    if (encrypted.data.byteLength !== header.payloadBytes) {
      throw new FormFlowError('VALIDATION_FAILED', 'Backup encryption produced an unexpected payload size.');
    }
    const envelope: EncryptedBackupEnvelopeV3 = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      header,
      payload: bufferToBase64(encrypted.data),
    };
    return new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  },

  async importEncrypted(
    file: Blob,
    passphrase: string,
    options: { beforeActivation?: () => Promise<void> } = {},
  ): Promise<{ imported: boolean; documents: number; values: number; collections: number }> {
    if (restoreInProgress) {
      throw new FormFlowError('VALIDATION_FAILED', 'A vault restore is already in progress. Wait for it to finish.');
    }
    restoreInProgress = true;
    try {
      await recoverInterruptedRestore();
      const existing = await readRestoreJournal();
      if (existing && (existing.status === 'validating' || existing.status === 'ready' || existing.status === 'activating')) {
        throw new FormFlowError('VALIDATION_FAILED', 'An interrupted restore is still being recovered. Reopen the vault and retry.');
      }
      return await this.importEncryptedUnlocked(file, passphrase, options);
    } catch (error) {
      const journal = await readRestoreJournal().catch(() => null);
      if (journal && (journal.status === 'validating' || journal.status === 'ready' || journal.status === 'activating')) {
        await writeRestoreJournal({
          ...journal,
          status: 'failed',
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'Restore failed before activation.',
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      restoreInProgress = false;
    }
  },

  async recoverInterruptedRestore(): Promise<RestoreJournal | null> {
    return recoverInterruptedRestore();
  },

  async restoreStatus(): Promise<RestoreJournal | null> {
    return readRestoreJournal();
  },

  async importEncryptedUnlocked(
    file: Blob,
    passphrase: string,
    options: { beforeActivation?: () => Promise<void> } = {},
  ): Promise<{ imported: boolean; documents: number; values: number; collections: number }> {
    if (!(await vaultSession.isUnlocked())) throw new FormFlowError('VAULT_LOCKED', 'Unlock the vault before importing.');
    const activeVault = await vaultRecordRepository.getActive();
    if (!activeVault) throw new FormFlowError('VAULT_NOT_FOUND', 'Create a local vault before importing.');
    if (!(await targetVaultIsEmpty())) {
      throw new FormFlowError('VALIDATION_FAILED', 'The target vault already contains data. Import into an empty vault to avoid overwriting existing records.');
    }
    assertBackupSize(file.size);
    const restoreId = `restore_${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    let restoreJournal: RestoreJournal = {
      restoreId,
      status: 'validating',
      targetVaultId: activeVault.id,
      archiveVersion: 0,
      startedAt,
      updatedAt: startedAt,
      counts: { documents: 0, values: 0, collections: 0 },
    };
    await writeRestoreJournal(restoreJournal);

    let rawText: string;
    try {
      rawText = await file.text();
    } catch {
      throw new FormFlowError('BACKUP_INVALID', 'The backup could not be read.');
    }
    let envelopeValue: unknown;
    try {
      envelopeValue = JSON.parse(rawText);
    } catch {
      throw new FormFlowError('BACKUP_INVALID', 'The backup is not valid JSON.');
    }
    const envelopeObject = object(envelopeValue, 'Backup');
    if (envelopeObject.version !== 1 && envelopeObject.version !== 2 && envelopeObject.version !== 3) {
      throw new FormFlowError('BACKUP_VERSION_UNSUPPORTED', 'Unsupported backup envelope version.');
    }
    let payload: PortableVaultPayload;

    if (envelopeObject.version === 3) {
      payload = await decryptV3Archive(envelopeObject, rawText, passphrase);
    } else {
      allowedKeys(envelopeObject, ['format', 'version', 'createdAt', 'kdf', 'cipher', 'manifest', 'payload'], 'Backup');
      if (envelopeObject.format !== BACKUP_FORMAT) {
        throw new FormFlowError('BACKUP_VERSION_UNSUPPORTED', 'This is not a supported FormFlow encrypted backup.');
      }
      if (envelopeObject.version !== 1 && envelopeObject.version !== 2) {
        throw new FormFlowError('BACKUP_VERSION_UNSUPPORTED', 'Unsupported backup envelope version.');
      }
      timestamp(envelopeObject.createdAt, 'Backup createdAt');
      const kdf = object(envelopeObject.kdf, 'Backup KDF metadata');
      allowedKeys(kdf, ['name', 'iterations', 'salt'], 'Backup KDF metadata');
      if (kdf.name !== 'PBKDF2-SHA256') invalid('Unsupported backup key derivation.');
      if (kdf.iterations !== PBKDF2_ITERATIONS) invalid('Backup key derivation parameters are not supported.');
      base64(kdf.salt, 'Backup salt', 16);
      const cipher = object(envelopeObject.cipher, 'Backup cipher metadata');
      allowedKeys(cipher, ['name', 'iv'], 'Backup cipher metadata');
      if (cipher.name !== 'AES-GCM') invalid('Unsupported backup cipher.');
      base64(cipher.iv, 'Backup nonce', 12);
      const manifest = object(envelopeObject.manifest, 'Backup manifest');
      allowedKeys(manifest, ['schemaVersion', 'documentCount', 'valueCount', 'collectionCount', 'conflictCount', 'totalBytes'], 'Backup manifest');
      if (manifest.schemaVersion !== 3) invalid('Unsupported backup manifest schema.');
      integer(manifest.documentCount, 'Backup manifest document count', 0, LIMITS.documents);
      integer(manifest.valueCount, 'Backup manifest value count', 0, LIMITS.values);
      integer(manifest.collectionCount, 'Backup manifest collection count', 0, LIMITS.collections);
      integer(manifest.conflictCount, 'Backup manifest conflict count', 0, LIMITS.conflicts);
      integer(manifest.totalBytes, 'Backup manifest total bytes', 0, MAX_BACKUP_BYTES);
      const payloadText = string(envelopeObject.payload, 'Backup payload', Math.ceil(MAX_BACKUP_BYTES * 4 / 3) + 1024, 1);
      base64(payloadText, 'Backup payload');

      const envelope: EncryptedBackupEnvelope = {
        format: BACKUP_FORMAT,
        version: envelopeObject.version,
        createdAt: envelopeObject.createdAt as string,
        kdf: {
          name: 'PBKDF2-SHA256',
          iterations: PBKDF2_ITERATIONS,
          salt: kdf.salt as string,
        },
        cipher: { name: 'AES-GCM', iv: cipher.iv as string },
        manifest: {
          schemaVersion: 3,
          documentCount: manifest.documentCount as number,
          valueCount: manifest.valueCount as number,
          collectionCount: manifest.collectionCount as number,
          conflictCount: manifest.conflictCount as number,
          totalBytes: manifest.totalBytes as number,
        },
        payload: payloadText,
      };

      let plaintext: ArrayBuffer;
      try {
        const backupKey = await deriveKeyFromPassword(
          passphrase,
          new Uint8Array(base64ToArrayBuffer(envelope.kdf.salt)),
          PBKDF2_ITERATIONS,
        );
        const ciphertext = base64ToArrayBuffer(envelope.payload);
        plaintext = envelope.version === 2
          ? await decryptBytesWithKey(backupKey, envelope.cipher.iv, ciphertext, BACKUP_AAD)
          : await decryptBytesWithLegacyAad(backupKey, envelope.cipher.iv, ciphertext);
      } catch (error) {
        throw new FormFlowError('BACKUP_PASSWORD_INVALID', 'The backup passphrase is incorrect or the archive is corrupted.', { cause: error });
      }
      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
      } catch {
        throw new FormFlowError('BACKUP_INVALID', 'The backup payload is not valid UTF-8.');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoded);
      } catch {
        throw new FormFlowError('BACKUP_INVALID', 'The decrypted backup payload is not valid JSON.');
      }
      payload = validatePayload(parsed, envelope);
    }

    const filesById = new Map(payload.files.map((file) => [file.documentId, file]));
    for (const document of payload.documents) {
      const file = filesById.get(document.record.id);
      if (!file) invalid(`Backup is missing the file for "${document.name}".`);
      const blob = base64ToBlob(file.dataBase64, file.mimeType);
      if (blob.size !== file.sizeBytes) invalid(`Backup file size mismatch for "${document.name}".`);
      const checksum = await sha256Hex(await blob.arrayBuffer());
      if (checksum !== document.record.checksum) invalid(`Checksum verification failed for "${document.name}".`);
    }
    if (!(await targetVaultIsEmpty())) {
      throw new FormFlowError('VALIDATION_FAILED', 'The target vault changed during import. Import into an empty vault.');
    }

    const db = await getDb();
    const key = await vaultSession.getDataKey();
    const now = new Date().toISOString();
    const context = (recordType: string, recordId: string, field: string) => contextFor(activeVault, recordType, recordId, field);

    const encryptedProfile = payload.profile
      ? {
        id: 'me' as const,
        profileEnc: await encryptJsonWithKey(key, payload.profile, context('profile', 'me', 'profile')),
        updatedAt: now,
      }
      : null;

    const encryptedDocuments: DocumentRecord[] = [];
    for (const document of payload.documents) {
      encryptedDocuments.push({
        ...document.record,
        vaultId: activeVault.id,
        nameEnc: await encryptJsonWithKey(key, document.name, context('document', document.record.id, 'name')),
        originalFilenameEnc: await encryptJsonWithKey(
          key,
          document.originalFilename,
          context('document', document.record.id, 'originalFilename'),
        ),
        createdAt: document.record.createdAt,
        updatedAt: document.record.updatedAt,
      });
    }

    const encryptedFiles: StoredDocumentFile[] = [];
    for (const file of payload.files) {
      const blob = base64ToBlob(file.dataBase64, file.mimeType);
      const encrypted = await encryptBytesWithKey(
        key,
        await blob.arrayBuffer(),
        context('documentFile', file.documentId, 'file'),
      );
      encryptedFiles.push({
        documentId: file.documentId,
        storageKey: `file_${file.documentId}`,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        ciphertext: new Blob([encrypted.data], { type: 'application/octet-stream' }),
        iv: encrypted.iv,
        version: 2,
        aadVersion: 2,
        createdAt: now,
        updatedAt: now,
      });
    }

    const encryptedValues: ExtractedValueRecord[] = [];
    for (const value of payload.values) {
      encryptedValues.push({
        ...value.record,
        label: '',
        labelEnc: await encryptJsonWithKey(key, value.record.label, context('value', value.record.id, 'label')),
        valueEnc: await encryptJsonWithKey(key, value.value, context('value', value.record.id, 'value')),
        normalizedValueEnc: await encryptJsonWithKey(key, value.normalizedValue, context('value', value.record.id, 'normalizedValue')),
      });
    }

    const encryptedConflicts: ConflictRecord[] = [];
    for (const conflict of payload.conflicts) {
      encryptedConflicts.push({
        ...conflict.record,
        label: '',
        labelEnc: await encryptJsonWithKey(key, conflict.record.label, context('conflict', conflict.record.id, 'label')),
        existingValueEnc: await encryptJsonWithKey(key, conflict.existingValue, context('conflict', conflict.record.id, 'existingValue')),
        newValueEnc: await encryptJsonWithKey(key, conflict.newValue, context('conflict', conflict.record.id, 'newValue')),
      });
    }

    const encryptedProfileRecords: ProfileRecordRow[] = [];
    for (const profileRecord of payload.profileRecords) {
      encryptedProfileRecords.push({
        ...profileRecord.record,
        dataEnc: await encryptJsonWithKey(
          key,
          profileRecord.data,
          context(`profileRecord:${profileRecord.record.type}`, profileRecord.record.id, 'data'),
        ),
      });
    }

    const encryptedCollections: CollectionRow[] = [];
    for (const collection of payload.collections) {
      encryptedCollections.push({
        ...collection.record,
        vaultId: activeVault.id,
        nameEnc: await encryptJsonWithKey(key, collection.name, context('collection', collection.record.id, 'name')),
        descriptionEnc: await encryptJsonWithKey(key, collection.description, context('collection', collection.record.id, 'description')),
        notesEnc: await encryptJsonWithKey(key, collection.notes, context('collection', collection.record.id, 'notes')),
      });
    }

    const encryptedActivity: ActivityRow[] = [];
    for (const item of payload.activity) {
      encryptedActivity.push({
        ...item.record,
        titleEnc: await encryptJsonWithKey(key, item.title, context('activity', item.record.id, 'title')),
        detailEnc: await encryptJsonWithKey(key, item.detail, context('activity', item.record.id, 'detail')),
      });
    }

    const encryptedHistory: FormHistoryRow[] = [];
    for (const item of payload.history) {
      encryptedHistory.push({
        ...item.record,
        websiteEnc: await encryptJsonWithKey(key, item.website, context('formHistory', item.record.id, 'website')),
        urlEnc: await encryptJsonWithKey(key, item.url, context('formHistory', item.record.id, 'url')),
        documentsUsedEnc: await encryptJsonWithKey(key, item.documentsUsed, context('formHistory', item.record.id, 'documentsUsed')),
      });
    }

    const encryptedText: StoredDocumentText[] = [];
    for (const item of payload.text) {
      encryptedText.push({
        ...item.record,
        textEnc: await encryptJsonWithKey(key, item.text, context('documentText', item.record.documentId, 'text')),
        pageTextsEnc: await encryptJsonWithKey(key, item.pageTexts, context('documentText', item.record.documentId, 'pageTexts')),
        ...(item.extraction
          ? { extractionEnc: await encryptJsonWithKey(key, item.extraction, context('documentText', item.record.documentId, 'extraction')) }
          : {}),
      });
    }

    const restoreCounts = {
      documents: encryptedDocuments.length,
      values: encryptedValues.length,
      collections: encryptedCollections.length,
    };
    await verifyPreparedImport(key, activeVault, payload, {
      profile: encryptedProfile,
      documents: encryptedDocuments,
      files: encryptedFiles,
      values: encryptedValues,
      conflicts: encryptedConflicts,
      profileRecords: encryptedProfileRecords,
      collections: encryptedCollections,
      activity: encryptedActivity,
      history: encryptedHistory,
      text: encryptedText,
    });
    restoreJournal = {
      ...restoreJournal,
      status: 'ready',
      archiveVersion: Number(envelopeObject.version),
      updatedAt: new Date().toISOString(),
      counts: restoreCounts,
    };
    await writeRestoreJournal(restoreJournal);
    await options.beforeActivation?.();

    const tx = db.transaction(
      ['vaultProfile', 'documents', 'documentFiles', 'extractedValues', 'conflicts', 'profileRecords', 'collections', 'collectionDocuments', 'activity', 'formHistory', 'documentText', 'settings'],
      'readwrite',
    );
    try {
      const [activeDocuments, activeValues, activeCollections] = await Promise.all([
        tx.objectStore('documents').count(),
        tx.objectStore('extractedValues').count(),
        tx.objectStore('collections').count(),
      ]);
      if (activeDocuments !== 0 || activeValues !== 0 || activeCollections !== 0) {
        throw new FormFlowError('VALIDATION_FAILED', 'The target vault changed during restore. The restore was not activated.');
      }
      if (encryptedProfile) await tx.objectStore('vaultProfile').put(encryptedProfile);
      for (const record of encryptedDocuments) await tx.objectStore('documents').put(record);
      for (const record of encryptedFiles) await tx.objectStore('documentFiles').put(record);
      for (const record of encryptedValues) await tx.objectStore('extractedValues').put(record);
      for (const record of encryptedConflicts) await tx.objectStore('conflicts').put(record);
      for (const record of encryptedProfileRecords) await tx.objectStore('profileRecords').put(record);
      for (const record of encryptedCollections) await tx.objectStore('collections').put(record);
      for (const membership of payload.collectionDocuments) await tx.objectStore('collectionDocuments').put(membership);
      for (const record of encryptedActivity) await tx.objectStore('activity').put(record);
      for (const record of encryptedHistory) await tx.objectStore('formHistory').put(record);
      for (const record of encryptedText) await tx.objectStore('documentText').put(record);
      const completedAt = new Date().toISOString();
      const completeJournal: RestoreJournal = {
        ...restoreJournal,
        status: 'complete',
        updatedAt: completedAt,
        completedAt,
        error: undefined,
      };
      await tx.objectStore('settings').put({ key: RESTORE_JOURNAL_KEY, value: completeJournal, updatedAt: completedAt });
      await tx.objectStore('settings').put({
        key: RESTORE_ACTIVATION_KEY,
        value: {
          restoreId,
          targetVaultId: activeVault.id,
          completedAt,
          counts: restoreCounts,
        } satisfies RestoreActivation,
        updatedAt: completedAt,
      });
      await tx.done;
    } catch (error) {
      tx.done.catch(() => undefined);
      try {
        tx.abort();
      } catch {
        // The transaction may already be aborting.
      }
      throw asStorageError(error);
    }

    // Activation is now complete and the journal/marker committed atomically.
    return { imported: true, documents: payload.documents.length, values: payload.values.length, collections: payload.collections.length };
  },
};

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBlob(base64Text: string, mimeType: string): Blob {
  const bytes = new Uint8Array(base64ToArrayBuffer(base64Text));
  return new Blob([bytes], { type: mimeType });
}
