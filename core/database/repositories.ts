import { FormFlowError, VaultLockedError } from '@shared/errors';
import type {
  ActivityItem,
  ActivityRow,
  Collection,
  CollectionRow,
  ConflictRecord,
  DocumentExtractionDetails,
  DocumentRecord,
  DocumentStatus,
  ExtractedValueRecord,
  FieldConflict,
  FormHistoryItem,
  FormHistoryRow,
  Preferences,
  ProfileRecordRow,
  SettingRow,
  StoredDocumentFile,
  StoredDocumentText,
  VaultCategory,
  VaultDocument,
  VaultField,
  VaultFieldInput,
  VaultProfile,
  StoredVaultProfileRow,
  ConflictRecord as ConflictRow,
} from '@shared/types';
import { DEFAULT_AUTO_LOCK_MINUTES, VAULT_SCHEMA_VERSION } from '@shared/constants';
import { getDb } from './database';
import { vaultRepository as vaultRecordRepository } from './vault-repository';
import {
  decryptBytesWithKey,
  decryptBytesWithLegacyAad,
  decryptJsonWithKey,
  encryptBytesWithKey,
  encryptJsonWithKey,
  type RecordAad,
} from '../encryption/crypto-service';
import { vaultSession } from '../vault/vault-session';
import { categoryForKey, labelForKey, SENSITIVE_KEYS } from '@shared/field-catalog';
import { normalizeValue } from '../extraction/normalize';

interface VaultIdentity {
  vaultId: string;
  schemaVersion: number;
}

async function identity(): Promise<VaultIdentity> {
  const vault = await vaultRecordRepository.getActive();
  if (!vault) throw new FormFlowError('VAULT_NOT_FOUND', 'No active local vault exists.');
  return { vaultId: vault.id, schemaVersion: vault.schemaVersion ?? VAULT_SCHEMA_VERSION };
}

function aad(vault: VaultIdentity, recordType: string, recordId: string, field: string): RecordAad {
  return {
    vaultId: vault.vaultId,
    recordType,
    recordId,
    field,
    schemaVersion: vault.schemaVersion,
  };
}

function assertVault(vault: VaultIdentity, recordVaultId: string): void {
  if (recordVaultId !== vault.vaultId) {
    throw new FormFlowError('VALIDATION_FAILED', 'This record belongs to a different vault.');
  }
}

async function key(): Promise<CryptoKey> {
  return vaultSession.getDataKey();
}

async function enc(value: unknown, context: RecordAad): Promise<string> {
  return encryptJsonWithKey(await vaultSession.getDataKey(), value, context);
}

async function dec<T>(payload: string, context?: RecordAad): Promise<T> {
  return decryptJsonWithKey<T>(await vaultSession.getDataKey(), payload, context);
}

