import { FormFlowError } from '@shared/errors';
import { PBKDF2_ITERATIONS } from '@shared/constants';
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
  StoredVaultProfileRow,
  VaultMeta,
} from '@shared/types';
import { getDb } from '../database/database';
import {
  deriveKeyFromPassword,
  encryptBytesWithKey,
  encryptJsonWithKey,
  exportKeyRaw,
  generateDataKey,
  importDataKey,
  randomBytes,
  base64ToArrayBuffer,
  bufferToBase64,
} from '../encryption/crypto-service';
import { vaultSession } from './vault-session';

export interface PlaintextMigrationResult {
  migrated: boolean;
  counts: {
    profile: number;
    documents: number;
    files: number;
    values: number;
    conflicts: number;
    profileRecords: number;
    collections: number;
    activity: number;
    history: number;
    text: number;
  };
}

interface PlaintextSnapshot {
  profile: StoredVaultProfileRow | null;
  documents: Array<DocumentRecord & { originalFilename?: string }>;
  files: Array<Omit<StoredDocumentFile, 'ciphertext' | 'iv'> & { data?: Blob; ciphertext?: Blob; iv?: string }>;
  values: ExtractedValueRecord[];
  conflicts: ConflictRecord[];
  profileRecords: ProfileRecordRow[];
  collections: CollectionRow[];
  activity: ActivityRow[];
  history: FormHistoryRow[];
  text: StoredDocumentText[];
  settings: Array<{ key: string; value: unknown; updatedAt: string }>;
}

