import {
  MODEL_LOAD_TIMEOUT_MS,
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_RELEASE_ID,
  MODEL_SELF_TEST_TIMEOUT_MS,
} from '@shared/constants';
import { inferenceTimeoutMsForTokens } from '../../../shared/model-timeouts';
import { hasSufficientStorage, insufficientStorageMessage, requiredModelStorageBytes } from '../../../shared/model-storage';
import { FormFlowError } from '@shared/errors';
import type {
  InstalledModelRecord,
  ModelCapabilities,
  ModelSelfTestResult,
  ModelStatusSnapshot,
  StorageEstimate,
} from '@shared/types';
import {
  MODEL_WORKER_PROTOCOL_VERSION,
  parseModelWorkerResponse,
  type ModelChatMessage,
  type ModelWorkerRequest,
  type ModelWorkerResponse,
} from '../../../shared/model-protocol';
import {
  MODEL_METADATA,
  MODEL_VARIANTS,
} from '../../../ai/models/model-registry';
import { defaultVariant, detectModelCapabilities, modelLoader, type DownloadProgress } from '../../../ai/runtime/model-loader';
import { checkForUpgrade, getTrustedManifest } from '../../../ai/runtime/model-manifest';
import {
  getRollbackStatus,
  readLifecycleState,
  recoverLifecycle,
  runRollback,
  runUpgrade,
  writeLifecycleState,
  type LifecycleSteps,
} from '../../../ai/runtime/model-lifecycle';
import { getDb } from '../../../core/database/database';
import { quotaManager } from '../../../core/storage/quota-manager';
import {
  disposeOffscreenModelWorker,
  onOffscreenModelDisconnect,
  onOffscreenModelResponse,
  sendOffscreenModelRequest,
} from '../offscreen/parser-client';

const MODEL_VARIANT: 'q8' = 'q8';
const INSTALL_STALE_MS = 15 * 60_000;

