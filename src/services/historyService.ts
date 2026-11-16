import { vaultClient } from '@/services/vaultClient';
import type { FormHistoryItem } from '../../shared/types';

export const historyService = {
  isLocal: true,
  list: () => vaultClient.getHistory(),
  record: (entry: {
    website: string;
    pageTitle?: string;
    url: string;
    documentsUsed?: string[];
    detected: number;
    filled: number;
    review: number;
    status: FormHistoryItem['status'];
    durationMs: number;
  }) => vaultClient.recordHistory(entry),
  clear: () => vaultClient.clearHistory(),
};
