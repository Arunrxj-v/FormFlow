import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useToast } from './ToastContext';
import { dashboardService, profileService, vaultService } from '@/services/localApplication';
import { documentService as localDocumentService, revokeDocumentObjectUrls } from '@/services/documentService';
import { settingsService } from '@/services/settingsService';
import { vaultClient } from '@/services/vaultClient';
import type { VaultStatus } from '@/services/vaultClientTypes';
import type {
  ActivityItem,
  DocumentUploadProgress,
  DocumentExtractionSummary,
  DocumentUploadResult,
  ExtensionConnection,
  ModelSelfTestResult,
  ModelStatusSnapshot,
  Preferences,
  User,
  VaultDocument,
  VaultField,
  VaultRecord,
} from '@/services/types';

export type AuthState = 'unauthenticated' | 'authenticating' | 'authenticated' | 'session_expired' | 'auth_error';
export type ServiceStatus = 'online' | 'offline' | 'checking';
export type VaultState = 'loading' | 'no_vault' | 'migration_required' | 'locked' | 'unlocked' | 'error';

interface AppContextValue {
  vault: VaultRecord | null;
  vaultStatus: VaultStatus | null;
  vaultState: VaultState;
  user: User | null;
  authState: AuthState;
  serviceStatus: ServiceStatus;
  authError: string | null;
  authLoading: boolean;
  dataLoading: boolean;
  checkHealth: () => Promise<boolean>;
  documents: VaultDocument[];
  fields: VaultField[];
  activity: ActivityItem[];
  preferences: Preferences;
  extensionConnection: ExtensionConnection;
  createVault: (input: { name: string; passphrase: string }) => Promise<VaultRecord>;
  migratePlaintextVault: (passphrase: string) => Promise<VaultRecord | null>;
  unlockVault: (passphrase: string) => Promise<void>;
  lockVault: () => Promise<void>;
  changePassphrase: (currentPassphrase: string, newPassphrase: string) => Promise<void>;
  login: (email: string, password: string) => Promise<User>;
  signup: (name: string, email: string, password: string) => Promise<User>;
  logout: () => void;
  handleAuthSuccess: (token: string, initialUser?: User) => Promise<void>;
  updateProfile: (user: User) => void;
  uploadDocuments: (
    files: File[],
    options?: { onProgress?: (event: DocumentUploadProgress) => void },
  ) => Promise<DocumentUploadResult>;
  cancelDocumentUpload: (importId?: string) => Promise<void>;
  retryDocument: (id: string, options?: { onProgress?: (event: DocumentUploadProgress) => void }) => Promise<void>;
  removeDocument: (id: string) => Promise<void>;
  renameDocument: (id: string, name: string) => Promise<void>;
  unlinkDocument: (id: string) => Promise<void>;
  addField: (field: Omit<VaultField, 'id'>) => Promise<VaultField>;
  updateField: (id: string, value: string) => Promise<void>;
  deleteField: (id: string) => Promise<void>;
  resolveConflict: (id: string, value: string) => Promise<void>;
  verifyField: (id: string) => Promise<void>;
  extractDocument: (id: string, useAi?: boolean) => Promise<DocumentExtractionSummary>;
  modelStatus: ModelStatusSnapshot | null;
  refreshModelStatus: () => Promise<ModelStatusSnapshot | null>;
  installModel: () => Promise<void>;
  cancelModelInstall: () => Promise<void>;
  removeModel: () => Promise<void>;
  selfTestModel: () => Promise<ModelSelfTestResult>;
  upgradeModel: () => Promise<{ ok: boolean; message: string }>;
  cancelModelUpgrade: () => Promise<{ cancelled: boolean }>;
  rollbackModel: () => Promise<{ ok: boolean; message: string }>;
  cancelInference: () => Promise<void>;
  updatePreferences: (preferences: Preferences) => Promise<void>;
  refreshData: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

function deriveUser(profile: Awaited<ReturnType<typeof profileService.getProfile>>): User | null {
  if (!profile.name && !profile.email) return null;
  const parts = profile.name.trim().split(/\s+/);
  return {
    id: 'me',
    name: profile.name,
    firstName: parts[0] ?? 'there',
    email: profile.email,
    avatarInitials: ((parts[0]?.[0] ?? 'F') + (parts[1]?.[0] ?? 'F')).toUpperCase(),
    accountType: profile.accountType,
  };
}

const disconnectedExtension: ExtensionConnection = {
  installed: false,
  connected: false,
  version: '2.0.0',
  browser: 'Chrome',
  lastSync: 'Not connected',
  shortcut: 'Alt + F',
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [vault, setVault] = useState<VaultRecord | null>(null);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [vaultState, setVaultState] = useState<VaultState>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [authState, setAuthState] = useState<AuthState>('authenticating');
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>('checking');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [documents, setDocuments] = useState<VaultDocument[]>([]);
  const [fields, setFields] = useState<VaultField[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatusSnapshot | null>(null);
  const [preferences, setPreferences] = useState<Preferences>({
    confirmBeforeAutofill: true,
    requireSensitiveReview: true,
    allowLongAnswers: true,
    autoDownloadFiles: false,
    productNotifications: false,
    activityNotifications: true,
    compactMode: false,
    autoLockMinutes: 15,
    ocrLanguage: 'eng',
    autoDownloadModel: true,
  });
  const [extension] = useState<ExtensionConnection>(disconnectedExtension);
  const { toast } = useToast();
  const lockTimer = useRef<number | null>(null);
  const encryptionUpgradeStarted = useRef(false);
  const activeUploads = useRef(new Set<string>());
  const uploadCancelled = useRef(false);

  const clearSensitive = useCallback(() => {
    revokeDocumentObjectUrls();
    setVault(null);
    setUser(null);
    setDocuments([]);
    setFields([]);
    setActivity([]);
  }, []);

  const checkHealth = useCallback(async () => {
    setServiceStatus('online');
    return true;
  }, []);

  const loadData = useCallback(async () => {
    setDataLoading(true);
    try {
      const status = await vaultClient.status();
      setVaultStatus(status);
      const prefs = await settingsService.getPreferences();
      setPreferences(prefs);

      if (status.requiresEncryptionMigration) {
        clearSensitive();
        setVaultState('migration_required');
        setAuthState('unauthenticated');
        setServiceStatus('online');
        return;
      }

      if (!status.exists) {
        clearSensitive();
        setVaultState('no_vault');
        setAuthState('unauthenticated');
        setServiceStatus('online');
        return;
      }

      if (!status.unlocked) {
        clearSensitive();
        setVaultState('locked');
        setAuthState('session_expired');
        setServiceStatus('online');
        return;
      }

      if (status.requiresEncryptionUpgrade && !encryptionUpgradeStarted.current) {
        encryptionUpgradeStarted.current = true;
        void vaultClient.migrateEncryption()
          .then(() => loadData())
          .catch((error) => {
            encryptionUpgradeStarted.current = false;
            toast({
              tone: 'error',
              title: 'Encryption upgrade incomplete',
              message: error instanceof Error ? error.message : 'Unlock the vault and retry the upgrade.',
            });
          });
      }

      const data = await dashboardService.load();
      setVault(data.vault);
      setUser(deriveUser(data.profile));
      setDocuments(data.documents);
      setFields(data.fields);
      setActivity(data.activity);
      setVaultState('unlocked');
      setAuthState('authenticated');
      setAuthError(null);
      setServiceStatus('online');
      void vaultService.touch();
      void vaultClient.modelStatus().then(setModelStatus).catch(() => undefined);
    } catch (error) {
      const code = (error as { code?: string }).code;
      clearSensitive();
      if (code === 'VAULT_LOCKED' || code === 'SESSION_EXPIRED') {
        setVaultState('locked');
        setAuthState('session_expired');
        setServiceStatus('online');
      } else {
        console.error('Local vault load failed', error);
        setVaultState('error');
        setAuthState('auth_error');
        setAuthError(error instanceof Error ? error.message : 'Unable to open the local vault.');
        setServiceStatus('offline');
      }
    } finally {
      setDataLoading(false);
    }
  }, [clearSensitive, toast]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    return vaultClient.subscribeState(() => {
      void loadData();
    });
  }, [loadData]);

  useEffect(() => {
    // A long-lived port keeps the MV3 worker alive while the dashboard is open.
    // If the worker is still terminated, the vault locks and requires unlock.
    return vaultClient.keepAlive();
  }, []);

  const refreshModelStatus = useCallback(async (): Promise<ModelStatusSnapshot | null> => {
    try {
      const status = await vaultClient.modelStatus();
      setModelStatus(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (vaultState !== 'unlocked') return;
    void refreshModelStatus();
  }, [vaultState, refreshModelStatus]);

  useEffect(() => {
    if (!modelStatus) return;
    if (!['downloading', 'verifying', 'initializing'].includes(modelStatus.status)) return;
    const timer = window.setInterval(() => { void refreshModelStatus(); }, 1500);
    return () => window.clearInterval(timer);
  }, [modelStatus?.status, refreshModelStatus]);

  const createVault = useCallback(async (input: { name: string; passphrase: string }) => {
    const record = await vaultService.createVault(input);
    await loadData();
    return record;
  }, [loadData]);

  const migratePlaintextVault = useCallback(async (passphrase: string) => {
    const record = await vaultService.migratePlaintextVault(passphrase);
    await loadData();
    return record;
  }, [loadData]);

  const unlockVault = useCallback(async (passphrase: string) => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      await vaultClient.unlock(passphrase);
      try {
        await vaultClient.migrateEncryption();
      } catch (error) {
        toast({
          tone: 'error',
          title: 'Vault unlocked, upgrade incomplete',
          message: error instanceof Error ? error.message : 'Encryption upgrade needs to be retried.',
        });
      }
      await loadData();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Unable to unlock the vault.');
      throw error;
    } finally {
      setAuthLoading(false);
    }
  }, [loadData, toast]);

  const lockVault = useCallback(async () => {
    await vaultClient.lock();
    clearSensitive();
    setVaultState('locked');
    setVaultStatus((current) => (current ? { ...current, unlocked: false } : current));
    setAuthState('session_expired');
  }, [clearSensitive]);

  const changePassphrase = useCallback(async (currentPassphrase: string, newPassphrase: string) => {
    await vaultClient.changePassphrase(currentPassphrase, newPassphrase);
    toast({ tone: 'success', title: 'Vault passphrase changed' });
  }, [toast]);

  const login = useCallback(async (_email: string, _password: string) => {
    throw new Error('Use the local vault unlock screen.');
  }, []);

  const signup = useCallback(async (_name: string, _email: string, _password: string) => {
    throw new Error('Use the local vault setup screen.');
  }, []);

  const logout = useCallback(() => {
    void lockVault();
  }, [lockVault]);

  const handleAuthSuccess = useCallback(async (_token: string, _initialUser?: User) => {
    await loadData();
  }, [loadData]);

  const updateProfile = useCallback((nextUser: User) => {
    void profileService.saveProfile({ name: nextUser.name, email: nextUser.email }).then(() => {
      setUser(nextUser);
      toast({ tone: 'success', title: 'Profile updated', message: 'Saved to your encrypted local vault.' });
    });
  }, [toast]);

  const uploadDocuments = useCallback(async (
    files: File[],
    options?: { onProgress?: (event: DocumentUploadProgress) => void },
  ): Promise<DocumentUploadResult> => {
    const accepted: VaultDocument[] = [];
    const acceptedIndices: number[] = [];
    const rejected: DocumentUploadResult['rejected'] = [];
    const duplicates: DocumentUploadResult['duplicates'] = [];
    let cancelled = false;
    uploadCancelled.current = false;
    for (let index = 0; index < files.length; index += 1) {
      if (uploadCancelled.current) {
        cancelled = true;
        break;
      }
      const file = files[index]!;
      const importId = `import_${crypto.randomUUID()}`;
      activeUploads.current.add(importId);
      try {
        const result = await localDocumentService.importDocument(file, undefined, undefined, {
          importId,
          fileIndex: index,
          fileCount: files.length,
          onProgress: options?.onProgress,
        });
        if (result.duplicate) duplicates.push({ fileName: file.name, fileIndex: index, existingDocument: result.document });
        else {
          accepted.push(result.document);
          acceptedIndices.push(index);
        }
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'UNKNOWN';
        if (code === 'CANCELLED' || uploadCancelled.current) {
          cancelled = true;
          break;
        }
        rejected.push({
          fileName: file.name,
          fileIndex: index,
          code,
          message: error instanceof Error ? error.message : 'Document import failed.',
        });
      } finally {
        activeUploads.current.delete(importId);
      }
    }
    if (accepted.length) {
      await loadData();
      toast({
        tone: 'success',
        title: 'Documents stored securely',
        message: `${accepted.length} document(s) and their extracted text were encrypted in this vault.`,
      });
      if (preferences.autoDownloadModel !== false && modelStatus?.status === 'not_installed') {
        void vaultClient.installModel()
          .then(() => refreshModelStatus())
          .catch((error) => {
            toast({
              tone: 'error',
              title: 'Local model download could not start',
              message: error instanceof Error ? error.message : 'Open Settings → Local AI to retry.',
            });
          });
      }
    }
    if (duplicates.length) {
      toast({
        tone: 'info',
        title: 'Duplicate files skipped',
        message: duplicates.map((item) => `${item.fileName} already exists as ${item.existingDocument.name}`).join(' · '),
      });
    }
    if (rejected.length) {
      toast({
        tone: 'error',
        title: 'Some files could not be imported',
        message: rejected.map((item) => `${item.fileName}: ${item.message}`).join(' · '),
      });
    }
    if (cancelled) {
      toast({ tone: 'info', title: 'Import cancelled', message: 'No partial document or text was committed.' });
    }
    return { accepted, acceptedIndices, duplicates, rejected, cancelled };
  }, [loadData, toast, modelStatus?.status, refreshModelStatus, preferences.autoDownloadModel]);

  const cancelDocumentUpload = useCallback(async (importId?: string) => {
    uploadCancelled.current = true;
    const targets = importId && activeUploads.current.has(importId)
      ? [importId]
      : Array.from(activeUploads.current);
    await Promise.all(targets.map((id) => localDocumentService.cancelImport(id).catch(() => undefined)));
  }, []);

  const retryDocument = useCallback(async (
    id: string,
    options?: { onProgress?: (event: DocumentUploadProgress) => void },
  ) => {
    try {
      await localDocumentService.retryExtraction(id, { onProgress: options?.onProgress });
      await loadData();
      toast({ tone: 'success', title: 'Extraction refreshed', message: 'The encrypted text was replaced in one transaction.' });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'CANCELLED') return;
      toast({
        tone: 'error',
        title: 'Extraction failed',
        message: error instanceof Error ? error.message : 'The document could not be reprocessed.',
      });
      throw error;
    }
  }, [loadData, toast]);

