import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { authService } from '@/services/authService';
import { documentService } from '@/services/documentService';
import { extractionService } from '@/services/extractionService';
import { activityService } from '@/services/activityService';
import { googleDriveService } from '@/services/googleDriveService';
import { settingsService } from '@/services/settingsService';
import { clearAuthStorage, setStoredToken, setStoredUser } from '@/services/apiClient';
import { useToast } from './ToastContext';
import type {
  ActivityItem,
  DriveConnection,
  DriveFile,
  ExtensionConnection,
  Preferences,
  User,
  VaultDocument,
  VaultField,
} from '@/services/types';

export type AuthState = 'unauthenticated' | 'authenticating' | 'authenticated' | 'session_expired' | 'auth_error';
export type ServiceStatus = 'online' | 'offline' | 'checking';

interface AppContextValue {
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
  login: (email: string, password: string) => Promise<User>;
  signup: (name: string, email: string, password: string) => Promise<User>;
  logout: () => void;
  handleAuthSuccess: (token: string, initialUser?: User) => Promise<void>;
  refreshDrive: () => Promise<DriveConnection>;
  updateProfile: (user: User) => void;
  addDriveDocuments: (files: DriveFile[]) => Promise<VaultDocument[]>;
  uploadDocuments: (files: File[]) => Promise<{ accepted: VaultDocument[]; rejected: string[] }>;
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

const AppContext = createContext<AppContextValue | null>(null);

// Purge legacy mock storage keys on startup
try {
  localStorage.removeItem('formflow.demo.session.v1');
  localStorage.removeItem('formflow.demo.store.v2');
  localStorage.removeItem('formflow.demo.records');
  localStorage.removeItem('formflow.demo.store');
  const storedUserRaw = localStorage.getItem('formflow.auth.user');
  if (storedUserRaw && (storedUserRaw.includes('usr_demo_arun') || storedUserRaw.includes('arun@example.com'))) {
    localStorage.removeItem('formflow.auth.user');
    localStorage.removeItem('formflow.auth.token');
  }
} catch {
  // Ignore localStorage errors
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => authService.getSession());
  const [authState, setAuthState] = useState<AuthState>(() => (authService.getSession() ? 'authenticating' : 'unauthenticated'));
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
    autoDownloadFiles: false,
    activityNotifications: true,
    productNotifications: false,
    compactMode: false,
  });
  const [drive, setDrive] = useState<DriveConnection>({
    connected: false,
    accountEmail: '',
    targetFolder: '/FormFlow Vault/',
    storageUsed: '0 MB',
    storageTotal: '15 GB',
    lastSync: 'Not synced',
    permissions: [],
    isDemo: false,
  });
  const [extension, setExtension] = useState<ExtensionConnection>({
    installed: false,
    connected: false,
    browser: 'Chrome',
    version: '1.4.0',
    lastSync: 'Never',
    shortcut: 'Alt + F',
  });
  const { toast } = useToast();

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        setServiceStatus('online');
        return true;
      }
      setServiceStatus('offline');
      return false;
    } catch {
      setServiceStatus('offline');
      return false;
    }
  }, []);

  // Extension connectivity check
  useEffect(() => {
    const checkExtension = () => {
      const isInstalled = Boolean(
        (typeof window !== 'undefined' && (window as any).__formflowInjected) ||
        (typeof document !== 'undefined' && document.documentElement.getAttribute('data-formflow-extension') === 'installed')
      );
      if (isInstalled) {
        setExtension((prev) => ({ ...prev, installed: true, connected: true, lastSync: 'Just now' }));
      }
    };
    checkExtension();

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'FORMFLOW_EXTENSION_PONG') {
        setExtension((prev) => ({ ...prev, installed: true, connected: true, lastSync: 'Just now', version: event.data.version || prev.version }));
      }
    };
    window.addEventListener('message', handleMessage);
    try {
      window.postMessage({ type: 'FORMFLOW_EXTENSION_PING' }, '*');
    } catch {
      // Ignore
    }
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const loadData = useCallback(async () => {
    if (!authService.getSession()) {
      setDocuments([]);
      setFields([]);
      setActivity([]);
      setDrive((prev) => ({ ...prev, connected: false }));
      setDataLoading(false);
      return;
    }
    setDataLoading(true);
    try {
      const [nextDocuments, nextFields, nextActivity, nextPreferences, nextDrive] = await Promise.all([
        documentService.list(),
        extractionService.list(),
        activityService.list(),
        settingsService.getPreferences(),
        googleDriveService.getConnection(),
      ]);
      setDocuments(nextDocuments);
      setFields(nextFields);
      setActivity(nextActivity);
      setPreferences(nextPreferences);
      setDrive(nextDrive);
    } catch (err) {
      console.error('Error loading vault data:', err);
    } finally {
      setDataLoading(false);
    }
  }, []);

  // Validate session and check health on mount
  useEffect(() => {
    let active = true;
    void (async () => {
      const isOnline = await checkHealth();
      if (!active) return;
      if (!isOnline) {
        setDataLoading(false);
        setAuthLoading(false);
        return;
      }

      const storedUser = authService.getSession();
      if (storedUser) {
        try {
          const verifiedUser = await authService.getMe();
          if (!active) return;
          if (verifiedUser) {
            setUser(verifiedUser);
            setAuthState('authenticated');
            void loadData();
          } else {
            setUser(null);
            clearAuthStorage();
            setAuthState('session_expired');
            setDataLoading(false);
          }
        } catch {
          if (!active) return;
          setUser(null);
          clearAuthStorage();
          setAuthState('unauthenticated');
          setDataLoading(false);
        }
      } else {
        setAuthState('unauthenticated');
        setDataLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [checkHealth, loadData]);

  const login = useCallback(async (email: string, password: string) => {
    setAuthLoading(true);
    setAuthState('authenticating');
    setAuthError(null);
    try {
      const nextUser = await authService.login(email, password);
      setUser(nextUser);
      setAuthState('authenticated');
      setServiceStatus('online');
      toast({ tone: 'success', title: 'Welcome back', message: `Signed in as ${nextUser.email}` });
      await loadData();
      return nextUser;
    } catch (err: any) {
      if (err?.status === 503 || err?.message?.includes('unreachable') || err?.message?.includes('Cannot connect')) {
        setServiceStatus('offline');
      }
      setAuthState('auth_error');
      setAuthError(err instanceof Error ? err.message : 'Unable to sign in.');
      throw err;
    } finally {
      setAuthLoading(false);
    }
  }, [loadData, toast]);

  const signup = useCallback(async (name: string, email: string, password: string) => {
    setAuthLoading(true);
    setAuthState('authenticating');
    setAuthError(null);
    try {
      const nextUser = await authService.signup(name, email, password);
      setUser(nextUser);
      setAuthState('authenticated');
      setServiceStatus('online');
      toast({ tone: 'success', title: 'Account created', message: 'Welcome to FormFlow.' });
      await loadData();
      return nextUser;
    } catch (err: any) {
      if (err?.status === 503 || err?.message?.includes('unreachable') || err?.message?.includes('Cannot connect')) {
        setServiceStatus('offline');
      }
      setAuthState('auth_error');
      setAuthError(err instanceof Error ? err.message : 'Unable to create account.');
      throw err;
    } finally {
      setAuthLoading(false);
    }
  }, [loadData, toast]);

  const logout = useCallback(() => {
    void authService.logout();
    setUser(null);
    setAuthState('unauthenticated');
    setAuthError(null);
    setDocuments([]);
    setFields([]);
    setActivity([]);
    setDrive((prev) => ({ ...prev, connected: false }));
    toast({ tone: 'info', title: 'Signed out successfully' });
  }, [toast]);

  const handleAuthSuccess = useCallback(async (token: string, initialUser?: User) => {
    setStoredToken(token);
    if (initialUser) {
      setStoredUser(initialUser);
      setUser(initialUser);
    }
    setAuthState('authenticated');
    setServiceStatus('online');
    setAuthError(null);
    try {
      const verifiedUser = await authService.getMe();
      if (verifiedUser) {
        setUser(verifiedUser);
      }
    } catch {
      // Continue with active token session
    }
    await loadData();
  }, [loadData]);

  const refreshDrive = useCallback(async () => {
    const nextDrive = await googleDriveService.getConnection();
    setDrive(nextDrive);
    return nextDrive;
  }, []);

  const updateProfile = useCallback((nextUser: User) => {
    authService.updateProfile(nextUser);
    setUser(nextUser);
  }, []);

  const addDriveDocuments = useCallback(
    async (files: DriveFile[]) => {
      const created = await documentService.addFromDrive(files);
      if (created.length) {
        setDocuments((current) => [...created, ...current]);
        await loadData();
        toast({
          tone: 'success',
          title: 'Documents added from Google Drive',
          message: `${created.length} ${created.length === 1 ? 'file' : 'files'} imported into your vault.`,
        });
      }
      return created;
    },
    [loadData, toast],
  );

  const uploadDocuments = useCallback(
    async (files: File[]) => {
      const result = await documentService.uploadLocal(files);
      if (result.accepted.length) {
        setDocuments((current) => [...result.accepted, ...current]);
        await loadData();
        toast({
          tone: 'success',
          title: 'Document uploaded',
          message: `${result.accepted.length} ${result.accepted.length === 1 ? 'document' : 'documents'} added to your vault.`,
        });
      }
      if (result.rejected.length) {
        toast({
          tone: 'error',
          title: 'Some files were not accepted',
          message: `${result.rejected.join(', ')} — use PDF, DOCX, JPG, PNG, or TXT.`,
        });
      }
      return result;
    },
    [loadData, toast],
  );

  const retryDocument = useCallback(
    async (id: string) => {
      const retried = await documentService.retry(id);
      if (!retried) return;
      setDocuments((current) => current.map((doc) => (doc.id === id ? retried : doc)));
      await loadData();
      toast({ tone: 'info', title: 'Reprocessing started' });
    },
    [loadData, toast],
  );

  const removeDocument = useCallback(
    async (id: string) => {
      const doc = documents.find((item) => item.id === id);
      await documentService.remove(id);
      setDocuments((current) => current.filter((item) => item.id !== id));
      await loadData();
      toast({ tone: 'success', title: 'Document removed', message: `${doc?.name || 'Document'} was removed from your vault.` });
    },
    [documents, loadData, toast],
  );

  const renameDocument = useCallback(
    async (id: string, name: string) => {
      const updated = await documentService.rename(id, name);
      if (!updated) return;
      setDocuments((current) => current.map((doc) => (doc.id === id ? updated : doc)));
      toast({ tone: 'success', title: 'Document renamed' });
    },
    [toast],
  );

  const unlinkDocument = useCallback(
    async (id: string) => {
      const updated = await documentService.unlink(id);
      if (!updated) return;
      setDocuments((current) => current.map((doc) => (doc.id === id ? updated : doc)));
      toast({ tone: 'success', title: 'Record unlinked' });
    },
    [toast],
  );

  const addField = useCallback(
    async (field: Omit<VaultField, 'id'>) => {
      const created = await extractionService.add(field);
      setFields((current) => [...current, created]);
      await loadData();
      toast({ tone: 'success', title: 'Value added to vault' });
      return created;
    },
    [loadData, toast],
  );

  const updateField = useCallback(
    async (id: string, value: string) => {
      const updated = await extractionService.update(id, value);
      if (!updated) return;
      setFields((current) => current.map((field) => (field.id === id ? updated : field)));
      toast({ tone: 'success', title: 'Vault value updated' });
    },
    [toast],
  );

  const deleteField = useCallback(
    async (id: string) => {
      await extractionService.remove(id);
      setFields((current) => current.filter((field) => field.id !== id));
      toast({ tone: 'success', title: 'Value removed' });
    },
    [toast],
  );

  const resolveConflict = useCallback(
    async (id: string, value: string) => {
      const updated = await extractionService.resolveConflict(id, value);
      if (!updated) return;
      setFields((current) => current.map((field) => (field.id === id ? updated : field)));
      toast({ tone: 'success', title: 'Conflict resolved', message: 'Preferred value selected.' });
    },
    [toast],
  );

  const updatePreferences = useCallback(
    async (next: Preferences) => {
      const saved = await settingsService.updatePreferences(next);
      setPreferences(saved);
      toast({ tone: 'success', title: 'Preferences saved' });
    },
    [toast],
  );

  const value = useMemo<AppContextValue>(
    () => ({
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
    }),
    [
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
      drive,
      extension,
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
      loadData,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>.');
  return value;
}
