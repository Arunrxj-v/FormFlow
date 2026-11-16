import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { resetDatabaseForTests, getDb } = await import('../../core/database/database');
const { vaultManager } = await import('../../core/vault/vault-manager');
const { vaultRepository: vaultRecordRepository } = await import('../../core/database/vault-repository');
const { documentRepository } = await import('../../core/database/repositories');
const { vaultExportService } = await import('../../core/storage/vault-export');
const { sha256Hex } = await import('../../core/encryption/crypto-service');

const SOURCE_PASS = 'restore-source-passphrase';
const TARGET_PASS = 'restore-target-passphrase';
const BACKUP_PASS = 'restore-backup-passphrase';

async function seedVault(name: string): Promise<string> {
  await resetDatabaseForTests();
  await vaultManager.create(name === 'source' ? SOURCE_PASS : TARGET_PASS);
  const vault = await vaultRecordRepository.create(name);
  return vault.id;
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

async function makeBackup(): Promise<Blob> {
  return vaultExportService.exportEncrypted(BACKUP_PASS);
}

async function prepareTarget(): Promise<string> {
  await vaultManager.lock();
  return seedVault('target');
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a valid restore completes the journal and exports v3 afterwards', async () => {
  await seedVault('source');
  await addDocument('restore source document', 'restore-source.txt');
  const backup = await makeBackup();
  const targetId = await prepareTarget();

  const result = await vaultExportService.importEncrypted(backup, BACKUP_PASS);
  assert.equal(result.imported, true);
  assert.equal(result.documents, 1);
  const journal = await vaultExportService.restoreStatus();
  assert.equal(journal?.status, 'complete');
  assert.equal(journal?.targetVaultId, targetId);
  const db = await getDb();
  const activation = await db.get('settings', 'vaultRestoreActivation');
  assert.equal((activation?.value as { restoreId: string }).restoreId, journal?.restoreId);

  const reexport = await vaultExportService.exportEncrypted(BACKUP_PASS);
  const envelope = JSON.parse(await reexport.text());
  assert.equal(envelope.version, 3);
  assert.equal(envelope.header.backupFormat, 3);
});

test('a malformed restore preserves the target and records a failed journal', async () => {
  await seedVault('source');
  await addDocument('restore source document', 'restore-source.txt');
  const backup = await makeBackup();
  await prepareTarget();

  const envelope = JSON.parse(await backup.text());
  const bytes = Buffer.from(envelope.payload, 'base64');
  bytes[0] ^= 1;
  const bad = new Blob([JSON.stringify({ ...envelope, payload: bytes.toString('base64') })]);
  await assert.rejects(() => vaultExportService.importEncrypted(bad, BACKUP_PASS));
  assert.equal((await documentRepository.list()).length, 0);
  const journal = await vaultExportService.restoreStatus();
  assert.equal(journal?.status, 'failed');
  assert.equal(journal?.counts.documents, 0);
});

test('an incomplete ready journal on an empty target is safely discarded', async () => {
  const targetId = await prepareTarget();
  const db = await getDb();
  const now = new Date().toISOString();
  await db.put('settings', {
    key: 'vaultRestoreJournal',
    value: {
      restoreId: 'restore_interrupted',
      status: 'ready',
      targetVaultId: targetId,
      archiveVersion: 3,
      startedAt: now,
      updatedAt: now,
      counts: { documents: 1, values: 0, collections: 0 },
    },
    updatedAt: now,
  });
  const recovered = await vaultExportService.recoverInterruptedRestore();
  assert.equal(recovered?.status, 'failed');
  assert.equal((await documentRepository.list()).length, 0);
});

test('recovery trusts activation and actual counts after a completed activation', async () => {
  const targetId = await prepareTarget();
  await addDocument('already activated', 'activated.txt');
  const db = await getDb();
  const now = new Date().toISOString();
  const restoreId = 'restore_activated';
  await db.put('settings', {
    key: 'vaultRestoreJournal',
    value: {
      restoreId,
      status: 'ready',
      targetVaultId: targetId,
      archiveVersion: 3,
      startedAt: now,
      updatedAt: now,
      counts: { documents: 1, values: 0, collections: 0 },
    },
    updatedAt: now,
  });
  await db.put('settings', {
    key: 'vaultRestoreActivation',
    value: {
      restoreId,
      targetVaultId: targetId,
      completedAt: now,
      counts: { documents: 1, values: 0, collections: 0 },
    },
    updatedAt: now,
  });
  const recovered = await vaultExportService.recoverInterruptedRestore();
  assert.equal(recovered?.status, 'complete');
});

test('concurrent target modification aborts activation without importing the archive', async () => {
  await seedVault('source');
  await addDocument('archive document', 'archive.txt');
  const backup = await makeBackup();
  await prepareTarget();

  let modified = false;
  await assert.rejects(
    () => vaultExportService.importEncrypted(backup, BACKUP_PASS, {
      beforeActivation: async () => {
        modified = true;
        await addDocument('concurrent document', 'concurrent.txt');
      },
    }),
    /target vault changed|not activated/i,
  );
  assert.equal(modified, true);
  const documents = await documentRepository.list();
  assert.equal(documents.length, 1);
  assert.equal(documents[0]?.name, 'concurrent.txt');
  const journal = await vaultExportService.restoreStatus();
  assert.equal(journal?.status, 'failed');
});

test('duplicate restore requests are serialized and rejected', async () => {
  await seedVault('source');
  await addDocument('archive document', 'archive.txt');
  const backup = await makeBackup();
  await prepareTarget();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = vaultExportService.importEncrypted(backup, BACKUP_PASS, {
    beforeActivation: () => gate,
  });
  await wait(200);
  await assert.rejects(
    () => vaultExportService.importEncrypted(backup, BACKUP_PASS),
    /already in progress/i,
  );
  release();
  const result = await first;
  assert.equal(result.imported, true);
  assert.equal((await documentRepository.list()).length, 1);
});