  const removeDocument = useCallback(async (id: string) => {
    await localDocumentService.remove(id);
    await loadData();
    toast({ tone: 'success', title: 'Document removed', message: 'Encrypted file and metadata were deleted.' });
  }, [loadData, toast]);

  const renameDocument = useCallback(async (id: string, name: string) => {
    await localDocumentService.rename(id, name);
    await loadData();
    toast({ tone: 'success', title: 'Document renamed' });
  }, [loadData, toast]);

  const unlinkDocument = useCallback(async (_id: string) => {
    await loadData();
  }, [loadData]);

  const addField = useCallback(async (field: Omit<VaultField, 'id'>) => {
    const result = await profileService.addField(field);
    await loadData();
    toast({ tone: 'success', title: 'Value added to vault' });
    return result.field;
  }, [loadData, toast]);

  const updateField = useCallback(async (id: string, value: string) => {
    await profileService.updateField(id, value);
    await loadData();
    toast({ tone: 'success', title: 'Vault value updated' });
  }, [loadData, toast]);

  const deleteField = useCallback(async (id: string) => {
    await profileService.deleteField(id);
    await loadData();
    toast({ tone: 'success', title: 'Value removed' });
  }, [loadData, toast]);

  const resolveConflict = useCallback(async (id: string, value: string) => {
    await profileService.resolveConflict(id, value);
    await loadData();
    toast({ tone: 'success', title: 'Conflict resolved', message: 'Preferred value selected.' });
  }, [loadData, toast]);

