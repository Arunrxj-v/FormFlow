import { localCollectionService } from './localApplication';
import type { Collection } from '../../shared/types';

export const collectionService = {
  isLocal: true,

  list(): Promise<Collection[]> {
    return localCollectionService.list();
  },

  create(input: Pick<Collection, 'name' | 'description' | 'documentIds' | 'notes'> & { color?: string }): Promise<Collection> {
    return localCollectionService.create(input);
  },

  update(id: string, patch: Partial<Pick<Collection, 'name' | 'description' | 'documentIds' | 'notes' | 'color'>>): Promise<Collection | null> {
    return localCollectionService.update(id, patch);
  },

  remove(id: string): Promise<void> {
    return localCollectionService.remove(id);
  },
};
