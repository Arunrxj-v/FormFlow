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
import { dashboardService, vaultService } from '@/services/localApplication';
import { documentService as localDocumentService } from '@/services/documentService';
import { profileService } from '@/services/localApplication';
import { settingsService } from '@/services/settingsService';
import { vaultManager } from '../../core/vault/vault-manager';
import { vaultSession } from '../../core/vault/vault-session';
import type { VaultStatus } from '../../core/vault/vault-manager';
import type {
  ActivityItem,
  DriveConnection,
  ExtensionConnection,
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
  driveConnection: DriveConnection;
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
  refreshDrive: () => Promise<DriveConnection>;
  updateProfile: (user: User) => void;
  addDriveDocuments: (files: Array<{ id: string; name: string; category: DocumentCategoryLike; subcategory: string }>) => Promise<VaultDocument[]>;
  uploadDocuments: (files: File[]) => Promise<{ accepted: VaultDocument[]; rejected: string[]; duplicates: string[] }>;
  retryDocument: (id: string) => Promise<void>;
  removeDocument: (id: string) => Promise<void>;
  renameDocument: (id: string, name: string) => Promise<void>;
  unlinkDocument: (id: string) => Promise<void>;
  addField: (field: Omit<VaultField, 'id'>) => Promise<VaultField>;
  updateField: (id: string, value: string) => Promise<void>;
  deleteField: (id: string) => Promise<void>;
  resolveConflict: (id: string, value: string) => Promise<void>;
  updatePreferences: (preferences: Preferences) => Promise<void>;
  refreshData: () => Promise<void>;
}

type DocumentCategoryLike = VaultDocument['category'];

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

const disconnectedDrive: DriveConnection = {
  connected: false,
  accountEmail: '',
  targetFolder: '',
  storageUsed: '',
  storageTotal: '',
  lastSync: 'Not connected',
  permissions: [],
  isDemo: false,
};

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
  });
  const [drive] = useState<DriveConnection>(disconnectedDrive);
  const [extension] = useState<ExtensionConnection>(disconnectedExtension);
  const { toast } = useToast();
  const lockTimer = useRef<number | null>(null);

  const clearSensitive = useCallback(() => {
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
      const status = await vaultManager.status();
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

      const activeVault = await vaultService.getActiveVault();
      setVault(activeVault);
      const profile = await profileService.getProfile();
      setUser(deriveUser(profile));
      const data = await dashboardService.load();
      setDocuments(data.documents);
      setFields(data.fields);
      setActivity(data.activity);
      setVaultState('unlocked');
      setAuthState('authenticated');
      setAuthError(null);
      setServiceStatus('online');
      void vaultService.touch();
    } catch (error) {
      console.error('Local vault load failed', error);
      clearSensitive();
      setVaultState('error');
      setAuthState('auth_error');
      setAuthError(error instanceof Error ? error.message : 'Unable to open the local vault.');
      setServiceStatus('offline');
    } finally {
      setDataLoading(false);
    }
  }, [clearSensitive]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    return vaultSession.subscribe(() => {
      void loadData();
    });
  }, [loadData]);

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
      await vaultManager.unlock(passphrase);
      await loadData();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Unable to unlock the vault.');
      throw error;
    } finally {
      setAuthLoading(false);
    }
  }, [loadData]);

  const lockVault = useCallback(async () => {
    await vaultManager.lock();
    clearSensitive();
    setVaultState('locked');
    setVaultStatus((current) => (current ? { ...current, unlocked: false } : current));
    setAuthState('session_expired');
  }, [clearSensitive]);

  const changePassphrase = useCallback(async (currentPassphrase: string, newPassphrase: string) => {
    await vaultManager.changePassword(currentPassphrase, newPassphrase);
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

  const refreshDrive = useCallback(async () => disconnectedDrive, []);

  const updateProfile = useCallback((nextUser: User) => {
    void profileService.saveProfile({ name: nextUser.name, email: nextUser.email }).then(() => {
      setUser(nextUser);
      toast({ tone: 'success', title: 'Profile updated', message: 'Saved to your encrypted local vault.' });
    });
  }, [toast]);

  const addDriveDocuments = useCallback(async () => [], []);

  const uploadDocuments = useCallback(async (files: File[]) => {
    const accepted: VaultDocument[] = [];
    const rejected: string[] = [];
    const duplicates: string[] = [];
    for (const file of files) {
      try {
        const result = await localDocumentService.importDocument(file);
        if (result.duplicate) duplicates.push(file.name);
        else accepted.push(result.document);
      } catch (error) {
        rejected.push(file.name);
        if (error instanceof Error) console.warn(`Import rejected: ${error.message}`);
      }
    }
    if (accepted.length) {
      await loadData();
      toast({ tone: 'success', title: 'Document encrypted locally', message: `${accepted.length} document(s) added to your vault.` });
    }
    if (duplicates.length) {
      toast({ tone: 'info', title: 'Duplicate files skipped', message: `${duplicates.length} identical file(s) already exist in this vault.` });
    }
    if (rejected.length) {
      toast({ tone: 'error', title: 'Some files could not be imported', message: `${rejected.join(', ')} failed validation.` });
    }
    return { accepted, rejected, duplicates };
  }, [loadData, toast]);

  const retryDocument = useCallback(async (_id: string) => {
    await loadData();
  }, [loadData]);

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
    driveConnection: drive,
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
    refreshDrive,
    updateProfile,
    addDriveDocuments,
    uploadDocuments,
    retryDocument,
    removeDocument,
    renameDocument,
    unlinkDocument,
    addField,
    updateField,
    deleteField,
    resolveConflict,
    updatePreferences,
    refreshData: loadData,
  }), [
    vault, vaultStatus, vaultState, user, authState, serviceStatus, authError, authLoading, dataLoading,
    checkHealth, documents, fields, activity, preferences, drive, extension, createVault, migratePlaintextVault,
    unlockVault, lockVault, changePassphrase, login, signup, logout, handleAuthSuccess, refreshDrive,
    updateProfile, addDriveDocuments, uploadDocuments, retryDocument, removeDocument, renameDocument,
    unlinkDocument, addField, updateField, deleteField, resolveConflict, updatePreferences, loadData,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>.');
  return value;
}
