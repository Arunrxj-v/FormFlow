import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import type { EncryptionMigrationFaultPoint } from '../../core/vault/encryption-v2-migration';
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
} from '../../shared/types';

const { resetDatabaseForTests, getDb } = await import('../../core/database/database');
const {
  decryptJsonWithKey,
  encryptJsonWithLegacyAad,
  encryptBytesWithLegacyAad,
  encryptBytesWithKey,
  encryptJsonWithKey,
  sha256Hex,
  bufferToBase64,
} = await import('../../core/encryption/crypto-service');
const { vaultManager } = await import('../../core/vault/vault-manager');
const { vaultRepository: vaultRecordRepository } = await import('../../core/database/vault-repository');
const {
  vaultRepository,
  documentRepository,
  collectionRepository,
  activityRepository,
  historyRepository,
} = await import('../../core/database/repositories');
const { encryptionV2Migration } = await import('../../core/vault/encryption-v2-migration');
const { checkVaultIntegrity } = await import('../../core/vault/vault-integrity');

const PASSPHRASE = 'phase31-migration-passphrase';
const DATA = 'hello world';

interface Identity {
  vaultId: string;
  schemaVersion: number;
}

const ctx = (vault: Identity, recordType: string, recordId: string, field: string) => ({
  vaultId: vault.vaultId,
  recordType,
  recordId,
  field,
  schemaVersion: vault.schemaVersion,
});

