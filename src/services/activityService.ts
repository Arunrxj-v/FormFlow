import { activityRepository } from '../../core/database/repositories';
import type { ActivityItem } from '../../shared/types';

export const activityService = {
  isLocal: true,

  list(): Promise<ActivityItem[]> {
    return activityRepository.list(100);
  },

  record(item: Omit<ActivityItem, 'id' | 'timestamp' | 'relativeTime'>): Promise<ActivityItem> {
    return activityRepository.record(item.type, item.title, item.detail).then(() => ({
      ...item,
      id: `act_${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      relativeTime: 'Just now',
    }));
  },
};
