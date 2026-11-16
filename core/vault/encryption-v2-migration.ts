import { FormFlowError } from '@shared/errors';
import { ENCRYPTION_FORMAT_VERSION, VAULT_SCHEMA_VERSION } from '@shared/constants';
import type {
  ActivityRow,
  CollectionRow,
  ConflictRecord,
  DocumentRecord,
  ExtractedValueRecord,
  FormHistoryRow,
  ProfileRecordRow,
  StoredDocumentFile,
  StoredDocumentText,
  VaultMeta,
} from '@shared/types';
import type { IDBPDatabase } from 'idb';
import type { FormFlowDB } from '../database/schema';
import { getDb } from '../database/database';
import { vaultRepository as vaultRecordRepository } from '../database/vault-repository';
import {
  decryptBytesWithKey,
  decryptBytesWithLegacyAad,
  decryptJsonWithKey,
  encryptBytesWithKey,
  encryptJsonWithKey,
  isV2Envelope,
  sha256Hex,
  type RecordAad,
} from '../encryption/crypto-service';
import { vaultSession } from './vault-session';
import { asStorageError } from '../storage/storage-errors';

export interface EncryptionMigrationJournal {
  version: 2;
  status: 'in_progress' | 'complete' | 'failed';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  migrated: Record<string, number>;
  lastError?: string;
}

export type EncryptionMigrationFaultPoint =
  | 'before_migration'
  | 'before_batch'
  | 'before_write'
  | 'during_transaction'
  | 'after_commit'
  | 'before_journal'
  | 'after_journal'
  | 'before_verification'
  | 'before_marker'
  | 'after_marker';

export interface EncryptionMigrationOptions {
  /** Deterministic failure injection for crash/transaction tests. */
  fault?: (point: EncryptionMigrationFaultPoint, detail?: Record<string, unknown>) => void;
}

export interface EncryptionMigrationStatus {
  encryptionFormat: number;
  needsMigration: boolean;
  journal: EncryptionMigrationJournal | null;
}

const JOURNAL_KEY = 'encryptionMigrationV2';
const BATCH_SIZE = 20;
const BLOB_BATCH_SIZE = 1;

interface Identity {
  vaultId: string;
  schemaVersion: number;
}

interface Prepared<T> {
  key: string;
  expected: Record<string, unknown>;
  next: T;
}

function nowIso(): string {
  return new Date().toISOString();
}

