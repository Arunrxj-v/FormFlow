/**
 * Journaled, versioned model lifecycle: safe upgrade, rollback and recovery.
 *
 * The active model is never replaced in place. A new release is downloaded and
 * verified into its own (revision-keyed) cache location, self-tested, and only
 * then atomically promoted by flipping the `modelLifecycle` journal record.
 * The previous release is retained until it is explicitly pruned, so any
 * failure before or after promotion can roll back to the last known-good model.
 *
 * All external effects are injected through `LifecycleSteps`, which keeps the
 * state machine deterministic and fully testable with fixtures — no second
 * (unverified) model is downloaded to prove the mechanism works.
 */
import type { IDBPDatabase } from 'idb';
import { MODEL_LIFECYCLE_ID } from '@shared/constants';
import type {
  FormFlowDB,
} from '../../core/database/schema';
import type {
  ModelLifecyclePhase,
  ModelLifecycleState,
  ModelRollbackStatus,
} from '@shared/types';
import {
  isUpgradeCompatible,
  type ModelManifest,
} from './model-manifest';

type DB = IDBPDatabase<FormFlowDB>;

export interface LifecycleSteps {
  /** Download and stage the target into its own revision-keyed location. */
  installTarget(manifest: ModelManifest, onPhase: (phase: ModelLifecyclePhase) => void, signal: AbortSignal): Promise<void>;
  /** Verify every staged file of the target against its manifest. */
  verifyTarget(manifest: ModelManifest): Promise<boolean>;
  /** Initialize the target and run a real inference self-test. */
  selfTest(manifest: ModelManifest): Promise<boolean>;
  /** Atomically promote verified staged files into the active location. */
  promote(manifest: ModelManifest): Promise<void>;
  /** Delete staged/temporary files for a release id. */
  cleanupStaged(releaseId: string): Promise<void>;
  /** Optionally confirm the retained previous release is still healthy. */
  verifyPrevious?(releaseId: string): Promise<boolean>;
  /** Delete obsolete files of a superseded release. Only called explicitly. */
  pruneObsolete?(releaseId: string): Promise<void>;
}

export interface LifecycleResult {
  ok: boolean;
  reason?: string;
  state: ModelLifecycleState;
}

