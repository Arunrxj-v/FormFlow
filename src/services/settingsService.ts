import { vaultClient } from '@/services/vaultClient';
import type { Preferences } from '../../shared/types';

export const settingsService = {
  isLocal: true,
  getPreferences(): Promise<Preferences> {
    return vaultClient.getPreferences();
  },
  updatePreferences(next: Preferences): Promise<Preferences> {
    return vaultClient.updatePreferences(next);
  },
};