function context(identity: Identity, recordType: string, recordId: string, field: string): RecordAad {
  return {
    vaultId: identity.vaultId,
    recordType,
    recordId,
    field,
    schemaVersion: identity.schemaVersion,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function readJson<T>(key: CryptoKey, payload: string, aad: RecordAad): Promise<T> {
  return decryptJsonWithKey<T>(key, payload, aad);
}

async function sealJson(key: CryptoKey, value: unknown, aad: RecordAad): Promise<string> {
  const encrypted = await encryptJsonWithKey(key, value, aad);
  const roundTrip = await decryptJsonWithKey<unknown>(key, encrypted, aad);
  if (!sameValue(roundTrip, value)) {
    throw new FormFlowError('VALIDATION_FAILED', 'Encryption verification failed for a migrated record.');
  }
  return encrypted;
}

async function sealBytes(key: CryptoKey, bytes: ArrayBuffer, aad: RecordAad): Promise<{ iv: string; data: ArrayBuffer; digest: string }> {
  const encrypted = await encryptBytesWithKey(key, bytes, aad);
  const roundTrip = await decryptBytesWithKey(key, encrypted.iv, encrypted.data, aad);
  const [expected, actual] = await Promise.all([sha256Hex(bytes), sha256Hex(roundTrip)]);
  if (expected !== actual) {
    throw new FormFlowError('VALIDATION_FAILED', 'Encryption verification failed for a migrated document.');
  }
  return { ...encrypted, digest: expected };
}

async function readJournal(): Promise<EncryptionMigrationJournal | null> {
  const db = await getDb();
  const row = await db.get('settings', JOURNAL_KEY);
  return (row?.value as EncryptionMigrationJournal | undefined) ?? null;
}

async function writeJournal(journal: EncryptionMigrationJournal): Promise<void> {
  const db = await getDb();
  await db.put('settings', { key: JOURNAL_KEY, value: journal, updatedAt: journal.updatedAt });
}

async function identity(): Promise<Identity> {
  const vault = await vaultRecordRepository.getActive();
  if (!vault) throw new FormFlowError('VAULT_NOT_FOUND', 'No active local vault exists.');
  return { vaultId: vault.id, schemaVersion: vault.schemaVersion ?? VAULT_SCHEMA_VERSION };
}

async function prepareRows<T>(
  rows: T[],
  keyOf: (row: T) => string,
  prepare: (row: T) => Promise<{ expected: Record<string, unknown>; next: T } | null>,
): Promise<Array<Prepared<T>>> {
  const prepared: Array<Prepared<T>> = [];
  for (const row of rows) {
    const result = await prepare(row);
    if (result) prepared.push({ key: keyOf(row), ...result });
  }
  return prepared;
}

async function putBatch<T>(
  db: IDBPDatabase<FormFlowDB>,
  storeName: 'vaultProfile' | 'documents' | 'extractedValues' | 'conflicts' | 'profileRecords' | 'collections' | 'activity' | 'formHistory' | 'documentText',
  prepared: Array<Prepared<T>>,
  fault?: EncryptionMigrationOptions['fault'],
): Promise<number> {
  if (!prepared.length) return 0;
  fault?.('before_write', { store: storeName, count: prepared.length });
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName) as unknown as {
    get(key: string): Promise<Record<string, unknown> | undefined>;
    put(value: unknown): Promise<unknown>;
  };
  let written = 0;
  try {
    for (const entry of prepared) {
      const current = await store.get(entry.key);
      if (!current) continue;
      const unchanged = Object.entries(entry.expected).every(([field, value]) => sameValue(current[field], value));
      if (!unchanged) continue;
      await store.put(entry.next);
      written += 1;
    }
    fault?.('during_transaction', { store: storeName, count: written });
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
  return written;
}

async function migrateProfile(db: IDBPDatabase<FormFlowDB>, key: CryptoKey, vault: Identity, fault?: EncryptionMigrationOptions['fault']): Promise<number> {
  const row = await db.get('vaultProfile', 'me');
  if (!row) return 0;
  const aad = context(vault, 'profile', 'me', 'profile');
  if (isV2Envelope(row.profileEnc)) return 0;
  const profile = await readJson<unknown>(key, row.profileEnc, aad);
  const next = { ...row, profileEnc: await sealJson(key, profile, aad) };
  fault?.('before_write', { store: 'vaultProfile', count: 1 });
  const tx = db.transaction('vaultProfile', 'readwrite');
  try {
    const current = await tx.objectStore('vaultProfile').get('me');
    if (current && current.profileEnc === row.profileEnc) await tx.objectStore('vaultProfile').put(next);
    fault?.('during_transaction', { store: 'vaultProfile', count: 1 });
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
  return 1;
}

async function migrateDocuments(db: IDBPDatabase<FormFlowDB>, key: CryptoKey, vault: Identity, fault?: EncryptionMigrationOptions['fault']): Promise<number> {
  const rows = await db.getAll('documents');
  let total = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const prepared = await prepareRows(
      rows.slice(offset, offset + BATCH_SIZE),
      (row) => row.id,
      async (row) => {
        if (row.vaultId !== vault.vaultId) {
          throw new FormFlowError('VALIDATION_FAILED', `Document ${row.id} belongs to a different vault.`);
        }
        const nameAad = context(vault, 'document', row.id, 'name');
        const filenameAad = context(vault, 'document', row.id, 'originalFilename');
        const nameNeeds = !isV2Envelope(row.nameEnc);
        const filenameNeeds = !isV2Envelope(row.originalFilenameEnc);
        if (!nameNeeds && !filenameNeeds) return null;
        const name = nameNeeds ? await readJson<string>(key, row.nameEnc, nameAad) : undefined;
        const filename = filenameNeeds ? await readJson<string>(key, row.originalFilenameEnc, filenameAad) : undefined;
        return {
          expected: {
            ...(nameNeeds ? { nameEnc: row.nameEnc } : {}),
            ...(filenameNeeds ? { originalFilenameEnc: row.originalFilenameEnc } : {}),
          },
          next: {
            ...row,
            ...(name !== undefined ? { nameEnc: await sealJson(key, name, nameAad) } : {}),
            ...(filename !== undefined ? { originalFilenameEnc: await sealJson(key, filename, filenameAad) } : {}),
          },
        };
      },
    );
    total += await putBatch(db, 'documents', prepared, fault);
  }
  return total;
}

async function migrateFiles(db: IDBPDatabase<FormFlowDB>, key: CryptoKey, vault: Identity, fault?: EncryptionMigrationOptions['fault']): Promise<number> {
  const rows = await db.getAll('documentFiles');
  let total = 0;
  for (let offset = 0; offset < rows.length; offset += BLOB_BATCH_SIZE) {
    const row = rows[offset]!;
    if (row.aadVersion === 2) continue;
    const aad = context(vault, 'documentFile', row.documentId, 'file');
    const ciphertext = await row.ciphertext.arrayBuffer();
    const plaintext = await decryptBytesWithLegacyAad(key, row.iv, ciphertext);
    const sealed = await sealBytes(key, plaintext, aad);
    const next: StoredDocumentFile = {
      ...row,
      ciphertext: new Blob([sealed.data], { type: 'application/octet-stream' }),
      iv: sealed.iv,
      aadVersion: 2,
      updatedAt: nowIso(),
    };
    fault?.('before_write', { store: 'documentFiles', count: 1 });
    const tx = db.transaction('documentFiles', 'readwrite');
    try {
      const current = await tx.objectStore('documentFiles').get(row.documentId);
      if (current && current.iv === row.iv && (current.aadVersion ?? 1) === (row.aadVersion ?? 1)) {
        await tx.objectStore('documentFiles').put(next);
        total += 1;
      }
      fault?.('during_transaction', { store: 'documentFiles', count: 1 });
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
  }
  return total;
}

async function migrateValues(db: IDBPDatabase<FormFlowDB>, key: CryptoKey, vault: Identity, fault?: EncryptionMigrationOptions['fault']): Promise<number> {
  const rows = await db.getAll('extractedValues');
  let total = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const prepared = await prepareRows(
      rows.slice(offset, offset + BATCH_SIZE),
      (row) => row.id,
      async (row) => {
        const valueAad = context(vault, 'value', row.id, 'value');
        const normalizedAad = context(vault, 'value', row.id, 'normalizedValue');
        const labelAad = context(vault, 'value', row.id, 'label');
        const valueNeeds = !isV2Envelope(row.valueEnc);
        const normalizedNeeds = !isV2Envelope(row.normalizedValueEnc);
        const labelNeeds = !row.labelEnc || !isV2Envelope(row.labelEnc);
        if (!valueNeeds && !normalizedNeeds && !labelNeeds) return null;
        const value = valueNeeds ? await readJson<string>(key, row.valueEnc, valueAad) : undefined;
        const normalized = normalizedNeeds ? await readJson<string>(key, row.normalizedValueEnc, normalizedAad) : undefined;
        const label = labelNeeds
          ? row.labelEnc
            ? await readJson<string>(key, row.labelEnc, labelAad)
            : row.label ?? ''
          : undefined;
        return {
          expected: {
            ...(valueNeeds ? { valueEnc: row.valueEnc } : {}),
            ...(normalizedNeeds ? { normalizedValueEnc: row.normalizedValueEnc } : {}),
            ...(labelNeeds ? { labelEnc: row.labelEnc, label: row.label } : {}),
          },
          next: {
            ...row,
            ...(value !== undefined ? { valueEnc: await sealJson(key, value, valueAad) } : {}),
            ...(normalized !== undefined ? { normalizedValueEnc: await sealJson(key, normalized, normalizedAad) } : {}),
            ...(label !== undefined ? { label: '', labelEnc: await sealJson(key, label, labelAad) } : {}),
          },
        };
      },
    );
    total += await putBatch(db, 'extractedValues', prepared, fault);
  }
  return total;
}

async function migrateConflicts(db: IDBPDatabase<FormFlowDB>, key: CryptoKey, vault: Identity, fault?: EncryptionMigrationOptions['fault']): Promise<number> {
  const rows = await db.getAll('conflicts');
  let total = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const prepared = await prepareRows(
      rows.slice(offset, offset + BATCH_SIZE),
      (row) => row.id,
      async (row) => {
        const existingAad = context(vault, 'conflict', row.id, 'existingValue');
        const newAad = context(vault, 'conflict', row.id, 'newValue');
        const labelAad = context(vault, 'conflict', row.id, 'label');
        const existingNeeds = !isV2Envelope(row.existingValueEnc);
        const newNeeds = !isV2Envelope(row.newValueEnc);
        const labelNeeds = !row.labelEnc || !isV2Envelope(row.labelEnc);
        if (!existingNeeds && !newNeeds && !labelNeeds) return null;
        const existing = existingNeeds ? await readJson<string>(key, row.existingValueEnc, existingAad) : undefined;
        const nextValue = newNeeds ? await readJson<string>(key, row.newValueEnc, newAad) : undefined;
        const label = labelNeeds
          ? row.labelEnc
            ? await readJson<string>(key, row.labelEnc, labelAad)
            : row.label ?? ''
          : undefined;
        return {
          expected: {
            ...(existingNeeds ? { existingValueEnc: row.existingValueEnc } : {}),
            ...(newNeeds ? { newValueEnc: row.newValueEnc } : {}),
            ...(labelNeeds ? { labelEnc: row.labelEnc, label: row.label } : {}),
          },
          next: {
            ...row,
            ...(existing !== undefined ? { existingValueEnc: await sealJson(key, existing, existingAad) } : {}),
            ...(nextValue !== undefined ? { newValueEnc: await sealJson(key, nextValue, newAad) } : {}),
            ...(label !== undefined ? { label: '', labelEnc: await sealJson(key, label, labelAad) } : {}),
          },
        };
      },
    );
    total += await putBatch(db, 'conflicts', prepared, fault);
  }
  return total;
}

async function migrateProfileRecords(db: IDBPDatabase<FormFlowDB>, key: CryptoKey, vault: Identity, fault?: EncryptionMigrationOptions['fault']): Promise<number> {
  const rows = await db.getAll('profileRecords');
  let total = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const prepared = await prepareRows(
      rows.slice(offset, offset + BATCH_SIZE),
      (row) => row.id,
      async (row) => {
        if (isV2Envelope(row.dataEnc)) return null;
        const aad = context(vault, `profileRecord:${row.type}`, row.id, 'data');
        const data = await readJson<unknown>(key, row.dataEnc, aad);
        return {
          expected: { dataEnc: row.dataEnc },
          next: { ...row, dataEnc: await sealJson(key, data, aad) },
        };
      },
    );
    total += await putBatch(db, 'profileRecords', prepared, fault);
  }
  return total;
}

