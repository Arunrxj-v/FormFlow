import { VaultLockedError } from '@shared/errors';
import { importDataKey, exportKeyRaw, bufferToBase64 } from '../encryption/crypto-service';
import { createDefaultSessionBackend, type KeySessionBackend } from './session-backend';

export type VaultLockListener = (locked: boolean) => void;

/**
 * Holds the unlocked data-encryption key for the current browser session.
 * In the extension, the raw key lives in chrome.storage.session (memory only,
 * never written to disk) and is unavailable to content scripts. Web builds use
 * sessionStorage, which is also cleared when the tab closes.
 */
export class VaultSession {
  private key: CryptoKey | null = null;
  private listeners = new Set<VaultLockListener>();

  constructor(private readonly backend: KeySessionBackend = createDefaultSessionBackend()) {
    this.bindStorageChanges();
  }

  private bindStorageChanges(): void {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'session' || !('formflow.vault.session_key' in changes)) return;
      const next = changes['formflow.vault.session_key']?.newValue;
      if (!next) {
        this.key = null;
        this.emit(true);
        return;
      }
      this.key = null;
      void this.hydrate().then((hydrated) => this.emit(!hydrated));
    });
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

  async hydrate(): Promise<boolean> {
    if (this.key) return true;
    const stored = await this.backend.get();
    if (!stored) return false;
    try {
      const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
      this.key = await importDataKey(raw);
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
    const raw = await exportKeyRaw(key);
    const b64 = bufferToBase64(raw);
    this.key = await importDataKey(raw);
    await this.backend.set(b64);
  }

  async lock(): Promise<void> {
    this.key = null;
    await this.backend.set(null);
    this.emit(true);
  }
}

export const vaultSession = new VaultSession();