async function seedVault(): Promise<{ identity: Identity; documentId: string }> {
  await resetDatabaseForTests();
  await vaultManager.create(PASSPHRASE);
  const vaultRecord = await vaultRecordRepository.create('Migration vault');
  const identity: Identity = { vaultId: vaultRecord.id, schemaVersion: vaultRecord.schemaVersion };
  const key = await vaultManager.getDataKeyOrThrow();

  await vaultRepository.saveProfile({ name: 'Migration User', email: 'migration@example.com' });
  const checksum = await sha256Hex(DATA);
  const document = await documentRepository.create(
    {
      vaultId: identity.vaultId,
      mimeType: 'text/plain',
      extension: 'txt',
      category: 'Other',
      subcategory: '',
      status: 'stored',
      fileType: 'txt',
      sizeBytes: DATA.length,
      sizeLabel: `${DATA.length} B`,
      checksum,
      storageKey: '',
      source: 'device',
      ocrUsed: false,
      extractedTextStatus: 'pending',
      metadata: {},
    },
    'v1-document.txt',
  );
  await documentRepository.saveOriginalFile(document.id, 'text/plain', new Blob([DATA], { type: 'text/plain' }));
  await documentRepository.update(document.id, { storageKey: `file_${document.id}` });
  await documentRepository.saveText(document.id, DATA, [DATA], 'txt');
  await vaultRepository.addField({
    key: 'contact.email',
    label: 'Email address',
    value: 'migration@example.com',
    category: 'contact',
    source: { documentId: document.id, documentName: 'v1-document.txt' },
    confidence: 100,
    verificationStatus: 'user_verified',
    extractionMethod: 'manual',
  });
  await vaultRepository.addField({
    key: 'contact.phone',
    label: 'Phone number',
    value: '+1 555 0100',
    category: 'contact',
    source: { documentId: document.id, documentName: 'v1-document.txt' },
    confidence: 80,
    verificationStatus: 'extracted',
    extractionMethod: 'deterministic',
  });
  const collection = await collectionRepository.create({ name: 'Migration collection', description: 'description', notes: 'notes' });
  await collectionRepository.update(collection.id, { documentIds: [document.id] });
  await activityRepository.record('document_added', 'Migration document', 'Added before the upgrade.');
  await historyRepository.record({
    website: 'example.com',
    url: 'https://example.com/form',
    detected: 3,
    filled: 2,
    review: 1,
    status: 'Partially completed',
    durationMs: 1200,
  });

  // Convert the freshly written v2 rows back to the Phase 3 v1 format.
  const db = await getDb();
  const profileRow = await db.get('vaultProfile', 'me');
  assert.ok(profileRow);
  const profile = await decryptJsonWithKey(key, profileRow.profileEnc, ctx(identity, 'profile', 'me', 'profile'));
  await db.put('vaultProfile', { ...profileRow, profileEnc: await encryptJsonWithLegacyAad(key, profile) });

  const documentRow = await db.get('documents', document.id);
  assert.ok(documentRow);
  const name = await decryptJsonWithKey<string>(key, documentRow.nameEnc, ctx(identity, 'document', document.id, 'name'));
  const filename = await decryptJsonWithKey<string>(key, documentRow.originalFilenameEnc, ctx(identity, 'document', document.id, 'originalFilename'));
  await db.put('documents', {
    ...documentRow,
    nameEnc: await encryptJsonWithLegacyAad(key, name),
    originalFilenameEnc: await encryptJsonWithLegacyAad(key, filename),
  });

  const file = await db.get('documentFiles', document.id);
  assert.ok(file);
  const plaintext = await documentRepository.getOriginalFile(document.id);
  assert.ok(plaintext);
  const legacyFile = await encryptBytesWithLegacyAad(key, await plaintext.arrayBuffer());
  await db.put('documentFiles', {
    ...file,
    ciphertext: new Blob([legacyFile.data], { type: 'application/octet-stream' }),
    iv: legacyFile.iv,
    aadVersion: 1,
  });

  const valueRows = await db.getAll('extractedValues');
  for (const row of valueRows) {
    const label = row.labelEnc
      ? await decryptJsonWithKey<string>(key, row.labelEnc, ctx(identity, 'value', row.id, 'label'))
      : row.label;
    const value = await decryptJsonWithKey<string>(key, row.valueEnc, ctx(identity, 'value', row.id, 'value'));
    const normalized = await decryptJsonWithKey<string>(key, row.normalizedValueEnc, ctx(identity, 'value', row.id, 'normalizedValue'));
    const legacy: ExtractedValueRecord = {
      ...row,
      label,
      valueEnc: await encryptJsonWithLegacyAad(key, value),
      normalizedValueEnc: await encryptJsonWithLegacyAad(key, normalized),
    };
    delete legacy.labelEnc;
    await db.put('extractedValues', legacy);
  }

  const conflictId = 'conf_migration_v1';
  const now = new Date().toISOString();
  const legacyConflict: ConflictRecord = {
    id: conflictId,
    key: 'contact.email',
    label: '',
    existingValueEnc: await encryptJsonWithLegacyAad(key, 'old@example.com'),
    existingSourceDocumentId: document.id,
    existingConfidence: 90,
    newValueEnc: await encryptJsonWithLegacyAad(key, 'new@example.com'),
    newSourceDocumentId: document.id,
    newConfidence: 95,
    status: 'open',
    createdAt: now,
  };
  legacyConflict.label = 'Email address';
  await db.put('conflicts', legacyConflict);

  const collectionRow = await db.get('collections', collection.id);
  assert.ok(collectionRow);
  const collectionName = await decryptJsonWithKey<string>(key, collectionRow.nameEnc, ctx(identity, 'collection', collection.id, 'name'));
  const collectionDescription = await decryptJsonWithKey<string>(key, collectionRow.descriptionEnc, ctx(identity, 'collection', collection.id, 'description'));
  const collectionNotes = await decryptJsonWithKey<string>(key, collectionRow.notesEnc, ctx(identity, 'collection', collection.id, 'notes'));
  const legacyCollection: CollectionRow = {
    ...collectionRow,
    nameEnc: await encryptJsonWithLegacyAad(key, collectionName),
    descriptionEnc: await encryptJsonWithLegacyAad(key, collectionDescription),
    notesEnc: await encryptJsonWithLegacyAad(key, collectionNotes),
  };
  await db.put('collections', legacyCollection);

  const activityRows = await db.getAll('activity');
  for (const row of activityRows) {
    const title = await decryptJsonWithKey<string>(key, row.titleEnc, ctx(identity, 'activity', row.id, 'title'));
    const detail = await decryptJsonWithKey<string>(key, row.detailEnc, ctx(identity, 'activity', row.id, 'detail'));
    await db.put('activity', {
      ...row,
      titleEnc: await encryptJsonWithLegacyAad(key, title),
      detailEnc: await encryptJsonWithLegacyAad(key, detail),
    });
  }

  const historyRows = await db.getAll('formHistory');
  for (const row of historyRows) {
    const website = await decryptJsonWithKey<string>(key, row.websiteEnc, ctx(identity, 'formHistory', row.id, 'website'));
    const url = await decryptJsonWithKey<string>(key, row.urlEnc, ctx(identity, 'formHistory', row.id, 'url'));
    const documents = await decryptJsonWithKey<string[]>(key, row.documentsUsedEnc, ctx(identity, 'formHistory', row.id, 'documentsUsed'));
    await db.put('formHistory', {
      ...row,
      websiteEnc: await encryptJsonWithLegacyAad(key, website),
      urlEnc: await encryptJsonWithLegacyAad(key, url),
      documentsUsedEnc: await encryptJsonWithLegacyAad(key, documents),
    });
  }

  const textRows = await db.getAll('documentText');
  for (const row of textRows) {
    const text = await decryptJsonWithKey<string>(key, row.textEnc, ctx(identity, 'documentText', row.documentId, 'text'));
    const pages = await decryptJsonWithKey<string[]>(key, row.pageTextsEnc, ctx(identity, 'documentText', row.documentId, 'pageTexts'));
    await db.put('documentText', {
      ...row,
      textEnc: await encryptJsonWithLegacyAad(key, text),
      pageTextsEnc: await encryptJsonWithLegacyAad(key, pages),
    });
  }

  const meta = await db.get('vaultMeta', 'meta');
  assert.ok(meta);
  await db.put('vaultMeta', { ...meta, encryptionFormat: 1 });
  await db.put('settings', { key: 'storageFormat', value: 'encrypted-v1', updatedAt: now });
  return { identity, documentId: document.id };
}

