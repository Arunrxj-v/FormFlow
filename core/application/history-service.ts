import type { FormHistoryItem } from '@shared/types';
import { activityRepository, historyRepository } from '../database/repositories';

export const historyService = {
  async list(): Promise<FormHistoryItem[]> {
    return historyRepository.list();
  },

  async record(entry: {
    website: string;
    pageTitle?: string;
    url: string;
    documentsUsed?: string[];
    detected: number;
    filled: number;
    review: number;
    status: FormHistoryItem['status'];
    durationMs: number;
  }): Promise<void> {
    await historyRepository.record(entry);
    await activityRepository.record(
      'form_filled',
      entry.website,
      `${entry.filled}/${entry.detected} fields filled`,
    );
  },

  async clear(): Promise<void> {
    await historyRepository.clear();
    await activityRepository.record('document_removed', 'History cleared', 'Autofill history reset.');
  },
};