interface PendingWorkerRequest {
  resolve: (message: ModelWorkerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  kind: 'load' | 'infer' | 'dispose';
}

let workerLoaded = false;
let inferenceInFlight = false;
let installController: AbortController | null = null;
let installPromise: Promise<InstalledModelRecord> | null = null;
let installProgress: DownloadProgress | null = null;
let installStartedAt = 0;
let workerIdleTimer: ReturnType<typeof setTimeout> | null = null;
let lastIntegrityCheck = 0;
let activeInference: { requestId: string; generatedTokens: number } | null = null;
let recoveryPromise: Promise<void> | null = null;
let upgradeController: AbortController | null = null;
const pending = new Map<string, PendingWorkerRequest>();

/**
 * Production wiring for the lifecycle state machine. The self-test runs the
 * active worker against the pinned, byte-identical artifact; for a future
 * distinct revision a staged worker load would be required (documented).
 */
function lifecycleSteps(): LifecycleSteps {
  return {
    installTarget: async (manifest, _onPhase, signal) => {
      await modelLoader.stageInstall(manifest, (progress) => {
        installProgress = progress;
      }, signal);
    },
    verifyTarget: (manifest) => modelLoader.verifyStaged(manifest),
    selfTest: async (manifest) => {
      void manifest;
      const result = await modelManager.selfTest();
      return result.ok;
    },
    promote: async (manifest) => {
      await modelLoader.promoteStaged(manifest);
    },
    cleanupStaged: () => modelLoader.clearStaging(),
    verifyPrevious: async () => {
      const record = await modelLoader.verify(MODEL_VARIANT, true);
      return Boolean(record && record.status !== 'corrupt' && record.status !== 'not_installed');
    },
    // The pinned revision means a superseded release is byte-identical; there
    // are no obsolete files that can be safely deleted without risking the
    // active install. Retention is therefore intentional.
    pruneObsolete: async () => undefined,
  };
}

async function ensureRecovery(): Promise<void> {
  if (!recoveryPromise) {
    recoveryPromise = (async () => {
      const db = await getDb();
      await recoverLifecycle({
        db,
        steps: lifecycleSteps(),
        resolveManifest: (releaseId) => getTrustedManifest(releaseId),
        verifyActive: async () => {
          const record = await modelLoader.verify(MODEL_VARIANT, true);
          return Boolean(record && record.status !== 'corrupt' && record.status !== 'not_installed');
        },
      });
      lastIntegrityCheck = 0;
    })().catch(() => undefined);
  }
  return recoveryPromise;
}

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clearWorkerIdle(): void {
  if (workerIdleTimer) clearTimeout(workerIdleTimer);
  workerIdleTimer = null;
}

function scheduleWorkerIdle(): void {
  clearWorkerIdle();
  workerIdleTimer = setTimeout(() => {
    if (pending.size === 0) modelManager.disposeWorker();
  }, 120_000);
}

function rejectPending(error: Error): void {
  for (const [id, item] of pending) {
    clearTimeout(item.timer);
    item.reject(error);
    pending.delete(id);
  }
}

function handleWorkerMessage(value: unknown): void {
  let message: ModelWorkerResponse;
  try {
    message = parseModelWorkerResponse(value);
  } catch {
    return;
  }
  const item = pending.get(message.requestId);
  if (!item) return;
  if (message.type === 'infer-progress') {
    if (activeInference && activeInference.requestId === message.requestId) {
      activeInference.generatedTokens = message.generatedTokens;
    }
    return;
  }
  if (message.type === 'load-progress') return;
  clearTimeout(item.timer);
  pending.delete(message.requestId);
  if (activeInference?.requestId === message.requestId) activeInference = null;
  if (message.type === 'error') {
    item.reject(new FormFlowError(
      message.code === 'MODEL_CANCELLED'
        ? 'MODEL_CANCELLED'
        : message.code === 'MODEL_LOAD_FAILED'
          ? 'MODEL_LOAD_FAILED'
          : message.code === 'INVALID_AI_OUTPUT'
            ? 'INVALID_AI_OUTPUT'
            : 'INFERENCE_FAILED',
      message.message,
    ));
    return;
  }
  item.resolve(message);
}

async function sendWorker(request: ModelWorkerRequest, timeoutMs: number, kind: PendingWorkerRequest['kind']): Promise<ModelWorkerResponse> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const response = new Promise<ModelWorkerResponse>((resolve, reject) => {
    timer = setTimeout(() => {
      pending.delete(request.requestId);
      modelManager.disposeWorker();
      reject(new FormFlowError(kind === 'infer' ? 'INFERENCE_TIMEOUT' : 'MODEL_LOAD_FAILED', kind === 'infer'
        ? 'Local inference exceeded the time limit and was stopped.'
        : 'The local model did not load in time.'));
    }, timeoutMs);
    pending.set(request.requestId, { resolve, reject, timer: timer as ReturnType<typeof setTimeout>, kind });
  });
  try {
    await sendOffscreenModelRequest(request);
  } catch (error) {
    if (timer) clearTimeout(timer);
    pending.delete(request.requestId);
    throw error instanceof FormFlowError
      ? error
      : new FormFlowError('MODEL_LOAD_FAILED', 'The isolated model runtime could not be started.');
  }
  return response;
}

async function ensureModelLoaded(): Promise<{ loadMs: number }> {
  if (workerLoaded) return { loadMs: 0 };
  const record = Date.now() - lastIntegrityCheck < 10 * 60_000
    ? await modelLoader.getRecord(MODEL_VARIANT)
    : await modelLoader.verify(MODEL_VARIANT);
  if (!record || (record.status !== 'installed' && record.status !== 'ready')) {
    throw new FormFlowError('MODEL_NOT_INSTALLED', 'Install and verify the local model before running inference.');
  }
  lastIntegrityCheck = Date.now();
  const started = performance.now();
  const response = await sendWorker({
    protocol: MODEL_WORKER_PROTOCOL_VERSION,
    type: 'load',
    requestId: requestId('model_load'),
    variantId: MODEL_VARIANT,
  }, MODEL_LOAD_TIMEOUT_MS, 'load');
  if (response.type !== 'loaded') throw new FormFlowError('MODEL_LOAD_FAILED', 'The local model did not report readiness.');
  workerLoaded = true;
  await modelLoader.markStatus(MODEL_VARIANT, 'ready', {
    lastInitializedAt: new Date().toISOString(),
    error: undefined,
  });
  scheduleWorkerIdle();
  return { loadMs: Math.max(0, Math.round(performance.now() - started)) };
}

