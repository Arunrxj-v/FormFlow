import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { getDb, resetDatabaseForTests } from '../../core/database/database';
import { TRUSTED_MODEL_MANIFESTS } from '../../ai/runtime/model-manifest';
import type { ModelManifest } from '../../ai/runtime/model-manifest';
import {
  defaultLifecycleState,
  getRollbackStatus,
  readLifecycleState,
  recoverLifecycle,
  runRollback,
  runUpgrade,
  writeLifecycleState,
  type LifecycleResult,
  type LifecycleSteps,
} from '../../ai/runtime/model-lifecycle';

const baseline = TRUSTED_MODEL_MANIFESTS[0]!;
const target = JSON.parse(JSON.stringify({
  ...baseline,
  version: '0.7.0-int8-r1',
  revision: 'b'.repeat(40),
  releaseId: 'qwen3-0.6b-int8-2026-12',
})) as ModelManifest;

interface StepBehavior {
  installError?: Error;
  verified?: boolean;
  selfTestOk?: boolean;
  promoteError?: Error;
  promoteFlipsActiveBeforeThrow?: boolean;
  verifyPreviousOk?: boolean;
}

const events: string[] = [];

function steps(behavior: StepBehavior = {}): LifecycleSteps {
  return {
    installTarget: async (_manifest, onPhase, signal) => {
      events.push('install');
      onPhase('downloading');
      if (signal.aborted) throw new Error('cancelled');
      if (behavior.installError) throw behavior.installError;
    },
    verifyTarget: async () => {
      events.push('verify');
      return behavior.verified ?? true;
    },
    selfTest: async () => {
      events.push('selftest');
      return behavior.selfTestOk ?? true;
    },
    promote: async () => {
      events.push('promote');
      if (behavior.promoteFlipsActiveBeforeThrow) {
        await writeLifecycleState(await getDb(), { activeReleaseId: target.releaseId });
        throw behavior.promoteError ?? new Error('promote failed');
      }
      if (behavior.promoteError) throw behavior.promoteError;
    },
    cleanupStaged: async () => { events.push('cleanup'); },
    verifyPrevious: async () => behavior.verifyPreviousOk ?? true,
  };
}

async function freshUpgrade(behavior: StepBehavior = {}): Promise<LifecycleResult> {
  const db = await getDb();
  return runUpgrade({
    db,
    current: baseline,
    target,
    storageAvailableBytes: target.minStorageBytes + 1,
    steps: steps(behavior),
    signal: new AbortController().signal,
  });
}

test.beforeEach(async () => {
  events.length = 0;
  await resetDatabaseForTests();
  const db = await getDb();
  await db.put('modelLifecycle', { ...defaultLifecycleState(), activeReleaseId: baseline.releaseId, status: 'idle', phase: 'idle' });
});

test('a healthy upgrade stages, verifies, self-tests, then atomically promotes', async () => {
  const result = await freshUpgrade();
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['install', 'verify', 'selftest', 'promote']);
  const state = await readLifecycleState(await getDb());
  assert.equal(state.activeReleaseId, target.releaseId);
  assert.equal(state.previousReleaseId, baseline.releaseId);
  assert.equal(state.status, 'completed');
  assert.equal(state.phase, 'completed');
  assert.ok(state.switchedAt);
});

test('install failure keeps the previous release active and cleans staging', async () => {
  const result = await freshUpgrade({ installError: new Error('network dropped') });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /network dropped/);
  const state = await readLifecycleState(await getDb());
  assert.equal(state.activeReleaseId, baseline.releaseId, 'previous release must remain active');
  assert.equal(state.status, 'failed');
  assert.equal(state.phase, 'failed');
  assert.ok(events.includes('cleanup'));
  assert.ok(!events.includes('promote'));
});

test('verification and self-test failures never promote', async () => {
  for (const behavior of [{ verified: false }, { selfTestOk: false }]) {
    events.length = 0;
    await writeLifecycleState(await getDb(), { status: 'idle', phase: 'idle' });
    const result = await freshUpgrade(behavior);
    assert.equal(result.ok, false);
    const state = await readLifecycleState(await getDb());
    assert.equal(state.activeReleaseId, baseline.releaseId);
    assert.ok(!events.includes('promote'));
  }
});

test('a failure during promotion rolls back to the known-good release', async () => {
  const result = await freshUpgrade({ promoteFlipsActiveBeforeThrow: true });
  assert.equal(result.ok, true, 'rollback itself must succeed');
  const state = await readLifecycleState(await getDb());
  assert.equal(state.activeReleaseId, baseline.releaseId);
  assert.equal(state.previousReleaseId, null);
  assert.equal(state.status, 'rolled_back');
  assert.match(state.failureReason ?? '', /promote failed/);
});

