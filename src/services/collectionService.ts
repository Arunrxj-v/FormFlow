import { apiRequest } from './apiClient';
import type { Collection } from './types';

export const collectionService = {
  isDemo: false,

  async list(): Promise<Collection[]> {
    try {
      const data = await apiRequest<{ collections: Collection[] }>('/api/collections');
      return Array.isArray(data?.collections) ? data.collections : [];
    } catch {
      return [];
    }
  },

  async create(input: Pick<Collection, 'name' | 'description' | 'documentIds' | 'notes'>): Promise<Collection> {
    const data = await apiRequest<{ collection: Collection }>('/api/collections', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return data.collection;
  },

  async update(id: string, patch: Partial<Pick<Collection, 'name' | 'description' | 'documentIds' | 'notes'>>): Promise<Collection | null> {
    const data = await apiRequest<{ collection: Collection }>(`/api/collections/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return data.collection || null;
  },

  async remove(id: string): Promise<void> {
    await apiRequest(`/api/collections/${id}`, { method: 'DELETE' });
  },
};
