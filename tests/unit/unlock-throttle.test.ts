import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { getDb, resetDatabaseForTests } = await import('../../core/database/database');
const { VaultManager, vaultManager, lockoutDelayMsForAttempts } = await import('../../core/vault/vault-manager');

const PASSPHRASE = 'throttle-test-passphrase-123';

await resetDatabaseForTests();
await vaultManager.create(PASSPHRASE);

test('lockout delay is progressive and capped', () => {
  assert.equal(lockoutDelayMsForAttempts(0), 0);
  assert.equal(lockoutDelayMsForAttempts(1), 0);
  assert.equal(lockoutDelayMsForAttempts(2), 0);
  assert.equal(lockoutDelayMsForAttempts(3), 1_000);
  assert.equal(lockoutDelayMsForAttempts(4), 2_000);
  assert.equal(lockoutDelayMsForAttempts(5), 4_000);
  assert.equal(lockoutDelayMsForAttempts(20), 60_000);
});

test('repeated failures survive a new manager instance and block the correct passphrase', async () => {
  await vaultManager.lock();
  await assert.rejects(() => vaultManager.unlock('wrong-passphrase-1'), /incorrect/i);
  await assert.rejects(() => vaultManager.unlock('wrong-passphrase-2'), /incorrect/i);
  await assert.rejects(() => vaultManager.unlock('wrong-passphrase-3'), /Too many failed unlock attempts/i);

  // A new manager represents a restarted service worker. The persisted state
  // must still block the correct passphrase until the deadline.
  const restarted = new VaultManager();
  await assert.rejects(() => restarted.unlock(PASSPHRASE), /Try again in/i);

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await restarted.unlock(PASSPHRASE);
  assert.equal(await vaultManager.status().then((status) => status.unlocked), true);
});

test('concurrent unlock attempts are serialized and cannot bypass the counter', async () => {
  await vaultManager.lock();
  const results = await Promise.allSettled([
    vaultManager.unlock('concurrent-wrong-1'),
    vaultManager.unlock('concurrent-wrong-2'),
    vaultManager.unlock('concurrent-wrong-3'),
  ]);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 3);
  await assert.rejects(() => vaultManager.unlock(PASSPHRASE), /Try again in/i);

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await vaultManager.unlock(PASSPHRASE);
});

test('corrupt throttling metadata fails open to a single normal attempt', async () => {
  await vaultManager.lock();
  const db = await getDb();
  await db.put('securityState', {
    id: 'unlock-throttle',
    failedAttempts: -1,
    lockedUntil: Number.NaN,
    updatedAt: 42 as unknown as string,
  });
  await assert.rejects(() => vaultManager.unlock('after-corruption-wrong'), /incorrect/i);
  await vaultManager.unlock(PASSPHRASE);
});

test('a future lockout deadline is enforced even if the clock moved backwards', async () => {
  await vaultManager.lock();
  const db = await getDb();
  const future = Date.now() + 30_000;
  await db.put('securityState', {
    id: 'unlock-throttle',
    failedAttempts: 4,
    lockedUntil: future,
    updatedAt: new Date().toISOString(),
  });
  await assert.rejects(() => vaultManager.unlock(PASSPHRASE), /Try again in/i);
  await db.put('securityState', {
    id: 'unlock-throttle',
    failedAttempts: 4,
    lockedUntil: 0,
    updatedAt: new Date().toISOString(),
  });
  await vaultManager.unlock(PASSPHRASE);
});
