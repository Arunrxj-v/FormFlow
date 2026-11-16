import {
  DOCUMENT_PROGRESS_EVENT,
  MESSAGE,
  type ScanPayload,
} from '@shared/messages';
import type {
  AddressRecord,
  DocumentIngestionProgress,
  CertificationRecord,
  EducationRecord,
  EmploymentRecord,
  Preferences,
  ProjectRecord,
  SkillRecord,
  VaultCategory,
  VaultField,
  VaultProfile,
} from '@shared/types';
import { LEGACY_VAULT_SESSION_KEY, VAULT_STATE_KEY } from '@shared/constants';
import { activityRepository, collectionRepository, documentRepository, historyRepository, profileRecordRepository, settingsRepository, toVaultDocument, vaultRepository } from '../../core/database/repositories';
import { FormFlowError } from '@shared/errors';
import { vaultManager } from '../../core/vault/vault-manager';
import { vaultSession } from '../../core/vault/vault-session';
import { encryptionV2Migration } from '../../core/vault/encryption-v2-migration';
import { checkVaultIntegrity } from '../../core/vault/vault-integrity';
import { VaultOperationCoordinator, type VaultOperationKind } from '../../core/vault/operation-coordinator';
import { vaultService } from '../../core/application/vault-service';
import { profileService } from '../../core/application/profile-service';
import { documentService } from '../../core/application/document-service';
import type { DocumentParseInput } from '../../core/documents/parsers/types';
import { acceptOffscreenParserPort, parseDocumentInOffscreen } from './offscreen/parser-client';
import {
  OFFSCREEN_PARSER_DOCUMENT,
  OFFSCREEN_PARSER_PORT,
  isOffscreenParserDocumentUrl,
} from '../../shared/offscreen-parser-protocol';
import { dashboardService } from '../../core/application/dashboard-service';
import { vaultExportService } from '../../core/storage/vault-export';
import { profileRecordService } from '../../core/application/profile-service';
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
const activeDocumentImports = new Map<string, AbortController>();
const documentProgressPorts = new Map<string, chrome.runtime.Port>();

function publishDocumentProgress(
  importId: string,
  fileIndex: number,
  fileCount: number,
  event: DocumentIngestionProgress,
): void {
  const port = documentProgressPorts.get(importId);
  if (!port) return;
  try {
    port.postMessage({
      type: DOCUMENT_PROGRESS_EVENT,
      importId,
      fileIndex,
      fileCount,
      ...event,
      at: Date.now(),
    });
  } catch {
    documentProgressPorts.delete(importId);
  }
}

async function documentParser(input: DocumentParseInput) {
  return parseDocumentInOffscreen(input, input.signal);
}

function startImportHeartbeat(): () => void {
  const timer = setInterval(() => {
    // Extension API activity resets the MV3 service-worker idle timer while a
    // long local parse is running. It performs no network request.
    void chrome.runtime.getPlatformInfo().catch(() => undefined);
  }, 20_000);
  return () => clearInterval(timer);
}

let lastPublishedState: 'locked' | 'unlocked' | 'locking' | null = null;

async function publishVaultState(state: 'locked' | 'unlocked' | 'locking'): Promise<void> {
  if (lastPublishedState === state) return;
  lastPublishedState = state;
  try {
    await chrome.storage.session.set({
      [VAULT_STATE_KEY]: {
        state,
        generation: vaultSession.getGeneration(),
        updatedAt: new Date().toISOString(),
      },
    });
  } catch {
    // State notifications are best-effort and never contain key material.
  }
}

const operationCoordinator = new VaultOperationCoordinator({
  lockTimeoutMs: 60_000,
  onChange: (state) => {
    void publishVaultState(state);
    void refreshBadge();
  },
});

async function vaultStatus() {
  const status = await vaultManager.status();
  return { ...status, unlocked: status.unlocked && operationCoordinator.isUnlocked() };
}


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

