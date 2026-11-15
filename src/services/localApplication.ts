import { dashboardService as coreDashboardService, type DashboardData } from '../../core/application/dashboard-service';
import { documentService as coreDocumentService } from '../../core/application/document-service';
import { profileRecordService as coreProfileRecordService, profileService as coreProfileService } from '../../core/application/profile-service';
import { historyService as coreHistoryService } from '../../core/application/history-service';
import { vaultService as coreVaultService } from '../../core/application/vault-service';
import { collectionRepository } from '../../core/database/repositories';

export const dashboardService = coreDashboardService;
export const documentService = coreDocumentService;
export const profileRecordService = coreProfileRecordService;
export const profileService = coreProfileService;
export const historyService = coreHistoryService;
export const vaultService = coreVaultService;

export const localCollectionService = {
  list: () => collectionRepository.list(),
  create: (input: { name: string; description?: string; notes?: string; color?: string; documentIds?: string[] }) => collectionRepository.create(input),
  update: (id: string, patch: { name?: string; description?: string; notes?: string; color?: string; documentIds?: string[] }) => collectionRepository.update(id, patch),
  remove: (id: string) => collectionRepository.remove(id),
};

export type { DashboardData };
