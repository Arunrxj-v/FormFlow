import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { resetDatabaseForTests } = await import('../../core/database/database');
const { vaultManager } = await import('../../core/vault/vault-manager');
const { vaultRepository: vaultRecordRepository } = await import('../../core/database/vault-repository');
const { documentRepository, vaultRepository } = await import('../../core/database/repositories');
const { documentStorage } = await import('../../core/storage/document-storage');
const { vaultExportService } = await import('../../core/storage/vault-export');
const { sha256Hex } = await import('../../core/encryption/crypto-service');

const SOURCE_PASS = 'source-vault-passphrase-123';
const TARGET_PASS = 'target-vault-passphrase-123';
const BACKUP_PASS = 'backup-passphrase-123';
let sourceBackup: Blob;

await resetDatabaseForTests();
await vaultManager.create(SOURCE_PASS);
const sourceVault = await vaultRecordRepository.create('Source vault');
await vaultRepository.saveProfile({ name: 'Backup User', email: 'backup@example.com' });
const checksum = await sha256Hex('hello world');
const document = await documentRepository.create(
  {
    vaultId: sourceVault.id,
    mimeType: 'text/plain',
    extension: 'txt',
    category: 'Other',
    subcategory: '',
    status: 'stored',
    fileType: 'txt',
    sizeBytes: 11,
    sizeLabel: '11 B',
    checksum,
    storageKey: '',
    source: 'device',
    ocrUsed: false,
    extractedTextStatus: 'pending',
    metadata: {},
  },
  'backup.txt',
);
await documentStorage.save(document.id, new Blob(['hello world'], { type: 'text/plain' }), 'text/plain');
await documentRepository.update(document.id, {
  storageKey: `file_${document.id}`,
  extractedTextStatus: 'extracted',
  extractionVersion: 1,
  extractedAt: new Date().toISOString(),
  ocrRequired: false,
});
await documentRepository.saveText(document.id, 'hello world', ['hello world'], 'txt', {
  version: 1,
  ocrRequired: false,
  pagesNeedingOcr: [],
  warnings: [{ code: 'BACKUP_FIXTURE', message: 'Encrypted extraction warning fixture' }],
  metadata: { encoding: 'utf-8', bom: false, lineEndings: 'lf' },
});
await vaultRepository.addField({
  key: 'contact.email',
  label: 'Email address',
  value: 'backup@example.com',
  category: 'contact',
  source: { documentId: document.id, documentName: 'backup.txt' },
  confidence: 99,
  verificationStatus: 'user_verified',
  extractionMethod: 'manual',
});

test('exports an encrypted archive without plaintext sensitive data', async () => {
  const blob = await vaultExportService.exportEncrypted(BACKUP_PASS);
  sourceBackup = blob;
  const text = await blob.text();
  assert.ok(text.includes('formflow-encrypted-backup'));
  assert.ok(!text.includes('backup@example.com'));
  assert.ok(!text.includes('hello world'));
  assert.ok(!text.includes(BACKUP_PASS));
});

test('rejects a wrong backup passphrase and imports into an empty vault', async () => {
  const blob = await vaultExportService.exportEncrypted(BACKUP_PASS);

  await vaultManager.lock();
  await resetDatabaseForTests();
  await vaultManager.create(TARGET_PASS);
  await vaultRecordRepository.create('Target vault');
  await vaultRepository.saveProfile({ name: 'Target vault', email: '' });
  await assert.rejects(() => vaultExportService.importEncrypted(blob, 'wrong-passphrase'), /incorrect|corrupted/i);

  const envelope = JSON.parse(await blob.text()) as { payload: string };
  const payloadBytes = Buffer.from(envelope.payload, 'base64');
  payloadBytes[0] ^= 1;
  const tampered = new Blob([JSON.stringify({ ...envelope, payload: payloadBytes.toString('base64') })], { type: 'application/json' });
  await assert.rejects(() => vaultExportService.importEncrypted(tampered, BACKUP_PASS), /incorrect|corrupted|authenticated/i);

  const result = await vaultExportService.importEncrypted(blob, BACKUP_PASS);
  assert.equal(result.imported, true);
  assert.equal(result.documents, 1);
  assert.equal(result.values, 1);

  const importedDoc = (await documentRepository.list())[0];
  assert.ok(importedDoc);
  assert.equal(importedDoc.name, 'backup.txt');
  const file = await documentRepository.getOriginalFile(importedDoc.row.id);
  assert.ok(file);
  assert.equal(await file.text(), 'hello world');
  const text = await documentRepository.getText(importedDoc.row.id);
  assert.ok(text);
  assert.equal(text.text, 'hello world');
  assert.deepEqual(text.pageTexts, ['hello world']);
  assert.equal(text.extraction?.metadata.encoding, 'utf-8');
  assert.equal(text.extraction?.warnings[0]?.code, 'BACKUP_FIXTURE');
  const fields = await vaultRepository.listFields();
  assert.equal(fields[0]!.value, 'backup@example.com');
});

test('rejects importing into a non-empty vault', async () => {
  const blob = await vaultExportService.exportEncrypted(BACKUP_PASS);
  await assert.rejects(() => vaultExportService.importEncrypted(blob, BACKUP_PASS), /already contains data/i);
});

test('rejects importing into a vault with a customized profile', async () => {
  await vaultManager.lock();
  await resetDatabaseForTests();
  await vaultManager.create(TARGET_PASS);
  await vaultRecordRepository.create('Personalized vault');
  await vaultRepository.saveProfile({ name: 'Custom Person', email: 'custom@example.com' });
  await assert.rejects(
    () => vaultExportService.importEncrypted(sourceBackup, BACKUP_PASS),
    /already contains data/i,
  );
});
