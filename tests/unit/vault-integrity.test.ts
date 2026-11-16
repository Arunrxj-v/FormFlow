import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { resetDatabaseForTests, getDb } = await import('../../core/database/database');
const { vaultManager } = await import('../../core/vault/vault-manager');
const { vaultRepository: vaultRecordRepository } = await import('../../core/database/vault-repository');
const {
  vaultRepository,
  documentRepository,
  collectionRepository,
} = await import('../../core/database/repositories');
const { checkVaultIntegrity } = await import('../../core/vault/vault-integrity');
const { sha256Hex } = await import('../../core/encryption/crypto-service');

const PASSPHRASE = 'integrity-passphrase-2026';
const CONTENT = 'integrity document bytes';

async function seed() {
  await resetDatabaseForTests();
  await vaultManager.create(PASSPHRASE);
  const vault = await vaultRecordRepository.create('Integrity vault');
  const checksum = await sha256Hex(CONTENT);
  const document = await documentRepository.create(
    {
      vaultId: vault.id,
      mimeType: 'text/plain',
      extension: 'txt',
      category: 'Other',
      subcategory: '',
      status: 'stored',
      fileType: 'txt',
      sizeBytes: CONTENT.length,
      sizeLabel: `${CONTENT.length} B`,
      checksum,
      storageKey: '',
      source: 'device',
      ocrUsed: false,
      extractedTextStatus: 'pending',
      metadata: {},
    },
    'integrity.txt',
  );
  await documentRepository.saveOriginalFile(document.id, 'text/plain', new Blob([CONTENT], { type: 'text/plain' }));
  await documentRepository.update(document.id, { storageKey: `file_${document.id}` });
  await vaultRepository.addField({
    key: 'contact.email',
    label: 'Email address',
    value: 'integrity@example.com',
    category: 'contact',
    source: { documentId: document.id, documentName: 'integrity.txt' },
    confidence: 100,
    verificationStatus: 'user_verified',
    extractionMethod: 'manual',
  });
  await vaultRepository.addField({
    key: 'contact.phone',
    label: 'Phone number',
    value: '+1 555 0199',
    category: 'contact',
    source: { documentId: document.id, documentName: 'integrity.txt' },
    confidence: 100,
    verificationStatus: 'user_verified',
    extractionMethod: 'manual',
  });
  await collectionRepository.create({ name: 'Integrity collection', documentIds: [document.id] });
  return document;
}

test('baseline vault passes integrity checks', async () => {
  await seed();
  const report = await checkVaultIntegrity();
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.equal(report.counts.documents, 1);
  assert.equal(report.counts.values, 2);
  assert.equal(report.encryptionFormat, 2);
});

test('cross-record ciphertext swapping is detected without deleting records', async () => {
  await seed();
  const db = await getDb();
  const values = await db.getAll('extractedValues');
  assert.equal(values.length, 2);
  const [first, second] = values;
  await db.put('extractedValues', { ...first!, valueEnc: second!.valueEnc });
  await db.put('extractedValues', { ...second!, valueEnc: first!.valueEnc });

  const report = await checkVaultIntegrity();
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === 'INVALID_CIPHERTEXT'));
  assert.equal((await db.getAll('extractedValues')).length, 2, 'integrity check must not delete corrupted records');
  assert.equal((await documentRepository.list()).length, 1);
});

test('missing files, checksum mismatches, and broken membership are reported', async () => {
  const document = await seed();
  const db = await getDb();
  const file = await db.get('documentFiles', document.id);
  assert.ok(file);
  await db.delete('documentFiles', document.id);
  let report = await checkVaultIntegrity();
  assert.ok(report.issues.some((issue) => issue.code === 'MISSING_DOCUMENT_FILE'));

  await db.put('documentFiles', file);
  const row = await db.get('documents', document.id);
  assert.ok(row);
  await db.put('documents', { ...row, checksum: '0'.repeat(64) });
  report = await checkVaultIntegrity();
  assert.ok(report.issues.some((issue) => issue.code === 'CHECKSUM_MISMATCH'));

  await db.put('documents', row);
  await db.put('collectionDocuments', {
    id: 'cd_broken',
    collectionId: 'col_missing',
    documentId: document.id,
  });
  report = await checkVaultIntegrity();
  assert.ok(report.issues.some((issue) => issue.code === 'BROKEN_MEMBERSHIP_COLLECTION'));
  assert.equal((await documentRepository.list()).length, 1, 'corrupted references must not delete documents');
});
