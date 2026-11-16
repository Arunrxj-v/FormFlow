import type { FormFlowErrorCode } from '@shared/errors';
import type {
  ActivityItem,
  Collection,
  FormHistoryItem,
  Preferences,
  StorageEstimate,
  VaultDocument,
  VaultField,
  VaultFieldInput,
  VaultProfile,
  VaultRecord,
} from '@shared/types';
import { MESSAGE } from '@shared/messages';
import { LEGACY_VAULT_SESSION_KEY, VAULT_STATE_KEY } from '@shared/constants';
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
} from './vaultClientTypes';

const PROTOCOL_VERSION = 1;

// Remove any Phase 3 raw session key as soon as an extension page starts.
if (typeof chrome !== 'undefined' && chrome.storage?.session) {
  void chrome.storage.session.remove(LEGACY_VAULT_SESSION_KEY).catch(() => undefined);
}

export class ExtensionRequestError extends Error {
  readonly code: FormFlowErrorCode | 'UNKNOWN';
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ExtensionRequestError';
    this.code = (code || 'UNKNOWN') as FormFlowErrorCode;
  }
}

function requestId(): string {
  return `ui_${crypto.randomUUID()}`;
}

function send<T>(operation: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return Promise.reject(new ExtensionRequestError('The extension service is not available in this context.', 'UNKNOWN'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ExtensionRequestError('The extension service did not respond in time.', 'UNKNOWN'));
    }, timeoutMs);
    chrome.runtime.sendMessage(
      { protocol: PROTOCOL_VERSION, requestId: requestId(), operation, payload },
      (response: { ok?: boolean; data?: T; error?: string; code?: string } | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new ExtensionRequestError(chrome.runtime.lastError.message ?? 'Extension messaging failed.', 'UNKNOWN'));
          return;
        }
        if (!response?.ok) {
          reject(new ExtensionRequestError(response?.error ?? 'Extension request failed.', response?.code ?? 'UNKNOWN'));
          return;
        }
        resolve(response.data as T);
      },
    );
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBlob(dataBase64: string, mimeType: string): Blob {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

function readState(value: unknown): VaultStateEvent | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<VaultStateEvent>;
  if (candidate.state !== 'locked' && candidate.state !== 'unlocked' && candidate.state !== 'locking') return null;
  return {
    state: candidate.state,
    generation: typeof candidate.generation === 'number' ? candidate.generation : 0,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
  };
}