test('migrates all v1 record types to per-record AAD and verifies the vault', async () => {
  const { documentId } = await seedVault();
  const before = await encryptionV2Migration.status();
  assert.equal(before.needsMigration, true);
  assert.equal(before.encryptionFormat, 1);

  const result = await encryptionV2Migration.runIfNeeded();
  assert.equal(result.needsMigration, false);
  assert.equal(result.encryptionFormat, 2);
  assert.equal(result.journal?.status, 'complete');
  assert.ok((result.journal?.migrated.documents ?? 0) >= 1);

  const db = await getDb();
  const meta = await db.get('vaultMeta', 'meta');
  assert.equal(meta?.encryptionFormat, 2);
  const valueRows = await db.getAll('extractedValues');
  assert.ok(valueRows.length >= 2);
  for (const row of valueRows) {
    assert.match(row.valueEnc, /"v":2/);
    assert.match(row.labelEnc ?? '', /"v":2/);
    assert.equal(row.label, '');
    assert.ok(!JSON.stringify(row).includes('Email address'));
  }
  const documentRow = await db.get('documents', documentId);
  assert.match(documentRow?.nameEnc ?? '', /"v":2/);
  const file = await db.get('documentFiles', documentId);
  assert.equal(file?.aadVersion, 2);

  const fields = await vaultRepository.listFields();
  assert.ok(fields.some((field) => field.label === 'Email address' && field.value === 'migration@example.com'));
  const documents = await documentRepository.list();
  assert.equal(documents[0]?.name, 'v1-document.txt');
  const blob = await documentRepository.getOriginalFile(documentId);
  assert.equal(await blob?.text(), DATA);
  const collections = await collectionRepository.list();
  assert.equal(collections[0]?.name, 'Migration collection');
  const activity = await activityRepository.list();
  assert.ok(activity.some((item) => item.title === 'Migration document'));
  const history = await historyRepository.list();
  assert.equal(history[0]?.website, 'example.com');

  const integrity = await checkVaultIntegrity();
  assert.equal(integrity.ok, true, JSON.stringify(integrity.issues));

  const again = await encryptionV2Migration.runIfNeeded();
  assert.equal(again.needsMigration, false);
  assert.equal(again.journal?.status, 'complete');
});

