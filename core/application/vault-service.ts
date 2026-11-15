import type { VaultRecord } from '@shared/types';
import { vaultRepository } from '../database/vault-repository';
import { activityRepository, settingsRepository, vaultRepository as vaultProfileRepository } from '../database/repositories';
import { vaultManager } from '../vault/vault-manager';
import { encryptionMigrationService } from '../vault/encryption-migration';

export const vaultService = {
  async getActiveVault(): Promise<VaultRecord | null> {
    return vaultRepository.getActive();
  },

  async createVault(input: { name: string; passphrase: string }): Promise<VaultRecord> {
    if (await vaultManager.exists()) {
      throw new Error('A vault already exists in this browser.');
    }
    if (await vaultRepository.getActive()) {
      throw new Error('A legacy unencrypted vault exists. Protect it with a passphrase instead of creating a new vault.');
    }
    await vaultManager.create(input.passphrase);
    const record = await vaultRepository.create(input.name);
    await vaultProfileRepository.saveProfile({ name: record.name, email: '', accountType: 'Local' });
    await settingsRepository.updateOnboarding({ completed: true, currentStep: 1, vaultCreatedAt: record.createdAt });
    await activityRepository.record('vault_created', 'Encrypted local vault created', `${record.name} · local IndexedDB storage.`);
    return record;
  },

  async migratePlaintextVault(passphrase: string): Promise<VaultRecord | null> {
    await encryptionMigrationService.migrate(passphrase);
    const record = await vaultRepository.getActive();
    if (record) {
      await vaultRepository.update({ setupCompleted: true });
      await settingsRepository.updateOnboarding({ completed: true, currentStep: 1, vaultCreatedAt: record.createdAt });
      await activityRepository.record('vault_created', 'Vault encrypted', `${record.name} · encryption migration complete.`);
    }
    return record;
  },

  async updateVault(patch: Partial<Omit<VaultRecord, 'id' | 'createdAt'>>): Promise<VaultRecord | null> {
    return vaultRepository.update(patch);
  },

  async touch(): Promise<void> {
    await vaultRepository.touch();
  },

  async completeSetup(): Promise<VaultRecord | null> {
    await settingsRepository.updateOnboarding({ completed: true, currentStep: 1 });
    return vaultRepository.update({ setupCompleted: true });
  },

  async getSetupState() {
    return settingsRepository.getOnboarding();
  },

  async updateSetupState(patch: { completed?: boolean; currentStep?: number; vaultCreatedAt?: string }) {
    await settingsRepository.updateOnboarding(patch);
  },
};