async function migrateCollections(db: IDBPDatabase<FormFlowDB>, key: CryptoKey, vault: Identity, fault?: EncryptionMigrationOptions['fault']): Promise<number> {
  const rows = await db.getAll('collections');
  let total = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const prepared = await prepareRows(
      rows.slice(offset, offset + BATCH_SIZE),
      (row) => row.id,
      async (row) => {
        if (row.vaultId !== vault.vaultId) {
          throw new FormFlowError('VALIDATION_FAILED', `Collection ${row.id} belongs to a different vault.`);
        }
        const fields = [
          { field: 'name', current: row.nameEnc },
          { field: 'description', current: row.descriptionEnc },
          { field: 'notes', current: row.notesEnc },
        ];
        const needing = fields.filter((entry) => !isV2Envelope(entry.current));
        if (!needing.length) return null;
        const next: CollectionRow = { ...row };
        const expected: Record<string, unknown> = {};
        for (const entry of needing) {
          expected[entry.field === 'name' ? 'nameEnc' : entry.field === 'description' ? 'descriptionEnc' : 'notesEnc'] = entry.current;
          const aad = context(vault, 'collection', row.id, entry.field);
          const plain = await readJson<string>(key, entry.current, aad);
          if (entry.field === 'name') next.nameEnc = await sealJson(key, plain, aad);
          if (entry.field === 'description') next.descriptionEnc = await sealJson(key, plain, aad);
          if (entry.field === 'notes') next.notesEnc = await sealJson(key, plain, aad);
        }
        return { expected, next };
      },
    );
    total += await putBatch(db, 'collections', prepared, fault);
  }
  return total;
}

