import {
  MESSAGE,
  type ScanPayload,
} from '@shared/messages';
import type { Preferences, VaultCategory, VaultField, VaultProfile } from '@shared/types';
import { collectionRepository, documentRepository, historyRepository, settingsRepository, toVaultDocument, vaultRepository } from '../../core/database/repositories';
import { vaultManager } from '../../core/vault/vault-manager';
import { vaultSession } from '../../core/vault/vault-session';
import { vaultService } from '../../core/application/vault-service';
import { profileService } from '../../core/application/profile-service';
import { documentService } from '../../core/application/document-service';
import { dashboardService } from '../../core/application/dashboard-service';
import { vaultExportService } from '../../core/storage/vault-export';
import { quotaManager } from '../../core/storage/quota-manager';
import { base64ToArrayBuffer, bufferToBase64 } from '../../core/encryption/crypto-service';
import { buildSuggestions } from './lib/matcher';
import {
  failure,
  isTrustedExtensionSender,
  optionalString,
  parseRequest,
  requireString,
  success,
  type ExtensionRequest,
  type ExtensionResponse,
} from './messaging/protocol';

const VERSION = chrome.runtime.getManifest().version;
const AUTO_LOCK_ALARM = 'formflow-auto-lock';

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab is available.');
  return tab;
}

function isSupported(url?: string): boolean {
  return Boolean(url && /^https?:\/\//i.test(url));
}

function isGoogleFormsEditorUrl(url?: string): boolean {
  if (!url) return false;
  return /docs\.google\.com\/forms\//i.test(url) && (/\/edit(\?|\/|$)/i.test(url) || /\/builder(\?|\/|$)/i.test(url));
}

async function pingTab(tabId: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve(false);
      }
    }, timeoutMs);
    chrome.tabs.sendMessage(tabId, { type: 'FORMFLOW_PING' }, (response) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(!chrome.runtime.lastError && Boolean(response?.ok));
    });
  });
}

async function sendTabMessage<T>(tabId: number, message: unknown, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error('The page did not respond to the form scanner (timeout).'));
      }
    }, timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message || 'Communication with tab failed.'));
      else resolve(response as T);
    });
  });
}