export function defaultLifecycleState(): ModelLifecycleState {
  return {
    id: MODEL_LIFECYCLE_ID,
    activeReleaseId: null,
    previousReleaseId: null,
    operation: null,
    phase: 'idle',
    status: 'idle',
    targetReleaseId: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function readLifecycleState(db: DB): Promise<ModelLifecycleState> {
  const stored = await db.get('modelLifecycle', MODEL_LIFECYCLE_ID);
  return stored ? { ...defaultLifecycleState(), ...stored } : defaultLifecycleState();
}

export async function writeLifecycleState(db: DB, patch: Partial<ModelLifecycleState>): Promise<ModelLifecycleState> {
  const current = await readLifecycleState(db);
  const next: ModelLifecycleState = { ...current, ...patch, id: MODEL_LIFECYCLE_ID, updatedAt: new Date().toISOString() };
  await db.put('modelLifecycle', next);
  return next;
}

function failureReason(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Upgrade to a trusted, compatible release. Returns `ok: false` (and never
 * touches the active release) when validation, storage, verification or the
 * self-test fails. A failure during/after promotion triggers an automatic
 * rollback to the retained previous release.
 */
export async function runUpgrade(params: {
  db: DB;
  current: ModelManifest | null;
  target: ModelManifest;
  storageAvailableBytes: number;
  /** Known quota; when provided, zero available bytes is a real constraint. */
  storageQuotaBytes?: number;
  steps: LifecycleSteps;
  signal: AbortSignal;
}): Promise<LifecycleResult> {
  const { db, current, target, storageAvailableBytes, storageQuotaBytes, steps, signal } = params;

  if (target.trusted !== true) {
    return { ok: false, reason: 'Refusing to upgrade from an untrusted manifest.', state: await readLifecycleState(db) };
  }
  if (current && !isUpgradeCompatible(current, target)) {
    return { ok: false, reason: 'The target release is not a compatible upgrade.', state: await readLifecycleState(db) };
  }
  const quotaKnown = storageQuotaBytes !== undefined ? storageQuotaBytes > 0 : storageAvailableBytes > 0;
  if (quotaKnown && storageAvailableBytes < target.minStorageBytes) {
    const needed = Math.ceil(target.minStorageBytes / (1024 * 1024));
    return {
      ok: false,
      reason: `At least ${needed} MB of free storage is required to stage and verify the model upgrade.`,
      state: await readLifecycleState(db),
    };
  }

  await writeLifecycleState(db, {
    operation: 'upgrade',
    status: 'in_progress',
    phase: 'checking',
    targetReleaseId: target.releaseId,
    targetVersion: target.version,
    targetRevision: target.revision,
    manifestVersion: target.schemaVersion,
    failureReason: undefined,
    startedAt: new Date().toISOString(),
  });

  const markFailure = async (reason: string): Promise<LifecycleResult> => {
    const state = await writeLifecycleState(db, { status: 'failed', phase: 'failed', failureReason: reason });
    await steps.cleanupStaged(target.releaseId).catch(() => undefined);
    return { ok: false, reason, state };
  };

  try {
    if (signal.aborted) return markFailure('Model upgrade was cancelled.');
    await steps.installTarget(target, (phase) => {
      void writeLifecycleState(db, { phase }).catch(() => undefined);
    }, signal);
    if (signal.aborted) return markFailure('Model upgrade was cancelled.');

    await writeLifecycleState(db, { phase: 'verifying' });
    const verified = await steps.verifyTarget(target);
    if (!verified) return markFailure('The staged model failed file integrity verification.');

    await writeLifecycleState(db, { phase: 'self_testing' });
    const healthy = await steps.selfTest(target);
    if (!healthy) return markFailure('The staged model failed its inference self-test.');

    // Journal the switch before the irreversible file promotion, then flip the
    // active release atomically once promotion succeeds.
    await writeLifecycleState(db, {
      phase: 'switching',
      previousReleaseId: current?.releaseId ?? null,
    });
    await steps.promote(target);
    await writeLifecycleState(db, {
      activeReleaseId: target.releaseId,
      status: 'completed',
      phase: 'completed',
      switchedAt: new Date().toISOString(),
      failureReason: undefined,
    });
    const state = await readLifecycleState(db);
    return { ok: true, state };
  } catch (error) {
    // A throw during promotion may have already flipped activeReleaseId. If so,
    // roll back rather than leaving a possibly half-activated release active.
    const state = await readLifecycleState(db);
    if (state.activeReleaseId === target.releaseId && state.previousReleaseId) {
      return runRollback({ db, reason: failureReason(error, 'The model upgrade was interrupted during activation.'), steps });
    }
    return markFailure(failureReason(error, 'The model upgrade failed.'));
  }
}

/** Roll back to the last known-good release retained by a prior upgrade. */
export async function runRollback(params: {
  db: DB;
  reason: string;
  steps: LifecycleSteps;
}): Promise<LifecycleResult> {
  const { db, reason, steps } = params;
  const state = await readLifecycleState(db);
  if (!state.previousReleaseId) {
    const failed = await writeLifecycleState(db, {
      operation: 'rollback',
      status: 'failed',
      phase: 'failed',
      failureReason: `${reason} No previous model is available to roll back to.`,
    });
    return { ok: false, reason: failed.failureReason, state: failed };
  }

  await writeLifecycleState(db, {
    operation: 'rollback',
    status: 'in_progress',
    phase: 'switching',
    failureReason: reason,
  });

  // If a verifier is available, confirm the rollback target is still healthy.
  if (steps.verifyPrevious) {
    const healthy = await steps.verifyPrevious(state.previousReleaseId).catch(() => false);
    if (!healthy) {
      const failed = await writeLifecycleState(db, {
        status: 'failed',
        phase: 'failed',
        failureReason: `${reason} The previous model also failed verification. Manual reinstall may be required.`,
      });
      return { ok: false, reason: failed.failureReason, state: failed };
    }
  }

  const restored = await writeLifecycleState(db, {
    activeReleaseId: state.previousReleaseId,
    previousReleaseId: null,
    targetReleaseId: null,
    status: 'rolled_back',
    phase: 'rolled_back',
    lastRollbackAt: new Date().toISOString(),
  });
  if (state.targetReleaseId) {
    await steps.cleanupStaged(state.targetReleaseId).catch(() => undefined);
  }
  return { ok: true, state: restored };
}

/**
 * Startup recovery. An upgrade interrupted before promotion is discarded and
 * reported as failed (the previous model was never touched). An interruption
 * during/after promotion is re-verified: a healthy target is finalized, an
 * unhealthy one is rolled back to the retained previous release.
 */
export async function recoverLifecycle(params: {
  db: DB;
  steps: LifecycleSteps;
  resolveManifest: (releaseId: string) => ModelManifest | null;
  verifyActive: (releaseId: string) => Promise<boolean>;
}): Promise<LifecycleResult> {
  const { db, steps, resolveManifest, verifyActive } = params;
  const state = await readLifecycleState(db);
  if (state.status !== 'in_progress') return { ok: true, state };

  const prePromotion = new Set<ModelLifecyclePhase>(['checking', 'downloading', 'verifying', 'self_testing']);
  if (prePromotion.has(state.phase) || state.activeReleaseId !== state.targetReleaseId) {
    if (state.targetReleaseId) await steps.cleanupStaged(state.targetReleaseId).catch(() => undefined);
    const failed = await writeLifecycleState(db, {
      status: 'failed',
      phase: 'failed',
      failureReason: 'A previous model upgrade was interrupted before activation and was discarded.',
      targetReleaseId: null,
    });
    return { ok: false, reason: failed.failureReason, state: failed };
  }

  // Promotion had begun. Confirm the newly active release is actually healthy.
  const activeId = state.activeReleaseId;
  const healthy = activeId ? await verifyActive(activeId).catch(() => false) : false;
  if (healthy) {
    const finalized = await writeLifecycleState(db, {
      status: 'completed',
      phase: 'completed',
      operation: null,
      targetReleaseId: null,
      failureReason: undefined,
    });
    return { ok: true, state: finalized };
  }
  return runRollback({ db, reason: 'The browser restarted during model activation and the new release could not be verified.', steps });
}

export async function getRollbackStatus(db: DB): Promise<ModelRollbackStatus> {
  const state = await readLifecycleState(db);
  return {
    available: Boolean(state.previousReleaseId),
    previousReleaseId: state.previousReleaseId,
    ...(state.lastRollbackAt ? { lastRollbackAt: state.lastRollbackAt } : {}),
    ...(state.failureReason ? { lastReason: state.failureReason } : {}),
  };
}

/** Prune superseded release files after the active release is confirmed healthy. */
export async function prunePrevious(db: DB, steps: LifecycleSteps): Promise<boolean> {
  const state = await readLifecycleState(db);
  if (!state.previousReleaseId || !steps.pruneObsolete) return false;
  await steps.pruneObsolete(state.previousReleaseId);
  await writeLifecycleState(db, { previousReleaseId: null });
  return true;
}