async function decLabel(row: { label?: string; labelEnc?: string }, context: RecordAad): Promise<string> {
  if (row.labelEnc) return dec<string>(row.labelEnc, context);
  return row.label ?? '';
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export const vaultRepository = {
  async getProfile(): Promise<VaultProfile> {
    const vault = await identity();
    const db = await getDb();
    const row = await db.get('vaultProfile', 'me');
    if (!row) {
      const now = new Date().toISOString();
      return { id: 'me', name: '', email: '', accountType: 'Local', createdAt: now, updatedAt: now };
    }
    return dec<VaultProfile>(row.profileEnc, aad(vault, 'profile', 'me', 'profile'));
  },

  async saveProfile(profile: Partial<Omit<VaultProfile, 'id'>>): Promise<VaultProfile> {
    const current = await this.getProfile();
    const updated: VaultProfile = {
      ...current,
      ...profile,
      id: 'me',
      updatedAt: new Date().toISOString(),
    };
    const vault = await identity();
    const db = await getDb();
    const row: StoredVaultProfileRow = {
      id: 'me',
      profileEnc: await enc(updated, aad(vault, 'profile', 'me', 'profile')),
      updatedAt: updated.updatedAt,
    };
    await db.put('vaultProfile', row);
    return updated;
  },

  async listFields(): Promise<VaultField[]> {
    const vault = await identity();
    const db = await getDb();
    const [rows, conflicts, documents] = await Promise.all([
      db.getAll('extractedValues'),
      db.getAll('conflicts'),
      db.getAll('documents'),
    ]);
    const documentNames = new Map<string, string>();
    for (const document of documents) {
      try {
        documentNames.set(
          document.id,
          await dec<string>(document.nameEnc, aad(vault, 'document', document.id, 'name')),
        );
      } catch {
        documentNames.set(document.id, 'Encrypted document');
      }
    }
    const openByKey = new Map<string, ConflictRecord[]>();
    for (const conflict of conflicts) {
      if (conflict.status !== 'open') continue;
      const list = openByKey.get(conflict.key) ?? [];
      list.push(conflict);
      openByKey.set(conflict.key, list);
    }

    const fields: VaultField[] = [];
    for (const row of rows) {
      const value = await dec<string>(row.valueEnc, aad(vault, 'value', row.id, 'value'));
      const normalized = await dec<string>(row.normalizedValueEnc, aad(vault, 'value', row.id, 'normalizedValue'));
      const label = await decLabel(row, aad(vault, 'value', row.id, 'label'));
      const sourceDocName = documentNames.get(row.sourceDocumentId) ?? 'Local document';
      const source = {
        documentId: row.sourceDocumentId,
        documentName: sourceDocName,
        page: row.sourcePage,
        extractedAt: row.createdAt,
      };
      const fieldConflicts: FieldConflict[] = [];
      for (const conflict of openByKey.get(row.key) ?? []) {
        const existing = await dec<string>(
          conflict.existingValueEnc,
          aad(vault, 'conflict', conflict.id, 'existingValue'),
        );
        const next = await dec<string>(
          conflict.newValueEnc,
          aad(vault, 'conflict', conflict.id, 'newValue'),
        );
        const alternateIsExisting = normalizeValue(row.key, value) === normalizeValue(row.key, existing);
        const alternateValue = alternateIsExisting ? next : existing;
        const alternateDocId = alternateIsExisting ? conflict.newSourceDocumentId : conflict.existingSourceDocumentId;
        const alternateConfidence = alternateIsExisting ? conflict.newConfidence : conflict.existingConfidence;
        if (normalizeValue(row.key, alternateValue) === normalizeValue(row.key, value)) continue;
        fieldConflicts.push({
          value: alternateValue,
          confidence: alternateConfidence,
          source: {
            documentId: alternateDocId,
            documentName: documentNames.get(alternateDocId) ?? 'Local document',
          },
          sourcePage: conflict.page,
        });
      }
      fields.push({
        id: row.id,
        key: row.key,
        label,
        value,
        normalizedValue: normalized,
        category: row.category,
        source,
        sourcePage: row.sourcePage,
        confidence: row.confidence,
        verificationStatus: row.verificationStatus,
        sensitive: row.sensitive,
        conflicts: fieldConflicts.length ? fieldConflicts : undefined,
        extractedAt: row.createdAt,
        lastUpdatedAt: row.updatedAt,
        extractionMethod: row.extractionMethod,
        userModified: row.userModified,
      });
    }
    fields.sort((a, b) => (b.lastUpdatedAt ?? '').localeCompare(a.lastUpdatedAt ?? ''));
    return fields;
  },

  async getFieldByKey(fieldKey: string): Promise<ExtractedValueRecord | null> {
    const db = await getDb();
    const rows = await db.getAllFromIndex('extractedValues', 'by-key', fieldKey);
    return rows[0] ?? null;
  },

  async addField(input: VaultFieldInput): Promise<{ field: VaultField; conflictCreated: boolean }> {
    const vault = await identity();
    const db = await getDb();
    const now = new Date().toISOString();
    const normalized = normalizeValue(input.key, input.value);
    const existingRows = await db.getAllFromIndex('extractedValues', 'by-key', input.key);
    const existing = existingRows[0];

    if (!existing) {
      const fieldId = id('val');
      const row: ExtractedValueRecord = {
        id: fieldId,
        key: input.key,
        label: '',
        labelEnc: await enc(input.label || labelForKey(input.key), aad(vault, 'value', fieldId, 'label')),
        valueEnc: await enc(input.value, aad(vault, 'value', fieldId, 'value')),
        normalizedValueEnc: await enc(normalized, aad(vault, 'value', fieldId, 'normalizedValue')),
        category: input.category || categoryForKey(input.key),
        sourceDocumentId: input.source.documentId,
        sourcePage: input.sourcePage,
        confidence: input.confidence,
        extractionMethod: input.extractionMethod ?? 'deterministic',
        verificationStatus: input.verificationStatus ?? 'extracted',
        sensitive: input.sensitive ?? SENSITIVE_KEYS.has(input.key),
        userModified: input.userModified ?? input.extractionMethod === 'manual',
        createdAt: now,
        updatedAt: now,
      };
      await db.put('extractedValues', row);
      const found = (await this.listFields()).find((item) => item.id === row.id);
      if (!found) throw new FormFlowError('NOT_FOUND', 'The saved value could not be read back.');
      return { field: found, conflictCreated: false };
    }

    const existingValue = await dec<string>(
      existing.valueEnc,
      aad(vault, 'value', existing.id, 'value'),
    );
    const existingNormalized = await dec<string>(
      existing.normalizedValueEnc,
      aad(vault, 'value', existing.id, 'normalizedValue'),
    );

    if (existingNormalized === normalized) {
      const merged: ExtractedValueRecord = {
        ...existing,
        confidence: Math.max(existing.confidence, input.confidence),
        updatedAt: now,
      };
      await db.put('extractedValues', merged);
      const field = (await this.listFields()).find((item) => item.id === existing.id);
      if (!field) throw new FormFlowError('NOT_FOUND', 'Value disappeared while saving.');
      return { field, conflictCreated: false };
    }

    if (existing.verificationStatus === 'user_verified' && input.verificationStatus !== 'user_verified') {
      const conflictCreated = await this.createConflict(existing, existingValue, input, normalized);
      const field = (await this.listFields()).find((item) => item.id === existing.id);
      if (!field) throw new FormFlowError('NOT_FOUND', 'Value disappeared while saving.');
      return { field, conflictCreated };
    }

    if (input.verificationStatus === 'user_verified' || input.extractionMethod === 'manual') {
      const updated: ExtractedValueRecord = {
        ...existing,
        valueEnc: await enc(input.value, aad(vault, 'value', existing.id, 'value')),
        normalizedValueEnc: await enc(normalized, aad(vault, 'value', existing.id, 'normalizedValue')),
        confidence: 100,
        extractionMethod: 'manual',
        verificationStatus: 'user_verified',
        userModified: true,
        sourceDocumentId: input.source.documentId,
        sourcePage: input.sourcePage,
        updatedAt: now,
      };
      await db.put('extractedValues', updated);
      await this.resolveOpenConflictsForKey(input.key, 'edited');
      const field = (await this.listFields()).find((item) => item.id === existing.id);
      if (!field) throw new FormFlowError('NOT_FOUND', 'Value disappeared while saving.');
      return { field, conflictCreated: false };
    }

    const conflictCreated = await this.createConflict(existing, existingValue, input, normalized);
    const field = (await this.listFields()).find((item) => item.id === existing.id);
    if (!field) throw new FormFlowError('NOT_FOUND', 'Value disappeared while saving.');
    return { field, conflictCreated };
  },

  async createConflict(
    existing: ExtractedValueRecord,
    existingValue: string,
    input: VaultFieldInput,
    normalized: string,
  ): Promise<boolean> {
    const vault = await identity();
    const db = await getDb();
    const open = await db.getAllFromIndex('conflicts', 'by-key', input.key);
    for (const row of open) {
      if (row.status !== 'open') continue;
      const newValue = await dec<string>(
        row.newValueEnc,
        aad(vault, 'conflict', row.id, 'newValue'),
      );
      if (normalizeValue(input.key, newValue) === normalized) return false;
    }
    const now = new Date().toISOString();
    const conflictId = id('conf');
    const label = await decLabel(existing, aad(vault, 'value', existing.id, 'label'));
    const conflict: ConflictRecord = {
      id: conflictId,
      key: input.key,
      label: '',
      labelEnc: await enc(label, aad(vault, 'conflict', conflictId, 'label')),
      existingValueEnc: await enc(existingValue, aad(vault, 'conflict', conflictId, 'existingValue')),
      existingSourceDocumentId: existing.sourceDocumentId,
      existingConfidence: existing.confidence,
      newValueEnc: await enc(input.value, aad(vault, 'conflict', conflictId, 'newValue')),
      newSourceDocumentId: input.source.documentId,
      newConfidence: input.confidence,
      page: input.sourcePage,
      status: 'open',
      createdAt: now,
    };
    await db.put('conflicts', conflict);
    return true;
  },

  async resolveOpenConflictsForKey(fieldKey: string, resolution: ConflictRow['resolution']): Promise<void> {
    const db = await getDb();
    const conflicts = await db.getAllFromIndex('conflicts', 'by-key', fieldKey);
    const now = new Date().toISOString();
    for (const conflict of conflicts) {
      if (conflict.status !== 'open') continue;
      await db.put('conflicts', { ...conflict, status: 'resolved', resolution, resolvedAt: now });
    }
  },

  async updateField(fieldId: string, value: string): Promise<VaultField> {
    const vault = await identity();
    const db = await getDb();
    const row = await db.get('extractedValues', fieldId);
    if (!row) throw new FormFlowError('NOT_FOUND', 'Vault value not found.');
    const updated: ExtractedValueRecord = {
      ...row,
      valueEnc: await enc(value, aad(vault, 'value', row.id, 'value')),
      normalizedValueEnc: await enc(normalizeValue(row.key, value), aad(vault, 'value', row.id, 'normalizedValue')),
      confidence: 100,
      extractionMethod: 'manual',
      verificationStatus: 'user_verified',
      userModified: true,
      updatedAt: new Date().toISOString(),
    };
    await db.put('extractedValues', updated);
    await this.resolveOpenConflictsForKey(row.key, 'edited');
    const field = (await this.listFields()).find((item) => item.id === fieldId);
    if (!field) throw new FormFlowError('NOT_FOUND', 'Vault value not found after update.');
    return field;
  },

  async markVerified(fieldId: string): Promise<void> {
    const db = await getDb();
    const row = await db.get('extractedValues', fieldId);
    if (!row) return;
    await db.put('extractedValues', {
      ...row,
      verificationStatus: 'user_verified',
      updatedAt: new Date().toISOString(),
    });
  },

  async deleteField(fieldId: string): Promise<void> {
    const db = await getDb();
    const row = await db.get('extractedValues', fieldId);
    if (!row) return;
    await db.delete('extractedValues', fieldId);
    const conflicts = await db.getAllFromIndex('conflicts', 'by-key', row.key);
    for (const conflict of conflicts) {
      if (conflict.status === 'open') await db.delete('conflicts', conflict.id);
    }
  },

  async resolveConflict(fieldId: string, chosenValue: string): Promise<VaultField> {
    const vault = await identity();
    const db = await getDb();
    const row = await db.get('extractedValues', fieldId);
    if (!row) throw new FormFlowError('NOT_FOUND', 'Vault value not found.');
    const conflicts = await db.getAllFromIndex('conflicts', 'by-key', row.key);
    const open = conflicts.filter((conflict) => conflict.status === 'open');
    const chosenNormalized = normalizeValue(row.key, chosenValue);
    const currentValue = await dec<string>(row.valueEnc, aad(vault, 'value', row.id, 'value'));
    const now = new Date().toISOString();

    for (const conflict of open) {
      const existingValue = await dec<string>(
        conflict.existingValueEnc,
        aad(vault, 'conflict', conflict.id, 'existingValue'),
      );
      const newValue = await dec<string>(
        conflict.newValueEnc,
        aad(vault, 'conflict', conflict.id, 'newValue'),
      );
      const existingNormalized = normalizeValue(row.key, existingValue);
      const newNormalized = normalizeValue(row.key, newValue);

      if (chosenNormalized === existingNormalized) {
        await db.put('conflicts', { ...conflict, status: 'resolved', resolution: 'kept_existing', resolvedAt: now });
        continue;
      }
      if (chosenNormalized === newNormalized) {
        const updated: ExtractedValueRecord = {
          ...row,
          valueEnc: await enc(newValue, aad(vault, 'value', row.id, 'value')),
          normalizedValueEnc: await enc(newNormalized, aad(vault, 'value', row.id, 'normalizedValue')),
          sourceDocumentId: conflict.newSourceDocumentId,
          sourcePage: conflict.page,
          confidence: conflict.newConfidence,
          extractionMethod: 'deterministic',
          verificationStatus: 'user_verified',
          userModified: false,
          updatedAt: now,
        };
        await db.put('extractedValues', updated);
        await db.put('conflicts', { ...conflict, status: 'resolved', resolution: 'used_new', resolvedAt: now });
        continue;
      }
      await db.put('conflicts', { ...conflict, status: 'resolved', resolution: 'edited', resolvedAt: now });
    }

    if (chosenNormalized !== normalizeValue(row.key, currentValue)) {
      await this.updateField(fieldId, chosenValue);
    }
    const field = (await this.listFields()).find((item) => item.id === fieldId);
    if (!field) throw new FormFlowError('NOT_FOUND', 'Vault value not found after resolution.');
    return field;
  },

  async listOpenConflicts(): Promise<Array<{ id: string; key: string; label: string; count: number }>> {
    const vault = await identity();
    const db = await getDb();
    const rows = await db.getAll('conflicts');
    const map = new Map<string, { id: string; key: string; label: string; count: number }>();
    for (const row of rows) {
      if (row.status !== 'open') continue;
      const existing = map.get(row.key);
      if (!existing) {
        map.set(row.key, {
          id: row.key,
          key: row.key,
          label: await decLabel(row, aad(vault, 'conflict', row.id, 'label')),
          count: 1,
        });
      } else {
        existing.count += 1;
      }
    }
    return Array.from(map.values());
  },
};

async function prepareDocumentRow(
  vault: VaultIdentity,
  documentId: string,
  record: Omit<DocumentRecord, 'id' | 'createdAt' | 'updatedAt' | 'nameEnc' | 'originalFilenameEnc'>,
  rawName: string,
): Promise<DocumentRecord> {
  if (record.vaultId !== vault.vaultId) {
    throw new FormFlowError('VALIDATION_FAILED', 'Document vault identity does not match the active vault.');
  }
  const now = new Date().toISOString();
  return {
    ...record,
    id: documentId,
    nameEnc: await enc(rawName, aad(vault, 'document', documentId, 'name')),
    originalFilenameEnc: await enc(rawName, aad(vault, 'document', documentId, 'originalFilename')),
    createdAt: now,
    updatedAt: now,
  };
}

async function prepareStoredFile(
  vault: VaultIdentity,
  documentId: string,
  mimeType: string,
  data: Blob,
): Promise<StoredDocumentFile> {
  const now = new Date().toISOString();
  const encrypted = await encryptBytesWithKey(
    await vaultSession.getDataKey(),
    await data.arrayBuffer(),
    aad(vault, 'documentFile', documentId, 'file'),
  );
  return {
    documentId,
    storageKey: `file_${documentId}`,
    mimeType,
    sizeBytes: data.size,
    ciphertext: new Blob([encrypted.data], { type: 'application/octet-stream' }),
    iv: encrypted.iv,
    version: 2,
    aadVersion: 2,
    createdAt: now,
    updatedAt: now,
  };
}

async function prepareStoredText(
  vault: VaultIdentity,
  documentId: string,
  text: string,
  pageTexts: string[],
  method: StoredDocumentText['method'],
  extraction?: DocumentExtractionDetails,
): Promise<StoredDocumentText> {
  return {
    documentId,
    textEnc: await enc(text, aad(vault, 'documentText', documentId, 'text')),
    pageTextsEnc: await enc(pageTexts, aad(vault, 'documentText', documentId, 'pageTexts')),
    pageCount: pageTexts.length,
    method,
    ...(extraction
      ? { extractionEnc: await enc(extraction, aad(vault, 'documentText', documentId, 'extraction')) }
      : {}),
    createdAt: new Date().toISOString(),
  };
}

export const documentRepository = {
  async list(): Promise<Array<{ row: DocumentRecord; name: string }>> {
    const vault = await identity();
    const db = await getDb();
    const rows = await db.getAll('documents');
    const result = [];
    for (const row of rows) {
      assertVault(vault, row.vaultId);
      result.push({
        row,
        name: await dec<string>(row.nameEnc, aad(vault, 'document', row.id, 'name')),
      });
    }
    result.sort((a, b) => b.row.createdAt.localeCompare(a.row.createdAt));
    return result;
  },

  async get(documentId: string): Promise<{ row: DocumentRecord; name: string } | null> {
    const vault = await identity();
    const db = await getDb();
    const row = await db.get('documents', documentId);
    if (!row) return null;
    assertVault(vault, row.vaultId);
    return {
      row,
      name: await dec<string>(row.nameEnc, aad(vault, 'document', row.id, 'name')),
    };
  },

  async findByChecksum(checksum: string): Promise<DocumentRecord | null> {
    const db = await getDb();
    return (await db.getFromIndex('documents', 'by-checksum', checksum)) ?? null;
  },

  async create(
    record: Omit<DocumentRecord, 'id' | 'createdAt' | 'updatedAt' | 'nameEnc' | 'originalFilenameEnc'>,
    rawName: string,
  ): Promise<DocumentRecord> {
    const vault = await identity();
    if (record.vaultId !== vault.vaultId) {
      throw new FormFlowError('VALIDATION_FAILED', 'Document vault identity does not match the active vault.');
    }
    const db = await getDb();
    const existing = await db.getFromIndex('documents', 'by-checksum', record.checksum);
    if (existing) {
      throw new FormFlowError('DUPLICATE_DOCUMENT', 'This document is already in your vault.');
    }
    const row = await prepareDocumentRow(vault, id('doc'), record, rawName);
    await db.put('documents', row);
    return row;
  },

  /** Builds an encrypted document row without writing it. Used by atomic ingestion. */
  async prepare(
    documentId: string,
    record: Omit<DocumentRecord, 'id' | 'createdAt' | 'updatedAt' | 'nameEnc' | 'originalFilenameEnc'>,
    rawName: string,
  ): Promise<DocumentRecord> {
    return prepareDocumentRow(await identity(), documentId, record, rawName);
  },

  async prepareOriginalFile(documentId: string, mimeType: string, data: Blob): Promise<StoredDocumentFile> {
    return prepareStoredFile(await identity(), documentId, mimeType, data);
  },

  async prepareText(
    documentId: string,
    text: string,
    pageTexts: string[],
    method: StoredDocumentText['method'],
    extraction?: DocumentExtractionDetails,
  ): Promise<StoredDocumentText> {
    return prepareStoredText(await identity(), documentId, text, pageTexts, method, extraction);
  },

  /**
   * Commits the document row, encrypted original file, and encrypted text in a
   * single IndexedDB transaction. A quota failure, lock, or worker termination
   * therefore cannot leave a successful document without its text or file.
   */
  async commitIngested(
    row: DocumentRecord,
    file: StoredDocumentFile,
    text: StoredDocumentText,
  ): Promise<void> {
    const vault = await identity();
    assertVault(vault, row.vaultId);
    if (file.documentId !== row.id || text.documentId !== row.id) {
      throw new FormFlowError('VALIDATION_FAILED', 'Prepared ingestion records do not share one document id.');
    }
    const db = await getDb();
    const tx = db.transaction(['documents', 'documentFiles', 'documentText'], 'readwrite', { durability: 'strict' });
    try {
      const existing = await tx.objectStore('documents').index('by-checksum').get(row.checksum);
      if (existing) {
        throw new FormFlowError('DUPLICATE_DOCUMENT', 'This document is already in your vault.');
      }
      await tx.objectStore('documents').put(row);
      await tx.objectStore('documentFiles').put(file);
      await tx.objectStore('documentText').put(text);
      await tx.done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The transaction already aborted or completed.
      }
      void tx.done.catch(() => undefined);
      if (error instanceof FormFlowError) throw error;
      if (error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError') {
        throw new FormFlowError(
          'INSUFFICIENT_STORAGE',
          'The encrypted document transaction was aborted before commit. No partial document or text was written.',
          { cause: error },
        );
      }
      throw error;
    }
  },

  async saveOriginalFile(documentId: string, mimeType: string, data: Blob): Promise<StoredDocumentFile> {
    const row = await this.prepareOriginalFile(documentId, mimeType, data);
    const db = await getDb();
    await db.put('documentFiles', row);
    return row;
  },

  async getOriginalFile(documentId: string): Promise<Blob | null> {
    const vault = await identity();
    const db = await getDb();
    const row = await db.get('documentFiles', documentId);
    if (!row) return null;
    const plaintext = row.aadVersion === 2
      ? await decryptBytesWithKey(
        await vaultSession.getDataKey(),
        row.iv,
        await row.ciphertext.arrayBuffer(),
        aad(vault, 'documentFile', documentId, 'file'),
      )
      : await decryptBytesWithLegacyAad(
        await vaultSession.getDataKey(),
        row.iv,
        await row.ciphertext.arrayBuffer(),
      );
    return new Blob([plaintext], { type: row.mimeType });
  },

  async saveText(
    documentId: string,
    text: string,
    pageTexts: string[],
    method: StoredDocumentText['method'],
    extraction?: DocumentExtractionDetails,
  ): Promise<void> {
    const row = await this.prepareText(documentId, text, pageTexts, method, extraction);
    const db = await getDb();
    await db.put('documentText', row);
  },

  async getText(documentId: string): Promise<{
    text: string;
    pageTexts: string[];
    method: StoredDocumentText['method'];
    extraction: DocumentExtractionDetails | null;
  } | null> {
    const vault = await identity();
    const db = await getDb();
    const row = await db.get('documentText', documentId);
    if (!row) return null;
    return {
      text: await dec<string>(row.textEnc, aad(vault, 'documentText', documentId, 'text')),
      pageTexts: await dec<string[]>(row.pageTextsEnc, aad(vault, 'documentText', documentId, 'pageTexts')),
      method: row.method,
      extraction: row.extractionEnc
        ? await dec<DocumentExtractionDetails>(row.extractionEnc, aad(vault, 'documentText', documentId, 'extraction'))
        : null,
    };
  },

  /** Replaces extraction output for an existing document in one transaction. */
  async replaceExtraction(
    documentId: string,
    text: string,
    pageTexts: string[],
    method: StoredDocumentText['method'],
    extraction: DocumentExtractionDetails,
    patch: Partial<Omit<DocumentRecord, 'id' | 'createdAt'>>,
  ): Promise<DocumentRecord> {
    const vault = await identity();
    const db = await getDb();
    const current = await db.get('documents', documentId);
    if (!current) throw new FormFlowError('NOT_FOUND', 'Document not found.');
    assertVault(vault, current.vaultId);
    // Encryption is asynchronous and must finish before the transaction opens;
    // IndexedDB transactions become inactive across unrelated awaits.
    const textRow = await prepareStoredText(vault, documentId, text, pageTexts, method, extraction);
    const tx = db.transaction(['documents', 'documentText'], 'readwrite', { durability: 'strict' });
    try {
      const latest = await tx.objectStore('documents').get(documentId);
      if (!latest) {
        tx.abort();
        throw new FormFlowError('NOT_FOUND', 'Document not found.');
      }
      if (latest.updatedAt !== current.updatedAt) {
        tx.abort();
        throw new FormFlowError('VALIDATION_FAILED', 'The document changed while extraction was running. Retry the extraction.');
      }
      assertVault(vault, latest.vaultId);
      const updated: DocumentRecord = {
        ...latest,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      await tx.objectStore('documents').put(updated);
      await tx.objectStore('documentText').put(textRow);
      await tx.done;
      return updated;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Already completed/aborted.
      }
      void tx.done.catch(() => undefined);
      throw error;
    }
  },

  async rename(documentId: string, name: string): Promise<void> {
    const vault = await identity();
    const db = await getDb();
    const row = await db.get('documents', documentId);
    if (!row) throw new FormFlowError('NOT_FOUND', 'Document not found.');
    assertVault(vault, row.vaultId);
    await db.put('documents', {
      ...row,
      nameEnc: await enc(name, aad(vault, 'document', row.id, 'name')),
      updatedAt: new Date().toISOString(),
    });
  },

  async remove(documentId: string): Promise<void> {
    const db = await getDb();
    const values = await db.getAllFromIndex('extractedValues', 'by-document', documentId);
    const tx = db.transaction(['documents', 'documentFiles', 'documentText', 'extractedValues', 'processingJobs', 'collectionDocuments', 'conflicts'], 'readwrite');
    await tx.objectStore('documents').delete(documentId);
    await tx.objectStore('documentFiles').delete(documentId);
    await tx.objectStore('documentText').delete(documentId);
    for (const value of values) await tx.objectStore('extractedValues').delete(value.id);
    const jobs = await tx.objectStore('processingJobs').index('by-document').getAll(documentId);
    for (const job of jobs) await tx.objectStore('processingJobs').delete(job.id);
    const memberships = await tx.objectStore('collectionDocuments').index('by-document').getAll(documentId);
    for (const membership of memberships) await tx.objectStore('collectionDocuments').delete(membership.id);
    const conflicts = await tx.objectStore('conflicts').getAll();
    for (const conflict of conflicts) {
      if (conflict.existingSourceDocumentId === documentId || conflict.newSourceDocumentId === documentId) {
        await tx.objectStore('conflicts').delete(conflict.id);
      }
    }
    await tx.done;
  },

  async updateStatus(documentId: string, status: DocumentStatus, detail: string, error?: string): Promise<void> {
    await this.update(documentId, {
      status,
      stageDetail: detail,
      processingError: error,
      failureReason: status === 'failed' ? error : undefined,
    });
  },

  async update(documentId: string, patch: Partial<Omit<DocumentRecord, 'id' | 'createdAt'>>): Promise<void> {
    const db = await getDb();
    const row = await db.get('documents', documentId);
    if (!row) throw new FormFlowError('NOT_FOUND', 'Document not found.');
    await db.put('documents', { ...row, ...patch, updatedAt: new Date().toISOString() });
  },
};