async function migrateActivity(db: IDBPDatabase<FormFlowDB>, key: CryptoKey, vault: Identity, fault?: EncryptionMigrationOptions['fault']): Promise<number> {
  const rows = await db.getAll('activity');
  let total = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const prepared = await prepareRows(
      rows.slice(offset, offset + BATCH_SIZE),
      (row) => row.id,
      async (row) => {
        const titleNeeds = !isV2Envelope(row.titleEnc);
        const detailNeeds = !isV2Envelope(row.detailEnc);
        if (!titleNeeds && !detailNeeds) return null;
        const titleAad = context(vault, 'activity', row.id, 'title');
        const detailAad = context(vault, 'activity', row.id, 'detail');
        const title = titleNeeds ? await readJson<string>(key, row.titleEnc, titleAad) : undefined;
        const detail = detailNeeds ? await readJson<string>(key, row.detailEnc, detailAad) : undefined;
        return {
          expected: {
            ...(titleNeeds ? { titleEnc: row.titleEnc } : {}),
            ...(detailNeeds ? { detailEnc: row.detailEnc } : {}),
          },
          next: {
            ...row,
            ...(title !== undefined ? { titleEnc: await sealJson(key, title, titleAad) } : {}),
            ...(detail !== undefined ? { detailEnc: await sealJson(key, detail, detailAad) } : {}),
          },
        };
      },
    );
    total += await putBatch(db, 'activity', prepared, fault);
  }
  return total;
}

