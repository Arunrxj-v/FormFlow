import { FormFlowError } from '@shared/errors';
import { ENCRYPTION_FORMAT_VERSION, VAULT_SCHEMA_VERSION } from '@shared/constants';
import { getDb } from '../database/database';
import {
  decryptBytesWithKey,
  decryptBytesWithLegacyAad,
  decryptJsonWithKey,
  sha256Hex,
  type RecordAad,
} from '../encryption/crypto-service';
import { vaultSession } from './vault-session';
import { encryptionV2Migration } from './encryption-v2-migration';

export interface IntegrityIssue {
  severity: 'error' | 'warning';
  code: string;
  recordType: string;
  recordId?: string;
  message: string;
}

export interface VaultIntegrityReport {
  ok: boolean;
  checkedAt: string;
  encryptionFormat: number;
  counts: {
    documents: number;
    files: number;
    values: number;
    conflicts: number;
    profileRecords: number;
    collections: number;
    memberships: number;
    activity: number;
    history: number;
    text: number;
  };
  issues: IntegrityIssue[];
}

interface Context {
  vaultId: string;
  schemaVersion: number;
}

function contextFor(vault: Context, recordType: string, recordId: string, field: string): RecordAad {
  return {
    vaultId: vault.vaultId,
    recordType,
    recordId,
    field,
    schemaVersion: vault.schemaVersion,
  };
}

