import { FormFlowError, InvalidPasswordError, VaultLockedError } from '@shared/errors';
import type { VaultMeta } from '@shared/types';
import { PBKDF2_ITERATIONS } from '@shared/constants';
import { getDb, deleteDatabase } from '../database/database';
import {
  base64ToArrayBuffer,
  bufferToBase64,
  encryptJsonWithKey,
  rewrapDataKey,
  unwrapDataKey,
  validatePasswordStrength,
  wrapDataKey,
} from '../encryption/crypto-service';
import { vaultSession } from './vault-session';

const META_ID = 'meta';

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  encrypted: boolean;
  requiresEncryptionMigration: boolean;
  createdAt?: string;
  passwordUpdatedAt?: string;
  kdf?: string;
  iterations?: number;
}

class VaultManager {
  private failedAttempts = 0;

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
      createdAt: now,
      passwordUpdatedAt: now,
    };
    const db = await getDb();
    await db.put('vaultMeta', meta);
    const raw = await unwrapDataKey(password, wrapped.salt, wrapped.iterations, wrapped.wrapped);
    await vaultSession.unlockWithDataKey(raw);
    this.failedAttempts = 0;
  }

  async unlock(password: string): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) throw new FormFlowError('VAULT_NOT_FOUND', 'No local vault exists yet.');
    if (this.failedAttempts > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, this.failedAttempts * 350)));
    }
    try {
      const key = await unwrapDataKey(
        password,
        meta.salt,
        meta.iterations,
        JSON.parse(meta.wrappedDataKey),
      );
      await vaultSession.unlockWithDataKey(key);
      this.failedAttempts = 0;
    } catch (error) {
      this.failedAttempts += 1;
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
    const strength = validatePasswordStrength(newPassword);
    if (!strength.ok) throw new FormFlowError('WEAK_PASSWORD', strength.message ?? 'Choose a stronger password.');
    const rewrapped = await rewrapDataKey(
      currentPassword,
      meta.salt,
      meta.iterations,
      JSON.parse(meta.wrappedDataKey),
      newPassword,
    );
    const updated: VaultMeta = {
      ...meta,
      iterations: rewrapped.iterations,
      salt: rewrapped.salt,
      wrappedDataKey: JSON.stringify(rewrapped.wrapped),
      passwordUpdatedAt: new Date().toISOString(),
    };
    const db = await getDb();
    await db.put('vaultMeta', updated);
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

  async encryptForVault(value: unknown): Promise<string> {
    const key = await this.getDataKeyOrThrow();
    return encryptJsonWithKey(key, value);
  }

  async ensureUnlocked(): Promise<void> {
    if (!(await vaultSession.isUnlocked())) throw new VaultLockedError();
  }
}

export const vaultManager = new VaultManager();