async function migrateHistory(db: IDBPDatabase<FormFlowDB>, key: CryptoKey, vault: Identity, fault?: EncryptionMigrationOptions['fault']): Promise<number> {
  const rows = await db.getAll('formHistory');
  let total = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const prepared = await prepareRows(
      rows.slice(offset, offset + BATCH_SIZE),
      (row) => row.id,
      async (row) => {
        const websiteNeeds = !isV2Envelope(row.websiteEnc);
        const urlNeeds = !isV2Envelope(row.urlEnc);
        const documentsNeeds = !isV2Envelope(row.documentsUsedEnc);
        if (!websiteNeeds && !urlNeeds && !documentsNeeds) return null;
        const websiteAad = context(vault, 'formHistory', row.id, 'website');
        const urlAad = context(vault, 'formHistory', row.id, 'url');
        const documentsAad = context(vault, 'formHistory', row.id, 'documentsUsed');
        const website = websiteNeeds ? await readJson<string>(key, row.websiteEnc, websiteAad) : undefined;
        const url = urlNeeds ? await readJson<string>(key, row.urlEnc, urlAad) : undefined;
        const documents = documentsNeeds ? await readJson<string[]>(key, row.documentsUsedEnc, documentsAad) : undefined;
        return {
          expected: {
            ...(websiteNeeds ? { websiteEnc: row.websiteEnc } : {}),
            ...(urlNeeds ? { urlEnc: row.urlEnc } : {}),
            ...(documentsNeeds ? { documentsUsedEnc: row.documentsUsedEnc } : {}),
          },
          next: {
            ...row,
            ...(website !== undefined ? { websiteEnc: await sealJson(key, website, websiteAad) } : {}),
            ...(url !== undefined ? { urlEnc: await sealJson(key, url, urlAad) } : {}),
            ...(documents !== undefined ? { documentsUsedEnc: await sealJson(key, documents, documentsAad) } : {}),
          },
        };
      },
    );
    total += await putBatch(db, 'formHistory', prepared, fault);
  }
  return total;
}

