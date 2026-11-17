/**
 * Localhost development implementation of the vault client.
 *
 * This module is aliased into the localhost dashboard by vite.config.ts and is
 * deliberately NOT packaged into the extension build. The extension build uses
 * src/services/vaultClient.ts, which can only reach the background router.
 */
import type {
  AddressRecord,
  ActivityItem,
  CertificationRecord,
  Collection,
  EducationRecord,
  EmploymentRecord,
  FormHistoryItem,
  Preferences,
  ProjectRecord,
  SkillRecord,
  StorageEstimate,
  VaultDocument,
  VaultField,
  VaultFieldInput,
  VaultProfile,
  VaultRecord,
} from '@shared/types';
import { dashboardService } from '../../core/application/dashboard-service';
import { documentService } from '../../core/application/document-service';
import { parseDocument } from '../../core/documents/parsers';
import { profileRecordService, profileService } from '../../core/application/profile-service';
import { extractDocumentInformation } from '../../core/application/extraction-service';
import { historyService } from '../../core/application/history-service';
import { vaultService } from '../../core/application/vault-service';
import { activityRepository, collectionRepository, profileRecordRepository, settingsRepository } from '../../core/database/repositories';
import { vaultManager } from '../../core/vault/vault-manager';
import { vaultSession } from '../../core/vault/vault-session';
import { encryptionV2Migration } from '../../core/vault/encryption-v2-migration';
import { checkVaultIntegrity } from '../../core/vault/vault-integrity';
import { vaultExportService } from '../../core/storage/vault-export';
import { legacyMigrationService } from '../../core/migration/legacy-migration-service';
import { quotaManager } from '../../core/storage/quota-manager';
import type {
  DashboardPayload,
  DocumentImportResult,
  EncryptionStatus,
  LegacyMigrationSummary,
  ProfileRecordType,
  VaultClientApi,
  VaultImportResult,
  VaultIntegrityReport,
  VaultStateEvent,
  VaultStatus,
} from '../services/vaultClientTypes';

