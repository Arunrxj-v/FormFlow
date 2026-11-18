import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { resetDatabaseForTests } = await import('../../core/database/database');
const { vaultManager } = await import('../../core/vault/vault-manager');
const { vaultRepository: vaultRecordRepository } = await import('../../core/database/vault-repository');
const { vaultRepository } = await import('../../core/database/repositories');
const { vaultExportService } = await import('../../core/storage/vault-export');
const { validateBackupPassphrase } = await import('../../core/encryption/crypto-service');

const VAULT_PASS = 'backup-policy-vault-passphrase';
const STRONG_BACKUP_PASS = 'new-backup-passphrase-123';

await resetDatabaseForTests();
await vaultManager.create(VAULT_PASS);
await vaultRecordRepository.create('Backup policy vault');
await vaultRepository.saveProfile({ name: 'Backup Policy User', email: 'policy@example.com' });

test('new backup passphrase policy uses a length-based minimum', () => {
  assert.equal(validateBackupPassphrase('').ok, false);
  assert.equal(validateBackupPassphrase('short').ok, false);
  assert.equal(validateBackupPassphrase('12345678901').ok, false);
  assert.equal(validateBackupPassphrase('123456789012').ok, true);
  assert.equal(validateBackupPassphrase('correct horse battery staple').ok, true);
  assert.equal(validateBackupPassphrase('🔐'.repeat(12)).ok, true, 'Unicode code points are counted, not UTF-16 units');
  assert.equal(validateBackupPassphrase('x'.repeat(201)).ok, false);
  assert.equal(validateBackupPassphrase('   ').ok, false);
});

test('export rejects a short new-backup passphrase and accepts a long Unicode one', async () => {
  await assert.rejects(
    () => vaultExportService.exportEncrypted('12345678'),
    /at least 12 characters/i,
  );
  const blob = await vaultExportService.exportEncrypted('🔐'.repeat(12));
  assert.ok(blob.size > 0);
  const text = await blob.text();
  assert.ok(!text.includes('🔐'));
});

test('restore does not apply the new export policy to archive passphrases', async () => {
  const blob = await vaultExportService.exportEncrypted(STRONG_BACKUP_PASS);
  await vaultManager.destroyVault();
  await vaultManager.create('restore-target-vault-passphrase');
  await vaultRecordRepository.create('Restore target');
  await assert.rejects(
    () => vaultExportService.importEncrypted(blob, '12345678'),
    /incorrect|corrupted|authenticated/i,
  );
  const imported = await vaultExportService.importEncrypted(blob, STRONG_BACKUP_PASS);
  assert.equal(imported.imported, true);
});
