import { settingsRepository } from '../../core/database/repositories';
import type { Preferences } from '../../shared/types';

export const settingsService = {
  isLocal: true,

  async getPreferences(): Promise<Preferences> {
    return settingsRepository.getPreferences();
  },

  async updatePreferences(next: Preferences): Promise<Preferences> {
    return settingsRepository.updatePreferences(next);
  },
};