test('failed migration keeps the vault on v1 and resumes after the bad record is restored', async () => {
  const { documentId } = await seedVault();
  const db = await getDb();
  const document = await db.get('documents', documentId);
  assert.ok(document);
  const original = document.nameEnc;
  const tampered = JSON.parse(document.nameEnc) as { data: string };
  const bytes = Buffer.from(tampered.data, 'base64');
  bytes[0] ^= 1;
  tampered.data = bytes.toString('base64');
  await db.put('documents', { ...document, nameEnc: JSON.stringify(tampered) });

  await assert.rejects(() => encryptionV2Migration.runIfNeeded(), /authenticated|malformed|valid/i);
  const failed = await encryptionV2Migration.status();
  assert.equal(failed.encryptionFormat, 1);
  assert.equal(failed.needsMigration, true);
  assert.equal(failed.journal?.status, 'failed');
  const meta = await db.get('vaultMeta', 'meta');
  assert.equal(meta?.encryptionFormat, 1);

  await db.put('documents', { ...document, nameEnc: original });
  const recovered = await encryptionV2Migration.runIfNeeded();
  assert.equal(recovered.encryptionFormat, 2);
  assert.equal(recovered.journal?.status, 'complete');
  const blob = await documentRepository.getOriginalFile(documentId);
  assert.equal(await blob?.text(), DATA);
});

test('migration is idempotent after partial v2 conversion', async () => {
  await seedVault();
  const db = await getDb();
  const values = await db.getAll('extractedValues');
  const row = values[0]!;
  const key = await vaultManager.getDataKeyOrThrow();
  const vault = await vaultRecordRepository.getActive();
  assert.ok(vault);
  const label = row.label;
  const value = await decryptJsonWithKey<string>(key, row.valueEnc, {
    vaultId: vault.id,
    recordType: 'value',
    recordId: row.id,
    field: 'value',
    schemaVersion: vault.schemaVersion,
  });
  await db.put('extractedValues', {
    ...row,
    valueEnc: await encryptJsonWithKey(key, value, {
      vaultId: vault.id,
      recordType: 'value',
      recordId: row.id,
      field: 'value',
      schemaVersion: vault.schemaVersion,
    }),
    labelEnc: await encryptJsonWithKey(key, label, {
      vaultId: vault.id,
      recordType: 'value',
      recordId: row.id,
      field: 'label',
      schemaVersion: vault.schemaVersion,
    }),
    label: '',
  });
  const first = await encryptionV2Migration.runIfNeeded();
  assert.equal(first.encryptionFormat, 2);
  const counts = { ...first.journal?.migrated };
  const second = await encryptionV2Migration.runIfNeeded();
  assert.deepEqual(second.journal?.migrated, counts);
  const integrity = await checkVaultIntegrity();
  assert.equal(integrity.ok, true, JSON.stringify(integrity.issues));
});

async function recoverFromFault(point: EncryptionMigrationFaultPoint, error: unknown = new Error('simulated crash')): Promise<void> {
  await seedVault();
  let fired = false;
  await assert.rejects(() => encryptionV2Migration.runIfNeeded({
    fault: (at) => {
      if (at === point && !fired) {
        fired = true;
        throw error;
      }
    },
  }));
  const failed = await encryptionV2Migration.status();
  assert.equal(failed.encryptionFormat, 1, `${point} must not advance the format marker`);
  const recovered = await encryptionV2Migration.runIfNeeded();
  assert.equal(recovered.encryptionFormat, 2);
  assert.equal(recovered.journal?.status, 'complete');
  const integrity = await checkVaultIntegrity();
  assert.equal(integrity.ok, true, JSON.stringify(integrity.issues));
}

test('crash before a batch begins resumes safely', async () => {
  await recoverFromFault('before_migration');
});