async function ensureContentScript(tabId: number): Promise<void> {
  if (await pingTab(tabId)) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function scanPage(): Promise<{ tab: chrome.tabs.Tab; scan: ScanPayload }> {
  const tab = await activeTab();
  if (!isSupported(tab.url)) {
    throw new Error('Open a regular http(s) page with a form, then try again. Chrome does not allow scanning browser or extension pages.');
  }
  if (isGoogleFormsEditorUrl(tab.url)) {
    return {
      tab,
      scan: {
        url: tab.url!,
        title: tab.title || 'Google Forms',
        adapter: 'Google Forms',
        isGoogleForms: true,
        isEditor: true,
        editorMessage: 'Google Forms editor detected. Open Preview or the responder link to fill the form.',
        fields: [],
        uploadFields: [],
        forms: 1,
        summary: { total: 0, matched: 0, needsReview: 0, unsupported: 0 },
      } as ScanPayload,
    };
  }
  await ensureContentScript(tab.id!);
  const response = await sendTabMessage<{ ok: boolean; data: ScanPayload; error?: string }>(
    tab.id!,
    { type: 'FORMFLOW_SCAN', requestId: `scan_${Date.now()}` },
    5000,
  );
  if (!response?.ok) throw new Error(response?.error ?? 'The page did not respond to the form scanner.');
  return { tab, scan: response.data };
}

async function fillPage(fills: Array<{ index: number; value: string }>) {
  const tab = await activeTab();
  if (!isSupported(tab.url)) throw new Error('This page cannot be filled.');
  await ensureContentScript(tab.id!);
  const response = await sendTabMessage<{ ok: boolean; data: unknown; error?: string }>(
    tab.id!,
    { type: 'FORMFLOW_FILL', fills, requestId: `fill_${Date.now()}` },
    6000,
  );
  if (!response?.ok) throw new Error(response?.error ?? 'The page did not accept the autofill request.');
  return { tab, result: response.data };
}

async function ensureUnlocked(): Promise<void> {
  if (!(await vaultSession.isUnlocked())) throw new Error('The vault is locked. Unlock it before using form suggestions.');
}

function requireStringArray(payload: Record<string, unknown>, key: string, maxItems = 1000): string[] {
  const value = payload[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value as string[];
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

const LEGACY_POPUP_KEYS = ['formflow.vault', 'formflow.collections', 'formflow.user', 'formflow.state'];

async function migrateLegacyPopupVault(): Promise<void> {
  if (!(await vaultSession.isUnlocked())) return;
  const stored = await chrome.storage.local.get(LEGACY_POPUP_KEYS);
  const legacyVault = stored['formflow.vault'];
  if (Array.isArray(legacyVault) && legacyVault.length > 0) {
    for (const item of legacyVault) {
      if (!item || typeof item !== 'object') continue;
      const value = item as Record<string, unknown>;
      if (typeof value.key !== 'string' || typeof value.value !== 'string' || !value.key || !value.value) continue;
      const category = typeof value.category === 'string' ? value.category.toLowerCase() : 'other';
      const normalizedCategory: VaultCategory =
        ['personal', 'contact', 'address', 'education', 'employment', 'skills', 'certifications', 'projects', 'identification', 'other'].includes(category)
          ? (category as VaultCategory)
          : 'other';
      try {
        await vaultRepository.addField({
          key: value.key,
          label: typeof value.label === 'string' ? value.label : value.key,
          value: value.value,
          category: normalizedCategory,
          source: {
            documentId: typeof value.sourceDocumentId === 'string' ? value.sourceDocumentId : 'legacy-popup',
            documentName: typeof value.sourceDocumentName === 'string' ? value.sourceDocumentName : typeof value.source === 'string' ? value.source : 'Legacy popup vault',
          },
          confidence: typeof value.confidence === 'number' ? value.confidence : 70,
          verificationStatus: 'extracted',
          sensitive: Boolean(value.sensitive),
          extractionMethod: 'deterministic',
          userModified: false,
        });
      } catch {
        // Keep the legacy keys if any value cannot be imported, so data is not lost silently.
        return;
      }
    }
  }
  await chrome.storage.local.remove(LEGACY_POPUP_KEYS);
}

async function collectionScopedFields(collectionId?: string): Promise<VaultField[]> {
  const fields = await vaultRepository.listFields();
  if (!collectionId || collectionId === 'all') return fields;
  const collections = await collectionRepository.list();
  const collection = collections.find((item) => item.id === collectionId);
  if (!collection) return fields;
  const allowed = new Set(collection.documentIds);
  return fields.filter((field) => allowed.has(field.source.documentId));
}

async function vaultSummary() {
  await ensureUnlocked();
  const [vault, profile, fields, collections, documents] = await Promise.all([
    vaultService.getActiveVault(),
    profileService.getProfile(),
    vaultRepository.listFields(),
    collectionRepository.list(),
    documentRepository.list(),
  ]);
  return {
    vault,
    profile,
    fields,
    collections,
    documentCount: documents.length,
  };
}

async function getState() {
  const status = await vaultManager.status();
  const preferences = await settingsRepository.getPreferences();
  const history = status.unlocked ? await historyRepository.list() : [];
  return { version: VERSION, vaultStatus: status, preferences, history };
}

async function updateSettings(payload: Record<string, unknown>) {
  const allowed = new Set(['confirmBeforeAutofill', 'requireSensitiveReview', 'allowLongAnswers', 'autoDownloadFiles', 'productNotifications', 'activityNotifications', 'compactMode', 'autoLockMinutes', 'ocrLanguage']);
  const patch: Partial<Preferences> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!allowed.has(key) || value === undefined) continue;
    (patch as Record<string, unknown>)[key] = value;
  }
  await settingsRepository.updatePreferences(patch);
  return settingsRepository.getPreferences();
}

async function openDashboard(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
}

async function handle(request: ExtensionRequest): Promise<unknown> {
  const payload = request.payload;
  switch (request.operation) {
    case MESSAGE.GET_STATE:
      return getState();
    case MESSAGE.UPDATE_SETTINGS:
      return updateSettings(payload);
    case MESSAGE.VAULT_STATUS:
      return vaultManager.status();
    case MESSAGE.VAULT_CREATE: {
      const name = requireString(payload, 'name', 1, 120);
      const passphrase = requireString(payload, 'passphrase', 10, 200);
      const vault = await vaultService.createVault({ name, passphrase });
      return { vault, status: await vaultManager.status() };
    }
    case MESSAGE.VAULT_UNLOCK: {
      const passphrase = requireString(payload, 'passphrase', 1, 200);
      await vaultManager.unlock(passphrase);
      await migrateLegacyPopupVault();
      return vaultManager.status();
    }
    case MESSAGE.VAULT_LOCK:
      await vaultManager.lock();
      return vaultManager.status();
    case MESSAGE.VAULT_SUMMARY:
      return vaultSummary();
    case MESSAGE.VAULT_TOUCH:
      await vaultService.touch();
      return { ok: true };
    case MESSAGE.GET_PROFILE:
      await ensureUnlocked();
      return profileService.getProfile();
    case MESSAGE.UPDATE_PROFILE: {
      await ensureUnlocked();
      const name = requireString(payload, 'name', 1, 160);
      const email = optionalString(payload, 'email', 320) ?? '';
      return profileService.saveProfile({ name, email });
    }
    case MESSAGE.LIST_DOCUMENTS: {
      await ensureUnlocked();
      const rows = await documentRepository.list();
      return {
        documents: rows.map(({ row, name }) => toVaultDocument(row, name)),
        count: rows.length,
      };
    }
    case MESSAGE.GET_DOCUMENT_METADATA: {
      await ensureUnlocked();
      const documentId = requireString(payload, 'documentId', 1, 160);
      const row = await documentRepository.get(documentId);
      if (!row) throw new Error('Document not found.');
      return toVaultDocument(row.row, row.name);
    }
    case MESSAGE.IMPORT_DOCUMENT: {
      await ensureUnlocked();
      const name = requireString(payload, 'name', 1, 255);
      const mimeType = requireString(payload, 'mimeType', 1, 160);
      const dataBase64 = requireString(payload, 'dataBase64', 1, 40 * 1024 * 1024);
      const bytes = new Uint8Array(base64ToArrayBuffer(dataBase64));
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('Document exceeds the 20 MB local limit.');
      const file = new File([bytes], name, { type: mimeType });
      return documentService.importDocument({ file });
    }
    case MESSAGE.DELETE_DOCUMENT: {
      await ensureUnlocked();
      const documentId = requireString(payload, 'documentId', 1, 160);
      await documentService.remove(documentId);
      return { ok: true };
    }
    case MESSAGE.LIST_COLLECTIONS:
      await ensureUnlocked();
      return collectionRepository.list();
    case MESSAGE.CREATE_COLLECTION: {
      await ensureUnlocked();
      return collectionRepository.create({
        name: requireString(payload, 'name', 1, 120),
        description: optionalString(payload, 'description', 1000) ?? '',
        notes: optionalString(payload, 'notes', 4000) ?? '',
        color: optionalString(payload, 'color', 40) ?? '#6366f1',
        documentIds: requireStringArray(payload, 'documentIds'),
      });
    }
    case MESSAGE.UPDATE_COLLECTION: {
      await ensureUnlocked();
      const collectionId = requireString(payload, 'collectionId', 1, 160);
      return collectionRepository.update(collectionId, {
        name: optionalString(payload, 'name', 120),
        description: optionalString(payload, 'description', 1000),
        notes: optionalString(payload, 'notes', 4000),
        color: optionalString(payload, 'color', 40),
        documentIds: payload.documentIds === undefined ? undefined : requireStringArray(payload, 'documentIds'),
      });
    }
    case MESSAGE.DELETE_COLLECTION: {
      await ensureUnlocked();
      await collectionRepository.remove(requireString(payload, 'collectionId', 1, 160));
      return { ok: true };
    }
    case MESSAGE.ASSIGN_DOCUMENT:
    case MESSAGE.REMOVE_DOCUMENT: {
      await ensureUnlocked();
      const collectionId = requireString(payload, 'collectionId', 1, 160);
      const documentId = requireString(payload, 'documentId', 1, 160);
      const collections = await collectionRepository.list();
      const collection = collections.find((item) => item.id === collectionId);
      if (!collection) throw new Error('Collection not found.');
      const documentIds = request.operation === MESSAGE.ASSIGN_DOCUMENT
        ? Array.from(new Set([...collection.documentIds, documentId]))
        : collection.documentIds.filter((id) => id !== documentId);
      return collectionRepository.update(collectionId, { documentIds });
    }
    case MESSAGE.GET_DASHBOARD_STATS: {
      await ensureUnlocked();
      const data = await dashboardService.load();
      return data.stats;
    }
    case MESSAGE.EXPORT_VAULT: {
      const passphrase = requireString(payload, 'passphrase', 8, 200);
      const blob = await vaultExportService.exportEncrypted(passphrase);
      return {
        dataBase64: await blobToBase64(blob),
        mimeType: 'application/json',
        sizeBytes: blob.size,
      };
    }
    case MESSAGE.IMPORT_VAULT: {
      const passphrase = requireString(payload, 'passphrase', 8, 200);
      const dataBase64 = requireString(payload, 'dataBase64', 1, 300 * 1024 * 1024);
      const bytes = new Uint8Array(base64ToArrayBuffer(dataBase64));
      return vaultExportService.importEncrypted(new Blob([bytes], { type: 'application/json' }), passphrase);
    }
    case MESSAGE.GET_HISTORY:
      await ensureUnlocked();
      return historyRepository.list();
    case MESSAGE.GET_STORAGE_STATUS: {
      const estimate = await quotaManager.estimate();
      return estimate;
    }
    case MESSAGE.SCAN_ACTIVE_TAB: {
      await ensureUnlocked();
      const { tab, scan } = await scanPage();
      return {
        tab: { id: tab.id, url: tab.url, title: tab.title },
        scan,
        matches: buildSuggestions(await vaultRepository.listFields(), scan.fields),
      };
    }
    case MESSAGE.GET_FORM_SUGGESTIONS: {
      await ensureUnlocked();
      const { tab, scan } = await scanPage();
      const collectionId = optionalString(payload, 'collectionId', 120);
      const fields = await collectionScopedFields(collectionId);
      return {
        tab: { id: tab.id, url: tab.url, title: tab.title },
        scan,
        matches: buildSuggestions(fields, scan.fields),
        collections: await collectionRepository.list(),
      };
    }
    case MESSAGE.FILL_ACTIVE_TAB: {
      await ensureUnlocked();
      const fills = Array.isArray(payload.fills) ? payload.fills : [];
      const normalized = fills
        .filter((item): item is { index: number; value: string } => Boolean(item && typeof item === 'object' && Number.isInteger((item as { index?: unknown }).index) && typeof (item as { value?: unknown }).value === 'string'))
        .slice(0, 500);
      return fillPage(normalized);
    }
    case MESSAGE.RECORD_HISTORY: {
      await ensureUnlocked();
      const website = requireString(payload, 'website', 1, 200);
      const url = optionalString(payload, 'url', 2000) ?? '';
      const detected = Number(payload.detected ?? 0);
      const filled = Number(payload.filled ?? 0);
      const skipped = Number(payload.skipped ?? 0);
      const status = (optionalString(payload, 'status', 40) ?? 'Completed') as 'Completed' | 'Partially completed' | 'Cancelled' | 'Failed';
      await historyRepository.record({
        website,
        url,
        detected: Number.isFinite(detected) ? detected : 0,
        filled: Number.isFinite(filled) ? filled : 0,
        review: Number.isFinite(skipped) ? skipped : 0,
        status,
        durationMs: 0,
      });
      return { ok: true };
    }
    case MESSAGE.CLEAR_HISTORY:
      await ensureUnlocked();
      await historyRepository.clear();
      return { ok: true };
    case MESSAGE.OPEN_DASHBOARD:
      await openDashboard();
      return { ok: true };
    case MESSAGE.OPEN_TAB: {
      const url = requireString(payload, 'url', 1, 2000);
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs may be opened.');
      await chrome.tabs.create({ url });
      return { ok: true };
    }
    case MESSAGE.MODEL_STATUS:
      return {
        status: 'not_installed',
        ready: false,
        message: 'Local AI runtime is not installed in this phase.',
      };
    default:
      throw new Error(`Unknown extension operation: ${request.operation}`);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedExtensionSender(sender)) {
    sendResponse(failure('unknown', 'Untrusted extension sender.', 'UNAUTHORIZED'));
    return false;
  }
  let request: ExtensionRequest;
  try {
    request = parseRequest(message);
  } catch (error) {
    sendResponse(failure('unknown', error instanceof Error ? error.message : 'Malformed request.', 'INVALID_REQUEST'));
    return false;
  }
  void (async () => {
    try {
      const data = await handle(request);
      sendResponse(success(request.requestId, data) satisfies ExtensionResponse);
      void scheduleAutoLock();
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Extension request failed.';
      sendResponse(failure(request.requestId, messageText, 'REQUEST_FAILED'));
    }
  })();
  return true;
});

