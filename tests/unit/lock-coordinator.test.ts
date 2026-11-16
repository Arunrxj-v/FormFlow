import test from 'node:test';
import assert from 'node:assert/strict';

const { VaultOperationCoordinator } = await import('../../core/vault/operation-coordinator');

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('lock waits for in-flight mutations and rejects new operations', async () => {
  const coordinator = new VaultOperationCoordinator({ lockTimeoutMs: 5_000 });
  await coordinator.unlock(async () => undefined);
  const gate = deferred();
  let mutationFinished = false;
  let lockFinished = false;

  const mutation = coordinator.run('mutation', 'upload', async () => {
    await gate.promise;
    mutationFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const lock = coordinator.lock(async () => undefined).then(() => {
    lockFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(coordinator.getState(), 'locking');
  assert.equal(lockFinished, false, 'lock must wait for the mutation');
  await assert.rejects(() => coordinator.run('mutation', 'late', async () => undefined), /locked/i);
  await assert.rejects(() => coordinator.run('read', 'late-read', async () => undefined), /locked/i);

  gate.resolve();
  await mutation;
  await lock;
  assert.equal(mutationFinished, true);
  assert.equal(lockFinished, true);
  assert.equal(coordinator.getState(), 'locked');
  await assert.rejects(() => coordinator.run('read', 'after', async () => undefined), /locked/i);
});

test('multiple simultaneous lock requests are serialized and idempotent', async () => {
  const coordinator = new VaultOperationCoordinator({ lockTimeoutMs: 5_000 });
  await coordinator.unlock(async () => undefined);
  let lockCalls = 0;
  const first = coordinator.lock(async () => {
    lockCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const second = coordinator.lock(async () => {
    lockCalls += 1;
  });
  await Promise.all([first, second]);
  assert.equal(lockCalls, 1);
  assert.equal(coordinator.getState(), 'locked');
  await coordinator.lock(async () => {
    lockCalls += 1;
  });
  assert.equal(lockCalls, 1, 'lock while already locked is a no-op');
});

test('unlock during locking is rejected', async () => {
  const coordinator = new VaultOperationCoordinator({ lockTimeoutMs: 5_000 });
  await coordinator.unlock(async () => undefined);
  const gate = deferred();
  const mutation = coordinator.run('mutation', 'delete', () => gate.promise);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const lock = coordinator.lock(async () => undefined);
  await assert.rejects(() => coordinator.unlock(async () => undefined), /locking|finish/i);
  gate.resolve();
  await mutation;
  await lock;
  assert.equal(coordinator.getState(), 'locked');
});

test('lock timeout fails closed without reporting locked', async () => {
  const coordinator = new VaultOperationCoordinator({ lockTimeoutMs: 20 });
  await coordinator.unlock(async () => undefined);
  const gate = deferred();
  const mutation = coordinator.run('mutation', 'stuck', () => gate.promise);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(() => coordinator.lock(async () => undefined), /could not lock|still running/i);
  assert.equal(coordinator.getState(), 'unlocked', 'a failed lock must not report locked');
  assert.equal(await coordinator.run('read', 'still-unlocked', async () => 42), 42);
  gate.resolve();
  await mutation;
});

test('a failed lock function restores the unlocked state and the key-clearing failure is visible', async () => {
  const coordinator = new VaultOperationCoordinator({ lockTimeoutMs: 5_000 });
  await coordinator.unlock(async () => undefined);
  await assert.rejects(() => coordinator.lock(async () => {
    throw new Error('storage failure');
  }), /storage failure/);
  assert.equal(coordinator.getState(), 'unlocked');
  assert.equal(await coordinator.run('mutation', 'retry', async () => 'ok'), 'ok');
});

test('concurrent mutations drain in any order before lock completes', async () => {
  const coordinator = new VaultOperationCoordinator({ lockTimeoutMs: 5_000 });
  await coordinator.unlock(async () => undefined);
  const gates = [deferred(), deferred(), deferred()];
  const mutations = gates.map((gate, index) => coordinator.run('mutation', `m${index}`, () => gate.promise));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const lock = coordinator.lock(async () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  gates[1]!.resolve();
  gates[2]!.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(coordinator.getState(), 'locking');
  gates[0]!.resolve();
  await Promise.all(mutations);
  await lock;
  assert.equal(coordinator.getState(), 'locked');
});
