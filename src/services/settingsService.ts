import { apiRequest } from './apiClient';
import type { Preferences } from './types';

const defaultPreferences: Preferences = {
  confirmBeforeAutofill: true,
  requireSensitiveReview: true,
  autoDownloadFiles: false,
  activityNotifications: true,
  productNotifications: false,
  compactMode: false,
};

export const settingsService = {
  isDemo: false,

  async getPreferences(): Promise<Preferences> {
    try {
      const data = await apiRequest<{ preferences: Preferences }>('/api/preferences');
      return data?.preferences ? { ...defaultPreferences, ...data.preferences } : defaultPreferences;
    } catch {
      return defaultPreferences;
    }
  },

  async updatePreferences(next: Preferences): Promise<Preferences> {
    try {
      const data = await apiRequest<{ preferences: Preferences }>('/api/preferences', {
        method: 'PUT',
        body: JSON.stringify(next),
      });
      return data.preferences;
    } catch {
      return next;
    }
  },
};
