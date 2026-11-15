import { historyService as coreHistoryService } from '../../core/application/history-service';
import type { FormHistoryItem } from '../../shared/types';

export const historyService = {
  isLocal: true,

  list(): Promise<FormHistoryItem[]> {
    return coreHistoryService.list();
  },

  record(entry: {
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
    return coreHistoryService.record(entry);
  },

  clear(): Promise<void> {
    return coreHistoryService.clear();
  },
};
