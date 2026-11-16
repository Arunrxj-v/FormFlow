import { FormFlowError } from '@shared/errors';
import { VAULT_SCHEMA_VERSION } from '@shared/constants';
import type { VaultRecord } from '@shared/types';
import { getDb } from './database';
import { decryptJsonWithKey, encryptJsonWithKey, type RecordAad } from '../encryption/crypto-service';
import { vaultSession } from '../vault/vault-session';

function context(record: Pick<VaultRecord, 'id' | 'schemaVersion'>): RecordAad {
  return {
    vaultId: record.id,
    recordType: 'vault',
    recordId: record.id,
    field: 'name',
    schemaVersion: record.schemaVersion ?? VAULT_SCHEMA_VERSION,
  };
}

async function decryptName(row: VaultRecord): Promise<string> {
  if (!row.nameEnc) return row.name;
  return decryptJsonWithKey<string>(await vaultSession.getDataKey(), row.nameEnc, context(row));
}

async function storageRecord(row: VaultRecord, plaintextName: string): Promise<VaultRecord> {
  return {
    ...row,
    name: '',
    nameEnc: await encryptJsonWithKey(await vaultSession.getDataKey(), plaintextName, context(row)),
  };
}

export const vaultRepository = {
  async getActive(): Promise<VaultRecord | null> {
    const db = await getDb();
    const rows = await db.getAll('vaults');
    const row = rows[0];
    if (!row) return null;
    return { ...row, name: await decryptName(row) };
  },

  async create(name: string): Promise<VaultRecord> {
    const db = await getDb();
    const existing = await this.getActive();
    if (existing) throw new FormFlowError('VAULT_EXISTS', 'A local vault already exists in this browser.');
    const now = new Date().toISOString();
    const id = `vault_${crypto.randomUUID()}`;
    const displayName = name.trim() || 'My FormFlow vault';
    const record: VaultRecord = {
      id,
      name: '',
      schemaVersion: VAULT_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      setupCompleted: true,
    };
    const stored = await storageRecord(record, displayName);
    await db.put('vaults', stored);
    return { ...stored, name: displayName };
  },

  async update(patch: Partial<Omit<VaultRecord, 'id' | 'createdAt'>>): Promise<VaultRecord | null> {
    const current = await this.getActive();
    if (!current) return null;
    const displayName = patch.name !== undefined ? patch.name : current.name;
    const updated: VaultRecord = {
      ...current,
      ...patch,
      name: displayName,
      updatedAt: new Date().toISOString(),
    };
    const stored = await storageRecord(updated, displayName);
    const db = await getDb();
    await db.put('vaults', stored);
    return { ...stored, name: displayName };
  },

  async touch(): Promise<void> {
    const current = await this.getActive();
    if (!current) return;
    const updated = { ...current, lastOpenedAt: new Date().toISOString() };
    const stored = await storageRecord(updated, current.name);
    const db = await getDb();
    await db.put('vaults', stored);
  },

  async delete(): Promise<void> {
    const db = await getDb();
    const current = await this.getActive();
    if (!current) return;
    await db.delete('vaults', current.id);
  },
};