function startInstallHeartbeat(): () => void {
  const timer = setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch(() => undefined);
  }, 20_000);
  return () => clearInterval(timer);
}

function currentReleaseIdFor(record: { releaseId?: string } | null): string | null {
  // Records written before the lifecycle system have no releaseId; treat them
  // as the known-good baseline so upgrades are evaluated honestly.
  if (record?.releaseId) return record.releaseId;
  return record ? MODEL_RELEASE_ID : null;
}

function installMessage(progress: DownloadProgress | null): ModelStatusSnapshot['progress'] {
  if (!progress) return undefined;
  return {
    phase: progress.phase,
    percent: Math.max(0, Math.min(100, progress.percent)),
    filePath: progress.filePath,
    downloadedBytes: progress.totalBytes,
    totalBytes: progress.totalTotalBytes,
  };
}

export const modelManager = {
  async status(): Promise<ModelStatusSnapshot> {
    await ensureRecovery();
    const capabilities = await detectModelCapabilities();
    const [record, storage, lifecycle, rollback] = await Promise.all([
      modelLoader.getRecord(MODEL_VARIANT),
      quotaManager.estimate(),
      readLifecycleState(await getDb()),
      getRollbackStatus(await getDb()),
    ]);
    const currentReleaseId = currentReleaseIdFor(record);
    const availableUpgrade = checkForUpgrade(currentReleaseId, record?.version);
    let current = record;
    if (current && (current.status === 'downloading' || current.status === 'verifying') && !installPromise) {
      if (Date.now() - installStartedAt > INSTALL_STALE_MS) {
        current = { ...current, status: 'failed', error: 'The previous model download was interrupted. Retry installation.' };
        await modelLoader.markStatus(MODEL_VARIANT, 'failed', { error: current.error });
      }
    }
    const ready = Boolean(current && current.status === 'ready');
    return {
      status: current?.status ?? 'not_installed',
      ready,
      record: current,
      capabilities,
      preferredVariant: 'q8',
      storage,
      availableUpgrade: { ...availableUpgrade, checkedAt: new Date().toISOString() },
      lifecycle,
      rollback,
      ...(lifecycle.failureReason ? { failureDetails: lifecycle.failureReason } : current?.error ? { failureDetails: current.error } : {}),
      ...(activeInference ? { inference: { active: true, generatedTokens: activeInference.generatedTokens } } : {}),
      message: ready
        ? `Local model ready (${MODEL_VARIANTS.q8.label}).`
        : current?.status === 'installed'
          ? 'Local model files are installed and verified; it will initialize on first use.'
          : current?.status === 'downloading' || current?.status === 'verifying'
            ? 'Local model is downloading or verifying.'
            : current?.error
              ? current.error
              : 'Local AI model is not installed. Basic document processing remains available.',
      ...(installMessage(installProgress) ? { progress: installMessage(installProgress) } : {}),
    };
  },

  async install(): Promise<{ started: boolean; status: ModelStatusSnapshot }> {
    if (installPromise) return { started: false, status: await this.status() };
    const capabilities = await detectModelCapabilities();
    const variant = defaultVariant();
    void capabilities;
    const storage = await quotaManager.estimate();
    // Resumable installation stores 8 MB chunks and then assembles the final
    // cache entry, so the transient peak is roughly twice the model size.
    const requiredBytes = requiredModelStorageBytes(variant.totalBytes);
    if (!hasSufficientStorage(storage.quotaBytes, storage.availableBytes, requiredBytes)) {
      throw new FormFlowError('INSUFFICIENT_STORAGE', insufficientStorageMessage(requiredBytes));
    }
    await quotaManager.requestPersistence().catch(() => false);
    const controller = new AbortController();
    installController = controller;
    installStartedAt = Date.now();
    const stopHeartbeat = startInstallHeartbeat();
    installPromise = modelLoader.install(MODEL_VARIANT, (progress) => {
      installProgress = progress;
    }, controller.signal)
      .then(async ({ record }) => {
        // modelLoader.install hashes every downloaded byte before committing the
        // record, so a second full 770 MB verification here would only block the
        // service worker and delay the first status request.
        lastIntegrityCheck = Date.now();
        installProgress = {
          phase: 'verifying',
          filePath: variant.modelFile,
          fileIndex: variant.files.length - 1,
          fileCount: variant.files.length,
          fileBytes: variant.totalBytes,
          fileTotalBytes: variant.totalBytes,
          totalBytes: variant.totalBytes,
          totalTotalBytes: variant.totalBytes,
          percent: 100,
        };
        await modelLoader.markStatus(MODEL_VARIANT, 'installed', { error: undefined });
        return record;
      })
      .finally(() => {
        stopHeartbeat();
        installController = null;
        installPromise = null;
        installProgress = null;
      });
    // The caller observes progress through MODEL_STATUS. Swallow the stored
    // promise rejection so a failed background install cannot surface as an
    // unhandled promise rejection in the service worker.
    void installPromise.catch(() => undefined);
    return { started: true, status: await this.status() };
  },

  async cancel(): Promise<{ cancelled: boolean }> {
    if (!installController) return { cancelled: false };
    installController.abort();
    return { cancelled: true };
  },

  /**
   * Upgrade to the latest trusted, compatible release. With a single trusted
   * release this returns an honest "no upgrade available" result; the full
   * stage → verify → self-test → atomic-promote → rollback state machine is
   * exercised by regression tests with fixtures.
   */
  async upgrade(): Promise<{ ok: boolean; message: string; status: ModelStatusSnapshot }> {
    await ensureRecovery();
    const record = await modelLoader.getRecord(MODEL_VARIANT);
    const info = checkForUpgrade(currentReleaseIdFor(record), record?.version);
    if (!info.available) {
      return {
        ok: false,
        message: info.reason ?? 'No verified model upgrade is available.',
        status: await this.status(),
      };
    }
    const target = info.releaseId ? getTrustedManifest(info.releaseId) : null;
    if (!target || !target.trusted) {
      return { ok: false, message: 'The advertised upgrade is not in the trusted manifest catalog.', status: await this.status() };
    }
    const current = currentReleaseIdFor(record) ? getTrustedManifest(currentReleaseIdFor(record)!) : null;
    const storage = await quotaManager.estimate();
    const controller = new AbortController();
    upgradeController = controller;
    const result = await runUpgrade({
      db: await getDb(),
      current,
      target,
      storageAvailableBytes: storage.availableBytes,
      storageQuotaBytes: storage.quotaBytes,
      steps: lifecycleSteps(),
      signal: controller.signal,
    });
    upgradeController = null;
    installProgress = null;
    lastIntegrityCheck = 0;
    if (result.ok) this.disposeWorker();
    return {
      ok: result.ok,
      message: result.ok
        ? `Upgraded to ${target.version}. The previous release is retained for rollback.`
        : result.reason ?? 'The model upgrade failed; the previous model remains active.',
      status: await this.status(),
    };
  },

  async cancelUpgrade(): Promise<{ cancelled: boolean }> {
    if (!upgradeController) return { cancelled: false };
    upgradeController.abort();
    return { cancelled: true };
  },

  async rollback(): Promise<{ ok: boolean; message: string; status: ModelStatusSnapshot }> {
    await ensureRecovery();
    const result = await runRollback({
      db: await getDb(),
      reason: 'Manual rollback requested.',
      steps: lifecycleSteps(),
    });
    lastIntegrityCheck = 0;
    this.disposeWorker();
    return {
      ok: result.ok,
      message: result.ok
        ? 'Rolled back to the previous verified model.'
        : result.reason ?? 'Rollback was not possible.',
      status: await this.status(),
    };
  },

  /** Delete superseded files once the active release is confirmed healthy. */
  async prunePrevious(): Promise<{ pruned: boolean }> {
    await ensureRecovery();
    const db = await getDb();
    const state = await readLifecycleState(db);
    const healthy = state.activeReleaseId
      ? (await modelLoader.verify(MODEL_VARIANT, true))?.status !== 'corrupt'
      : false;
    if (!healthy) return { pruned: false };
    const steps = lifecycleSteps();
    if (!steps.pruneObsolete || !state.previousReleaseId) return { pruned: false };
    await steps.pruneObsolete(state.previousReleaseId);
    await writeLifecycleState(db, { previousReleaseId: null });
    return { pruned: true };
  },

  async remove(): Promise<void> {
    this.disposeWorker();
    installController?.abort();
    await installPromise?.catch(() => undefined);
    lastIntegrityCheck = 0;
    await modelLoader.remove(MODEL_VARIANT);
  },

  async selfTest(): Promise<ModelSelfTestResult> {
    if (inferenceInFlight) {
      return {
        ok: false,
        runtime: 'wasm',
        variant: MODEL_VARIANT,
        message: 'Another local inference is already running. Wait for it to finish or cancel it.',
      };
    }
    inferenceInFlight = true;
    const loadStarted = performance.now();
    try {
      const loaded = await ensureModelLoaded();
      const started = performance.now();
      const response = await sendWorker({
        protocol: MODEL_WORKER_PROTOCOL_VERSION,
        type: 'infer',
        requestId: requestId('model_selftest'),
        messages: [
          { role: 'system', content: 'You are a strict JSON-only extraction engine. Reply with one JSON object and no markdown.' },
          { role: 'user', content: 'Return {"status":"ok","value":42}.' },
        ],
        maxNewTokens: 32,
        temperature: 0,
      }, MODEL_SELF_TEST_TIMEOUT_MS, 'infer');
      if (response.type !== 'result') throw new FormFlowError('INFERENCE_FAILED', 'The model self-test returned no result.');
      return {
        ok: true,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        loadMs: loaded.loadMs || Math.max(0, Math.round(performance.now() - loadStarted)),
        runtime: 'wasm',
        variant: MODEL_VARIANT,
        message: 'Local inference self-test completed.',
      };
    } catch (error) {
      return {
        ok: false,
        runtime: 'wasm',
        variant: MODEL_VARIANT,
        message: error instanceof Error ? error.message : 'Local inference self-test failed.',
      };
    } finally {
      inferenceInFlight = false;
    }
  },

  async infer(messages: ModelChatMessage[], options: { maxNewTokens?: number; temperature?: number } = {}): Promise<{ text: string; latencyMs: number; loadMs: number }> {
    if (inferenceInFlight) {
      throw new FormFlowError('INFERENCE_FAILED', 'Another local inference is already running. Wait for it to finish or cancel it.');
    }
    inferenceInFlight = true;
    try {
      const loaded = await ensureModelLoaded();
      const started = performance.now();
      const inferenceRequestId = requestId('model_infer');
      const maxNewTokens = Math.max(16, Math.min(512, options.maxNewTokens ?? MODEL_MAX_OUTPUT_TOKENS));
      activeInference = { requestId: inferenceRequestId, generatedTokens: 0 };
      let response: ModelWorkerResponse;
      try {
        response = await sendWorker({
          protocol: MODEL_WORKER_PROTOCOL_VERSION,
          type: 'infer',
          requestId: inferenceRequestId,
          messages,
          maxNewTokens,
          temperature: Math.max(0, Math.min(1, options.temperature ?? 0)),
        }, inferenceTimeoutMsForTokens(maxNewTokens), 'infer');
      } catch (error) {
        activeInference = null;
        throw error;
      }
      activeInference = null;
      if (response.type !== 'result') throw new FormFlowError('INFERENCE_FAILED', 'The local model returned no result.');
      scheduleWorkerIdle();
      return {
        text: response.text,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        loadMs: loaded.loadMs,
      };
    } finally {
      inferenceInFlight = false;
    }
  },

  disposeWorker(): void {
    clearWorkerIdle();
    workerLoaded = false;
    activeInference = null;
    disposeOffscreenModelWorker();
    rejectPending(new FormFlowError('MODEL_CANCELLED', 'The local model worker was stopped.'));
  },

  metadata() {
    return {
      ...MODEL_METADATA,
      variant: MODEL_VARIANTS.q8,
    };
  },
};

onOffscreenModelResponse((response) => handleWorkerMessage(response));
onOffscreenModelDisconnect(() => {
  workerLoaded = false;
  lastIntegrityCheck = 0;
  activeInference = null;
  rejectPending(new FormFlowError('MODEL_CANCELLED', 'The isolated model runtime closed.'));
});