test('crash before a write resumes safely', async () => {
  await recoverFromFault('before_write');
});

test('crash during an IndexedDB transaction rolls back the batch', async () => {
  await recoverFromFault('during_transaction');
});

test('crash after a batch commits but before the journal update resumes', async () => {
  await recoverFromFault('after_commit');
});

test('crash before the final verification or marker update resumes', async () => {
  await recoverFromFault('before_verification');
  await recoverFromFault('before_marker');
});

test('quota exhaustion during a migration batch is reported and recoverable', async () => {
  await recoverFromFault('during_transaction', new DOMException('Quota exceeded', 'QuotaExceededError'));
});

test('quota exhaustion during journal and marker updates is recoverable', async () => {
  await seedVault();
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patched(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === 'settings') throw new DOMException('Quota exceeded', 'QuotaExceededError');
    return originalPut.call(this, value as never, key as never);
  } as typeof IDBObjectStore.prototype.put;
  try {
    await assert.rejects(() => encryptionV2Migration.runIfNeeded(), /storage|quota/i);
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.equal((await encryptionV2Migration.status()).encryptionFormat, 1);
  const recovered = await encryptionV2Migration.runIfNeeded();
  assert.equal(recovered.encryptionFormat, 2);

  // Final format-marker write fails after all records are verified.
  await seedVault();
  IDBObjectStore.prototype.put = function patchedMarker(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === 'vaultMeta' && (value as { id?: string } | undefined)?.id === 'meta') {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    }
    return originalPut.call(this, value as never, key as never);
  } as typeof IDBObjectStore.prototype.put;
  try {
    await assert.rejects(() => encryptionV2Migration.runIfNeeded(), /storage|quota/i);
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.equal((await encryptionV2Migration.status()).encryptionFormat, 1);
  const markerRecovered = await encryptionV2Migration.runIfNeeded();
  assert.equal(markerRecovered.encryptionFormat, 2);
  const integrity = await checkVaultIntegrity();
  assert.equal(integrity.ok, true, JSON.stringify(integrity.issues));
});

test('quota exhaustion during profile metadata migration is recoverable', async () => {
  await seedVault();
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patched(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === 'vaultProfile') throw new DOMException('Quota exceeded', 'QuotaExceededError');
    return originalPut.call(this, value as never, key as never);
  } as typeof IDBObjectStore.prototype.put;
  try {
    await assert.rejects(() => encryptionV2Migration.runIfNeeded(), /storage|quota/i);
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.equal((await encryptionV2Migration.status()).encryptionFormat, 1);
  const recovered = await encryptionV2Migration.runIfNeeded();
  assert.equal(recovered.encryptionFormat, 2);
  const integrity = await checkVaultIntegrity();
  assert.equal(integrity.ok, true, JSON.stringify(integrity.issues));
});

test('quota exhaustion during encrypted document migration preserves the v1 blob', async () => {
  const { documentId } = await seedVault();
  const db = await getDb();
  const originalFile = await db.get('documentFiles', documentId);
  assert.ok(originalFile);
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patched(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === 'documentFiles') throw new DOMException('Quota exceeded', 'QuotaExceededError');
    return originalPut.call(this, value as never, key as never);
  } as typeof IDBObjectStore.prototype.put;
  try {
    await assert.rejects(() => encryptionV2Migration.runIfNeeded(), /storage|quota/i);
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.equal((await encryptionV2Migration.status()).encryptionFormat, 1);
  const fileAfterFailure = await db.get('documentFiles', documentId);
  assert.equal(fileAfterFailure?.aadVersion, 1, 'the original v1 blob must remain');
  const recovered = await encryptionV2Migration.runIfNeeded();
  assert.equal(recovered.encryptionFormat, 2);
  const blob = await documentRepository.getOriginalFile(documentId);
  assert.equal(await blob?.text(), DATA);
});

test('crash before a batch and around journal updates resumes safely', async () => {
  await recoverFromFault('before_batch');
  await recoverFromFault('before_journal');
  await recoverFromFault('after_journal');
});
