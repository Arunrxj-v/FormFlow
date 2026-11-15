import { apiRequest } from './apiClient';
import type { DriveConnection, DriveFile } from './types';

const defaultStatus: DriveConnection = {
  connected: false,
  accountEmail: '',
  accountName: '',
  targetFolder: '/FormFlow Vault/',
  storageUsed: '0 MB',
  storageTotal: '15 GB',
  lastSync: 'Not synced',
  permissions: [],
  isDemo: false,
};

export const googleDriveService = {
  isDemo: false,

  async getConnection(): Promise<DriveConnection> {
    try {
      const data = await apiRequest<{ drive: { connected: boolean; accountEmail?: string; accountName?: string; lastSync?: string; isConfigured?: boolean } }>('/api/drive/status');
      if (!data?.drive) return defaultStatus;
      return {
        ...defaultStatus,
        connected: Boolean(data.drive.connected),
        accountEmail: data.drive.accountEmail || '',
        accountName: data.drive.accountName || '',
        lastSync: data.drive.lastSync || 'Not synced',
      };
    } catch {
      return defaultStatus;
    }
  },

  async listFiles(): Promise<DriveFile[]> {
    try {
      const data = await apiRequest<{ files: DriveFile[] }>('/api/drive/files');
      return Array.isArray(data.files) ? data.files : [];
    } catch {
      return [];
    }
  },

  async getAuthUrl(): Promise<string> {
    const data = await apiRequest<{ url: string }>('/api/auth/google/url?intent=drive');
    return data.url;
  },

  async connect(): Promise<DriveConnection> {
    const url = await this.getAuthUrl();
    if (typeof window !== 'undefined') {
      window.location.href = url;
    }
    return defaultStatus;
  },

  async disconnect(): Promise<void> {
    await apiRequest('/api/drive/disconnect', { method: 'POST', body: '{}' });
  },

  async importFile(fileId: string, name: string, category: string, subcategory = ''): Promise<any> {
    return apiRequest('/api/drive/import', {
      method: 'POST',
      body: JSON.stringify({ fileId, name, category, subcategory }),
    });
  },
};
