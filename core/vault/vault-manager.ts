import { FormFlowError, InvalidPasswordError, VaultLockedError } from '@shared/errors';
import type { UnlockThrottleRecord, VaultMeta } from '@shared/types';
import { ENCRYPTION_FORMAT_VERSION, PBKDF2_ITERATIONS } from '@shared/constants';
import { getDb, deleteDatabase } from '../database/database';
import {
  rewrapDataKey,
  unwrapDataKey,
  validatePasswordStrength,
  wrapDataKey,
} from '../encryption/crypto-service';
import { vaultSession } from './vault-session';

const META_ID = 'meta';
const UNLOCK_THROTTLE_ID = 'unlock-throttle' as const;
const LOCKOUT_AFTER_ATTEMPTS = 3;
const MAX_LOCKOUT_MS = 60_000;

/**
 * Progressive delay after repeated failures. The first two mistakes are not
 * delayed; from the third failure the delay doubles up to one minute. The
 * counter and lockout deadline are persisted in IndexedDB, so an MV3 worker
 * restart, extension reload, or browser restart cannot reset the policy.
 */
export function lockoutDelayMsForAttempts(failedAttempts: number): number {
  if (!Number.isFinite(failedAttempts) || failedAttempts < LOCKOUT_AFTER_ATTEMPTS) return 0;
  return Math.min(MAX_LOCKOUT_MS, 1_000 * 2 ** Math.min(failedAttempts - LOCKOUT_AFTER_ATTEMPTS, 6));
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  encrypted: boolean;
  requiresEncryptionMigration: boolean;
  requiresEncryptionUpgrade: boolean;
  encryptionFormat?: number;
  createdAt?: string;
  passwordUpdatedAt?: string;
  kdf?: string;
  iterations?: number;
}

export class VaultManager {
  private unlockQueue: Promise<void> = Promise.resolve();

  private async readThrottle(): Promise<UnlockThrottleRecord> {
    const db = await getDb();
    const row = await db.get('securityState', UNLOCK_THROTTLE_ID);
    if (!row) {
      return { id: UNLOCK_THROTTLE_ID, failedAttempts: 0, lockedUntil: 0, updatedAt: new Date(0).toISOString() };
    }
    if (
      row.id !== UNLOCK_THROTTLE_ID
      || !Number.isInteger(row.failedAttempts)
      || row.failedAttempts < 0
      || row.failedAttempts > 10_000
      || !Number.isFinite(row.lockedUntil)
      || row.lockedUntil < 0
      || typeof row.updatedAt !== 'string'
    ) {
      // Corrupt throttling metadata is treated as no lockout rather than a
      // permanent lockout. A local attacker who can edit IndexedDB can bypass
      // this control anyway; PBKDF2 remains the primary offline cost.
      await db.delete('securityState', UNLOCK_THROTTLE_ID);
      return { id: UNLOCK_THROTTLE_ID, failedAttempts: 0, lockedUntil: 0, updatedAt: new Date(0).toISOString() };
    }
    return row;
  }

  private async writeThrottle(failedAttempts: number, lockedUntil: number): Promise<void> {
    const db = await getDb();
    await db.put('securityState', {
      id: UNLOCK_THROTTLE_ID,
      failedAttempts,
      lockedUntil,
      updatedAt: new Date().toISOString(),
    } satisfies UnlockThrottleRecord);
  }

  private async clearThrottle(): Promise<void> {
    const db = await getDb();
    await db.delete('securityState', UNLOCK_THROTTLE_ID);
  }

  async getMeta(): Promise<VaultMeta | null> {
    const db = await getDb();
    const meta = await db.get('vaultMeta', META_ID);
    return meta ?? null;
  }

  async exists(): Promise<boolean> {
    return Boolean(await this.getMeta());
  }

  async status(): Promise<VaultStatus> {
    const meta = await this.getMeta();
    const unlocked = await vaultSession.isUnlocked();
    const db = await getDb();
    const vaults = await db.getAll('vaults');
    return {
      exists: Boolean(meta),
      unlocked,
      encrypted: Boolean(meta),
      requiresEncryptionMigration: !meta && vaults.length > 0,
      requiresEncryptionUpgrade: Boolean(meta) && ((meta?.encryptionFormat ?? 1) < ENCRYPTION_FORMAT_VERSION || (meta?.nameFormat ?? 1) < ENCRYPTION_FORMAT_VERSION),
      encryptionFormat: meta?.encryptionFormat ?? (meta ? 1 : undefined),
      createdAt: meta?.createdAt,
      passwordUpdatedAt: meta?.passwordUpdatedAt,
      kdf: meta?.kdf,
      iterations: meta?.iterations,
    };
  }

