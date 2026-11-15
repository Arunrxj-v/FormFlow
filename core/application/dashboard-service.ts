import type { ActivityItem, VaultDocument, VaultField } from '@shared/types';
import { activityRepository, collectionRepository, documentRepository, toVaultDocument, vaultRepository } from '../database/repositories';

export interface DashboardData {
  documents: VaultDocument[];
  fields: VaultField[];
  activity: ActivityItem[];
  stats: {
    totalDocuments: number;
    totalValues: number;
    verifiedValues: number;
    pendingReview: number;
    openConflicts: number;
    totalCollections: number;
    completedForms: number;
    processedDocuments: number;
    documentStorageBytes: number;
  };
}

export const dashboardService = {
  async load(): Promise<DashboardData> {
    const [documents, fields, activity, collections, conflicts] = await Promise.all([
      documentRepository.list().then((rows) => rows.map(({ row, name }) => toVaultDocument(row, name))),
      vaultRepository.listFields(),
      activityRepository.list(100),
      collectionRepository.list(),
      vaultRepository.listOpenConflicts(),
    ]);

    const processedDocuments = documents.filter((doc) => doc.status === 'completed' || doc.status === 'stored').length;
    const verifiedValues = fields.filter((field) => field.verificationStatus === 'user_verified').length;
    const pendingReview = fields.filter((field) => field.verificationStatus === 'extracted' || field.conflicts?.length).length;
    const documentStorageBytes = documents.reduce((sum, doc) => sum + doc.sizeBytes, 0);

    return {
      documents,
      fields,
      activity,
      stats: {
        totalDocuments: documents.length,
        totalValues: fields.length,
        verifiedValues,
        pendingReview,
        openConflicts: conflicts.length,
        totalCollections: collections.length,
        completedForms: activity.filter((item) => item.type === 'form_filled').length,
        processedDocuments,
        documentStorageBytes,
      },
    };
  },
};
