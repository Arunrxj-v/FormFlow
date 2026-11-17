import { VaultLockedError } from '@shared/errors';
import { importDataKey, exportKeyRaw, bufferToBase64 } from '../encryption/crypto-service';
import { createDefaultSessionBackend, type KeySessionBackend } from './session-backend';

export type VaultLockListener = (locked: boolean) => void;

/**
 * Holds the unlocked data-encryption key for the current browser session.
 * In the extension the key is memory-only inside the service worker; it is not
 * written to chrome.storage.session or IndexedDB, so extension pages cannot
 * read it. Web development builds use sessionStorage, which is cleared when
 * the tab closes.
 *
 * `generation` increments on explicit lock/unlock transitions so callers can
 * discard responses that were produced across a lock boundary.
 */
export class VaultSession {
  private key: CryptoKey | null = null;
  private listeners = new Set<VaultLockListener>();
  private generation = 0;
  private epoch = 0;
  private transition: Promise<void> = Promise.resolve();

  constructor(private readonly backend: KeySessionBackend = createDefaultSessionBackend()) {}

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.transition.then(operation, operation);
    this.transition = run.catch(() => undefined);
    return run;
  }

  private emit(locked: boolean): void {
    for (const listener of this.listeners) {
      try {
        listener(locked);
      } catch {
        // Listener failures must not break vault state transitions.
      }
    }
  }

  subscribe(listener: VaultLockListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getGeneration(): number {
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  async hydrate(): Promise<boolean> {
    if (this.key) return true;
    const epoch = this.epoch;
    const stored = await this.backend.get();
    if (!stored || epoch !== this.epoch) return false;
    try {
      const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
      this.key = await importDataKey(raw);
      if (epoch !== this.epoch) {
        this.key = null;
        return false;
      }
      return true;
    } catch {
      await this.backend.set(null);
      return false;
    }
  }

  async isUnlocked(): Promise<boolean> {
    if (this.key) return true;
    return this.hydrate();
  }

  async getDataKey(): Promise<CryptoKey> {
    if (this.key) return this.key;
    const hydrated = await this.hydrate();
    if (!hydrated || !this.key) throw new VaultLockedError();
    return this.key;
  }

  async unlockWithDataKey(key: CryptoKey): Promise<void> {
    await this.enqueue(async () => {
      this.epoch += 1;
      // The extension backend is memory-only. Keep the CryptoKey directly
      // instead of exporting a second raw base64 copy inside the worker.
      if (this.backend.kind === 'memory') {
        this.key = key;
        await this.backend.set(null);
      } else {
        const raw = await exportKeyRaw(key);
        this.key = await importDataKey(raw);
        await this.backend.set(bufferToBase64(raw));
      }
      this.generation += 1;
      this.emit(false);
    });
  }

  async lock(): Promise<void> {
    await this.enqueue(async () => {
      const hadKey = this.key !== null;
      this.epoch += 1;
      this.key = null;
      await this.backend.set(null);
      if (hadKey) this.generation += 1;
      this.emit(true);
    });
  }
}

export const vaultSession = new VaultSession();