export function toVaultDocument(row: DocumentRecord, name: string): VaultDocument {
  return {
    id: row.id,
    name,
    category: row.category,
    subcategory: row.subcategory,
    status: row.status,
    fileType: row.fileType,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sizeLabel: row.sizeLabel,
    uploadedAt: new Date(row.createdAt).toLocaleDateString(),
    modifiedAt: row.updatedAt,
    source: row.source,
    pageCount: row.pageCount,
    confidence: row.confidence,
    failureReason: row.failureReason,
    processingError: row.processingError,
    checksum: row.checksum,
    ocrUsed: row.ocrUsed,
    extractedTextStatus: row.extractedTextStatus,
    extractionVersion: row.extractionVersion,
    extractedAt: row.extractedAt,
    ocrRequired: row.ocrRequired,
    ocrStatus: row.ocrStatus,
    ocrLanguage: row.ocrLanguage,
    ocrConfidence: row.ocrConfidence,
    ocrPagesTotal: row.ocrPagesTotal,
    ocrPagesCompleted: row.ocrPagesCompleted,
    extractedCount: undefined,
    previewTone: undefined,
    linkedRecordId: undefined,
    linkedRecordTitle: undefined,
    linkedRecordMeta: undefined,
  };
}

export const collectionRepository = {
  async list(): Promise<Collection[]> {
    const vault = await identity();
    const db = await getDb();
    const rows = await db.getAll('collections');
    const memberships = await db.getAll('collectionDocuments');
    const result: Collection[] = [];
    for (const row of rows) {
      assertVault(vault, row.vaultId);
      result.push({
        id: row.id,
        vaultId: row.vaultId,
        name: await dec<string>(row.nameEnc, aad(vault, 'collection', row.id, 'name')),
        description: await dec<string>(row.descriptionEnc, aad(vault, 'collection', row.id, 'description')),
        notes: await dec<string>(row.notesEnc, aad(vault, 'collection', row.id, 'notes')),
        color: row.color,
        documentIds: memberships.filter((item) => item.collectionId === row.id).map((item) => item.documentId),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  },

  async create(input: { name: string; description?: string; notes?: string; color?: string; documentIds?: string[] }): Promise<Collection> {
    const vault = await identity();
    const db = await getDb();
    const now = new Date().toISOString();
    const collectionId = id('col');
    const row: CollectionRow = {
      id: collectionId,
      vaultId: vault.vaultId,
      nameEnc: await enc(input.name, aad(vault, 'collection', collectionId, 'name')),
      descriptionEnc: await enc(input.description ?? '', aad(vault, 'collection', collectionId, 'description')),
      notesEnc: await enc(input.notes ?? '', aad(vault, 'collection', collectionId, 'notes')),
      color: input.color ?? '#6366f1',
      createdAt: now,
      updatedAt: now,
    };
    await db.put('collections', row);
    for (const documentId of input.documentIds ?? []) {
      await db.put('collectionDocuments', { id: id('cd'), collectionId: row.id, documentId });
    }
    await activityRepository.record('document_added', input.name, 'Collection created');
    return {
      id: row.id,
      vaultId: row.vaultId,
      name: input.name,
      description: input.description ?? '',
      notes: input.notes ?? '',
      color: row.color,
      documentIds: input.documentIds ?? [],
      createdAt: now,
      updatedAt: now,
    };
  },

  async update(
    collectionId: string,
    patch: { name?: string; description?: string; notes?: string; color?: string; documentIds?: string[] },
  ): Promise<Collection | null> {
    const vault = await identity();
    const db = await getDb();
    const row = await db.get('collections', collectionId);
    if (!row) return null;
    assertVault(vault, row.vaultId);
    const updated: CollectionRow = {
      ...row,
      nameEnc: patch.name !== undefined
        ? await enc(patch.name, aad(vault, 'collection', row.id, 'name'))
        : row.nameEnc,
      descriptionEnc: patch.description !== undefined
        ? await enc(patch.description, aad(vault, 'collection', row.id, 'description'))
        : row.descriptionEnc,
      notesEnc: patch.notes !== undefined
        ? await enc(patch.notes, aad(vault, 'collection', row.id, 'notes'))
        : row.notesEnc,
      color: patch.color ?? row.color,
      updatedAt: new Date().toISOString(),
    };
    await db.put('collections', updated);
    if (patch.documentIds) {
      const existing = await db.getAllFromIndex('collectionDocuments', 'by-collection', collectionId);
      for (const membership of existing) await db.delete('collectionDocuments', membership.id);
      for (const documentId of patch.documentIds) {
        await db.put('collectionDocuments', { id: id('cd'), collectionId, documentId });
      }
    }
    await activityRepository.record('document_updated', patch.name ?? collectionId, 'Collection updated');
    return (await this.list()).find((item) => item.id === collectionId) ?? null;
  },

  async remove(collectionId: string): Promise<void> {
    const vault = await identity();
    const db = await getDb();
    const row = await db.get('collections', collectionId);
    await db.delete('collections', collectionId);
    const memberships = await db.getAllFromIndex('collectionDocuments', 'by-collection', collectionId);
    for (const membership of memberships) await db.delete('collectionDocuments', membership.id);
    if (row) {
      const name = await dec<string>(row.nameEnc, aad(vault, 'collection', row.id, 'name'));
      await activityRepository.record('document_removed', name, 'Collection deleted; documents retained.');
    }
  },
};

export const activityRepository = {
  async list(limit = 50): Promise<ActivityItem[]> {
    const vault = await identity();
    const db = await getDb();
    const rows = (await db.getAll('activity')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    const items: ActivityItem[] = [];
    for (const row of rows) {
      items.push({
        id: row.id,
        type: row.type,
        title: await dec<string>(row.titleEnc, aad(vault, 'activity', row.id, 'title')),
        detail: await dec<string>(row.detailEnc, aad(vault, 'activity', row.id, 'detail')),
        timestamp: row.createdAt,
        relativeTime: relativeTime(row.createdAt),
      });
    }
    return items;
  },

  async record(type: ActivityItem['type'], title: string, detail: string): Promise<void> {
    const vault = await identity();
    const db = await getDb();
    const activityId = id('act');
    const row: ActivityRow = {
      id: activityId,
      type,
      titleEnc: await enc(title, aad(vault, 'activity', activityId, 'title')),
      detailEnc: await enc(detail, aad(vault, 'activity', activityId, 'detail')),
      createdAt: new Date().toISOString(),
    };
    await db.put('activity', row);
  },

  async clear(): Promise<void> {
    const db = await getDb();
    await db.clear('activity');
  },
};

export const historyRepository = {
  async list(): Promise<FormHistoryItem[]> {
    const vault = await identity();
    const db = await getDb();
    const rows = (await db.getAll('formHistory')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const items: FormHistoryItem[] = [];
    for (const row of rows) {
      items.push({
        id: row.id,
        website: await dec<string>(row.websiteEnc, aad(vault, 'formHistory', row.id, 'website')),
        url: await dec<string>(row.urlEnc, aad(vault, 'formHistory', row.id, 'url')),
        timestamp: row.createdAt,
        dateLabel: new Date(row.createdAt).toLocaleString(),
        fieldsDetected: row.fieldsDetected,
        fieldsFilled: row.fieldsFilled,
        fieldsReview: row.fieldsReview,
        status: row.status,
        documentsUsed: await dec<string[]>(row.documentsUsedEnc, aad(vault, 'formHistory', row.id, 'documentsUsed')),
        duration: formatDuration(row.durationMs),
      });
    }
    return items;
  },

  async record(entry: {
    website: string;
    url: string;
    documentsUsed?: string[];
    detected: number;
    filled: number;
    review: number;
    status: FormHistoryItem['status'];
    durationMs: number;
  }): Promise<void> {
    const vault = await identity();
    const db = await getDb();
    const historyId = id('hist');
    const row: FormHistoryRow = {
      id: historyId,
      websiteEnc: await enc(entry.website, aad(vault, 'formHistory', historyId, 'website')),
      urlEnc: await enc(entry.url, aad(vault, 'formHistory', historyId, 'url')),
      documentsUsedEnc: await enc(entry.documentsUsed ?? [], aad(vault, 'formHistory', historyId, 'documentsUsed')),
      fieldsDetected: entry.detected,
      fieldsFilled: entry.filled,
      fieldsReview: entry.review,
      status: entry.status,
      durationMs: entry.durationMs,
      createdAt: new Date().toISOString(),
    };
    await db.put('formHistory', row);
  },

  async clear(): Promise<void> {
    const db = await getDb();
    await db.clear('formHistory');
  },
};

export const settingsRepository = {
  defaults(): Preferences {
    return {
      confirmBeforeAutofill: true,
      requireSensitiveReview: true,
      allowLongAnswers: true,
      autoDownloadFiles: false,
      productNotifications: false,
      activityNotifications: true,
      compactMode: false,
      autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
      ocrLanguage: 'eng',
    };
  },

  async get<T>(settingKey: string, fallback: T): Promise<T> {
    const db = await getDb();
    const row = await db.get('settings', settingKey);
    return row ? (row.value as T) : fallback;
  },

  async set<T>(settingKey: string, value: T): Promise<void> {
    const db = await getDb();
    const row: SettingRow = { key: settingKey, value, updatedAt: new Date().toISOString() };
    await db.put('settings', row);
  },

  async getPreferences(): Promise<Preferences> {
    return { ...this.defaults(), ...(await this.get<Partial<Preferences>>('preferences', {})) };
  },

  async updatePreferences(patch: Partial<Preferences>): Promise<Preferences> {
    const next = { ...(await this.getPreferences()), ...patch };
    await this.set('preferences', next);
    return next;
  },

  async getOnboarding(): Promise<{ completed: boolean; currentStep: number; vaultCreatedAt?: string }> {
    return this.get('onboarding', { completed: false, currentStep: 0 });
  },

  async updateOnboarding(patch: Partial<{ completed: boolean; currentStep: number; vaultCreatedAt: string }>): Promise<void> {
    const current = await this.getOnboarding();
    await this.set('onboarding', { ...current, ...patch });
  },
};

export const profileRecordRepository = {
  async list<T>(type: ProfileRecordRow['type']): Promise<T[]> {
    const vault = await identity();
    const db = await getDb();
    const rows = await db.getAllFromIndex('profileRecords', 'by-type', type);
    const result: T[] = [];
    for (const row of rows) {
      result.push(await dec<T>(row.dataEnc, aad(vault, `profileRecord:${row.type}`, row.id, 'data')));
    }
    return result;
  },

  async save<T extends { id: string }>(type: ProfileRecordRow['type'], value: T, documentId?: string): Promise<T> {
    const vault = await identity();
    const db = await getDb();
    const existing = await db.get('profileRecords', value.id);
    const now = new Date().toISOString();
    const row: ProfileRecordRow = {
      id: value.id,
      type,
      dataEnc: await enc(value, aad(vault, `profileRecord:${type}`, value.id, 'data')),
      documentId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await db.put('profileRecords', row);
    return value;
  },

  async remove(recordId: string): Promise<void> {
    const db = await getDb();
    await db.delete('profileRecords', recordId);
  },
};

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export { vaultSession, dec, enc, key };
