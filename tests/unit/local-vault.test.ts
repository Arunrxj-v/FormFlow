import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import type { EducationRecord } from '../../shared/types';

const { resetDatabaseForTests } = await import('../../core/database/database');
const { documentRepository, profileRecordRepository, collectionRepository, vaultRepository, activityRepository, historyRepository } = await import('../../core/database/repositories');
const { vaultRepository: vaultRecordRepository } = await import('../../core/database/vault-repository');
const { documentStorage } = await import('../../core/storage/document-storage');
const { vaultManager } = await import('../../core/vault/vault-manager');
const { generateDataKey, encryptJsonWithKey, decryptJsonWithKey } = await import('../../core/encryption/crypto-service');

const PASSPHRASE = 'unit-test-passphrase-123';
await resetDatabaseForTests();
await vaultManager.create(PASSPHRASE);

test('creates an encrypted local vault and returns its record', async () => {
  const status = await vaultManager.status();
  assert.equal(status.exists, true);
  assert.equal(status.unlocked, true);
  assert.equal(status.encrypted, true);
  const vault = await vaultRecordRepository.create('Test vault');
  assert.equal(vault.name, 'Test vault');
  assert.equal(vault.schemaVersion, 2);
  assert.equal(vault.setupCompleted, true);
  assert.equal((await vaultRecordRepository.getActive())?.id, vault.id);
});

test('rejects a wrong passphrase and tampered ciphertext', async () => {
  await vaultManager.lock();
  await assert.rejects(() => vaultManager.unlock('wrong-passphrase'), /incorrect/i);
  await vaultManager.unlock(PASSPHRASE);
  const key = await generateDataKey();
  const encrypted = await encryptJsonWithKey(key, { secret: 'value' });
  const encryptedAgain = await encryptJsonWithKey(key, { secret: 'value' });
  assert.notEqual(encrypted, encryptedAgain, 'AES-GCM must use a fresh nonce per encryption');
  assert.deepEqual(await decryptJsonWithKey(key, encrypted), { secret: 'value' });
  const parsed = JSON.parse(encrypted) as { data: string };
  const bytes = Buffer.from(parsed.data, 'base64');
  bytes[0] ^= 1;
  parsed.data = bytes.toString('base64');
  await assert.rejects(() => decryptJsonWithKey(key, JSON.stringify(parsed)), /authenticated|malformed|valid/i);
});

test('changes the passphrase by rewrapping the vault data key', async () => {
  const newPassphrase = 'unit-test-passphrase-456';
  await vaultManager.changePassword(PASSPHRASE, newPassphrase);
  await vaultManager.lock();
  await assert.rejects(() => vaultManager.unlock(PASSPHRASE), /incorrect/i);
  await vaultManager.unlock(newPassphrase);
  await vaultManager.changePassword(newPassphrase, PASSPHRASE);
});

test('stores a document blob and metadata and detects duplicates', async () => {
  const vault = (await vaultRecordRepository.getActive())!;
  const file = new Blob(['hello world'], { type: 'text/plain' });
  const checksum = 'stub-checksum';
  const row = await documentRepository.create(
    {
      vaultId: vault.id,
      mimeType: 'text/plain',
      extension: 'txt',
      category: 'Other',
      subcategory: '',
      status: 'stored',
      fileType: 'txt',
      sizeBytes: file.size,
      sizeLabel: '11 B',
      checksum,
      storageKey: '',
      source: 'device',
      ocrUsed: false,
      extractedTextStatus: 'pending',
      metadata: { note: 'unit test' },
    },
    'hello.txt',
  );

  await documentStorage.save(row.id, file, 'text/plain');
  await documentRepository.update(row.id, { storageKey: `file_${row.id}` });
  const stored = await documentRepository.getOriginalFile(row.id);
  assert.ok(stored);
  assert.equal(await stored.text(), 'hello world');

  const duplicate = await documentRepository.findByChecksum(checksum);
  assert.ok(duplicate);
  assert.equal(duplicate.id, row.id);

  const document = await documentRepository.get(row.id);
  assert.ok(document);
  assert.equal(document.name, 'hello.txt');
  assert.equal(document.row.storageKey, `file_${row.id}`);
});