async function migrateText(db: IDBPDatabase<FormFlowDB>, key: CryptoKey, vault: Identity, fault?: EncryptionMigrationOptions['fault']): Promise<number> {
  const rows = await db.getAll('documentText');
  let total = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const prepared = await prepareRows(
      rows.slice(offset, offset + BATCH_SIZE),
      (row) => row.documentId,
      async (row) => {
        const textNeeds = !isV2Envelope(row.textEnc);
        const pagesNeed = !isV2Envelope(row.pageTextsEnc);
        if (!textNeeds && !pagesNeed) return null;
        const textAad = context(vault, 'documentText', row.documentId, 'text');
        const pagesAad = context(vault, 'documentText', row.documentId, 'pageTexts');
        const text = textNeeds ? await readJson<string>(key, row.textEnc, textAad) : undefined;
        const pages = pagesNeed ? await readJson<string[]>(key, row.pageTextsEnc, pagesAad) : undefined;
        return {
          expected: {
            ...(textNeeds ? { textEnc: row.textEnc } : {}),
            ...(pagesNeed ? { pageTextsEnc: row.pageTextsEnc } : {}),
          },
          next: {
            ...row,
            ...(text !== undefined ? { textEnc: await sealJson(key, text, textAad) } : {}),
            ...(pages !== undefined ? { pageTextsEnc: await sealJson(key, pages, pagesAad) } : {}),
          },
        };
      },
    );
    total += await putBatch(db, 'documentText', prepared, fault);
  }
  return total;
}

