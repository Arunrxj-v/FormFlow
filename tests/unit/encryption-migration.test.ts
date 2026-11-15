import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import type {
  ActivityRow,
  CollectionRow,
  DocumentRecord,
  ExtractedValueRecord,
  FormHistoryRow,
  StoredDocumentFile,
  StoredDocumentText,
} from '../../shared/types';

const { resetDatabaseForTests, getDb } = await import('../../core/database/database');
const { encryptionMigrationService } = await import('../../core/vault/encryption-migration');
const { vaultManager } = await import('../../core/vault/vault-manager');
const { vaultRepository, documentRepository, collectionRepository, activityRepository, historyRepository, profileRecordRepository } = await import('../../core/database/repositories');

await resetDatabaseForTests();
const PASSPHRASE = 'encryption-migration-passphrase-123';
const now = new Date().toISOString();
const vaultId = 'vault_legacy_test';
const documentId = 'doc_legacy_test';

test('migrates a Phase 2 plaintext vault to encrypted storage', async () => {
  const db = await getDb();
  await db.put('vaults', {
    id: vaultId,
    name: 'Legacy plaintext vault',
    schemaVersion: 2,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    setupCompleted: true,
  });
  await db.put('vaultProfile', {
    id: 'me',
    profileEnc: JSON.stringify({ id: 'me', name: 'Legacy User', email: 'legacy@example.com', accountType: 'Local', createdAt: now, updatedAt: now }),
    updatedAt: now,
  });
  await db.put('documents', {
    id: documentId,
    vaultId,
    nameEnc: JSON.stringify('legacy.txt'),
    originalFilename: 'legacy.txt',
    mimeType: 'text/plain',
    extension: 'txt',
    category: 'Other',
    subcategory: '',
    status: 'stored',
    fileType: 'txt',
    sizeBytes: 11,
    sizeLabel: '11 B',
    checksum: 'legacy-checksum',
    storageKey: `file_${documentId}`,
    source: 'device',
    ocrUsed: false,
    extractedTextStatus: 'pending',
    createdAt: now,
    updatedAt: now,
  } as unknown as DocumentRecord);
  await db.put('documentFiles', {
    documentId,
    storageKey: `file_${documentId}`,
    mimeType: 'text/plain',
    sizeBytes: 11,
    data: new Blob(['hello world'], { type: 'text/plain' }),
    version: 1,
    createdAt: now,
    updatedAt: now,
  } as unknown as StoredDocumentFile);
  await db.put('extractedValues', {
    id: 'val_legacy',
    key: 'contact.email',
    label: 'Email address',
    valueEnc: JSON.stringify('legacy@example.com'),
    normalizedValueEnc: JSON.stringify('legacy@example.com'),
    category: 'contact',
    sourceDocumentId: documentId,
    confidence: 99,
    extractionMethod: 'deterministic',
    verificationStatus: 'extracted',
    sensitive: false,
    userModified: false,
    createdAt: now,
    updatedAt: now,
  } as ExtractedValueRecord);
  await db.put('collections', {
    id: 'col_legacy',
    vaultId,
    nameEnc: JSON.stringify('Legacy collection'),
    descriptionEnc: JSON.stringify('Plaintext description'),
    notesEnc: JSON.stringify('Plaintext note'),
    color: '#6366f1',
    createdAt: now,
    updatedAt: now,
  } as CollectionRow);
  await db.put('activity', {
    id: 'act_legacy',
    type: 'document_added',
    titleEnc: JSON.stringify('Legacy document'),
    detailEnc: JSON.stringify('Imported in Phase 2'),
    createdAt: now,
  } as ActivityRow);
  await db.put('formHistory', {
    id: 'hist_legacy',
    websiteEnc: JSON.stringify('legacy.example.com'),
    urlEnc: JSON.stringify('https://legacy.example.com/form'),
    documentsUsedEnc: JSON.stringify(['legacy.txt']),
    fieldsDetected: 5,
    fieldsFilled: 4,
    fieldsReview: 1,
    status: 'Partially completed',
    durationMs: 1000,
    createdAt: now,
  } as FormHistoryRow);
  await db.put('documentText', {
    documentId,
    textEnc: JSON.stringify('hello world'),
    pageTextsEnc: JSON.stringify(['hello world']),
    pageCount: 1,
    method: 'txt',
    createdAt: now,
  } as StoredDocumentText);

  assert.equal(await encryptionMigrationService.hasPlaintextVault(), true);
  const result = await encryptionMigrationService.migrate(PASSPHRASE);
  assert.equal(result.migrated, true);
  assert.equal(result.counts.documents, 1);
  assert.equal(result.counts.values, 1);
  assert.equal(result.counts.collections, 1);

  const status = await vaultManager.status();
  assert.equal(status.encrypted, true);
  assert.equal(status.unlocked, true);

  const fields = await vaultRepository.listFields();
  assert.equal(fields.length, 1);
  assert.equal(fields[0]!.value, 'legacy@example.com');

  const documents = await documentRepository.list();
  assert.equal(documents.length, 1);
  assert.equal(documents[0]!.name, 'legacy.txt');
  const file = await documentRepository.getOriginalFile(documentId);
  assert.ok(file);
  assert.equal(await file.text(), 'hello world');

  const collections = await collectionRepository.list();
  assert.equal(collections[0]!.name, 'Legacy collection');
  const activity = await activityRepository.list();
  assert.equal(activity[0]!.title, 'Legacy document');
  const history = await historyRepository.list();
  assert.equal(history[0]!.website, 'legacy.example.com');

  const rawDocument = await db.get('documents', documentId);
  assert.ok(rawDocument);
  assert.notEqual(rawDocument.nameEnc, JSON.stringify('legacy.txt'));
  assert.match(rawDocument.nameEnc, /"alg":"AES-GCM"/);

  await vaultManager.lock();
  await assert.rejects(() => vaultRepository.listFields(), /locked/i);
  await vaultManager.unlock(PASSPHRASE);
  const profile = await profileRecordRepository.list('education');
  assert.deepEqual(profile, []);
});

test('rejects a wrong passphrase for the migrated vault', async () => {
  await vaultManager.lock();
  await assert.rejects(() => vaultManager.unlock('wrong-passphrase'), /incorrect/i);
  await vaultManager.unlock(PASSPHRASE);
});