  const verifyField = useCallback(async (id: string) => {
    await vaultClient.verifyField(id);
    await loadData();
    toast({ tone: 'success', title: 'Value verified', message: 'This value is now user-verified.' });
  }, [loadData, toast]);

  const extractDocument = useCallback(async (id: string, useAi = true): Promise<DocumentExtractionSummary> => {
    const summary = await vaultClient.extractDocument(id, useAi);
    await loadData();
    toast({
      tone: summary.warnings.length ? 'info' : 'success',
      title: 'Profile extraction complete',
      message: `${summary.candidates} value(s) linked from this document${summary.conflicts ? ` · ${summary.conflicts} conflict(s) to review` : ''}${summary.aiUsed ? ' · local AI assisted' : ''}${summary.warnings.length ? ` · ${summary.warnings[0]!.slice(0, 240)}` : ''}.`,
    });
    return summary;
  }, [loadData, toast]);

  const installModel = useCallback(async () => {
    try {
      await vaultClient.installModel();
      await refreshModelStatus();
      toast({ tone: 'info', title: 'Local model download started', message: 'You can keep using the dashboard while it downloads.' });
    } catch (error) {
      toast({
        tone: 'error',
        title: 'Could not start the model download',
        message: error instanceof Error ? error.message : 'Check local storage and retry from Settings → Local AI.',
      });
      throw error;
    }
  }, [refreshModelStatus, toast]);

