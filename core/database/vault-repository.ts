import { FormFlowError } from '@shared/errors';
import type { VaultRecord } from '@shared/types';
import { getDb } from './database';

export const vaultRepository = {
  async getActive(): Promise<VaultRecord | null> {
    const db = await getDb();
    const rows = await db.getAll('vaults');
    return rows[0] ?? null;
  },

  async create(name: string): Promise<VaultRecord> {
    const db = await getDb();
    const existing = await this.getActive();
    if (existing) throw new FormFlowError('VAULT_EXISTS', 'A local vault already exists in this browser.');
    const now = new Date().toISOString();
    const record: VaultRecord = {
      id: `vault_${crypto.randomUUID()}`,
      name: name.trim() || 'My FormFlow vault',
      schemaVersion: 2,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      setupCompleted: true,
    };
    await db.put('vaults', record);
    return record;
  },

  async update(patch: Partial<Omit<VaultRecord, 'id' | 'createdAt'>>): Promise<VaultRecord | null> {
    const current = await this.getActive();
    if (!current) return null;
    const updated: VaultRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const db = await getDb();
    await db.put('vaults', updated);
    return updated;
  },

  async touch(): Promise<void> {
    const current = await this.getActive();
    if (!current) return;
    const updated = { ...current, lastOpenedAt: new Date().toISOString() };
    const db = await getDb();
    await db.put('vaults', updated);
  },

  async delete(): Promise<void> {
    const db = await getDb();
    const current = await this.getActive();
    if (!current) return;
    await db.delete('vaults', current.id);
  },
};
