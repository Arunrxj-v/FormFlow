import { FormFlowError } from '@shared/errors';
import { PBKDF2_ITERATIONS, SUPPORTED_EXTENSIONS } from '@shared/constants';
import type {
  ActivityRow,
  CollectionDocumentRow,
  CollectionRow,
  ConflictRecord,
  DocumentRecord,
  ExtractedValueRecord,
  FormHistoryRow,
  ProfileRecordRow,
  StoredDocumentFile,
  StoredDocumentText,
  StoredVaultProfileRow,
  VaultProfile,
  VaultRecord,
} from '@shared/types';
import { getDb } from '../database/database';
import { vaultRepository as vaultRecordRepository } from '../database/vault-repository';
import {
  base64ToArrayBuffer,
  bufferToBase64,
  decryptBytesWithKey,
  decryptJsonWithKey,
  deriveKeyFromPassword,
  encryptBytesWithKey,
  encryptJsonWithKey,
  randomBytes,
  sha256Hex,
} from '../encryption/crypto-service';
import { vaultSession } from '../vault/vault-session';
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
  record: Omit<ExtractedValueRecord, 'valueEnc' | 'normalizedValueEnc'>;
  value: string;
  normalizedValue: string;
}

export interface PortableConflict {
  record: Omit<ConflictRecord, 'existingValueEnc' | 'newValueEnc'>;
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
  record: Omit<StoredDocumentText, 'textEnc' | 'pageTextsEnc'>;
  text: string;
  pageTexts: string[];
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

export interface EncryptedBackupEnvelope {
  format: 'formflow-encrypted-backup';
  version: 1;
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

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const bytes = new Uint8Array(base64ToArrayBuffer(base64));
  return new Blob([bytes], { type: mimeType });
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
      const profile = await decryptJsonWithKey<VaultProfile>(await vaultSession.getDataKey(), profileRow.profileEnc);
      const defaultProfile = profile.name === activeVault.name && !profile.email;
      if (!defaultProfile) return false;
    } catch {
      // Without a verifiable default profile, treat the vault as populated.
      return false;
    }
  }
  return true;
}

