import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { resetDatabaseForTests, getDb } = await import('../../core/database/database');
const { vaultManager } = await import('../../core/vault/vault-manager');
const { vaultRepository: vaultRecordRepository } = await import('../../core/database/vault-repository');
const { encryptionV2Migration } = await import('../../core/vault/encryption-v2-migration');
const { checkVaultIntegrity } = await import('../../core/vault/vault-integrity');
const { decryptJsonWithKey } = await import('../../core/encryption/crypto-service');

const PASSPHRASE = 'vault-name-passphrase-2026';

test('new vault display names are encrypted at rest and decrypt for the UI', async () => {
  await resetDatabaseForTests();
  await vaultManager.create(PASSPHRASE);
  const created = await vaultRecordRepository.create('Private applications 2026');
  assert.equal(created.name, 'Private applications 2026');
  assert.match(created.nameEnc ?? '', /"v":2/);
  const db = await getDb();
  const row = await db.get('vaults', created.id);
  assert.ok(row);
  assert.equal(row.name, '');
  assert.equal(JSON.stringify(row).includes('Private applications 2026'), false);
  const loaded = await vaultRecordRepository.getActive();
  assert.equal(loaded?.name, 'Private applications 2026');
  const integrity = await checkVaultIntegrity();
  assert.equal(integrity.ok, true, JSON.stringify(integrity.issues));
});

test('v2 migration encrypts a legacy plaintext vault name and verifies it', async () => {
  await resetDatabaseForTests();
  await vaultManager.create(PASSPHRASE);
  const created = await vaultRecordRepository.create('Legacy visible name');
  const db = await getDb();
  const raw = await db.get('vaults', created.id);
  assert.ok(raw);
  const plaintext = await decryptJsonWithKey<string>(
    await vaultManager.getDataKeyOrThrow(),
    raw.nameEnc!,
    { vaultId: raw.id, recordType: 'vault', recordId: raw.id, field: 'name', schemaVersion: raw.schemaVersion },
  );
  assert.equal(plaintext, 'Legacy visible name');
  await db.put('vaults', { ...raw, name: plaintext, nameEnc: undefined });
  const meta = await db.get('vaultMeta', 'meta');
  assert.ok(meta);
  await db.put('vaultMeta', { ...meta, encryptionFormat: 1 });

  const before = await checkVaultIntegrity();
  assert.ok(before.issues.some((issue) => issue.code === 'PLAINTEXT_VAULT_NAME'));
  assert.equal((await vaultRecordRepository.getActive())?.name, 'Legacy visible name');

  const migrated = await encryptionV2Migration.runIfNeeded();
  assert.equal(migrated.encryptionFormat, 2);
  const migratedRaw = await db.get('vaults', created.id);
  assert.equal(migratedRaw?.name, '');
  assert.match(migratedRaw?.nameEnc ?? '', /"v":2/);
  assert.equal((await vaultRecordRepository.getActive())?.name, 'Legacy visible name');
  const after = await checkVaultIntegrity();
  assert.equal(after.ok, true, JSON.stringify(after.issues));
});

test('a corrupted vault name fails closed', async () => {
  await resetDatabaseForTests();
  await vaultManager.create(PASSPHRASE);
  const created = await vaultRecordRepository.create('Corruption test');
  const db = await getDb();
  const row = await db.get('vaults', created.id);
  assert.ok(row?.nameEnc);
  const envelope = JSON.parse(row.nameEnc);
  const bytes = Buffer.from(envelope.data, 'base64');
  bytes[0] ^= 1;
  envelope.data = bytes.toString('base64');
  await db.put('vaults', { ...row, nameEnc: JSON.stringify(envelope) });
  await assert.rejects(() => vaultRecordRepository.getActive(), /authenticated|malformed/i);
  const integrity = await checkVaultIntegrity();
  assert.equal(integrity.ok, false);
  assert.ok(integrity.issues.some((issue) => issue.code === 'INVALID_CIPHERTEXT'));
});

test('an existing format-v2 vault without a name format is migrated on unlock', async () => {
  await resetDatabaseForTests();
  await vaultManager.create(PASSPHRASE);
  const created = await vaultRecordRepository.create('Format v2 plaintext name');
  const db = await getDb();
  const raw = await db.get('vaults', created.id);
  assert.ok(raw);
  const plaintext = await decryptJsonWithKey<string>(
    await vaultManager.getDataKeyOrThrow(),
    raw.nameEnc!,
    { vaultId: raw.id, recordType: 'vault', recordId: raw.id, field: 'name', schemaVersion: raw.schemaVersion },
  );
  await db.put('vaults', { ...raw, name: plaintext, nameEnc: undefined });
  const meta = await db.get('vaultMeta', 'meta');
  assert.ok(meta);
  await db.put('vaultMeta', { ...meta, encryptionFormat: 2, nameFormat: undefined });
  const status = await vaultManager.status();
  assert.equal(status.requiresEncryptionUpgrade, true);
  const migrationStatus = await encryptionV2Migration.status();
  assert.equal(migrationStatus.needsMigration, true);
  const migrated = await encryptionV2Migration.runIfNeeded();
  assert.equal(migrated.needsMigration, false);
  const row = await db.get('vaults', created.id);
  assert.match(row?.nameEnc ?? '', /"v":2/);
  assert.equal(row?.name, '');
  assert.equal((await vaultRecordRepository.getActive())?.name, 'Format v2 plaintext name');
});
