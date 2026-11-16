import { vaultClient } from '@/services/vaultClient';
import type { ActivityItem } from '../../shared/types';

export const activityService = {
  isLocal: true,
  list(): Promise<ActivityItem[]> {
    return vaultClient.listActivity();
  },
  async record(item: Omit<ActivityItem, 'id' | 'timestamp' | 'relativeTime'>): Promise<ActivityItem> {
    await vaultClient.recordActivity(item);
    return {
      ...item,
      id: `act_${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      relativeTime: 'Just now',
    };
  },
};
