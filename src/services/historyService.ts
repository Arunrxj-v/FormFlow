import { apiRequest } from './apiClient';
import type { FormHistoryItem } from './types';

export const historyService = {
  isDemo: false,

  async list(): Promise<FormHistoryItem[]> {
    try {
      const data = await apiRequest<{ history: FormHistoryItem[] }>('/api/history');
      return Array.isArray(data?.history) ? data.history : [];
    } catch {
      return [];
    }
  },

  async record(entry: { website: string; url: string; collectionId?: string; detected: number; filled: number; skipped: number; status: string; duration: number }): Promise<void> {
    await apiRequest('/api/history', {
      method: 'POST',
      body: JSON.stringify(entry),
    });
  },

  async clear(): Promise<void> {
    // No-op or clear
  },
};
