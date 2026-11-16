import { vaultClient } from '@/services/vaultClient';
import type { DashboardPayload } from '@/services/vaultClientTypes';

export const dashboardService = {
  load(): Promise<DashboardPayload> {
    return vaultClient.getDashboardData();
  },
};

export const profileService = {
  getProfile: () => vaultClient.getProfile(),
  saveProfile: (patch: Parameters<typeof vaultClient.updateProfile>[0]) => vaultClient.updateProfile(patch),
  listFields: () => vaultClient.listFields(),
  addField: (field: Parameters<typeof vaultClient.addField>[0]) => vaultClient.addField(field),
  updateField: (id: string, value: string) => vaultClient.updateField(id, value),
  deleteField: (id: string) => vaultClient.deleteField(id),
  resolveConflict: (id: string, value: string) => vaultClient.resolveConflict(id, value),
};

export const historyService = {
  list: () => vaultClient.getHistory(),
  record: (entry: Parameters<typeof vaultClient.recordHistory>[0]) => vaultClient.recordHistory(entry),
  clear: () => vaultClient.clearHistory(),
};

export const vaultService = {
  getActiveVault: () => vaultClient.getActiveVault(),
  createVault: async (input: { name: string; passphrase: string }) => {
    const result = await vaultClient.createVault(input);
    return result.vault;
  },
  migratePlaintextVault: (passphrase: string) => vaultClient.migratePlaintextVault(passphrase),
  updateVault: (patch: Parameters<typeof vaultClient.updateVault>[0]) => vaultClient.updateVault(patch),
  touch: () => vaultClient.touch(),
};

export type { DashboardPayload as DashboardData };