function parsePlain(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

export const encryptionMigrationService = {
  async hasPlaintextVault(): Promise<boolean> {
    const db = await getDb();
    const [meta, vaults] = await Promise.all([db.get('vaultMeta', 'meta'), db.getAll('vaults')]);
    return !meta && vaults.length > 0;
  },

  async migrate(passphrase: string): Promise<PlaintextMigrationResult> {
    const db = await getDb();
    if (await db.get('vaultMeta', 'meta')) {
      throw new FormFlowError('VAULT_EXISTS', 'This vault already has encryption metadata.');
    }
    const vaults = await db.getAll('vaults');
    if (!vaults.length) throw new FormFlowError('VAULT_NOT_FOUND', 'No local vault exists to protect.');

    const salt = randomBytes(16);
    const kek = await deriveKeyFromPassword(passphrase, salt, PBKDF2_ITERATIONS);
    const dataKey = await generateDataKey();
    const rawKey = await exportKeyRaw(dataKey);
    const wrappedBytes = await encryptBytesWithKey(kek, rawKey);
    const now = new Date().toISOString();
    const meta: VaultMeta = {
      id: 'meta',
      version: 1,
      kdf: 'PBKDF2-SHA256',
      iterations: PBKDF2_ITERATIONS,
      salt: bufferToBase64(salt),
      wrappedDataKey: JSON.stringify({
        v: 1,
        alg: 'AES-GCM',
        iv: wrappedBytes.iv,
        data: bufferToBase64(wrappedBytes.data),
      }),
      createdAt: now,
      passwordUpdatedAt: now,
    };

    const snapshot: PlaintextSnapshot = {
      profile: (await db.get('vaultProfile', 'me')) ?? null,
      documents: (await db.getAll('documents')) as PlaintextSnapshot['documents'],
      files: (await db.getAll('documentFiles')) as PlaintextSnapshot['files'],
      values: await db.getAll('extractedValues'),
      conflicts: await db.getAll('conflicts'),
      profileRecords: await db.getAll('profileRecords'),
      collections: await db.getAll('collections'),
      activity: await db.getAll('activity'),
      history: await db.getAll('formHistory'),
      text: await db.getAll('documentText'),
      settings: await db.getAll('settings'),
    };

    try {
      const encryptedProfile = snapshot.profile
        ? { ...snapshot.profile, profileEnc: await encryptJsonWithKey(dataKey, parsePlain(snapshot.profile.profileEnc)) }
        : null;

      const encryptedDocuments: DocumentRecord[] = [];
      for (const row of snapshot.documents) {
        const name = asString(parsePlain(row.nameEnc));
        const originalFilename = asString(row.originalFilename ?? parsePlain(row.originalFilenameEnc ?? '""') ?? name);
        const { originalFilename: _omit, ...rest } = row;
        encryptedDocuments.push({
          ...rest,
          nameEnc: await encryptJsonWithKey(dataKey, name),
          originalFilenameEnc: await encryptJsonWithKey(dataKey, originalFilename || name),
        });
      }

      const encryptedFiles: StoredDocumentFile[] = [];
      for (const row of snapshot.files) {
        if (row.ciphertext && row.iv) {
          encryptedFiles.push({ ...row, ciphertext: row.ciphertext, iv: row.iv, version: 2 });
          continue;
        }
        if (!row.data) throw new FormFlowError('VALIDATION_FAILED', `Document file ${row.documentId} is missing its plaintext blob.`);
        const encrypted = await encryptBytesWithKey(dataKey, await row.data.arrayBuffer());
        encryptedFiles.push({
          ...row,
          ciphertext: new Blob([encrypted.data], { type: 'application/octet-stream' }),
          iv: encrypted.iv,
          version: 2,
        });
      }

      const encryptedValues: ExtractedValueRecord[] = [];
      for (const row of snapshot.values) {
        encryptedValues.push({
          ...row,
          valueEnc: await encryptJsonWithKey(dataKey, parsePlain(row.valueEnc)),
          normalizedValueEnc: await encryptJsonWithKey(dataKey, parsePlain(row.normalizedValueEnc)),
        });
      }

      const encryptedConflicts: ConflictRecord[] = [];
      for (const row of snapshot.conflicts) {
        encryptedConflicts.push({
          ...row,
          existingValueEnc: await encryptJsonWithKey(dataKey, parsePlain(row.existingValueEnc)),
          newValueEnc: await encryptJsonWithKey(dataKey, parsePlain(row.newValueEnc)),
        });
      }

      const encryptedProfileRecords: ProfileRecordRow[] = [];
      for (const row of snapshot.profileRecords) {
        encryptedProfileRecords.push({ ...row, dataEnc: await encryptJsonWithKey(dataKey, parsePlain(row.dataEnc)) });
      }

      const encryptedCollections: CollectionRow[] = [];
      for (const row of snapshot.collections) {
        encryptedCollections.push({
          ...row,
          nameEnc: await encryptJsonWithKey(dataKey, parsePlain(row.nameEnc)),
          descriptionEnc: await encryptJsonWithKey(dataKey, parsePlain(row.descriptionEnc)),
          notesEnc: await encryptJsonWithKey(dataKey, parsePlain(row.notesEnc)),
        });
      }

      const encryptedActivity: ActivityRow[] = [];
      for (const row of snapshot.activity) {
        encryptedActivity.push({
          ...row,
          titleEnc: await encryptJsonWithKey(dataKey, parsePlain(row.titleEnc)),
          detailEnc: await encryptJsonWithKey(dataKey, parsePlain(row.detailEnc)),
        });
      }

      const encryptedHistory: FormHistoryRow[] = [];
      for (const row of snapshot.history) {
        encryptedHistory.push({
          ...row,
          websiteEnc: await encryptJsonWithKey(dataKey, parsePlain(row.websiteEnc)),
          urlEnc: await encryptJsonWithKey(dataKey, parsePlain(row.urlEnc)),
          documentsUsedEnc: await encryptJsonWithKey(dataKey, parsePlain(row.documentsUsedEnc)),
        });
      }

      const encryptedText: StoredDocumentText[] = [];
      for (const row of snapshot.text) {
        encryptedText.push({
          ...row,
          textEnc: await encryptJsonWithKey(dataKey, parsePlain(row.textEnc)),
          pageTextsEnc: await encryptJsonWithKey(dataKey, parsePlain(row.pageTextsEnc)),
        });
      }

      const tx = db.transaction(
        ['vaultMeta', 'vaultProfile', 'documents', 'documentFiles', 'extractedValues', 'conflicts', 'profileRecords', 'collections', 'activity', 'formHistory', 'documentText', 'settings'],
        'readwrite',
      );
      await tx.objectStore('vaultMeta').put(meta);
      if (encryptedProfile) await tx.objectStore('vaultProfile').put(encryptedProfile);
      for (const row of encryptedDocuments) await tx.objectStore('documents').put(row);
      for (const row of encryptedFiles) await tx.objectStore('documentFiles').put(row);
      for (const row of encryptedValues) await tx.objectStore('extractedValues').put(row);
      for (const row of encryptedConflicts) await tx.objectStore('conflicts').put(row);
      for (const row of encryptedProfileRecords) await tx.objectStore('profileRecords').put(row);
      for (const row of encryptedCollections) await tx.objectStore('collections').put(row);
      for (const row of encryptedActivity) await tx.objectStore('activity').put(row);
      for (const row of encryptedHistory) await tx.objectStore('formHistory').put(row);
      for (const row of encryptedText) await tx.objectStore('documentText').put(row);
      await tx.objectStore('settings').put({ key: 'storageFormat', value: 'encrypted-v1', updatedAt: now });
      await tx.done;

      await vaultSession.unlockWithDataKey(await importDataKey(rawKey, true));

      return {
        migrated: true,
        counts: {
          profile: encryptedProfile ? 1 : 0,
          documents: encryptedDocuments.length,
          files: encryptedFiles.length,
          values: encryptedValues.length,
          conflicts: encryptedConflicts.length,
          profileRecords: encryptedProfileRecords.length,
          collections: encryptedCollections.length,
          activity: encryptedActivity.length,
          history: encryptedHistory.length,
          text: encryptedText.length,
        },
      };
    } catch (error) {
      // Best-effort rollback if the transaction did not commit.
      try {
        const rollback = db.transaction(
          ['vaultMeta', 'vaultProfile', 'documents', 'documentFiles', 'extractedValues', 'conflicts', 'profileRecords', 'collections', 'activity', 'formHistory', 'documentText'],
          'readwrite',
        );
        await rollback.objectStore('vaultMeta').delete('meta');
        if (snapshot.profile) await rollback.objectStore('vaultProfile').put(snapshot.profile);
        for (const row of snapshot.documents) await rollback.objectStore('documents').put(row as DocumentRecord);
        for (const row of snapshot.files) {
          const { ciphertext: _ciphertext, iv: _iv, data, ...rest } = row;
          if (data) await rollback.objectStore('documentFiles').put({ ...rest, data } as unknown as StoredDocumentFile);
        }
        for (const row of snapshot.values) await rollback.objectStore('extractedValues').put(row);
        for (const row of snapshot.conflicts) await rollback.objectStore('conflicts').put(row);
        for (const row of snapshot.profileRecords) await rollback.objectStore('profileRecords').put(row);
        for (const row of snapshot.collections) await rollback.objectStore('collections').put(row);
        for (const row of snapshot.activity) await rollback.objectStore('activity').put(row);
        for (const row of snapshot.history) await rollback.objectStore('formHistory').put(row);
        for (const row of snapshot.text) await rollback.objectStore('documentText').put(row);
        await rollback.done;
      } catch {
        // The original error is more useful than a rollback failure.
      }
      await vaultSession.lock();
      throw error;
    }
  },

  encryptedEnvelopeToBytes(envelope: { iv: string; data: string }): { iv: string; data: ArrayBuffer } {
    return { iv: envelope.iv, data: base64ToArrayBuffer(envelope.data) };
  },
};