export const vaultExportService = {
  async hasPortableData(): Promise<boolean> {
    return !(await targetVaultIsEmpty());
  },

  async exportEncrypted(passphrase: string): Promise<Blob> {
    if (!(await vaultSession.isUnlocked())) throw new FormFlowError('VAULT_LOCKED', 'Unlock the vault before exporting.');
    if (!passphrase || passphrase.length < 8) throw new FormFlowError('WEAK_PASSWORD', 'Use a backup passphrase of at least 8 characters.');

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

    const profile = profileRow ? await decryptJsonWithKey<VaultProfile>(await vaultSession.getDataKey(), profileRow.profileEnc) : null;

    const portableDocuments: PortableDocument[] = [];
    for (const record of documents as DocumentRecord[]) {
      const name = await decryptJsonWithKey<string>(await vaultSession.getDataKey(), record.nameEnc);
      const originalFilename = await decryptJsonWithKey<string>(await vaultSession.getDataKey(), record.originalFilenameEnc);
      const { nameEnc: _nameEnc, originalFilenameEnc: _originalFilenameEnc, ...rest } = record;
      portableDocuments.push({ record: rest, name, originalFilename });
    }

    const portableFiles: PortableFile[] = [];
    for (const file of files as StoredDocumentFile[]) {
      const plaintext = await decryptBytesWithKey(await vaultSession.getDataKey(), file.iv, await file.ciphertext.arrayBuffer());
      portableFiles.push({
        documentId: file.documentId,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        dataBase64: await blobToBase64(new Blob([plaintext], { type: file.mimeType })),
      });
    }

    const portableValues: PortableValue[] = [];
    for (const record of values as ExtractedValueRecord[]) {
      const { valueEnc, normalizedValueEnc, ...rest } = record;
      portableValues.push({
        record: rest,
        value: await decryptJsonWithKey<string>(await vaultSession.getDataKey(), valueEnc),
        normalizedValue: await decryptJsonWithKey<string>(await vaultSession.getDataKey(), normalizedValueEnc),
      });
    }

    const portableConflicts: PortableConflict[] = [];
    for (const record of conflicts as ConflictRecord[]) {
      const { existingValueEnc, newValueEnc, ...rest } = record;
      portableConflicts.push({
        record: rest,
        existingValue: await decryptJsonWithKey<string>(await vaultSession.getDataKey(), existingValueEnc),
        newValue: await decryptJsonWithKey<string>(await vaultSession.getDataKey(), newValueEnc),
      });
    }

    const portableProfileRecords: PortableProfileRecord[] = [];
    for (const record of profileRecords as ProfileRecordRow[]) {
      const { dataEnc, ...rest } = record;
      portableProfileRecords.push({ record: rest, data: await decryptJsonWithKey<unknown>(await vaultSession.getDataKey(), dataEnc) });
    }

    const portableCollections: PortableCollection[] = [];
    for (const record of collections as CollectionRow[]) {
      const { nameEnc, descriptionEnc, notesEnc, ...rest } = record;
      portableCollections.push({
        record: rest,
        name: await decryptJsonWithKey<string>(await vaultSession.getDataKey(), nameEnc),
        description: await decryptJsonWithKey<string>(await vaultSession.getDataKey(), descriptionEnc),
        notes: await decryptJsonWithKey<string>(await vaultSession.getDataKey(), notesEnc),
      });
    }

    const portableActivity: PortableActivity[] = [];
    for (const record of activity as ActivityRow[]) {
      const { titleEnc, detailEnc, ...rest } = record;
      portableActivity.push({
        record: rest,
        title: await decryptJsonWithKey<string>(await vaultSession.getDataKey(), titleEnc),
        detail: await decryptJsonWithKey<string>(await vaultSession.getDataKey(), detailEnc),
      });
    }

    const portableHistory: PortableHistory[] = [];
    for (const record of history as FormHistoryRow[]) {
      const { websiteEnc, urlEnc, documentsUsedEnc, ...rest } = record;
      portableHistory.push({
        record: rest,
        website: await decryptJsonWithKey<string>(await vaultSession.getDataKey(), websiteEnc),
        url: await decryptJsonWithKey<string>(await vaultSession.getDataKey(), urlEnc),
        documentsUsed: await decryptJsonWithKey<string[]>(await vaultSession.getDataKey(), documentsUsedEnc),
      });
    }

    const portableText: PortableText[] = [];
    for (const record of text as StoredDocumentText[]) {
      const { textEnc, pageTextsEnc, ...rest } = record;
      portableText.push({
        record: rest,
        text: await decryptJsonWithKey<string>(await vaultSession.getDataKey(), textEnc),
        pageTexts: await decryptJsonWithKey<string[]>(await vaultSession.getDataKey(), pageTextsEnc),
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
    const encrypted = await encryptBytesWithKey(backupKey, new TextEncoder().encode(JSON.stringify(payload)));
    const envelope: EncryptedBackupEnvelope = {
      format: 'formflow-encrypted-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: bufferToBase64(salt) },
      cipher: { name: 'AES-GCM', iv: encrypted.iv },
      manifest: {
        schemaVersion: 3,
        documentCount: portableDocuments.length,
        valueCount: portableValues.length,
        collectionCount: portableCollections.length,
        conflictCount: portableConflicts.length,
        totalBytes: portableFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
      },
      payload: bufferToBase64(encrypted.data),
    };
    return new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  },

  async importEncrypted(file: Blob, passphrase: string): Promise<{ imported: boolean; documents: number; values: number; collections: number }> {
    if (!(await vaultSession.isUnlocked())) throw new FormFlowError('VAULT_LOCKED', 'Unlock the vault before importing.');
    if (!(await vaultRecordRepository.getActive())) throw new FormFlowError('VAULT_NOT_FOUND', 'Create a local vault before importing.');
    if (!(await targetVaultIsEmpty())) {
      throw new FormFlowError('VALIDATION_FAILED', 'The target vault already contains data. Import into an empty vault to avoid overwriting existing records.');
    }
    if (file.size > 200 * 1024 * 1024) throw new FormFlowError('VALIDATION_FAILED', 'Backup file is larger than the 200 MB local import limit.');

    const envelope = JSON.parse(await file.text()) as EncryptedBackupEnvelope;
    if (envelope.format !== 'formflow-encrypted-backup' || envelope.version !== 1) {
      throw new FormFlowError('BACKUP_VERSION_UNSUPPORTED', 'This is not a supported FormFlow encrypted backup.');
    }
    if (envelope.kdf?.name !== 'PBKDF2-SHA256' || envelope.cipher?.name !== 'AES-GCM') {
      throw new FormFlowError('BACKUP_VERSION_UNSUPPORTED', 'Unsupported backup encryption metadata.');
    }

    let payload: PortableVaultPayload;
    try {
      const backupKey = await deriveKeyFromPassword(passphrase, new Uint8Array(base64ToArrayBuffer(envelope.kdf.salt)), envelope.kdf.iterations);
      const plaintext = await decryptBytesWithKey(backupKey, envelope.cipher.iv, base64ToArrayBuffer(envelope.payload));
      payload = JSON.parse(new TextDecoder().decode(plaintext)) as PortableVaultPayload;
    } catch (error) {
      throw new FormFlowError('BACKUP_PASSWORD_INVALID', 'The backup passphrase is incorrect or the archive is corrupted.', { cause: error });
    }

    if (payload.format !== 'formflow-portable-vault' || payload.schemaVersion !== 3) {
      throw new FormFlowError('BACKUP_VERSION_UNSUPPORTED', 'Unsupported portable vault schema.');
    }
    if (
      envelope.manifest?.documentCount !== payload.documents.length ||
      envelope.manifest?.valueCount !== payload.values.length ||
      envelope.manifest?.collectionCount !== payload.collections.length ||
      envelope.manifest?.conflictCount !== payload.conflicts.length
    ) {
      throw new FormFlowError('VALIDATION_FAILED', 'Backup manifest does not match its encrypted payload.');
    }

    const collectionIds = new Set(payload.collections.map((collection) => collection.record.id));
    for (const membership of payload.collectionDocuments) {
      if (!collectionIds.has(membership.collectionId)) {
        throw new FormFlowError('VALIDATION_FAILED', 'Backup contains a collection membership referencing a missing collection.');
      }
    }

    const documentIds = new Set<string>();
    for (const document of payload.documents) {
      if (!document.record.id || documentIds.has(document.record.id)) {
        throw new FormFlowError('VALIDATION_FAILED', 'Backup contains duplicate document identifiers.');
      }
      documentIds.add(document.record.id);
      const extension = (document.name || document.originalFilename).split('.').pop()?.toLowerCase() ?? '';
      if (!SUPPORTED_EXTENSIONS.includes(extension as (typeof SUPPORTED_EXTENSIONS)[number])) {
        throw new FormFlowError('VALIDATION_FAILED', `Backup document "${document.name}" uses an unsupported format.`);
      }
      if (document.record.extension !== extension || inferFileKind(document.name) !== document.record.fileType) {
        throw new FormFlowError('VALIDATION_FAILED', `Backup document "${document.name}" has inconsistent type metadata.`);
      }
    }

    const filesById = new Map(payload.files.map((entry) => [entry.documentId, entry]));
    if (filesById.size !== payload.files.length) throw new FormFlowError('VALIDATION_FAILED', 'Backup contains duplicate file identifiers.');
    for (const document of payload.documents) {
      const file = filesById.get(document.record.id);
      if (!file) throw new FormFlowError('VALIDATION_FAILED', `Backup is missing the file for "${document.name}".`);
      if (file.sizeBytes > 20 * 1024 * 1024) throw new FormFlowError('FILE_TOO_LARGE', `Backup document "${document.name}" exceeds the 20 MB limit.`);
      const blob = base64ToBlob(file.dataBase64, file.mimeType);
      if (blob.size !== file.sizeBytes) throw new FormFlowError('VALIDATION_FAILED', `Backup file size mismatch for "${document.name}".`);
      const checksum = await sha256Hex(await blob.arrayBuffer());
      if (checksum !== document.record.checksum) {
        throw new FormFlowError('VALIDATION_FAILED', `Checksum verification failed for "${document.name}".`);
      }
    }

    for (const membership of payload.collectionDocuments) {
      if (!documentIds.has(membership.documentId)) {
        throw new FormFlowError('VALIDATION_FAILED', 'Backup contains a collection membership referencing a missing document.');
      }
    }

    const db = await getDb();
    const key = await vaultSession.getDataKey();
    const now = new Date().toISOString();

    const encryptedProfile = payload.profile
      ? { id: 'me' as const, profileEnc: await encryptJsonWithKey(key, payload.profile), updatedAt: now }
      : null;

    const encryptedDocuments: DocumentRecord[] = [];
    for (const document of payload.documents) {
      encryptedDocuments.push({
        ...document.record,
        nameEnc: await encryptJsonWithKey(key, document.name),
        originalFilenameEnc: await encryptJsonWithKey(key, document.originalFilename),
      });
    }

    const encryptedFiles: StoredDocumentFile[] = [];
    for (const file of payload.files) {
      const blob = base64ToBlob(file.dataBase64, file.mimeType);
      const encrypted = await encryptBytesWithKey(key, await blob.arrayBuffer());
      encryptedFiles.push({
        documentId: file.documentId,
        storageKey: `file_${file.documentId}`,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        ciphertext: new Blob([encrypted.data], { type: 'application/octet-stream' }),
        iv: encrypted.iv,
        version: 2,
        createdAt: now,
        updatedAt: now,
      });
    }

    const encryptedValues: ExtractedValueRecord[] = [];
    for (const value of payload.values) {
      encryptedValues.push({
        ...value.record,
        valueEnc: await encryptJsonWithKey(key, value.value),
        normalizedValueEnc: await encryptJsonWithKey(key, value.normalizedValue),
      });
    }

    const encryptedConflicts: ConflictRecord[] = [];
    for (const conflict of payload.conflicts) {
      encryptedConflicts.push({
        ...conflict.record,
        existingValueEnc: await encryptJsonWithKey(key, conflict.existingValue),
        newValueEnc: await encryptJsonWithKey(key, conflict.newValue),
      });
    }

    const encryptedProfileRecords: ProfileRecordRow[] = [];
    for (const profileRecord of payload.profileRecords) {
      encryptedProfileRecords.push({ ...profileRecord.record, dataEnc: await encryptJsonWithKey(key, profileRecord.data) });
    }

    const encryptedCollections: CollectionRow[] = [];
    for (const collection of payload.collections) {
      encryptedCollections.push({
        ...collection.record,
        nameEnc: await encryptJsonWithKey(key, collection.name),
        descriptionEnc: await encryptJsonWithKey(key, collection.description),
        notesEnc: await encryptJsonWithKey(key, collection.notes),
      });
    }

    const encryptedActivity: ActivityRow[] = [];
    for (const item of payload.activity) {
      encryptedActivity.push({
        ...item.record,
        titleEnc: await encryptJsonWithKey(key, item.title),
        detailEnc: await encryptJsonWithKey(key, item.detail),
      });
    }

    const encryptedHistory: FormHistoryRow[] = [];
    for (const item of payload.history) {
      encryptedHistory.push({
        ...item.record,
        websiteEnc: await encryptJsonWithKey(key, item.website),
        urlEnc: await encryptJsonWithKey(key, item.url),
        documentsUsedEnc: await encryptJsonWithKey(key, item.documentsUsed),
      });
    }

    const encryptedText: StoredDocumentText[] = [];
    for (const item of payload.text) {
      encryptedText.push({
        ...item.record,
        textEnc: await encryptJsonWithKey(key, item.text),
        pageTextsEnc: await encryptJsonWithKey(key, item.pageTexts),
      });
    }

    const tx = db.transaction(
      ['vaultProfile', 'documents', 'documentFiles', 'extractedValues', 'conflicts', 'profileRecords', 'collections', 'collectionDocuments', 'activity', 'formHistory', 'documentText'],
      'readwrite',
    );

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
    await tx.done;

    const verify = await db.getAll('documents');
    if (verify.length !== payload.documents.length) throw new FormFlowError('VALIDATION_FAILED', 'Imported document count does not match the manifest.');
    return { imported: true, documents: payload.documents.length, values: payload.values.length, collections: payload.collections.length };
  },
};