async function verifyVault(db: IDBPDatabase<FormFlowDB>, key: CryptoKey, vault: Identity): Promise<void> {
  const [profile, documents, files, values, conflicts, profileRecords, collections, activity, history, text] = await Promise.all([
    db.get('vaultProfile', 'me'),
    db.getAll('documents'),
    db.getAll('documentFiles'),
    db.getAll('extractedValues'),
    db.getAll('conflicts'),
    db.getAll('profileRecords'),
    db.getAll('collections'),
    db.getAll('activity'),
    db.getAll('formHistory'),
    db.getAll('documentText'),
  ]);

  const encryptedStrings: Array<{ payload: string; aad: RecordAad; label: string }> = [];
  if (profile) encryptedStrings.push({ payload: profile.profileEnc, aad: context(vault, 'profile', 'me', 'profile'), label: 'profile' });
  for (const row of documents) {
    encryptedStrings.push(
      { payload: row.nameEnc, aad: context(vault, 'document', row.id, 'name'), label: `document ${row.id} name` },
      { payload: row.originalFilenameEnc, aad: context(vault, 'document', row.id, 'originalFilename'), label: `document ${row.id} filename` },
    );
  }
  for (const row of values) {
    encryptedStrings.push(
      { payload: row.valueEnc, aad: context(vault, 'value', row.id, 'value'), label: `value ${row.id}` },
      { payload: row.normalizedValueEnc, aad: context(vault, 'value', row.id, 'normalizedValue'), label: `value ${row.id} normalized` },
    );
    if (!row.labelEnc) throw new FormFlowError('VALIDATION_FAILED', `Value ${row.id} still has a plaintext label.`);
    encryptedStrings.push({ payload: row.labelEnc, aad: context(vault, 'value', row.id, 'label'), label: `value ${row.id} label` });
  }
  for (const row of conflicts) {
    encryptedStrings.push(
      { payload: row.existingValueEnc, aad: context(vault, 'conflict', row.id, 'existingValue'), label: `conflict ${row.id} existing` },
      { payload: row.newValueEnc, aad: context(vault, 'conflict', row.id, 'newValue'), label: `conflict ${row.id} new` },
    );
    if (!row.labelEnc) throw new FormFlowError('VALIDATION_FAILED', `Conflict ${row.id} still has a plaintext label.`);
    encryptedStrings.push({ payload: row.labelEnc, aad: context(vault, 'conflict', row.id, 'label'), label: `conflict ${row.id} label` });
  }
  for (const row of profileRecords) {
    encryptedStrings.push({ payload: row.dataEnc, aad: context(vault, `profileRecord:${row.type}`, row.id, 'data'), label: `profile record ${row.id}` });
  }
  for (const row of collections) {
    encryptedStrings.push(
      { payload: row.nameEnc, aad: context(vault, 'collection', row.id, 'name'), label: `collection ${row.id} name` },
      { payload: row.descriptionEnc, aad: context(vault, 'collection', row.id, 'description'), label: `collection ${row.id} description` },
      { payload: row.notesEnc, aad: context(vault, 'collection', row.id, 'notes'), label: `collection ${row.id} notes` },
    );
  }
  for (const row of activity) {
    encryptedStrings.push(
      { payload: row.titleEnc, aad: context(vault, 'activity', row.id, 'title'), label: `activity ${row.id} title` },
      { payload: row.detailEnc, aad: context(vault, 'activity', row.id, 'detail'), label: `activity ${row.id} detail` },
    );
  }
  for (const row of history) {
    encryptedStrings.push(
      { payload: row.websiteEnc, aad: context(vault, 'formHistory', row.id, 'website'), label: `history ${row.id} website` },
      { payload: row.urlEnc, aad: context(vault, 'formHistory', row.id, 'url'), label: `history ${row.id} url` },
      { payload: row.documentsUsedEnc, aad: context(vault, 'formHistory', row.id, 'documentsUsed'), label: `history ${row.id} documents` },
    );
  }
  for (const row of text) {
    encryptedStrings.push(
      { payload: row.textEnc, aad: context(vault, 'documentText', row.documentId, 'text'), label: `text ${row.documentId}` },
      { payload: row.pageTextsEnc, aad: context(vault, 'documentText', row.documentId, 'pageTexts'), label: `text ${row.documentId} pages` },
    );
  }

  for (const entry of encryptedStrings) {
    if (!isV2Envelope(entry.payload)) {
      throw new FormFlowError('VALIDATION_FAILED', `${entry.label} is not using encryption format 2.`);
    }
    await decryptJsonWithKey(key, entry.payload, entry.aad);
  }

  for (const file of files) {
    if (file.aadVersion !== 2) {
      throw new FormFlowError('VALIDATION_FAILED', `Document file ${file.documentId} is not using encryption format 2.`);
    }
    await decryptBytesWithKey(
      key,
      file.iv,
      await file.ciphertext.arrayBuffer(),
      context(vault, 'documentFile', file.documentId, 'file'),
    );
  }
}

