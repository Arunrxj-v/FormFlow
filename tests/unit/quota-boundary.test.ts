import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { resetDatabaseForTests, getDb } = await import('../../core/database/database');
const { vaultManager } = await import('../../core/vault/vault-manager');
const { vaultRepository: vaultRecordRepository } = await import('../../core/database/vault-repository');
const { documentRepository, vaultRepository, collectionRepository } = await import('../../core/database/repositories');
const { documentService } = await import('../../core/application/document-service');
const { vaultExportService, assertBackupSize, BACKUP_SIZE_LIMIT_BYTES } = await import('../../core/storage/vault-export');
const { sha256Hex } = await import('../../core/encryption/crypto-service');
const { MAX_BACKUP_BYTES } = await import('../../shared/constants');

const PASSPHRASE = 'quota-boundary-passphrase';
const BACKUP_PASS = 'quota-boundary-backup-pass';

async function seedVault(name = 'Quota target'): Promise<void> {
  await resetDatabaseForTests();
  await vaultManager.create(PASSPHRASE);
  await vaultRecordRepository.create(name);
}

async function addDocument(content: string, name: string): Promise<string> {
  const vault = (await vaultRecordRepository.getActive())!;
  const checksum = await sha256Hex(content);
  const document = await documentRepository.create(
    {
      vaultId: vault.id,
      mimeType: 'text/plain',
      extension: 'txt',
      category: 'Other',
      subcategory: '',
      status: 'stored',
      fileType: 'txt',
      sizeBytes: content.length,
      sizeLabel: `${content.length} B`,
      checksum,
      storageKey: '',
      source: 'device',
      ocrUsed: false,
      extractedTextStatus: 'pending',
      metadata: {},
    },
    name,
  );
  await documentRepository.saveOriginalFile(document.id, 'text/plain', new Blob([content], { type: 'text/plain' }));
  await documentRepository.update(document.id, { storageKey: `file_${document.id}` });
  return document.id;
}

test('the archive limit is exactly 200 × 1024 × 1024 bytes and rejects only above it', () => {
  assert.equal(MAX_BACKUP_BYTES, 200 * 1024 * 1024);
  assert.equal(BACKUP_SIZE_LIMIT_BYTES, MAX_BACKUP_BYTES);
  assert.equal(MAX_BACKUP_BYTES, 209_715_200);
  assert.doesNotThrow(() => assertBackupSize(MAX_BACKUP_BYTES - 1));
  assert.doesNotThrow(() => assertBackupSize(MAX_BACKUP_BYTES));
  assert.throws(() => assertBackupSize(MAX_BACKUP_BYTES + 1), /200 MB/i);
  assert.throws(() => assertBackupSize(0), /empty/i);
  assert.throws(() => assertBackupSize(-1), /empty/i);
});

test('the import size check runs before reading or parsing the archive', async () => {
  await seedVault();
  let reads = 0;
  const oversized = {
    size: MAX_BACKUP_BYTES + 1,
    text: async () => {
      reads += 1;
      return '{}';
    },
  } as unknown as Blob;
  await assert.rejects(() => vaultExportService.importEncrypted(oversized, BACKUP_PASS), /200 MB/i);
  assert.equal(reads, 0);

  const atLimit = {
    size: MAX_BACKUP_BYTES,
    text: async () => {
      reads += 1;
      return '{}';
    },
  } as unknown as Blob;
  await assert.rejects(() => vaultExportService.importEncrypted(atLimit, BACKUP_PASS), /not valid JSON|supported/i);
  assert.equal(reads, 1, 'an archive exactly at the limit must reach parsing');
});

test('quota failure during document upload removes the partial document', async () => {
  await seedVault();
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patched(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === 'documentFiles') throw new DOMException('Quota exceeded', 'QuotaExceededError');
    return originalPut.call(this, value as never, key as never);
  } as typeof IDBObjectStore.prototype.put;
  try {
    await assert.rejects(
      () => documentService.importDocument({ file: new File(['quota document'], 'quota.txt', { type: 'text/plain' }) }),
      /storage|quota/i,
    );
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.equal((await documentRepository.list()).length, 0, 'document metadata must be rolled back');
  const db = await getDb();
  assert.equal((await db.getAll('documentFiles')).length, 0, 'partial encrypted file must be rolled back');
});

test('quota failure during backup import aborts the whole transaction', async () => {
  await seedVault('Quota source');
  await addDocument('quota backup content', 'quota-backup.txt');
  const backup = await vaultExportService.exportEncrypted(BACKUP_PASS);

  await vaultManager.lock();
  await seedVault('Quota empty target');
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patched(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === 'documents') throw new DOMException('Quota exceeded', 'QuotaExceededError');
    return originalPut.call(this, value as never, key as never);
  } as typeof IDBObjectStore.prototype.put;
  try {
    await assert.rejects(() => vaultExportService.importEncrypted(backup, BACKUP_PASS), /storage|quota/i);
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.equal((await documentRepository.list()).length, 0);
  assert.equal((await collectionRepository.list()).length, 0);
  const profile = await vaultRepository.getProfile();
  assert.equal(profile.email, '', 'profile write must be rolled back with the transaction');
});

test('a valid archive at exactly the 200 MB boundary is accepted', async () => {
  await seedVault('Boundary source');
  await addDocument('boundary content', 'boundary.txt');
  const backup = await vaultExportService.exportEncrypted(BACKUP_PASS);
  const bytes = await backup.arrayBuffer();

  await vaultManager.lock();
  await seedVault('Boundary target');
  const atLimit = {
    size: MAX_BACKUP_BYTES,
    text: async () => new TextDecoder().decode(bytes),
  } as unknown as Blob;
  const result = await vaultExportService.importEncrypted(atLimit, BACKUP_PASS);
  assert.equal(result.imported, true);
  assert.equal(result.documents, 1);
});
