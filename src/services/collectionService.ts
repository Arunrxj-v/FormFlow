import { vaultClient } from '@/services/vaultClient';
import type { Collection } from '../../shared/types';

export const collectionService = {
  isLocal: true,
  list(): Promise<Collection[]> {
    return vaultClient.listCollections();
  },
  create(input: Pick<Collection, 'name' | 'description' | 'documentIds' | 'notes'> & { color?: string }): Promise<Collection> {
    return vaultClient.createCollection(input);
  },
  update(id: string, patch: Partial<Pick<Collection, 'name' | 'description' | 'documentIds' | 'notes' | 'color'>>): Promise<Collection | null> {
    return vaultClient.updateCollection(id, patch);
  },
  remove(id: string): Promise<void> {
    return vaultClient.deleteCollection(id);
  },
};