const PROFILE_RECORD_TYPES = ['education', 'employment', 'skill', 'certification', 'project', 'address'] as const;
type ProfileRecordType = (typeof PROFILE_RECORD_TYPES)[number];

const FIELD_CATEGORIES = ['personal', 'contact', 'address', 'education', 'employment', 'skills', 'certifications', 'projects', 'identification', 'other'] as const;

function requireObject(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = payload[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be an object.`);
  return value as Record<string, unknown>;
}

function requireEnum<T extends string>(payload: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = payload[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${key} is not supported.`);
  return value as T;
}

function requireNumber(payload: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}.`);
  }
  return value;
}

function validateFieldInput(value: Record<string, unknown>) {
  const source = requireObject(value, 'source');
  const category = value.category;
  if (typeof category !== 'string' || !FIELD_CATEGORIES.includes(category as (typeof FIELD_CATEGORIES)[number])) {
    throw new Error('Field category is not supported.');
  }
  return {
    key: requireString(value, 'key', 1, 200),
    label: requireString(value, 'label', 0, 300),
    value: requireString(value, 'value', 0, 100_000),
    category: category as (typeof FIELD_CATEGORIES)[number],
    source: {
      documentId: requireString(source, 'documentId', 1, 200),
      documentName: optionalString(source, 'documentName', 300) ?? 'Local document',
      page: typeof source.page === 'number' ? source.page : undefined,
    },
    sourcePage: typeof value.sourcePage === 'number' ? value.sourcePage : undefined,
    confidence: requireNumber(value, 'confidence', 0, 100),
    verificationStatus: typeof value.verificationStatus === 'string'
      ? value.verificationStatus as 'extracted' | 'user_verified' | 'outdated'
      : 'extracted',
    sensitive: typeof value.sensitive === 'boolean' ? value.sensitive : undefined,
    extractionMethod: typeof value.extractionMethod === 'string'
      ? value.extractionMethod as 'deterministic' | 'ai' | 'manual' | 'derived'
      : 'deterministic',
    userModified: typeof value.userModified === 'boolean' ? value.userModified : false,
  };
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
  const status = await vaultStatus();
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
      return vaultStatus();
    case MESSAGE.VAULT_CREATE: {
      const name = requireString(payload, 'name', 1, 120);
      const passphrase = requireString(payload, 'passphrase', 10, 200);
      let vault: Awaited<ReturnType<typeof vaultService.createVault>> | null = null;
      await operationCoordinator.create(async () => {
        vault = await vaultService.createVault({ name, passphrase });
      });
      if (!vault) throw new Error('Vault creation failed.');
      return { vault, status: await vaultStatus() };
    }
    case MESSAGE.MIGRATE_PLAINTEXT_VAULT: {
      const passphrase = requireString(payload, 'passphrase', 10, 200);
      let vault: Awaited<ReturnType<typeof vaultService.migratePlaintextVault>> = null;
      await operationCoordinator.create(async () => {
        vault = await vaultService.migratePlaintextVault(passphrase);
      });
      return { vault, status: await vaultStatus() };
    }
    case MESSAGE.VAULT_UNLOCK: {
      const passphrase = requireString(payload, 'passphrase', 1, 200);
      await operationCoordinator.unlock(async () => {
        await vaultManager.unlock(passphrase);
        await migrateLegacyPopupVault();
      });
      void vaultExportService.recoverInterruptedRestore().catch(() => undefined);
      void operationCoordinator
        .run('mutation', 'AUTO_ENCRYPTION_MIGRATION', () => encryptionV2Migration.runIfNeeded())
        .catch(() => undefined);
      return vaultStatus();
    }
    case MESSAGE.VAULT_LOCK:
      await operationCoordinator.lock(async () => {
        await vaultManager.lock();
      });
      return vaultStatus();
    case MESSAGE.DESTROY_VAULT:
      await operationCoordinator.lock(async () => {
        await vaultManager.destroyVault();
      });
      return { ok: true };
    case MESSAGE.VAULT_SUMMARY:
      return vaultSummary();
    case MESSAGE.GET_PROFILE:
      await ensureUnlocked();
      return profileService.getProfile();
    case MESSAGE.UPDATE_PROFILE: {
      await ensureUnlocked();
      const name = requireString(payload, 'name', 1, 160);
      const email = optionalString(payload, 'email', 320) ?? '';
      return profileService.saveProfile({ name, email });
    }
    case MESSAGE.GET_DASHBOARD_DATA: {
      await ensureUnlocked();
      const [vault, profile, data] = await Promise.all([
        vaultService.getActiveVault(),
        profileService.getProfile(),
        dashboardService.load(),
      ]);
      return { vault, profile, ...data };
    }
    case MESSAGE.LIST_FIELDS:
      await ensureUnlocked();
      return profileService.listFields();
    case MESSAGE.ADD_FIELD: {
      await ensureUnlocked();
      const field = requireObject(payload, 'field');
      return profileService.addField(validateFieldInput(field));
    }
    case MESSAGE.UPDATE_FIELD: {
      await ensureUnlocked();
      const fieldId = requireString(payload, 'id', 1, 160);
      const value = requireString(payload, 'value', 0, 100_000);
      return profileService.updateField(fieldId, value);
    }
    case MESSAGE.DELETE_FIELD: {
      await ensureUnlocked();
      await profileService.deleteField(requireString(payload, 'id', 1, 160));
      return { ok: true };
    }
    case MESSAGE.RESOLVE_CONFLICT: {
      await ensureUnlocked();
      return profileService.resolveConflict(
        requireString(payload, 'id', 1, 160),
        requireString(payload, 'value', 0, 100_000),
      );
    }
    case MESSAGE.GET_ACTIVITY:
      await ensureUnlocked();
      return activityRepository.list(100);
    case MESSAGE.RECORD_ACTIVITY: {
      await ensureUnlocked();
      const type = requireEnum(payload, 'type', [
        'document_added', 'document_processed', 'form_detected', 'form_filled',
        'document_updated', 'document_removed', 'vault_created', 'model_installed',
      ] as const);
      await activityRepository.record(
        type,
        requireString(payload, 'title', 1, 300),
        requireString(payload, 'detail', 0, 4_000),
      );
      return { ok: true };
    }
    case MESSAGE.GET_ACTIVE_VAULT:
      await ensureUnlocked();
      return vaultService.getActiveVault();
    case MESSAGE.UPDATE_VAULT: {
      await ensureUnlocked();
      const patch = requireObject(payload, 'patch');
      const name = patch.name === undefined ? undefined : requireString(patch, 'name', 1, 120);
      const setupCompleted = patch.setupCompleted === undefined ? undefined : patch.setupCompleted === true;
      return vaultService.updateVault({ ...(name !== undefined ? { name } : {}), ...(setupCompleted !== undefined ? { setupCompleted } : {}) });
    }
    case MESSAGE.TOUCH_VAULT:
    case MESSAGE.VAULT_TOUCH:
      await ensureUnlocked();
      await vaultService.touch();
      return { ok: true };
    case MESSAGE.LIST_PROFILE_RECORDS: {
      await ensureUnlocked();
      const type = requireEnum(payload, 'type', PROFILE_RECORD_TYPES);
      switch (type) {
        case 'address': return profileRecordService.listAddresses();
        case 'education': return profileRecordService.listEducation();
        case 'employment': return profileRecordService.listEmployment();
        case 'skill': return profileRecordService.listSkills();
        case 'certification': return profileRecordService.listCertifications();
        case 'project': return profileRecordService.listProjects();
      }
    }
    case MESSAGE.SAVE_PROFILE_RECORD: {
      await ensureUnlocked();
      const type = requireEnum(payload, 'type', PROFILE_RECORD_TYPES) as ProfileRecordType;
      const record = requireObject(payload, 'record');
      const documentId = optionalString(payload, 'documentId', 200);
      switch (type) {
        case 'address': return profileRecordService.saveAddress(record as unknown as Partial<AddressRecord> & Pick<AddressRecord, 'addressLine1'>);
        case 'education': return profileRecordService.saveEducation(record as unknown as EducationRecord, documentId);
        case 'employment': return profileRecordService.saveEmployment(record as unknown as EmploymentRecord, documentId);
        case 'skill': return profileRecordService.saveSkill(record as unknown as Omit<SkillRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string });
        case 'certification': return profileRecordService.saveCertification(record as unknown as Omit<CertificationRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string });
        case 'project': return profileRecordService.saveProject(record as unknown as Omit<ProjectRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string });
      }
    }
    case MESSAGE.REMOVE_PROFILE_RECORD: {
      await ensureUnlocked();
      await profileRecordRepository.remove(requireString(payload, 'id', 1, 160));
      return { ok: true };
    }
    case MESSAGE.LIST_DOCUMENTS: {
      await ensureUnlocked();
      const rows = await documentRepository.list();
      return {
        documents: rows.map(({ row, name }) => toVaultDocument(row, name)),
        count: rows.length,
      };
    }
    case MESSAGE.RENAME_DOCUMENT: {
      await ensureUnlocked();
      return documentService.rename(
        requireString(payload, 'documentId', 1, 160),
        requireString(payload, 'name', 1, 255),
      );
    }
    case MESSAGE.GET_DOCUMENT_BLOB: {
      await ensureUnlocked();
      const documentId = requireString(payload, 'documentId', 1, 160);
      const document = await documentService.get(documentId);
      const blob = await documentService.getBlob(documentId);
      if (!document || !blob) throw new Error('Document file not found.');
      return { dataBase64: await blobToBase64(blob), mimeType: document.mimeType, sizeBytes: blob.size };
    }
    case MESSAGE.GET_DOCUMENT_METADATA: {
      await ensureUnlocked();
      const documentId = requireString(payload, 'documentId', 1, 160);
      const row = await documentRepository.get(documentId);
      if (!row) throw new Error('Document not found.');
      return toVaultDocument(row.row, row.name);
    }
    case MESSAGE.GET_DOCUMENT_TEXT: {
      await ensureUnlocked();
      const documentId = requireString(payload, 'documentId', 1, 160);
      const result = await documentService.getText(documentId);
      if (!result) throw new FormFlowError('NOT_FOUND', 'Extracted text is not available for this document.');
      const requested = typeof payload.maxChars === 'number' && Number.isFinite(payload.maxChars)
        ? Math.trunc(payload.maxChars)
        : 200_000;
      const maxChars = Math.max(1_000, Math.min(10_000_000, requested));
      const pageBudget = Math.max(1_000, Math.floor(maxChars / Math.max(1, result.pageTexts.length)));
      const pageTexts = result.pageTexts.map((page) => page.length > pageBudget ? page.slice(0, pageBudget) : page);
      return {
        ...result,
        text: result.text.slice(0, maxChars),
        pageTexts,
        truncated: result.text.length > maxChars || pageTexts.some((page, index) => page.length < result.pageTexts[index]!.length),
      };
    }
    case MESSAGE.IMPORT_DOCUMENT: {
      await ensureUnlocked();
      const name = requireString(payload, 'name', 1, 255);
      const mimeType = requireString(payload, 'mimeType', 1, 160);
      const dataBase64 = requireString(payload, 'dataBase64', 1, 40 * 1024 * 1024);
      const bytes = new Uint8Array(base64ToArrayBuffer(dataBase64));
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('Document exceeds the 20 MB local limit.');
      const file = new File([bytes], name, { type: mimeType });
      const category = optionalString(payload, 'category', 100) as Parameters<typeof documentService.importDocument>[0]['category'];
      const subcategory = optionalString(payload, 'subcategory', 200);
      const importId = optionalString(payload, 'importId', 160) ?? request.requestId;
      const fileIndex = typeof payload.fileIndex === 'number' ? Math.max(0, Math.trunc(payload.fileIndex)) : 0;
      const fileCount = typeof payload.fileCount === 'number' ? Math.max(1, Math.trunc(payload.fileCount)) : 1;
      if (activeDocumentImports.has(importId)) {
        throw new FormFlowError('VALIDATION_FAILED', 'A document with this import id is already being processed.');
      }
      const requestedTimeout = payload.testParserTimeoutMs;
      if (requestedTimeout !== undefined && !__FORMFLOW_TEST_HOOKS__) {
        throw new FormFlowError('VALIDATION_FAILED', 'Unknown document import option.');
      }
      if (requestedTimeout !== undefined && (
        typeof requestedTimeout !== 'number'
        || !Number.isFinite(requestedTimeout)
        || requestedTimeout < 50
        || requestedTimeout > 120_000
      )) {
        throw new FormFlowError('VALIDATION_FAILED', 'Test parser timeout is out of range.');
      }
      const parserTimeoutMs = __FORMFLOW_TEST_HOOKS__ && typeof requestedTimeout === 'number'
        ? Math.trunc(requestedTimeout)
        : undefined;
      const controller = new AbortController();
      activeDocumentImports.set(importId, controller);
      const stopHeartbeat = startImportHeartbeat();
      try {
        return await documentService.importDocument(
          { file, category, subcategory, signal: controller.signal },
          {
            parse: documentParser,
            signal: controller.signal,
            onProgress: (event) => publishDocumentProgress(importId, fileIndex, fileCount, event),
            ...(parserTimeoutMs !== undefined ? { timeoutMs: parserTimeoutMs } : {}),
          },
        );
      } finally {
        stopHeartbeat();
        activeDocumentImports.delete(importId);
        documentProgressPorts.delete(importId);
      }
    }
    case MESSAGE.CANCEL_DOCUMENT_IMPORT: {
      const importId = requireString(payload, 'importId', 1, 160);
      const controller = activeDocumentImports.get(importId);
      if (!controller) return { cancelled: false };
      controller.abort();
      return { cancelled: true };
    }
    case MESSAGE.RETRY_DOCUMENT_EXTRACTION: {
      await ensureUnlocked();
      const documentId = requireString(payload, 'documentId', 1, 160);
      const importId = optionalString(payload, 'importId', 160) ?? request.requestId;
      const controller = new AbortController();
      activeDocumentImports.set(importId, controller);
      const stopHeartbeat = startImportHeartbeat();
      try {
        return await documentService.retryExtraction(documentId, {
          parse: documentParser,
          signal: controller.signal,
          onProgress: (event) => publishDocumentProgress(importId, 0, 1, event),
        });
      } finally {
        stopHeartbeat();
        activeDocumentImports.delete(importId);
        documentProgressPorts.delete(importId);
      }
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
    case MESSAGE.GET_PREFERENCES:
      return settingsRepository.getPreferences();
    case MESSAGE.UPDATE_PREFERENCES: {
      const allowed = new Set(['confirmBeforeAutofill', 'requireSensitiveReview', 'allowLongAnswers', 'autoDownloadFiles', 'productNotifications', 'activityNotifications', 'compactMode', 'autoLockMinutes', 'ocrLanguage']);
      const patch: Partial<Preferences> = {};
      for (const [key, value] of Object.entries(payload)) {
        if (!allowed.has(key) || value === undefined) continue;
        (patch as Record<string, unknown>)[key] = value;
      }
      return settingsRepository.updatePreferences(patch);
    }
    case MESSAGE.GET_ENCRYPTION_STATUS:
      return encryptionV2Migration.status();
    case MESSAGE.MIGRATE_ENCRYPTION:
      await ensureUnlocked();
      return encryptionV2Migration.runIfNeeded();
    case MESSAGE.CHECK_VAULT_INTEGRITY:
      return checkVaultIntegrity();
    case MESSAGE.CHANGE_PASSPHRASE: {
      await ensureUnlocked();
      const currentPassphrase = requireString(payload, 'currentPassphrase', 1, 200);
      const newPassphrase = requireString(payload, 'newPassphrase', 10, 200);
      await vaultManager.changePassword(currentPassphrase, newPassphrase);
      return { ok: true };
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

const SESSION_STABLE_EXEMPT = new Set<string>([
  'VAULT_STATUS',
  'VAULT_CREATE',
  'VAULT_UNLOCK',
  'VAULT_LOCK',
  'DESTROY_VAULT',
  'MIGRATE_PLAINTEXT_VAULT',
  'VAULT_TOUCH',
  'UPDATE_SETTINGS',
  'OPEN_DASHBOARD',
  'OPEN_TAB',
  'MODEL_STATUS',
  'GET_ENCRYPTION_STATUS',
  'MIGRATE_ENCRYPTION',
  'CANCEL_DOCUMENT_IMPORT',
]);

const LEASE_KINDS: Record<string, VaultOperationKind> = {
  [MESSAGE.VAULT_SUMMARY]: 'read',
  [MESSAGE.GET_PROFILE]: 'read',
  [MESSAGE.UPDATE_PROFILE]: 'mutation',
  [MESSAGE.GET_DASHBOARD_DATA]: 'read',
  [MESSAGE.LIST_FIELDS]: 'read',
  [MESSAGE.ADD_FIELD]: 'mutation',
  [MESSAGE.UPDATE_FIELD]: 'mutation',
  [MESSAGE.DELETE_FIELD]: 'mutation',
  [MESSAGE.RESOLVE_CONFLICT]: 'mutation',
  [MESSAGE.GET_ACTIVITY]: 'read',
  [MESSAGE.RECORD_ACTIVITY]: 'mutation',
  [MESSAGE.GET_ACTIVE_VAULT]: 'read',
  [MESSAGE.UPDATE_VAULT]: 'mutation',
  [MESSAGE.TOUCH_VAULT]: 'mutation',
  [MESSAGE.VAULT_TOUCH]: 'mutation',
  [MESSAGE.LIST_DOCUMENTS]: 'read',
  [MESSAGE.GET_DOCUMENT_METADATA]: 'read',
  [MESSAGE.GET_DOCUMENT_TEXT]: 'read',
  [MESSAGE.GET_DOCUMENT_BLOB]: 'read',
  [MESSAGE.IMPORT_DOCUMENT]: 'mutation',
  [MESSAGE.RETRY_DOCUMENT_EXTRACTION]: 'mutation',
  [MESSAGE.RENAME_DOCUMENT]: 'mutation',
  [MESSAGE.DELETE_DOCUMENT]: 'mutation',
  [MESSAGE.LIST_COLLECTIONS]: 'read',
  [MESSAGE.CREATE_COLLECTION]: 'mutation',
  [MESSAGE.UPDATE_COLLECTION]: 'mutation',
  [MESSAGE.DELETE_COLLECTION]: 'mutation',
  [MESSAGE.ASSIGN_DOCUMENT]: 'mutation',
  [MESSAGE.REMOVE_DOCUMENT]: 'mutation',
  [MESSAGE.GET_DASHBOARD_STATS]: 'read',
  [MESSAGE.LIST_PROFILE_RECORDS]: 'read',
  [MESSAGE.SAVE_PROFILE_RECORD]: 'mutation',
  [MESSAGE.REMOVE_PROFILE_RECORD]: 'mutation',
  [MESSAGE.GET_HISTORY]: 'read',
  [MESSAGE.RECORD_HISTORY]: 'mutation',
  [MESSAGE.CLEAR_HISTORY]: 'mutation',
  [MESSAGE.SCAN_ACTIVE_TAB]: 'read',
  [MESSAGE.GET_FORM_SUGGESTIONS]: 'read',
  [MESSAGE.FILL_ACTIVE_TAB]: 'read',
  [MESSAGE.EXPORT_VAULT]: 'read',
  [MESSAGE.IMPORT_VAULT]: 'mutation',
  [MESSAGE.CHECK_VAULT_INTEGRITY]: 'read',
  [MESSAGE.CHANGE_PASSPHRASE]: 'mutation',
  [MESSAGE.MIGRATE_ENCRYPTION]: 'mutation',
};

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
  const sessionGeneration = vaultSession.getGeneration();
  const leaseKind = LEASE_KINDS[request.operation];
  void (async () => {
    try {
      const data = leaseKind
        ? await operationCoordinator.run(leaseKind, request.operation, () => handle(request))
        : await handle(request);
      if (!SESSION_STABLE_EXEMPT.has(request.operation) && !vaultSession.isCurrent(sessionGeneration)) {
        throw new FormFlowError('SESSION_EXPIRED', 'The vault locked while this request was running. Nothing was returned.');
      }
      sendResponse(success(request.requestId, data) satisfies ExtensionResponse);
      void scheduleAutoLock();
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Extension request failed.';
      sendResponse(failure(request.requestId, messageText, error instanceof FormFlowError ? error.code : 'REQUEST_FAILED'));
    }
  })();
  return true;
});

// Keep a truthful, non-sensitive extension badge for the active vault state.
async function refreshBadge(): Promise<void> {
  const status = await vaultStatus();
  const text = status.unlocked ? 'ON' : status.exists ? 'LOCK' : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: status.unlocked ? '#16a34a' : '#6b7280' });
}

async function scheduleAutoLock(): Promise<void> {
  const unlocked = operationCoordinator.isUnlocked() && (await vaultSession.isUnlocked());
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

// Publish the initial locked state before any async cleanup so a fast unlock
// cannot be overwritten by a late startup write.
void publishVaultState('locked');
void (async () => {
  // The DEK is memory-only. Remove any legacy Phase 3 session key and make
  // sure non-secret state markers are not exposed to content scripts.
  try {
    await chrome.storage.session.remove(LEGACY_VAULT_SESSION_KEY);
  } catch {
    // Ignore unavailable session storage.
  }
  try {
    await chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Older Chrome builds may not expose setAccessLevel.
  }
  void vaultExportService.recoverInterruptedRestore().catch(() => undefined);
  await refreshBadge();
})();

chrome.runtime.onConnect.addListener((port) => {
  if (!port.sender?.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
    port.disconnect();
    return;
  }
  const fromOffscreen = isOffscreenParserDocumentUrl(port.sender.url, chrome.runtime.id);
  if (port.name === OFFSCREEN_PARSER_PORT) {
    if (!fromOffscreen) {
      port.disconnect();
      return;
    }
    acceptOffscreenParserPort(port);
    return;
  }
  if (fromOffscreen) {
    port.disconnect();
    return;
  }
  if (port.name === 'formflow-document-progress') {
    let watchedImport: string | null = null;
    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const event = message as { type?: unknown; importId?: unknown };
      if (event.type !== 'watch' || typeof event.importId !== 'string' || event.importId.length > 160) return;
      watchedImport = event.importId;
      documentProgressPorts.set(event.importId, port);
      port.postMessage({ type: 'ready', importId: event.importId });
    });
    port.onDisconnect.addListener(() => {
      if (watchedImport) documentProgressPorts.delete(watchedImport);
    });
    return;
  }
  if (port.name !== 'formflow-vault-keepalive') {
    port.disconnect();
    return;
  }
  // Holding the port keeps the MV3 worker alive while a dashboard/popup is open.
  // Forced worker termination still destroys the in-memory DEK and locks.
  port.onDisconnect.addListener(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM) return;
  void (async () => {
    try {
      await operationCoordinator.lock(() => vaultManager.lock());
    } catch {
      // A failed lock remains unlocked and is reported to the next caller.
    }
    await refreshBadge();
  })();
});
