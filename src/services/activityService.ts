import { apiRequest } from './apiClient';
import type { ActivityItem } from './types';

export const activityService = {
  isDemo: false,

  async list(): Promise<ActivityItem[]> {
    try {
      const data = await apiRequest<{ activity: ActivityItem[] }>('/api/activity');
      return Array.isArray(data?.activity) ? data.activity : [];
    } catch {
      return [];
    }
  },

  async record(item: Omit<ActivityItem, 'id' | 'timestamp' | 'relativeTime'>): Promise<ActivityItem> {
    const created: ActivityItem = {
      ...item,
      id: `act_${Date.now()}`,
      timestamp: new Date().toISOString(),
      relativeTime: 'Just now',
    };
    return created;
  },
};