test('stores profile records and collection relationships', async () => {
  const vault = (await vaultRecordRepository.getActive())!;
  const documentRows = await documentRepository.list();
  const documentId = documentRows[0]!.row.id;

  const education = {
    id: 'edu_test',
    level: 'Tertiary / Degree',
    degree: 'B.Tech',
    institution: 'Cochin University',
    university: 'Cochin University',
    period: '2021 - 2025',
    status: 'Completed' as const,
    metrics: [],
    registrationNo: 'KTU21CS0001',
    gpa: '8.7',
    specialization: 'Computer Science',
    autofillTag: 'edu.degree',
    createdAt: new Date().toISOString(),
    lastSynced: 'Just now',
    sourceNote: 'Unit test record',
    documentId,
  };
  await profileRecordRepository.save<EducationRecord>('education', education, documentId);
  const educationRows = await profileRecordRepository.list<EducationRecord>('education');
  assert.equal(educationRows.length, 1);
  assert.equal(educationRows[0]!.institution, 'Cochin University');

  const collection = await collectionRepository.create({
    name: 'Education',
    description: 'Degrees and certificates',
    color: '#10b981',
    documentIds: [documentId],
  });
  assert.equal(collection.vaultId, vault.id);
  assert.deepEqual(collection.documentIds, [documentId]);

  const updated = await collectionRepository.update(collection.id, { documentIds: [] });
  assert.ok(updated);
  assert.deepEqual(updated.documentIds, []);
  const documentAfterCollectionUpdate = await documentRepository.get(documentId);
  assert.ok(documentAfterCollectionUpdate, 'Collection edits must not delete documents');
});

test('deleting a document removes dependent records but keeps collections and profile data', async () => {
  const documentRows = await documentRepository.list();
  const documentId = documentRows[0]!.row.id;

  await collectionRepository.create({ name: 'Docs', documentIds: [documentId] });
  await vaultRepository.addField({
    key: 'contact.email',
    label: 'Email address',
    value: 'user@example.com',
    category: 'contact',
    source: { documentId, documentName: 'hello.txt' },
    confidence: 99,
    verificationStatus: 'extracted',
    extractionMethod: 'deterministic',
  });

  const valuesBefore = await vaultRepository.listFields();
  assert.equal(valuesBefore.length, 1);
  assert.equal(valuesBefore[0]!.source.documentId, documentId);

  await documentRepository.remove(documentId);

  const valuesAfter = await vaultRepository.listFields();
  assert.equal(valuesAfter.length, 0);
  const collections = await collectionRepository.list();
  assert.ok(collections.some((collection) => collection.name === 'Docs'));
  const blob = await documentRepository.getOriginalFile(documentId);
  assert.equal(blob, null);
  const profileRows = await profileRecordRepository.list<EducationRecord>('education');
  assert.equal(profileRows.length, 1);
});

test('creates and resolves vault field conflicts without silently overwriting values', async () => {
  const vault = (await vaultRecordRepository.getActive())!;
  const documentRow = await documentRepository.create(
    {
      vaultId: vault.id,
      mimeType: 'application/pdf',
      extension: 'pdf',
      category: 'Identity',
      subcategory: '',
      status: 'stored',
      fileType: 'pdf',
      sizeBytes: 100,
      sizeLabel: '100 B',
      checksum: 'conflict-source-checksum',
      storageKey: '',
      source: 'device',
      ocrUsed: false,
      extractedTextStatus: 'pending',
      metadata: {},
    },
    'conflict-source.pdf',
  );

  await vaultRepository.addField({
    key: 'contact.phone',
    label: 'Phone number',
    value: '9876543210',
    category: 'contact',
    source: { documentId: documentRow.id, documentName: 'conflict-source.pdf' },
    confidence: 95,
    verificationStatus: 'extracted',
    extractionMethod: 'deterministic',
  });

  await vaultRepository.addField({
    key: 'contact.phone',
    label: 'Phone number',
    value: '9740000000',
    category: 'contact',
    source: { documentId: documentRow.id, documentName: 'conflict-source.pdf' },
    confidence: 88,
    verificationStatus: 'extracted',
    extractionMethod: 'deterministic',
  });

  const fieldsWithConflict = await vaultRepository.listFields();
  const phoneField = fieldsWithConflict.find((field) => field.key === 'contact.phone');
  assert.ok(phoneField);
  assert.equal(phoneField.value, '9876543210');
  assert.ok(phoneField.conflicts?.length);

  const resolved = await vaultRepository.resolveConflict(phoneField.id, '9740000000');
  assert.equal(resolved.value, '9740000000');
  const conflictsAfterResolution = await vaultRepository.listOpenConflicts();
  assert.equal(conflictsAfterResolution.length, 0);
});

test('records local activity and form history', async () => {
  await activityRepository.record('document_added', 'Document added', 'Unit test activity');
  await historyRepository.record({
    website: 'example.com',
    url: 'https://example.com/form',
    detected: 10,
    filled: 8,
    review: 2,
    status: 'Partially completed',
    durationMs: 12_000,
    documentsUsed: ['example.pdf'],
  });

  const activity = await activityRepository.list();
  const history = await historyRepository.list();
  assert.ok(activity.some((item) => item.title === 'Document added'));
  assert.equal(history.length, 1);
  assert.equal(history[0]!.website, 'example.com');
  assert.equal(history[0]!.fieldsFilled, 8);
  await historyRepository.clear();
  const cleared = await historyRepository.list();
  assert.equal(cleared.length, 0);
});