// Keep a truthful, non-sensitive extension badge for the active vault state.
async function refreshBadge(): Promise<void> {
  const status = await vaultManager.status();
  const text = status.unlocked ? 'ON' : status.exists ? 'LOCK' : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: status.unlocked ? '#16a34a' : '#6b7280' });
}

async function scheduleAutoLock(): Promise<void> {
  const unlocked = await vaultSession.isUnlocked();
  if (!unlocked) {
    await chrome.alarms.clear(AUTO_LOCK_ALARM);
    return;
  }
  const preferences = await settingsRepository.getPreferences();
  if (preferences.autoLockMinutes > 0) {
    chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: preferences.autoLockMinutes });
  } else {
    await chrome.alarms.clear(AUTO_LOCK_ALARM);
  }
}

void refreshBadge();
void vaultManager.status().then((status) => {
  if (status.unlocked) {
    void migrateLegacyPopupVault();
    void scheduleAutoLock();
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM) return;
  void (async () => {
    await vaultManager.lock();
    await refreshBadge();
  })();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !('formflow.vault.session_key' in changes)) return;
  void refreshBadge();
  if (changes['formflow.vault.session_key'].newValue) {
    void migrateLegacyPopupVault();
    void scheduleAutoLock();
  } else {
    void chrome.alarms.clear(AUTO_LOCK_ALARM);
  }
});