  const cancelModelInstall = useCallback(async () => {
    await vaultClient.cancelModelInstall();
    await refreshModelStatus();
    toast({ tone: 'info', title: 'Model download cancelled', message: 'Partial files are cleaned up before the next attempt.' });
  }, [refreshModelStatus, toast]);

  const removeModel = useCallback(async () => {
    await vaultClient.removeModel();
    await refreshModelStatus();
    toast({ tone: 'success', title: 'Local model removed', message: 'Your vault data was not changed.' });
  }, [refreshModelStatus, toast]);

  const selfTestModel = useCallback(async (): Promise<ModelSelfTestResult> => {
    const result = await vaultClient.selfTestModel();
    await refreshModelStatus();
    return result;
  }, [refreshModelStatus]);

  const upgradeModel = useCallback(async () => {
    const result = await vaultClient.upgradeModel();
    await refreshModelStatus();
    toast({
      tone: result.ok ? 'success' : 'info',
      title: result.ok ? 'Model upgraded' : 'Model upgrade unavailable',
      message: result.message,
    });
    return { ok: result.ok, message: result.message };
  }, [refreshModelStatus, toast]);

  const cancelModelUpgrade = useCallback(async () => {
    const result = await vaultClient.cancelModelUpgrade();
    await refreshModelStatus();
    return result;
  }, [refreshModelStatus]);