  async create(password: string): Promise<void> {
    if (await this.exists()) throw new FormFlowError('VAULT_EXISTS', 'A vault already exists in this browser.');
    const strength = validatePasswordStrength(password);
    if (!strength.ok) throw new FormFlowError('WEAK_PASSWORD', strength.message ?? 'Choose a stronger password.');

    const wrapped = await wrapDataKey(password, PBKDF2_ITERATIONS);
    const now = new Date().toISOString();
    const meta: VaultMeta = {
      id: 'meta',
      version: 1,
      kdf: 'PBKDF2-SHA256',
      iterations: wrapped.iterations,
      salt: wrapped.salt,
      wrappedDataKey: JSON.stringify(wrapped.wrapped),
      encryptionFormat: ENCRYPTION_FORMAT_VERSION,
      nameFormat: ENCRYPTION_FORMAT_VERSION,
      createdAt: now,
      passwordUpdatedAt: now,
    };
    const db = await getDb();
    await db.put('vaultMeta', meta);
    const raw = await unwrapDataKey(password, wrapped.salt, wrapped.iterations, wrapped.wrapped);
    await vaultSession.unlockWithDataKey(raw);
    await this.clearThrottle();
  }

  async unlock(password: string): Promise<void> {
    // Serialize attempts so concurrent calls cannot race past the counter or
    // leave two passphrase derivations competing for the same session.
    const attempt = this.unlockQueue.then(
      () => this.unlockOnce(password),
      () => this.unlockOnce(password),
    );
    this.unlockQueue = attempt.then(() => undefined, () => undefined);
    return attempt;
  }

  private async unlockOnce(password: string): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) throw new FormFlowError('VAULT_NOT_FOUND', 'No local vault exists yet.');
    const throttle = await this.readThrottle();
    const now = Date.now();
    if (throttle.lockedUntil > now) {
      const seconds = Math.max(1, Math.ceil((throttle.lockedUntil - now) / 1000));
      throw new FormFlowError(
        'VAULT_LOCKED_OUT',
        `Too many failed unlock attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
      );
    }
    try {
      const key = await unwrapDataKey(
        password,
        meta.salt,
        meta.iterations,
        JSON.parse(meta.wrappedDataKey),
      );
      await vaultSession.unlockWithDataKey(key);
      await this.clearThrottle();
    } catch (error) {
      const failedAttempts = throttle.failedAttempts + 1;
      const delay = lockoutDelayMsForAttempts(failedAttempts);
      const lockedUntil = delay > 0 ? now + delay : 0;
      await this.writeThrottle(failedAttempts, lockedUntil);
      if (delay > 0) {
        const seconds = Math.max(1, Math.ceil(delay / 1000));
        throw new FormFlowError(
          'VAULT_LOCKED_OUT',
          `Too many failed unlock attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
        );
      }
      if (error instanceof InvalidPasswordError || error instanceof FormFlowError) throw error;
      throw new InvalidPasswordError();
    }
  }

  async lock(): Promise<void> {
    await vaultSession.lock();
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) throw new FormFlowError('VAULT_NOT_FOUND', 'No local vault exists yet.');
    const generation = vaultSession.getGeneration();
    const strength = validatePasswordStrength(newPassword);
    if (!strength.ok) throw new FormFlowError('WEAK_PASSWORD', strength.message ?? 'Choose a stronger password.');
    const rewrapped = await rewrapDataKey(
      currentPassword,
      meta.salt,
      meta.iterations,
      JSON.parse(meta.wrappedDataKey),
      newPassword,
    );
    // Verify the new envelope before replacing the old one. A failure here
    // leaves the existing passphrase metadata untouched.
    await unwrapDataKey(
      newPassword,
      rewrapped.salt,
      rewrapped.iterations,
      rewrapped.wrapped,
    );
    if (!vaultSession.isCurrent(generation) || !(await vaultSession.isUnlocked())) {
      throw new FormFlowError('SESSION_EXPIRED', 'The vault locked while the passphrase change was in progress. The passphrase was not changed.');
    }
    const updated: VaultMeta = {
      ...meta,
      iterations: rewrapped.iterations,
      salt: rewrapped.salt,
      wrappedDataKey: JSON.stringify(rewrapped.wrapped),
      passwordUpdatedAt: new Date().toISOString(),
    };
    const db = await getDb();
    await db.put('vaultMeta', updated);
    await this.clearThrottle();
  }

  async verifyPassword(password: string): Promise<boolean> {
    const meta = await this.getMeta();
    if (!meta) return false;
    try {
      await unwrapDataKey(password, meta.salt, meta.iterations, JSON.parse(meta.wrappedDataKey));
      return true;
    } catch {
      return false;
    }
  }

  async getDataKeyOrThrow(): Promise<CryptoKey> {
    return vaultSession.getDataKey();
  }

  async destroyVault(): Promise<void> {
    await vaultSession.lock();
    await deleteDatabase();
    try {
      await caches.delete('formflow-model-cache-v1');
    } catch {
      // Cache API may be unavailable in tests.
    }
  }

  async ensureUnlocked(): Promise<void> {
    if (!(await vaultSession.isUnlocked())) throw new VaultLockedError();
  }
}

export const vaultManager = new VaultManager();