export async function checkVaultIntegrity(): Promise<VaultIntegrityReport> {
  if (!(await vaultSession.isUnlocked())) {
    throw new FormFlowError('VAULT_LOCKED', 'Unlock the vault before running an integrity check.');
  }
  const db = await getDb();
  const [meta, vaultRows, documents, files, values, conflicts, profileRecords, collections, memberships, activity, history, text, profileRow] = await Promise.all([
    db.get('vaultMeta', 'meta'),
    db.getAll('vaults'),
    db.getAll('documents'),
    db.getAll('documentFiles'),
    db.getAll('extractedValues'),
    db.getAll('conflicts'),
    db.getAll('profileRecords'),
    db.getAll('collections'),
    db.getAll('collectionDocuments'),
    db.getAll('activity'),
    db.getAll('formHistory'),
    db.getAll('documentText'),
    db.get('vaultProfile', 'me'),
  ]);
  if (!meta) throw new FormFlowError('VAULT_NOT_FOUND', 'No encrypted vault exists.');
  const activeVault = vaultRows[0];
  if (!activeVault) throw new FormFlowError('VAULT_NOT_FOUND', 'No active vault record exists.');

  const vault: Context = {
    vaultId: activeVault.id,
    schemaVersion: activeVault.schemaVersion ?? VAULT_SCHEMA_VERSION,
  };
  const issues: IntegrityIssue[] = [];
  const reportIssue = (issue: IntegrityIssue) => {
    if (issues.length < 200) issues.push(issue);
  };

  const encryptionFormat = meta.encryptionFormat ?? 1;
  if (encryptionFormat < ENCRYPTION_FORMAT_VERSION) {
    reportIssue({
      severity: 'warning',
      code: 'MIGRATION_INCOMPLETE',
      recordType: 'vault',
      message: 'This vault has not finished the per-record encryption upgrade.',
    });
  }
  const migration = await encryptionV2Migration.status().catch(() => null);
  if (migration?.journal?.status === 'failed') {
    reportIssue({
      severity: 'warning',
      code: 'MIGRATION_FAILED',
      recordType: 'vault',
      message: migration.journal.lastError ?? 'The encryption upgrade previously failed and can be resumed.',
    });
  }

  const documentIds = new Set(documents.map((document) => document.id));
  const collectionIds = new Set(collections.map((collection) => collection.id));
  const fileByDocument = new Map(files.map((file) => [file.documentId, file]));
  const key = await vaultSession.getDataKey();

  const tryDecryptJson = async (payload: string, aad: RecordAad, label: string, recordType: string, recordId: string, field: string) => {
    try {
      // v1 envelopes are accepted only while the migration is incomplete;
      // v2 envelopes must authenticate against this exact record context.
      await decryptJsonWithKey(key, payload, aad);
      return true;
    } catch (error) {
      reportIssue({
        severity: 'error',
        code: 'INVALID_CIPHERTEXT',
        recordType,
        recordId,
        message: `${label} could not be authenticated: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
      return false;
    }
  };

  for (const row of vaultRows) {
    if (!row.nameEnc) {
      reportIssue({
        severity: 'warning',
        code: 'PLAINTEXT_VAULT_NAME',
        recordType: 'vault',
        recordId: row.id,
        message: 'The vault display name is not encrypted yet.',
      });
    } else {
      await tryDecryptJson(
        row.nameEnc,
        contextFor(vault, 'vault', row.id, 'name'),
        'Vault display name',
        'vault',
        row.id,
        'name',
      );
    }
  }

  if (profileRow) {
    await tryDecryptJson(
      profileRow.profileEnc,
      contextFor(vault, 'profile', 'me', 'profile'),
      'Vault profile',
      'profile',
      'me',
      'profile',
    );
  }

  const documentNames = new Map<string, string>();
  for (const document of documents) {
    if (document.vaultId !== vault.vaultId) {
      reportIssue({
        severity: 'error',
        code: 'VAULT_MISMATCH',
        recordType: 'document',
        recordId: document.id,
        message: 'Document metadata references a different vault.',
      });
    }
    try {
      const name = await decryptJsonWithKey<string>(
        key,
        document.nameEnc,
        contextFor(vault, 'document', document.id, 'name'),
      );
      documentNames.set(document.id, name);
      await decryptJsonWithKey<string>(
        key,
        document.originalFilenameEnc,
        contextFor(vault, 'document', document.id, 'originalFilename'),
      );
    } catch (error) {
      reportIssue({
        severity: 'error',
        code: 'INVALID_DOCUMENT_NAME',
        recordType: 'document',
        recordId: document.id,
        message: `Document name could not be authenticated: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    }
    const file = fileByDocument.get(document.id);
    if (!file) {
      reportIssue({
        severity: 'error',
        code: 'MISSING_DOCUMENT_FILE',
        recordType: 'document',
        recordId: document.id,
        message: 'The encrypted original file is missing.',
      });
      continue;
    }
    if (file.mimeType !== document.mimeType) {
      reportIssue({
        severity: 'warning',
        code: 'MIME_MISMATCH',
        recordType: 'document',
        recordId: document.id,
        message: 'Stored file MIME type does not match the document metadata.',
      });
    }
    if (file.aadVersion !== 2) {
      reportIssue({
        severity: 'warning',
        code: 'MIGRATION_INCOMPLETE',
        recordType: 'documentFile',
        recordId: document.id,
        message: 'This document file still uses the legacy encryption format.',
      });
    }
    try {
      const plaintext = file.aadVersion === 2
        ? await decryptBytesWithKey(
          key,
          file.iv,
          await file.ciphertext.arrayBuffer(),
          contextFor(vault, 'documentFile', file.documentId, 'file'),
        )
        : await decryptBytesWithLegacyAad(key, file.iv, await file.ciphertext.arrayBuffer());
      if (plaintext.byteLength !== document.sizeBytes) {
        reportIssue({
          severity: 'error',
          code: 'SIZE_MISMATCH',
          recordType: 'document',
          recordId: document.id,
          message: 'Decrypted file size does not match the document metadata.',
        });
      }
      const checksum = await sha256Hex(plaintext);
      if (checksum !== document.checksum) {
        reportIssue({
          severity: 'error',
          code: 'CHECKSUM_MISMATCH',
          recordType: 'document',
          recordId: document.id,
          message: 'Decrypted file checksum does not match the stored checksum.',
        });
      }
    } catch (error) {
      reportIssue({
        severity: 'error',
        code: 'INVALID_DOCUMENT_FILE',
        recordType: 'documentFile',
        recordId: document.id,
        message: `Encrypted document could not be authenticated: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    }
  }
  for (const file of files) {
    if (!documentIds.has(file.documentId)) {
      reportIssue({
        severity: 'warning',
        code: 'ORPHAN_FILE',
        recordType: 'documentFile',
        recordId: file.documentId,
        message: 'An encrypted file has no matching document record.',
      });
    }
  }

  for (const value of values) {
    await tryDecryptJson(value.valueEnc, contextFor(vault, 'value', value.id, 'value'), 'Vault value', 'value', value.id, 'value');
    await tryDecryptJson(
      value.normalizedValueEnc,
      contextFor(vault, 'value', value.id, 'normalizedValue'),
      'Normalized value',
      'value',
      value.id,
      'normalizedValue',
    );
    if (!value.labelEnc) {
      reportIssue({
        severity: 'warning',
        code: 'PLAINTEXT_LABEL',
        recordType: 'value',
        recordId: value.id,
        message: 'This value still has a plaintext label.',
      });
    } else {
      await tryDecryptJson(value.labelEnc, contextFor(vault, 'value', value.id, 'label'), 'Value label', 'value', value.id, 'label');
    }
    if (value.evidenceEnc) {
      await tryDecryptJson(
        value.evidenceEnc,
        contextFor(vault, 'value', value.id, 'evidence'),
        'Value evidence',
        'value',
        value.id,
        'evidence',
      );
    }
    if (value.sourceDocumentId.startsWith('doc_') && !documentIds.has(value.sourceDocumentId)) {
      reportIssue({
        severity: 'warning',
        code: 'BROKEN_VALUE_SOURCE',
        recordType: 'value',
        recordId: value.id,
        message: `Source document ${value.sourceDocumentId} is missing.`,
      });
    }
  }

  for (const conflict of conflicts) {
    await tryDecryptJson(
      conflict.existingValueEnc,
      contextFor(vault, 'conflict', conflict.id, 'existingValue'),
      'Conflict existing value',
      'conflict',
      conflict.id,
      'existingValue',
    );
    await tryDecryptJson(
      conflict.newValueEnc,
      contextFor(vault, 'conflict', conflict.id, 'newValue'),
      'Conflict new value',
      'conflict',
      conflict.id,
      'newValue',
    );
    if (!conflict.labelEnc) {
      reportIssue({
        severity: 'warning',
        code: 'PLAINTEXT_LABEL',
        recordType: 'conflict',
        recordId: conflict.id,
        message: 'This conflict still has a plaintext label.',
      });
    } else {
      await tryDecryptJson(conflict.labelEnc, contextFor(vault, 'conflict', conflict.id, 'label'), 'Conflict label', 'conflict', conflict.id, 'label');
    }
    for (const source of [conflict.existingSourceDocumentId, conflict.newSourceDocumentId]) {
      if (source.startsWith('doc_') && !documentIds.has(source)) {
        reportIssue({
          severity: 'warning',
          code: 'BROKEN_CONFLICT_SOURCE',
          recordType: 'conflict',
          recordId: conflict.id,
          message: `Conflict source document ${source} is missing.`,
        });
      }
    }
  }

  for (const record of profileRecords) {
    await tryDecryptJson(
      record.dataEnc,
      contextFor(vault, `profileRecord:${record.type}`, record.id, 'data'),
      'Profile record',
      'profileRecord',
      record.id,
      'data',
    );
    if (record.documentId?.startsWith('doc_') && !documentIds.has(record.documentId)) {
      reportIssue({
        severity: 'warning',
        code: 'BROKEN_PROFILE_SOURCE',
        recordType: 'profileRecord',
        recordId: record.id,
        message: `Source document ${record.documentId} is missing.`,
      });
    }
  }

  for (const collection of collections) {
    if (collection.vaultId !== vault.vaultId) {
      reportIssue({
        severity: 'error',
        code: 'VAULT_MISMATCH',
        recordType: 'collection',
        recordId: collection.id,
        message: 'Collection metadata references a different vault.',
      });
    }
    for (const field of ['name', 'description', 'notes'] as const) {
      const payload = field === 'name' ? collection.nameEnc : field === 'description' ? collection.descriptionEnc : collection.notesEnc;
      await tryDecryptJson(payload, contextFor(vault, 'collection', collection.id, field), `Collection ${field}`, 'collection', collection.id, field);
    }
  }

  const membershipPairs = new Set<string>();
  for (const membership of memberships) {
    if (!collectionIds.has(membership.collectionId)) {
      reportIssue({
        severity: 'error',
        code: 'BROKEN_MEMBERSHIP_COLLECTION',
        recordType: 'collectionDocument',
        recordId: membership.id,
        message: 'Collection membership references a missing collection.',
      });
    }
    if (!documentIds.has(membership.documentId)) {
      reportIssue({
        severity: 'error',
        code: 'BROKEN_MEMBERSHIP_DOCUMENT',
        recordType: 'collectionDocument',
        recordId: membership.id,
        message: 'Collection membership references a missing document.',
      });
    }
    const pair = `${membership.collectionId}\u0000${membership.documentId}`;
    if (membershipPairs.has(pair)) {
      reportIssue({
        severity: 'warning',
        code: 'DUPLICATE_MEMBERSHIP',
        recordType: 'collectionDocument',
        recordId: membership.id,
        message: 'Duplicate collection membership.',
      });
    }
    membershipPairs.add(pair);
  }

  for (const row of activity) {
    await tryDecryptJson(row.titleEnc, contextFor(vault, 'activity', row.id, 'title'), 'Activity title', 'activity', row.id, 'title');
    await tryDecryptJson(row.detailEnc, contextFor(vault, 'activity', row.id, 'detail'), 'Activity detail', 'activity', row.id, 'detail');
  }
  for (const row of history) {
    await tryDecryptJson(row.websiteEnc, contextFor(vault, 'formHistory', row.id, 'website'), 'History website', 'formHistory', row.id, 'website');
    await tryDecryptJson(row.urlEnc, contextFor(vault, 'formHistory', row.id, 'url'), 'History URL', 'formHistory', row.id, 'url');
    await tryDecryptJson(
      row.documentsUsedEnc,
      contextFor(vault, 'formHistory', row.id, 'documentsUsed'),
      'History documents',
      'formHistory',
      row.id,
      'documentsUsed',
    );
  }
  for (const row of text) {
    if (!documentIds.has(row.documentId)) {
      reportIssue({
        severity: 'warning',
        code: 'ORPHAN_TEXT',
        recordType: 'documentText',
        recordId: row.documentId,
        message: 'Extracted text has no matching document record.',
      });
    }
    await tryDecryptJson(row.textEnc, contextFor(vault, 'documentText', row.documentId, 'text'), 'Document text', 'documentText', row.documentId, 'text');
    await tryDecryptJson(
      row.pageTextsEnc,
      contextFor(vault, 'documentText', row.documentId, 'pageTexts'),
      'Document page text',
      'documentText',
      row.documentId,
      'pageTexts',
    );
    if (row.extractionEnc) {
      await tryDecryptJson(
        row.extractionEnc,
        contextFor(vault, 'documentText', row.documentId, 'extraction'),
        'Document extraction details',
        'documentText',
        row.documentId,
        'extraction',
      );
    }
  }
  const textDocumentIds = new Set(text.map((row) => row.documentId));
  for (const document of documents) {
    if (document.extractedTextStatus === 'extracted' && !textDocumentIds.has(document.id)) {
      reportIssue({
        severity: document.extractionVersion ? 'error' : 'warning',
        code: 'MISSING_DOCUMENT_TEXT',
        recordType: 'document',
        recordId: document.id,
        message: document.extractionVersion
          ? 'Document reports extracted text but its encrypted text record is missing.'
          : 'Legacy document reports extracted text without an encrypted text record.',
      });
    }
  }

  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    checkedAt: new Date().toISOString(),
    encryptionFormat,
    counts: {
      documents: documents.length,
      files: files.length,
      values: values.length,
      conflicts: conflicts.length,
      profileRecords: profileRecords.length,
      collections: collections.length,
      memberships: memberships.length,
      activity: activity.length,
      history: history.length,
      text: text.length,
    },
    issues,
  };
}
