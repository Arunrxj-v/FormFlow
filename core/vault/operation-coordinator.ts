import { FormFlowError } from '@shared/errors';

export type VaultOperationState = 'locked' | 'unlocked' | 'locking';
export type VaultOperationKind = 'read' | 'mutation';

export interface OperationCoordinatorOptions {
  /** How long lock waits for in-flight operations before failing closed. */
  lockTimeoutMs?: number;
  onChange?: (state: VaultOperationState, activeOperations: number) => void;
}

/**
 * Coordinates the background vault session with in-flight operations.
 *
 * A lock only reports completion after every operation that acquired a lease
 * has settled and the privileged service has cleared the key. New operations
 * are rejected as soon as locking starts. A timeout returns an error and keeps
 * the vault unlocked; it never reports LOCKED while a mutation can still commit.
 */
export class VaultOperationCoordinator {
  private state: VaultOperationState = 'locked';
  private active = new Map<symbol, { operation: string; kind: VaultOperationKind; startedAt: number }>();
  private lockPromise: Promise<void> | null = null;
  private unlocking = false;
  private drainWaiters = new Set<() => void>();
  private readonly lockTimeoutMs: number;
  private readonly onChange: (state: VaultOperationState, activeOperations: number) => void;

  constructor(options: OperationCoordinatorOptions = {}) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
    this.onChange = options.onChange ?? (() => undefined);
  }

  getState(): VaultOperationState {
    return this.state;
  }

  isUnlocked(): boolean {
    return this.state === 'unlocked';
  }

  getActiveOperationCount(): number {
    return this.active.size;
  }

  private notify(): void {
    try {
      this.onChange(this.state, this.active.size);
    } catch {
      // State notifications must never break the vault state machine.
    }
  }

  private waitForDrain(): Promise<boolean> {
    if (this.active.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.drainWaiters.delete(check);
        resolve(drained);
      };
      const check = () => {
        if (this.active.size === 0) finish(true);
      };
      const timer = setTimeout(() => finish(false), this.lockTimeoutMs);
      this.drainWaiters.add(check);
      check();
    });
  }

  private release(token: symbol): void {
    this.active.delete(token);
    if (this.state === 'locking' || this.active.size === 0) {
      for (const waiter of [...this.drainWaiters]) waiter();
    }
    this.notify();
  }

  async run<T>(kind: VaultOperationKind, operation: string, fn: () => Promise<T>): Promise<T> {
    if (this.state !== 'unlocked') {
      throw new FormFlowError('VAULT_LOCKED', 'The vault is locked. Unlock it to continue.');
    }
    const token = Symbol(operation);
    this.active.set(token, { operation, kind, startedAt: Date.now() });
    this.notify();
    try {
      return await fn();
    } finally {
      this.release(token);
    }
  }

  /** Run a vault-creating/unlocking transition. Lock is rejected while it runs. */
  async unlock(fn: () => Promise<void>): Promise<void> {
    if (this.state === 'locking' || this.lockPromise) {
      throw new FormFlowError('SESSION_EXPIRED', 'The vault is currently locking. Wait for the lock to finish.');
    }
    if (this.unlocking) {
      throw new FormFlowError('SESSION_EXPIRED', 'Another unlock is already in progress.');
    }
    if (this.state === 'unlocked') return;
    this.unlocking = true;
    try {
      await fn();
      this.state = 'unlocked';
      this.notify();
    } finally {
      this.unlocking = false;
    }
  }

  async create(fn: () => Promise<void>): Promise<void> {
    if (this.state !== 'locked' || this.unlocking || this.lockPromise) {
      throw new FormFlowError('VAULT_EXISTS', 'A vault transition is already in progress.');
    }
    this.unlocking = true;
    try {
      await fn();
      this.state = 'unlocked';
      this.notify();
    } finally {
      this.unlocking = false;
    }
  }

  async lock(fn: () => Promise<void>): Promise<void> {
    if (this.lockPromise) return this.lockPromise;
    if (this.unlocking) {
      throw new FormFlowError('SESSION_EXPIRED', 'An unlock is in progress. Retry the lock.');
    }
    if (this.state === 'locked') return;

    this.state = 'locking';
    this.notify();
    this.lockPromise = (async () => {
      const drained = await this.waitForDrain();
      if (!drained) {
        this.state = 'unlocked';
        this.notify();
        throw new FormFlowError(
          'SESSION_EXPIRED',
          `The vault could not lock because ${this.active.size} operation(s) are still running. The vault remains unlocked; retry the lock.`,
        );
      }
      await fn();
      this.state = 'locked';
      this.notify();
    })()
      .catch((error) => {
        if (this.state === 'locking') {
          this.state = 'unlocked';
          this.notify();
        }
        throw error;
      })
      .finally(() => {
        this.lockPromise = null;
      });
    return this.lockPromise;
  }
}