export const vaultClient: VaultClientApi = {
  status: () => send<VaultStatus>(MESSAGE.VAULT_STATUS),
  createVault: (input) => send<{ vault: VaultRecord; status: VaultStatus }>(MESSAGE.VAULT_CREATE, input),
  migratePlaintextVault: async (passphrase) => {
    const result = await send<{ vault: VaultRecord | null; status: VaultStatus }>(MESSAGE.MIGRATE_PLAINTEXT_VAULT, { passphrase }, 300_000);
    return result.vault;
  },
  unlock: (passphrase) => send<VaultStatus>(MESSAGE.VAULT_UNLOCK, { passphrase }, 120_000),
  lock: () => send<VaultStatus>(MESSAGE.VAULT_LOCK, {}, 120_000),
  destroy: () => send<void>(MESSAGE.DESTROY_VAULT, {}, 120_000),
  changePassphrase: (currentPassphrase, newPassphrase) =>
    send<void>(MESSAGE.CHANGE_PASSPHRASE, { currentPassphrase, newPassphrase }, 120_000),
  getActiveVault: () => send<VaultRecord | null>(MESSAGE.GET_ACTIVE_VAULT),
  updateVault: (patch) => send<VaultRecord | null>(MESSAGE.UPDATE_VAULT, { patch }),
  touch: () => send<void>(MESSAGE.TOUCH_VAULT),
  getProfile: () => send<VaultProfile>(MESSAGE.GET_PROFILE),
  updateProfile: (patch) => send<VaultProfile>(MESSAGE.UPDATE_PROFILE, patch as Record<string, unknown>),
  getDashboardData: () => send<DashboardPayload>(MESSAGE.GET_DASHBOARD_DATA, {}, 60_000),
  listFields: () => send<VaultField[]>(MESSAGE.LIST_FIELDS),
  addField: (field) => send<{ field: VaultField; conflictCreated: boolean }>(MESSAGE.ADD_FIELD, { field: field as unknown as Record<string, unknown> }),
  updateField: (id, value) => send<VaultField>(MESSAGE.UPDATE_FIELD, { id, value }),
  deleteField: (id) => send<void>(MESSAGE.DELETE_FIELD, { id }),
  resolveConflict: (id, value) => send<VaultField>(MESSAGE.RESOLVE_CONFLICT, { id, value }),
  listDocuments: async () => {
    const result = await send<{ documents: VaultDocument[] }>(MESSAGE.LIST_DOCUMENTS);
    return result.documents;
  },
  getDocument: async (id) => {
    try {
      return await send<VaultDocument>(MESSAGE.GET_DOCUMENT_METADATA, { documentId: id });
    } catch (error) {
      if (error instanceof ExtensionRequestError && /not found/i.test(error.message)) return null;
      throw error;
    }
  },
  importDocument: async (file, category, subcategory) => {
    const dataBase64 = await blobToBase64(file);
    return send<DocumentImportResult>(
      MESSAGE.IMPORT_DOCUMENT,
      {
        name: file.name,
        mimeType: file.type,
        dataBase64,
        category,
        subcategory,
      },
      300_000,
    );
  },
  renameDocument: (id, name) => send<VaultDocument>(MESSAGE.RENAME_DOCUMENT, { documentId: id, name }),
  deleteDocument: (id) => send<void>(MESSAGE.DELETE_DOCUMENT, { documentId: id }),
  getDocumentBlob: async (id) => {
    try {
      const result = await send<{ dataBase64: string; mimeType: string }>(MESSAGE.GET_DOCUMENT_BLOB, { documentId: id }, 120_000);
      return { blob: base64ToBlob(result.dataBase64, result.mimeType), mimeType: result.mimeType };
    } catch (error) {
      if (error instanceof ExtensionRequestError && /not found/i.test(error.message)) return null;
      throw error;
    }
  },
  listCollections: () => send<Collection[]>(MESSAGE.LIST_COLLECTIONS),
  createCollection: (input) => send<Collection>(MESSAGE.CREATE_COLLECTION, input as Record<string, unknown>),
  updateCollection: (id, patch) => send<Collection | null>(MESSAGE.UPDATE_COLLECTION, { collectionId: id, ...patch }),
  deleteCollection: (id) => send<void>(MESSAGE.DELETE_COLLECTION, { collectionId: id }),
  listActivity: () => send<ActivityItem[]>(MESSAGE.GET_ACTIVITY),
  recordActivity: async (item) => {
    await send<void>(MESSAGE.RECORD_ACTIVITY, item as unknown as Record<string, unknown>);
  },
  getHistory: () => send<FormHistoryItem[]>(MESSAGE.GET_HISTORY),
  recordHistory: async (entry) => {
    await send<void>(MESSAGE.RECORD_HISTORY, {
      website: entry.website,
      url: entry.url,
      detected: entry.detected,
      filled: entry.filled,
      skipped: entry.review,
      status: entry.status,
    });
  },
  clearHistory: () => send<void>(MESSAGE.CLEAR_HISTORY),
  getPreferences: () => send<Preferences>(MESSAGE.GET_PREFERENCES),
  updatePreferences: (preferences) => send<Preferences>(MESSAGE.UPDATE_PREFERENCES, preferences as unknown as Record<string, unknown>),
  listProfileRecords: <T>(type: ProfileRecordType) => send<T[]>(MESSAGE.LIST_PROFILE_RECORDS, { type }),
  saveProfileRecord: <T>(type: ProfileRecordType, record: T, documentId?: string) =>
    send<T>(MESSAGE.SAVE_PROFILE_RECORD, { type, record: record as Record<string, unknown>, documentId }),
  removeProfileRecord: (id) => send<void>(MESSAGE.REMOVE_PROFILE_RECORD, { id }),
  exportVault: async (passphrase) => {
    const result = await send<{ dataBase64: string; mimeType: string }>(MESSAGE.EXPORT_VAULT, { passphrase }, 300_000);
    return base64ToBlob(result.dataBase64, result.mimeType);
  },
  importVault: async (file, passphrase) => {
    const dataBase64 = await blobToBase64(file);
    return send<VaultImportResult>(MESSAGE.IMPORT_VAULT, { passphrase, dataBase64 }, 300_000);
  },
  storageEstimate: () => send<StorageEstimate>(MESSAGE.GET_STORAGE_STATUS),
  encryptionStatus: () => send<EncryptionStatus>(MESSAGE.GET_ENCRYPTION_STATUS),
  migrateEncryption: () => send<EncryptionStatus>(MESSAGE.MIGRATE_ENCRYPTION, {}, 300_000),
  checkIntegrity: () => send<VaultIntegrityReport>(MESSAGE.CHECK_VAULT_INTEGRITY, {}, 120_000),
  subscribeState: (listener) => {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return () => undefined;
    const emit = (value: unknown) => {
      const state = readState(value);
      if (state) listener(state);
    };
    void chrome.storage.session.get(VAULT_STATE_KEY).then((result) => emit(result[VAULT_STATE_KEY])).catch(() => undefined);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session' || !(VAULT_STATE_KEY in changes)) return;
      emit(changes[VAULT_STATE_KEY]?.newValue);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  },
  keepAlive: () => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return () => undefined;
    try {
      const port = chrome.runtime.connect({ name: 'formflow-vault-keepalive' });
      return () => {
        try {
          port.disconnect();
        } catch {
          // Already disconnected.
        }
      };
    } catch {
      return () => undefined;
    }
  },
  legacyBackendStatus: async () => ({ user: null }),
  legacyBackendMigrate: async () => {
    throw new ExtensionRequestError('Legacy backend migration is only available in the localhost development dashboard.', 'UNKNOWN');
  },
};