export const vaultClient: VaultClientApi = {
  status: () => vaultManager.status(),
  createVault: async (input) => {
    const vault = await vaultService.createVault(input);
    return { vault, status: await vaultManager.status() };
  },
  migratePlaintextVault: (passphrase) => vaultService.migratePlaintextVault(passphrase),
  unlock: async (passphrase) => {
    await vaultManager.unlock(passphrase);
    return vaultManager.status();
  },
  lock: async () => {
    await vaultManager.lock();
    return vaultManager.status();
  },
  destroy: () => vaultManager.destroyVault(),
  changePassphrase: (currentPassphrase, newPassphrase) => vaultManager.changePassword(currentPassphrase, newPassphrase),
  getActiveVault: () => vaultService.getActiveVault(),
  updateVault: (patch) => vaultService.updateVault(patch),
  touch: () => vaultService.touch(),
  getProfile: () => profileService.getProfile(),
  updateProfile: (patch) => profileService.saveProfile(patch),
  getDashboardData: async (): Promise<DashboardPayload> => {
    const [vault, profile, data] = await Promise.all([
      vaultService.getActiveVault(),
      profileService.getProfile(),
      dashboardService.load(),
    ]);
    return { vault, profile, ...data };
  },
  listFields: () => profileService.listFields(),
  addField: (field: VaultFieldInput) => profileService.addField(field),
  updateField: (id, value) => profileService.updateField(id, value),
  deleteField: (id) => profileService.deleteField(id),
  resolveConflict: (id, value) => profileService.resolveConflict(id, value),
  verifyField: (id) => profileService.verifyField(id),
  extractDocument: (id) => extractDocumentInformation(id),
  modelStatus: async () => ({
    status: 'not_installed',
    ready: false,
    record: null,
    capabilities: { webgpu: false, wasm: true, hardwareConcurrency: 1 },
    preferredVariant: 'q8',
    storage: await quotaManager.estimate(),
    message: 'Local model lifecycle is available in the installed Chrome extension build.',
  }),
  installModel: async () => {
    throw new Error('Install the FormFlow Chrome extension to manage the local AI model.');
  },
  cancelModelInstall: async () => ({ cancelled: false }),
  removeModel: async () => undefined,
  selfTestModel: async () => ({
    ok: false,
    runtime: 'wasm',
    variant: 'q8',
    message: 'Local inference is available in the installed Chrome extension build.',
  }),
  cancelInference: async () => ({ cancelled: false }),
  listDocuments: () => documentService.list(),
  getDocument: (id) => documentService.get(id),
  importDocument: (file, category, subcategory, options): Promise<DocumentImportResult> =>
    documentService.importDocument({
      file,
      category,
      subcategory,
      onProgress: options?.onProgress
        ? (event) => options.onProgress!({
          ...event,
          importId: options.importId ?? 'local',
          fileIndex: options.fileIndex ?? 0,
          fileCount: options.fileCount ?? 1,
        })
        : undefined,
    }, { parse: parseDocument }),
  cancelDocumentImport: async () => ({ cancelled: false }),
  retryDocumentExtraction: (id, options) => documentService.retryExtraction(id, {
    parse: parseDocument,
    onProgress: options?.onProgress
      ? (event) => options.onProgress!({
        ...event,
        importId: options.importId ?? 'local-retry',
        fileIndex: 0,
        fileCount: 1,
      })
      : undefined,
  }),
  getDocumentText: async (id, maxChars) => {
    const result = await documentService.getText(id);
    if (!result) return null;
    const limit = typeof maxChars === 'number' ? Math.max(1_000, Math.min(10_000_000, maxChars)) : 200_000;
    return {
      ...result,
      text: result.text.slice(0, limit),
      truncated: result.text.length > limit,
    };
  },
  renameDocument: (id, name) => documentService.rename(id, name),
  deleteDocument: (id) => documentService.remove(id),
  getDocumentBlob: async (id) => {
    const document = await documentService.get(id);
    const blob = await documentService.getBlob(id);
    if (!document || !blob) return null;
    return { blob, mimeType: document.mimeType };
  },
  listCollections: () => collectionRepository.list(),
  createCollection: (input) => collectionRepository.create(input),
  updateCollection: (id, patch) => collectionRepository.update(id, patch),
  deleteCollection: (id) => collectionRepository.remove(id),
  listActivity: () => activityRepository.list(100),
  recordActivity: async (item) => {
    await activityRepository.record(item.type, item.title, item.detail);
  },
  getHistory: () => historyService.list(),
  recordHistory: (entry) => historyService.record(entry),
  clearHistory: () => historyService.clear(),
  getPreferences: () => settingsRepository.getPreferences(),
  updatePreferences: (preferences: Preferences) => settingsRepository.updatePreferences(preferences),
  listProfileRecords: async <T>(type: ProfileRecordType): Promise<T[]> => {
    switch (type) {
      case 'address':
        return (await profileRecordService.listAddresses()) as T[];
      case 'education':
        return (await profileRecordService.listEducation()) as T[];
      case 'employment':
        return (await profileRecordService.listEmployment()) as T[];
      case 'skill':
        return (await profileRecordService.listSkills()) as T[];
      case 'certification':
        return (await profileRecordService.listCertifications()) as T[];
      case 'project':
        return (await profileRecordService.listProjects()) as T[];
    }
  },
  saveProfileRecord: async <T>(type: ProfileRecordType, record: T, documentId?: string): Promise<T> => {
    switch (type) {
      case 'address':
        return (await profileRecordService.saveAddress(record as Partial<AddressRecord> & Pick<AddressRecord, 'addressLine1'>)) as T;
      case 'education':
        return (await profileRecordService.saveEducation(record as EducationRecord, documentId)) as T;
      case 'employment':
        return (await profileRecordService.saveEmployment(record as EmploymentRecord, documentId)) as T;
      case 'skill':
        return (await profileRecordService.saveSkill(record as Omit<SkillRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string })) as T;
      case 'certification':
        return (await profileRecordService.saveCertification(record as Omit<CertificationRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string })) as T;
      case 'project':
        return (await profileRecordService.saveProject(record as Omit<ProjectRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string })) as T;
    }
  },
  removeProfileRecord: (id) => profileRecordRepository.remove(id),
  exportVault: (passphrase) => vaultExportService.exportEncrypted(passphrase),
  importVault: (file, passphrase): Promise<VaultImportResult> => vaultExportService.importEncrypted(file, passphrase),
  storageEstimate: (): Promise<StorageEstimate> => quotaManager.estimate(),
  encryptionStatus: (): Promise<EncryptionStatus> => encryptionV2Migration.status(),
  migrateEncryption: (): Promise<EncryptionStatus> => encryptionV2Migration.runIfNeeded(),
  checkIntegrity: (): Promise<VaultIntegrityReport> => checkVaultIntegrity(),
  subscribeState: (listener) => {
    const emit = () => {
      const state: VaultStateEvent = {
        state: 'locked',
        generation: vaultSession.getGeneration(),
        updatedAt: new Date().toISOString(),
      };
      void vaultSession.isUnlocked().then((unlocked) => {
        listener({ ...state, state: unlocked ? 'unlocked' : 'locked' });
      });
    };
    emit();
    return vaultSession.subscribe(() => emit());
  },
  keepAlive: () => () => undefined,
  legacyBackendStatus: async () => {
    const snapshot = await legacyMigrationService.probe();
    return { user: snapshot.user ? { email: snapshot.user.email } : null };
  },
  legacyBackendMigrate: async (email, password): Promise<LegacyMigrationSummary> => {
    if (email.trim() && password) await legacyMigrationService.login(email, password);
    return legacyMigrationService.migrate();
  },
};