  const rollbackModel = useCallback(async () => {
    const result = await vaultClient.rollbackModel();
    await refreshModelStatus();
    toast({
      tone: result.ok ? 'success' : 'error',
      title: result.ok ? 'Model rolled back' : 'Rollback unavailable',
      message: result.message,
    });
    return { ok: result.ok, message: result.message };
  }, [refreshModelStatus, toast]);

  const cancelInference = useCallback(async () => {
    await vaultClient.cancelInference();
    await refreshModelStatus();
    toast({ tone: 'info', title: 'Local inference cancelled' });
  }, [refreshModelStatus, toast]);

  const updatePreferences = useCallback(async (next: Preferences) => {
    const saved = await settingsService.updatePreferences(next);
    setPreferences(saved);
    toast({ tone: 'success', title: 'Preferences saved' });
  }, [toast]);

  useEffect(() => {
    if (vaultState !== 'unlocked' || !preferences.autoLockMinutes || preferences.autoLockMinutes <= 0) {
      if (lockTimer.current) window.clearTimeout(lockTimer.current);
      return;
    }
    const timeoutMs = preferences.autoLockMinutes * 60_000;
    const reset = () => {
      if (lockTimer.current) window.clearTimeout(lockTimer.current);
      lockTimer.current = window.setTimeout(() => { void lockVault(); }, timeoutMs);
    };
    reset();
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart', 'scroll'];
    for (const event of events) window.addEventListener(event, reset, { passive: true });
    return () => {
      if (lockTimer.current) window.clearTimeout(lockTimer.current);
      for (const event of events) window.removeEventListener(event, reset);
    };
  }, [vaultState, preferences.autoLockMinutes, lockVault]);

  const value = useMemo<AppContextValue>(() => ({
    vault,
    vaultStatus,
    vaultState,
    user,
    authState,
    serviceStatus,
    authError,
    authLoading,
    dataLoading,
    checkHealth,
    documents,
    fields,
    activity,
    preferences,
    extensionConnection: extension,
    createVault,
    migratePlaintextVault,
    unlockVault,
    lockVault,
    changePassphrase,
    login,
    signup,
    logout,
    handleAuthSuccess,
    updateProfile,
    uploadDocuments,
    cancelDocumentUpload,
    retryDocument,
    removeDocument,
    renameDocument,
    unlinkDocument,
    addField,
    updateField,
    deleteField,
    resolveConflict,
    verifyField,
    extractDocument,
    modelStatus,
    refreshModelStatus,
    installModel,
    cancelModelInstall,
    removeModel,
    selfTestModel,
    upgradeModel,
    cancelModelUpgrade,
    rollbackModel,
    cancelInference,
    updatePreferences,
    refreshData: loadData,
  }), [
    vault, vaultStatus, vaultState, user, authState, serviceStatus, authError, authLoading, dataLoading,
    checkHealth, documents, fields, activity, preferences, extension, createVault, migratePlaintextVault,
    unlockVault, lockVault, changePassphrase, login, signup, logout, handleAuthSuccess,
    updateProfile, uploadDocuments, cancelDocumentUpload, retryDocument, removeDocument, renameDocument,
    unlinkDocument, addField, updateField, deleteField, resolveConflict, verifyField, extractDocument,
    modelStatus, refreshModelStatus, installModel, cancelModelInstall, removeModel, selfTestModel,
    upgradeModel, cancelModelUpgrade, rollbackModel, cancelInference,
    updatePreferences, loadData,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>.');
  return value;
}