async function runExclusive(options: EncryptionMigrationOptions = {}): Promise<EncryptionMigrationStatus> {
  const fault = options.fault;
  fault?.('before_migration');
  const db = await getDb();
  const meta = await db.get('vaultMeta', 'meta');
  if (!meta) throw new FormFlowError('VAULT_NOT_FOUND', 'No encrypted vault exists.');
  const existingJournal = await readJournal();
  if ((meta.encryptionFormat ?? 1) >= ENCRYPTION_FORMAT_VERSION && existingJournal?.status === 'complete') {
    return { encryptionFormat: meta.encryptionFormat ?? 1, needsMigration: false, journal: existingJournal };
  }
  if (!(await vaultSession.isUnlocked())) {
    throw new FormFlowError('VAULT_LOCKED', 'Unlock the vault before upgrading its encryption format.');
  }
  const generation = vaultSession.getGeneration();
  const vault = await identity();
  const startedAt = existingJournal?.startedAt ?? nowIso();
  const journal: EncryptionMigrationJournal = {
    version: 2,
    status: 'in_progress',
    startedAt,
    updatedAt: nowIso(),
    migrated: existingJournal?.migrated ?? {},
  };
  await writeJournal(journal);

  try {
    const key = await vaultSession.getDataKey();
    const steps: Array<[string, (db: IDBPDatabase<FormFlowDB>, key: CryptoKey, vault: Identity, fault?: EncryptionMigrationOptions['fault']) => Promise<number>, number]> = [
      ['profile', migrateProfile, BATCH_SIZE],
      ['documents', migrateDocuments, BATCH_SIZE],
      ['files', migrateFiles, BLOB_BATCH_SIZE],
      ['values', migrateValues, BATCH_SIZE],
      ['conflicts', migrateConflicts, BATCH_SIZE],
      ['profileRecords', migrateProfileRecords, BATCH_SIZE],
      ['collections', migrateCollections, BATCH_SIZE],
      ['activity', migrateActivity, BATCH_SIZE],
      ['history', migrateHistory, BATCH_SIZE],
      ['text', migrateText, BATCH_SIZE],
    ];
    for (const [name, step] of steps) {
      if (!vaultSession.isCurrent(generation) || !(await vaultSession.isUnlocked())) {
        throw new FormFlowError('SESSION_EXPIRED', 'The vault locked during the encryption upgrade. Unlock to resume.');
      }
      fault?.('before_batch', { store: name });
      const written = await step(db, key, vault, fault);
      fault?.('after_commit', { store: name, written });
      journal.migrated[name] = (journal.migrated[name] ?? 0) + written;
      journal.updatedAt = nowIso();
      fault?.('before_journal', { store: name });
      await writeJournal(journal);
      fault?.('after_journal', { store: name });
    }

    fault?.('before_verification');
    await verifyVault(db, key, vault);
    fault?.('before_marker');
    if (!vaultSession.isCurrent(generation)) {
      throw new FormFlowError('SESSION_EXPIRED', 'The vault locked during the encryption upgrade. Unlock to resume.');
    }

    const updatedMeta: VaultMeta = { ...meta, encryptionFormat: ENCRYPTION_FORMAT_VERSION };
    journal.status = 'complete';
    journal.completedAt = nowIso();
    journal.updatedAt = journal.completedAt;
    journal.lastError = undefined;
    const tx = db.transaction(['vaultMeta', 'settings'], 'readwrite');
    await tx.objectStore('vaultMeta').put(updatedMeta);
    await tx.objectStore('settings').put({ key: JOURNAL_KEY, value: journal, updatedAt: journal.updatedAt });
    await tx.objectStore('settings').put({ key: 'storageFormat', value: 'encrypted-v2', updatedAt: journal.updatedAt });
    await tx.done;
    fault?.('after_marker');
    return { encryptionFormat: ENCRYPTION_FORMAT_VERSION, needsMigration: false, journal };
  } catch (error) {
    journal.status = 'failed';
    journal.updatedAt = nowIso();
    journal.lastError = error instanceof Error ? error.message : 'Encryption upgrade failed.';
    await writeJournal(journal).catch(() => undefined);
    throw error;
  }
}

export const encryptionV2Migration = {
  async status(): Promise<EncryptionMigrationStatus> {
    const db = await getDb();
    const meta = await db.get('vaultMeta', 'meta');
    const journal = await readJournal();
    const format = meta?.encryptionFormat ?? (meta ? 1 : 0);
    return {
      encryptionFormat: format,
      needsMigration: Boolean(meta) && format < ENCRYPTION_FORMAT_VERSION,
      journal,
    };
  },

  async runIfNeeded(options: EncryptionMigrationOptions = {}): Promise<EncryptionMigrationStatus> {
    const status = await this.status();
    if (!status.needsMigration) return status;
    if (!(await vaultSession.isUnlocked())) {
      throw new FormFlowError('VAULT_LOCKED', 'Unlock the vault before upgrading its encryption format.');
    }
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    if (locks?.request) {
      return locks.request('formflow-vault-encryption-v2', () => runExclusive(options));
    }
    return runExclusive(options);
  },
};