test('cancellation during staging keeps the previous release active', async () => {
  const db = await getDb();
  const controller = new AbortController();
  controller.abort();
  const result = await runUpgrade({
    db,
    current: baseline,
    target,
    storageAvailableBytes: target.minStorageBytes,
    steps: steps(),
    signal: controller.signal,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /cancel/i);
  assert.equal((await readLifecycleState(await getDb())).activeReleaseId, baseline.releaseId);
});

test('insufficient storage and untrusted/incompatible targets are rejected before journaling', async () => {
  const db = await getDb();
  const noSpace = await runUpgrade({
    db, current: baseline, target,
    storageAvailableBytes: 1,
    steps: steps(), signal: new AbortController().signal,
  });
  assert.equal(noSpace.ok, false);
  assert.match(noSpace.reason ?? '', /free storage/i);

  const zeroAvailable = await runUpgrade({
    db, current: baseline, target,
    storageAvailableBytes: 0, storageQuotaBytes: target.minStorageBytes,
    steps: steps(), signal: new AbortController().signal,
  });
  assert.equal(zeroAvailable.ok, false, 'zero available bytes with a known quota must block the upgrade');

  const untrusted = await runUpgrade({
    db, current: baseline, target: { ...target, trusted: false },
    storageAvailableBytes: target.minStorageBytes, steps: steps(), signal: new AbortController().signal,
  });
  assert.equal(untrusted.ok, false);
  assert.match(untrusted.reason ?? '', /untrusted/i);

  const older = await runUpgrade({
    db, current: baseline, target: { ...baseline },
    storageAvailableBytes: target.minStorageBytes, steps: steps(), signal: new AbortController().signal,
  });
  assert.equal(older.ok, false);
  assert.match(older.reason ?? '', /not a compatible/i);

  assert.deepEqual(events, [], 'no staging work should have started');
});

test('rollback with no retained release fails safely', async () => {
  const result = await runRollback({ db: await getDb(), reason: 'manual', steps: steps() });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /No previous model/i);
});

test('recovery discards an upgrade interrupted before promotion', async () => {
  const db = await getDb();
  await writeLifecycleState(db, {
    operation: 'upgrade', status: 'in_progress', phase: 'downloading',
    targetReleaseId: target.releaseId, activeReleaseId: baseline.releaseId,
  });
  const result = await recoverLifecycle({
    db,
    steps: steps(),
    resolveManifest: () => target,
    verifyActive: async () => true,
  });
  assert.equal(result.ok, false);
  const state = await readLifecycleState(db);
  assert.equal(state.activeReleaseId, baseline.releaseId);
  assert.equal(state.status, 'failed');
  assert.ok(events.includes('cleanup'));
});

test('recovery rolls back an unhealthy release interrupted during promotion', async () => {
  const db = await getDb();
  await writeLifecycleState(db, {
    operation: 'upgrade', status: 'in_progress', phase: 'switching',
    targetReleaseId: target.releaseId, activeReleaseId: target.releaseId,
    previousReleaseId: baseline.releaseId,
  });
  const result = await recoverLifecycle({
    db, steps: steps({ verifyPreviousOk: true }),
    resolveManifest: () => target,
    verifyActive: async () => false,
  });
  assert.equal(result.ok, true);
  const state = await readLifecycleState(db);
  assert.equal(state.activeReleaseId, baseline.releaseId);
  assert.equal(state.status, 'rolled_back');
});

test('recovery finalizes a healthy release interrupted during promotion', async () => {
  const db = await getDb();
  await writeLifecycleState(db, {
    operation: 'upgrade', status: 'in_progress', phase: 'switching',
    targetReleaseId: target.releaseId, activeReleaseId: target.releaseId,
    previousReleaseId: baseline.releaseId,
  });
  const result = await recoverLifecycle({
    db, steps: steps(), resolveManifest: () => target, verifyActive: async () => true,
  });
  assert.equal(result.ok, true);
  const state = await readLifecycleState(db);
  assert.equal(state.activeReleaseId, target.releaseId);
  assert.equal(state.status, 'completed');
  assert.equal(state.operation, null);
});

test('rollback status exposes the retained release', async () => {
  await freshUpgrade();
  const status = await getRollbackStatus(await getDb());
  assert.equal(status.available, true);
  assert.equal(status.previousReleaseId, baseline.releaseId);
});
