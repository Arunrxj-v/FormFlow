import { historyService } from './historyService';
import type { FormHistoryItem } from './types';

export const autofillService = {
  isDemo: false,

  async history(): Promise<FormHistoryItem[]> {
    return historyService.list();
  },
};
