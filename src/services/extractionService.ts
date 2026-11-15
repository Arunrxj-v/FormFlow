import { apiRequest } from './apiClient';
import type { VaultField } from './types';

export const extractionService = {
  isDemo: false,

  async list(): Promise<VaultField[]> {
    try {
      const data = await apiRequest<{ fields: VaultField[] }>('/api/fields');
      return Array.isArray(data.fields) ? data.fields : [];
    } catch {
      return [];
    }
  },

  async update(fieldId: string, value: string): Promise<VaultField | undefined> {
    const data = await apiRequest<{ field: VaultField }>(`/api/fields/${fieldId}`, {
      method: 'PATCH',
      body: JSON.stringify({ value }),
    });
    return data.field;
  },

  async remove(fieldId: string): Promise<void> {
    await apiRequest(`/api/fields/${fieldId}`, { method: 'DELETE' });
  },

  async resolveConflict(fieldId: string, value: string): Promise<VaultField | undefined> {
    const data = await apiRequest<{ field: VaultField }>(`/api/fields/${fieldId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ value }),
    });
    return data.field;
  },

  async add(field: Omit<VaultField, 'id'>): Promise<VaultField> {
    const data = await apiRequest<{ field: VaultField }>('/api/fields', {
      method: 'POST',
      body: JSON.stringify(field),
    });
    return data.field;
  },
};
