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
  VaultRecord,
} from '@shared/types';
import { getDb } from '../database/database';
import { vaultSession } from './vault-session';
import {
  decryptBytesWithKey,
  decryptBytesWithLegacyAad,
  decryptJsonWithKey,
  encryptBytesWithLegacyAad,
  encryptJsonWithLegacyAad,
  type RecordAad,
} from '../encryption/crypto-service';

/**
 * Test-only fixture helper for the Phase 3.1.2.1 browser migration crash test.
 * It is bundled only by the FORMFLOW_TEST_HOOKS build and never by production.
 */
export async function downgradeVaultToV1(): Promise<{
  vaultId: string;
  documents: number;
  files: number;
  values: number;
  collections: number;
}> {
  if (!(await vaultSession.isUnlocked())) throw new Error('Unlock the vault before downgrading the test fixture.');
  const db = await getDb();
  const vaults = await db.getAll('vaults');
  const active = vaults[0];
  if (!active) throw new Error('No active vault.');
  const meta = await db.get('vaultMeta', 'meta');
  if (!meta) throw new Error('No vault metadata.');
  const key = await vaultSession.getDataKey();
  const identity = { vaultId: active.id, schemaVersion: active.schemaVersion ?? 2 };
  const ctx = (recordType: string, recordId: string, field: string): RecordAad => ({
    ...identity,
    recordType,
    recordId,
    field,
  });

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

  const vaultName = active.nameEnc
    ? await decryptJsonWithKey<string>(key, active.nameEnc, ctx('vault', active.id, 'name'))
    : active.name;
  const legacyVault: VaultRecord = { ...active, name: vaultName, nameEnc: undefined };

  const legacyProfile: StoredVaultProfileRow | null = profile
    ? {
      ...profile,
      profileEnc: await encryptJsonWithLegacyAad(
        key,
        await decryptJsonWithKey(key, profile.profileEnc, ctx('profile', 'me', 'profile')),
      ),
    }
    : null;

  const legacyDocuments: DocumentRecord[] = [];
  for (const row of documents) {
    legacyDocuments.push({
      ...row,
      nameEnc: await encryptJsonWithLegacyAad(key, await decryptJsonWithKey(key, row.nameEnc, ctx('document', row.id, 'name'))),
      originalFilenameEnc: await encryptJsonWithLegacyAad(
        key,
        await decryptJsonWithKey(key, row.originalFilenameEnc, ctx('document', row.id, 'originalFilename')),
      ),
    });
  }

  const legacyFiles: StoredDocumentFile[] = [];
  for (const row of files) {
    const ciphertext = await row.ciphertext.arrayBuffer();
    const plaintext = row.aadVersion === 2
      ? await decryptBytesWithKey(key, row.iv, ciphertext, ctx('documentFile', row.documentId, 'file'))
      : await decryptBytesWithLegacyAad(key, row.iv, ciphertext);
    const legacy = await encryptBytesWithLegacyAad(key, plaintext);
    legacyFiles.push({
      ...row,
      ciphertext: new Blob([legacy.data], { type: 'application/octet-stream' }),
      iv: legacy.iv,
      aadVersion: 1,
    });
  }

  const legacyValues: ExtractedValueRecord[] = [];
  for (const row of values) {
    const label = row.labelEnc
      ? await decryptJsonWithKey<string>(key, row.labelEnc, ctx('value', row.id, 'label'))
      : row.label;
    legacyValues.push({
      ...row,
      label,
      labelEnc: undefined,
      valueEnc: await encryptJsonWithLegacyAad(key, await decryptJsonWithKey(key, row.valueEnc, ctx('value', row.id, 'value'))),
      normalizedValueEnc: await encryptJsonWithLegacyAad(
        key,
        await decryptJsonWithKey(key, row.normalizedValueEnc, ctx('value', row.id, 'normalizedValue')),
      ),
    });
  }

  const legacyConflicts: ConflictRecord[] = [];
  for (const row of conflicts) {
    const label = row.labelEnc
      ? await decryptJsonWithKey<string>(key, row.labelEnc, ctx('conflict', row.id, 'label'))
      : row.label;
    legacyConflicts.push({
      ...row,
      label,
      labelEnc: undefined,
      existingValueEnc: await encryptJsonWithLegacyAad(
        key,
        await decryptJsonWithKey(key, row.existingValueEnc, ctx('conflict', row.id, 'existingValue')),
      ),
      newValueEnc: await encryptJsonWithLegacyAad(
        key,
        await decryptJsonWithKey(key, row.newValueEnc, ctx('conflict', row.id, 'newValue')),
      ),
    });
  }

  const legacyProfileRecords: ProfileRecordRow[] = [];
  for (const row of profileRecords) {
    legacyProfileRecords.push({
      ...row,
      dataEnc: await encryptJsonWithLegacyAad(
        key,
        await decryptJsonWithKey(key, row.dataEnc, ctx(`profileRecord:${row.type}`, row.id, 'data')),
      ),
    });
  }

  const legacyCollections: CollectionRow[] = [];
  for (const row of collections) {
    legacyCollections.push({
      ...row,
      nameEnc: await encryptJsonWithLegacyAad(key, await decryptJsonWithKey(key, row.nameEnc, ctx('collection', row.id, 'name'))),
      descriptionEnc: await encryptJsonWithLegacyAad(
        key,
        await decryptJsonWithKey(key, row.descriptionEnc, ctx('collection', row.id, 'description')),
      ),
      notesEnc: await encryptJsonWithLegacyAad(key, await decryptJsonWithKey(key, row.notesEnc, ctx('collection', row.id, 'notes'))),
    });
  }

  const legacyActivity: ActivityRow[] = [];
  for (const row of activity) {
    legacyActivity.push({
      ...row,
      titleEnc: await encryptJsonWithLegacyAad(key, await decryptJsonWithKey(key, row.titleEnc, ctx('activity', row.id, 'title'))),
      detailEnc: await encryptJsonWithLegacyAad(key, await decryptJsonWithKey(key, row.detailEnc, ctx('activity', row.id, 'detail'))),
    });
  }

  const legacyHistory: FormHistoryRow[] = [];
  for (const row of history) {
    legacyHistory.push({
      ...row,
      websiteEnc: await encryptJsonWithLegacyAad(key, await decryptJsonWithKey(key, row.websiteEnc, ctx('formHistory', row.id, 'website'))),
      urlEnc: await encryptJsonWithLegacyAad(key, await decryptJsonWithKey(key, row.urlEnc, ctx('formHistory', row.id, 'url'))),
      documentsUsedEnc: await encryptJsonWithLegacyAad(
        key,
        await decryptJsonWithKey(key, row.documentsUsedEnc, ctx('formHistory', row.id, 'documentsUsed')),
      ),
    });
  }

  const legacyText: StoredDocumentText[] = [];
  for (const row of text) {
    legacyText.push({
      ...row,
      textEnc: await encryptJsonWithLegacyAad(key, await decryptJsonWithKey(key, row.textEnc, ctx('documentText', row.documentId, 'text'))),
      pageTextsEnc: await encryptJsonWithLegacyAad(
        key,
        await decryptJsonWithKey(key, row.pageTextsEnc, ctx('documentText', row.documentId, 'pageTexts')),
      ),
    });
  }

  const legacyMeta: VaultMeta = { ...meta, encryptionFormat: 1, nameFormat: 1 };
  const tx = db.transaction(
    ['vaults', 'vaultMeta', 'vaultProfile', 'documents', 'documentFiles', 'extractedValues', 'conflicts', 'profileRecords', 'collections', 'activity', 'formHistory', 'documentText', 'settings'],
    'readwrite',
  );
  await tx.objectStore('vaults').put(legacyVault);
  await tx.objectStore('vaultMeta').put(legacyMeta);
  if (legacyProfile) await tx.objectStore('vaultProfile').put(legacyProfile);
  for (const row of legacyDocuments) await tx.objectStore('documents').put(row);
  for (const row of legacyFiles) await tx.objectStore('documentFiles').put(row);
  for (const row of legacyValues) await tx.objectStore('extractedValues').put(row);
  for (const row of legacyConflicts) await tx.objectStore('conflicts').put(row);
  for (const row of legacyProfileRecords) await tx.objectStore('profileRecords').put(row);
  for (const row of legacyCollections) await tx.objectStore('collections').put(row);
  for (const row of legacyActivity) await tx.objectStore('activity').put(row);
  for (const row of legacyHistory) await tx.objectStore('formHistory').put(row);
  for (const row of legacyText) await tx.objectStore('documentText').put(row);
  await tx.objectStore('settings').put({ key: 'storageFormat', value: 'encrypted-v1', updatedAt: new Date().toISOString() });
  await tx.done;

  return {
    vaultId: active.id,
    documents: legacyDocuments.length,
    files: legacyFiles.length,
    values: legacyValues.length,
    collections: legacyCollections.length,
  };
}
