import { FormFlowError } from '@shared/errors';
import type { DocumentCategory, DocumentStatus, FileKind, FormHistoryItem, VaultDocument, VaultField, Collection } from '@shared/types';
import { documentRepository, historyRepository, activityRepository, collectionRepository, vaultRepository } from '../database/repositories';
import { documentStorage } from '../storage/document-storage';
import { sha256Hex } from '../encryption/crypto-service';
import { inferFileKind, formatSize } from '../documents/validation';
import { vaultRepository as vaultRecordRepository } from '../database/vault-repository';

const LEGACY_TOKEN_KEY = 'formflow.auth.token';

function legacyToken(): string | null {
  try {
    return localStorage.getItem(LEGACY_TOKEN_KEY);
  } catch {
    return null;
  }
}

async function legacyGet<T>(endpoint: string): Promise<T | null> {
  const token = legacyToken();
  if (!token) return null;
  try {
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${token}` },
      credentials: 'include',
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export interface LegacyDataSnapshot {
  user: { id: string; name: string; email: string } | null;
  documents: Array<Record<string, unknown>>;
  fields: VaultField[];
  collections: Collection[];
  history: FormHistoryItem[];
}

export interface MigrationSummary {
  documents: { imported: number; skipped: number; failed: number };
  values: { imported: number; skipped: number; conflictsCreated: number };
  collections: { imported: number; skipped: number };
  history: { imported: number; skipped: number };
}

export const legacyMigrationService = {
  async login(email: string, password: string): Promise<{ id: string; name: string; email: string }> {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new FormFlowError('INVALID_PASSWORD', payload?.error || 'Legacy backend login failed.');
    }
    const payload = (await response.json()) as { token: string; user: { id: string; name: string; email: string } };
    if (!payload.token) throw new FormFlowError('INVALID_PASSWORD', 'Legacy backend did not return a session token.');
    try {
      localStorage.setItem(LEGACY_TOKEN_KEY, payload.token);
    } catch {
      throw new FormFlowError('INVALID_PASSWORD', 'Could not store the temporary legacy migration session.');
    }
    return payload.user;
  },

  async probe(): Promise<LegacyDataSnapshot> {
    const token = legacyToken();
    if (!token) throw new FormFlowError('VAULT_LOCKED', 'Sign in to the legacy backend once to read migration data.');
    const user = await legacyGet<{ user: { id: string; name: string; email: string } }>('/api/auth/me').then((data) => data?.user ?? null);
    if (!user) throw new FormFlowError('VAULT_LOCKED', 'Legacy backend session is not available.');
    const [documents, fields, collections, history] = await Promise.all([
      legacyGet<{ documents: Array<Record<string, unknown>> }>('/api/documents').then((data) => data?.documents ?? []),
      legacyGet<{ fields: VaultField[] }>('/api/fields').then((data) => data?.fields ?? []),
      legacyGet<{ collections: Collection[] }>('/api/collections').then((data) => data?.collections ?? []),
      legacyGet<{ history: FormHistoryItem[] }>('/api/history').then((data) => data?.history ?? []),
    ]);
    return { user, documents, fields, collections, history };
  },

  async migrate(): Promise<MigrationSummary> {
    const snapshot = await this.probe();
    if (!snapshot.user) throw new FormFlowError('VAULT_LOCKED', 'Legacy backend session expired before migration.');

    const activeVault = await vaultRecordRepository.getActive();
    if (!activeVault) throw new FormFlowError('VAULT_LOCKED', 'Create a local vault before migrating legacy data.');

    const summary: MigrationSummary = {
      documents: { imported: 0, skipped: 0, failed: 0 },
      values: { imported: 0, skipped: 0, conflictsCreated: 0 },
      collections: { imported: 0, skipped: 0 },
      history: { imported: 0, skipped: 0 },
    };

    const documentIdMap = new Map<string, string>();

    for (const legacyDocument of snapshot.documents) {
      const documentId = String(legacyDocument.id ?? '');
      const name = String(legacyDocument.name ?? legacyDocument.filename ?? '').trim();
      if (!documentId || !name) {
        summary.documents.failed += 1;
        continue;
      }
      try {
        const blob = await this.fetchLegacyDocumentFile(documentId);
        if (!blob) {
          summary.documents.failed += 1;
          continue;
        }
        const checksum = await sha256Hex(await blob.arrayBuffer());
        const existing = await documentRepository.findByChecksum(checksum);
        if (existing) {
          documentIdMap.set(documentId, existing.id);
          summary.documents.skipped += 1;
          continue;
        }
        const fileKind = inferFileKind(name);
        const sizeBytes = blob.size;
        const category = (legacyDocument.category as DocumentCategory) ?? 'Other';
        const status = (legacyDocument.status as DocumentStatus) ?? 'stored';
        const mimeType = String(legacyDocument.mimeType || blob.type || 'application/octet-stream');
        const extension = name.split('.').pop()?.toLowerCase() ?? '';
        const row = await documentRepository.create(
          {
            vaultId: activeVault.id,
            mimeType,
            extension,
            category,
            subcategory: String(legacyDocument.subcategory ?? ''),
            status,
            fileType: fileKind,
            sizeBytes,
            sizeLabel: formatSize(sizeBytes),
            checksum,
            storageKey: '',
            source: 'legacy-import',
            pageCount: Number(legacyDocument.pageCount ?? 0) || undefined,
            ocrUsed: Boolean(legacyDocument.ocrUsed),
            extractedTextStatus: legacyDocument.extractedText ? 'extracted' : 'pending',
            metadata: { legacyDocumentId: documentId },
          },
          name,
        );
        const storageKey = `file_${row.id}`;
        await documentStorage.save(row.id, blob, mimeType);
        await documentRepository.update(row.id, { storageKey });
        documentIdMap.set(documentId, row.id);
        summary.documents.imported += 1;
      } catch {
        summary.documents.failed += 1;
      }
    }

    for (const field of snapshot.fields) {
      const localDocumentId = field.source.documentId ? documentIdMap.get(field.source.documentId) : undefined;
      try {
        const result = await vaultRepository.addField({
          key: field.key,
          label: field.label,
          value: field.value,
          normalizedValue: field.normalizedValue ?? field.value,
          category: field.category,
          source: {
            documentId: localDocumentId ?? 'manual',
            documentName: field.source.documentName ?? 'Legacy document',
          },
          sourcePage: field.sourcePage,
          confidence: field.confidence,
          verificationStatus: field.verificationStatus ?? 'extracted',
          sensitive: field.sensitive,
          extractionMethod: field.extractionMethod === 'manual' ? 'manual' : 'deterministic',
          userModified: field.userModified,
        });
        if (result.conflictCreated) summary.values.conflictsCreated += 1;
        else summary.values.imported += 1;
      } catch {
        summary.values.skipped += 1;
      }
    }

    const collectionIdMap = new Map<string, string>();
    for (const collection of snapshot.collections) {
      try {
        const existingCollections = await collectionRepository.list();
        const duplicate = existingCollections.find((item) => item.name.toLowerCase() === collection.name.toLowerCase());
        if (duplicate) {
          collectionIdMap.set(collection.id, duplicate.id);
          summary.collections.skipped += 1;
          continue;
        }
        const created = await collectionRepository.create({
          name: collection.name,
          description: collection.description,
          notes: collection.notes,
          documentIds: collection.documentIds.map((id) => documentIdMap.get(id) ?? id).filter(Boolean),
        });
        collectionIdMap.set(collection.id, created.id);
        summary.collections.imported += 1;
      } catch {
        summary.collections.skipped += 1;
      }
    }

    for (const entry of snapshot.history) {
      try {
        await historyRepository.record({
          website: entry.website,
          url: entry.url,
          documentsUsed: entry.documentsUsed ?? [],
          detected: entry.fieldsDetected,
          filled: entry.fieldsFilled,
          review: entry.fieldsReview,
          status: entry.status,
          durationMs: this.parseDuration(entry.duration),
        });
        summary.history.imported += 1;
      } catch {
        summary.history.skipped += 1;
      }
    }

    if (snapshot.user.name || snapshot.user.email) {
      await vaultRepository.saveProfile({ name: snapshot.user.name, email: snapshot.user.email, accountType: 'Local' });
    }

    await activityRepository.record(
      'vault_created',
      'Legacy data migrated',
      `${summary.documents.imported} documents · ${summary.values.imported} values · ${summary.collections.imported} collections.`,
    );
    return summary;
  },

  async fetchLegacyDocumentFile(documentId: string): Promise<Blob | null> {
    const token = legacyToken();
    if (!token) return null;
    try {
      const response = await fetch(`/api/documents/${documentId}/preview`, {
        headers: { authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!response.ok) return null;
      return await response.blob();
    } catch {
      return null;
    }
  },

  parseDuration(value: string | number | undefined): number {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value) * 1000;
    if (typeof value !== 'string') return 0;
    const seconds = Number.parseInt(value.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
  },
};
