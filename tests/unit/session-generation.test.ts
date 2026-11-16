import test from 'node:test';
import assert from 'node:assert/strict';

const { VaultSession } = await import('../../core/vault/vault-session');
const { MemorySessionBackend } = await import('../../core/vault/session-backend');
const { generateDataKey } = await import('../../core/encryption/crypto-service');

test('session generation invalidates stale reads across lock and unlock', async () => {
  const session = new VaultSession(new MemorySessionBackend());
  const key = await generateDataKey();
  await session.unlockWithDataKey(key);
  const generation = session.getGeneration();
  assert.equal(session.isCurrent(generation), true);
  assert.equal(await session.isUnlocked(), true);

  const staleKey = await session.getDataKey();
  assert.ok(staleKey);
  await session.lock();
  assert.equal(session.isCurrent(generation), false);
  assert.equal(await session.isUnlocked(), false);
  await assert.rejects(() => session.getDataKey(), /locked/i);

  await session.unlockWithDataKey(key);
  assert.equal(session.isCurrent(generation), false);
  assert.equal(await session.isUnlocked(), true);
});

test('concurrent lock and unlock transitions serialize', async () => {
  const session = new VaultSession(new MemorySessionBackend());
  const key = await generateDataKey();
  await session.unlockWithDataKey(key);

  await Promise.all([session.unlockWithDataKey(key), session.lock()]);
  assert.equal(await session.isUnlocked(), false, 'queued lock must be the final state');
  await Promise.all([session.lock(), session.unlockWithDataKey(key)]);
  assert.equal(await session.isUnlocked(), true, 'queued unlock must be the final state');
});

test('a stale generation cannot be reused after a lock', async () => {
  const session = new VaultSession(new MemorySessionBackend());
  const key = await generateDataKey();
  await session.unlockWithDataKey(key);
  const generation = session.getGeneration();
  const readStarted = session.isCurrent(generation);
  await session.lock();
  assert.equal(readStarted, true);
  assert.equal(session.isCurrent(generation), false);
});
