import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import type { AuthenticatedBackupHeaderV3 } from '../../core/storage/vault-export';

const { resetDatabaseForTests } = await import('../../core/database/database');
const { vaultManager } = await import('../../core/vault/vault-manager');
const { vaultRepository: vaultRecordRepository } = await import('../../core/database/vault-repository');
const { documentRepository, collectionRepository } = await import('../../core/database/repositories');
const { vaultExportService, authenticatedBackupHeaderAad } = await import('../../core/storage/vault-export');
const {
  BACKUP_AAD,
  base64ToArrayBuffer,
  bufferToBase64,
  decryptBytesWithKey,
  decryptBytesWithLegacyAad,
  decryptBytesWithRawAad,
  deriveKeyFromPassword,
  encryptBytesWithKey,
  encryptBytesWithLegacyAad,
  encryptBytesWithRawAad,
  sha256Hex,
} = await import('../../core/encryption/crypto-service');

const SOURCE_PASS = 'final-source-passphrase';
const TARGET_PASS = 'final-target-passphrase';
const BACKUP_PASS = 'final-backup-passphrase';

interface V3Envelope {
  format: string;
  version: number;
  header: AuthenticatedBackupHeaderV3;
  payload: string;
}

interface LegacyEnvelope {
  format: string;
  version: number;
  createdAt: string;
  kdf: { name: string; iterations: number; salt: string };
  cipher: { name: string; iv: string };
  manifest: {
    schemaVersion: number;
    documentCount: number;
    valueCount: number;
    collectionCount: number;
    conflictCount: number;
    totalBytes: number;
  };
  payload: string;
}

let validBackup: Blob;
let sourcePayloadJson: string;

async function resetTarget(): Promise<void> {
  await vaultManager.lock();
  await resetDatabaseForTests();
  await vaultManager.create(TARGET_PASS);
  await vaultRecordRepository.create('Final hostile target vault');
}

async function decryptV3(envelope: V3Envelope, passphrase = BACKUP_PASS): Promise<string> {
  const key = await deriveKeyFromPassword(
    passphrase,
    new Uint8Array(base64ToArrayBuffer(envelope.header.salt)),
    envelope.header.iterations,
  );
  const plaintext = await decryptBytesWithRawAad(
    key,
    envelope.header.nonce,
    base64ToArrayBuffer(envelope.payload),
    authenticatedBackupHeaderAad(envelope.header),
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
}

async function encryptV3Payload(envelope: V3Envelope, plaintext: string): Promise<Blob> {
  const key = await deriveKeyFromPassword(
    BACKUP_PASS,
    new Uint8Array(base64ToArrayBuffer(envelope.header.salt)),
    envelope.header.iterations,
  );
  const bytes = new TextEncoder().encode(plaintext);
  envelope.header.payloadBytes = bytes.byteLength + 16;
  const encrypted = await encryptBytesWithRawAad(
    key,
    bytes,
    authenticatedBackupHeaderAad(envelope.header),
    envelope.header.nonce,
  );
  envelope.payload = bufferToBase64(encrypted.data);
  return new Blob([JSON.stringify(envelope)], { type: 'application/json' });
}

async function reencrypt(mutate: (payload: Record<string, unknown>, envelope: V3Envelope) => void): Promise<Blob> {
  const envelope = JSON.parse(await validBackup.text()) as V3Envelope;
  const payload = JSON.parse(await decryptV3(envelope)) as Record<string, unknown>;
  mutate(payload, envelope);
  return encryptV3Payload(envelope, JSON.stringify(payload));
}

async function mutateHeader(mutate: (header: Record<string, unknown>, envelope: V3Envelope) => void): Promise<Blob> {
  const envelope = JSON.parse(await validBackup.text()) as unknown as { header: Record<string, unknown> } & V3Envelope;
  mutate(envelope.header, envelope as V3Envelope);
  return new Blob([JSON.stringify(envelope)], { type: 'application/json' });
}

async function assertRejected(blob: Blob, pattern: RegExp): Promise<void> {
  await assert.rejects(() => vaultExportService.importEncrypted(blob, BACKUP_PASS), pattern);
  assert.equal((await documentRepository.list()).length, 0, 'failed import modified the target vault');
  assert.equal((await collectionRepository.list()).length, 0, 'failed import modified the target collections');
}

async function buildLegacy(version: 1 | 2): Promise<Blob> {
  const envelope = JSON.parse(await validBackup.text()) as V3Envelope;
  const plaintext = await decryptV3(envelope);
  sourcePayloadJson = plaintext;
  const key = await deriveKeyFromPassword(
    BACKUP_PASS,
    new Uint8Array(base64ToArrayBuffer(envelope.header.salt)),
    envelope.header.iterations,
  );
  const encrypted = version === 2
    ? await encryptBytesWithKey(key, new TextEncoder().encode(plaintext), BACKUP_AAD)
    : await encryptBytesWithLegacyAad(key, new TextEncoder().encode(plaintext));
  const legacy: LegacyEnvelope = {
    format: 'formflow-encrypted-backup',
    version,
    createdAt: envelope.header.createdAt,
    kdf: {
      name: 'PBKDF2-SHA256',
      iterations: envelope.header.iterations,
      salt: envelope.header.salt,
    },
    cipher: { name: 'AES-GCM', iv: encrypted.iv },
    manifest: {
      schemaVersion: 3,
      documentCount: envelope.header.documentCount,
      valueCount: envelope.header.valueCount,
      collectionCount: envelope.header.collectionCount,
      conflictCount: envelope.header.conflictCount,
      totalBytes: envelope.header.totalBytes,
    },
    payload: bufferToBase64(encrypted.data),
  };
  return new Blob([JSON.stringify(legacy)], { type: 'application/json' });
}

// Seed a source vault with two documents and one collection.
await resetDatabaseForTests();
await vaultManager.create(SOURCE_PASS);
const sourceVault = await vaultRecordRepository.create('Final hostile source vault');
const documents = [];
for (const [index, content] of ['first final document', 'second final document'].entries()) {
  const checksum = await sha256Hex(content);
  const document = await documentRepository.create(
    {
      vaultId: sourceVault.id,
      mimeType: 'text/plain',
      extension: 'txt',
      category: 'Other',
      subcategory: '',
      status: 'stored',
      fileType: 'txt',
      sizeBytes: content.length,
      sizeLabel: `${content.length} B`,
      checksum,
      storageKey: '',
      source: 'device',
      ocrUsed: false,
      extractedTextStatus: 'pending',
      metadata: {},
    },
    `final-${index}.txt`,
  );
  await documentRepository.saveOriginalFile(document.id, 'text/plain', new Blob([content], { type: 'text/plain' }));
  await documentRepository.update(document.id, { storageKey: `file_${document.id}` });
  documents.push(document);
}
await collectionRepository.create({ name: 'Final collection', documentIds: [documents[0]!.id] });
validBackup = await vaultExportService.exportEncrypted(BACKUP_PASS);
await resetTarget();

test('export produces an authenticated v3 header', async () => {
  const envelope = JSON.parse(await validBackup.text()) as V3Envelope;
  assert.equal(envelope.version, 3);
  assert.equal(envelope.header.application, 'FormFlow');
  assert.equal(envelope.header.backupFormat, 3);
  assert.equal(envelope.header.cipher, 'AES-GCM');
  assert.equal(envelope.header.kdf, 'PBKDF2-SHA256');
  assert.equal(envelope.header.iterations, 600_000);
  assert.equal(envelope.header.manifestVersion, 1);
  assert.equal(envelope.header.documentCount, 2);
  assert.equal(envelope.header.collectionCount, 1);
  assert.ok(envelope.header.payloadBytes > 16);
  assert.ok(!JSON.stringify(envelope).includes('final-0.txt'));
  assert.ok(!JSON.stringify(envelope).includes(BACKUP_PASS));
});

test('rejects empty, invalid, and truncated archives before authentication', async () => {
  await assertRejected(new Blob([]), /empty/i);
  await assertRejected(new Blob(['not json']), /not valid JSON/i);
  await assertRejected(new Blob(['{"format":']), /not valid JSON/i);
});

test('rejects unsupported versions and unexpected envelope properties', async () => {
  const source = JSON.parse(await validBackup.text()) as Record<string, unknown>;
  await assertRejected(new Blob([JSON.stringify({ ...source, version: 99 })]), /version/i);
  await assertRejected(new Blob([JSON.stringify({ ...source, format: 'other' })]), /supported/i);
  await assertRejected(new Blob([JSON.stringify({ ...source, unexpected: true })]), /unexpected property/i);
});

test('authenticates the cipher, KDF, iteration count, salt, nonce, and encryption format', async () => {
  await assertRejected(await mutateHeader((header) => { header.application = 'Other'; }), /application/i);
  await assertRejected(await mutateHeader((header) => { header.backupFormat = 2; }), /format/i);
  await assertRejected(await mutateHeader((header) => { header.cipher = 'AES-CBC'; }), /cipher/i);
  await assertRejected(await mutateHeader((header) => { header.kdf = 'SHA-1'; }), /key derivation/i);
  await assertRejected(await mutateHeader((header) => { header.iterations = 900_000; }), /parameters/i);
  await assertRejected(await mutateHeader((header) => { header.salt = 'AAAA'; }), /salt|length/i);
  await assertRejected(await mutateHeader((header) => { header.nonce = 'AAAA'; }), /nonce|length/i);
  await assertRejected(await mutateHeader((header) => { header.encryptionFormat = 3; }), /encryption format/i);
  await assertRejected(await mutateHeader((header) => { header.schemaVersion = 2; }), /schema/i);
  await assertRejected(await mutateHeader((header) => { header.manifestVersion = 2; }), /manifest version/i);
});

test('authenticates every manifest count, size, and timestamp', async () => {
  const authFailure = /incorrect|authenticated|corrupted/i;
  await assertRejected(await mutateHeader((header) => { header.documentCount = 1; }), authFailure);
  await assertRejected(await mutateHeader((header) => { header.valueCount = 1; }), authFailure);
  await assertRejected(await mutateHeader((header) => { header.collectionCount = 0; }), authFailure);
  await assertRejected(await mutateHeader((header) => { header.conflictCount = 1; }), authFailure);
  await assertRejected(await mutateHeader((header) => { header.profileRecordCount = 1; }), authFailure);
  await assertRejected(await mutateHeader((header) => { header.activityCount = 2; }), authFailure);
  await assertRejected(await mutateHeader((header) => { header.historyCount = 1; }), authFailure);
  await assertRejected(await mutateHeader((header) => { header.textCount = 1; }), authFailure);
  await assertRejected(await mutateHeader((header) => { header.totalBytes = 1; }), authFailure);
  await assertRejected(await mutateHeader((header) => { (header as unknown as AuthenticatedBackupHeaderV3).payloadBytes += 1; }), /size|authenticated|corrupted/i);
  await assertRejected(await mutateHeader((header) => { header.createdAt = '2020-01-01T00:00:00.000Z'; }), authFailure);
});

test('rejects invalid header types, missing fields, and duplicate keys', async () => {
  await assertRejected(await mutateHeader((header) => { header.documentCount = '2'; }), /integer|number/i);
  await assertRejected(await mutateHeader((header) => { header.createdAt = 'not-a-time'; }), /timestamp/i);
  await assertRejected(await mutateHeader((header) => { delete header.nonce; }), /nonce|string|object/i);

  const raw = await validBackup.text();
  const duplicated = raw.replace(/"iterations":\s*600000/, '"iterations":600000,"iterations":600000');
  assert.notEqual(duplicated, raw);
  await assertRejected(new Blob([duplicated]), /duplicate/i);
});

test('rejects tampered ciphertext and invalid UTF-8 payloads', async () => {
  const source = JSON.parse(await validBackup.text()) as V3Envelope;
  const bytes = Buffer.from(source.payload, 'base64');
  bytes[0] ^= 1;
  await assertRejected(
    new Blob([JSON.stringify({ ...source, payload: bytes.toString('base64') })]),
    /incorrect or the archive is corrupted/i,
  );

  const key = await deriveKeyFromPassword(
    BACKUP_PASS,
    new Uint8Array(base64ToArrayBuffer(source.header.salt)),
    source.header.iterations,
  );
  const invalid = new Uint8Array([0xff, 0xfe, 0xfd]);
  source.header.payloadBytes = invalid.byteLength + 16;
  const encrypted = await encryptBytesWithRawAad(
    key,
    invalid,
    authenticatedBackupHeaderAad(source.header),
    source.header.nonce,
  );
  await assertRejected(
    new Blob([JSON.stringify({ ...source, payload: bufferToBase64(encrypted.data) })]),
    /UTF-8/i,
  );
});

test('rejects duplicate IDs, missing files, bad checksums, negative sizes, and broken references', async () => {
  const duplicateDocument = await reencrypt((payload) => {
    const docs = payload.documents as Array<{ record: { id: string } }>;
    docs[1]!.record.id = docs[0]!.record.id;
  });
  await assertRejected(duplicateDocument, /duplicate document/i);

  const duplicateFile = await reencrypt((payload) => {
    const files = payload.files as Array<{ documentId: string }>;
    files[1]!.documentId = files[0]!.documentId;
  });
  await assertRejected(duplicateFile, /duplicate file/i);

  const missingFile = await reencrypt((payload, envelope) => {
    (payload.files as unknown[]).pop();
    envelope.header.totalBytes = (payload.files as Array<{ sizeBytes: number }>).reduce((sum, file) => sum + file.sizeBytes, 0);
  });
  await assertRejected(missingFile, /missing the file/i);

  const badChecksum = await reencrypt((payload) => {
    const docs = payload.documents as Array<{ record: { checksum: string } }>;
    docs[0]!.record.checksum = '0'.repeat(64);
  });
  await assertRejected(badChecksum, /checksum/i);

  const negativeSize = await reencrypt((payload) => {
    const files = payload.files as Array<{ sizeBytes: number }>;
    files[0]!.sizeBytes = -1;
  });
  await assertRejected(negativeSize, /size/i);

  const brokenCollection = await reencrypt((payload) => {
    const memberships = payload.collectionDocuments as Array<{ collectionId: string }>;
    memberships[0]!.collectionId = 'col_missing';
  });
  await assertRejected(brokenCollection, /missing collection/i);
});

test('rejects unexpected record properties, timestamps, MIME, and extension metadata', async () => {
  await assertRejected(await reencrypt((payload) => {
    const docs = payload.documents as Array<{ record: Record<string, unknown> }>;
    docs[0]!.record.injected = 'value';
  }), /unexpected property/i);

  await assertRejected(await reencrypt((payload) => {
    const docs = payload.documents as Array<{ record: Record<string, unknown> }>;
    docs[0]!.record.createdAt = 'not-a-timestamp';
  }), /timestamp/i);

  await assertRejected(await reencrypt((payload) => {
    const docs = payload.documents as Array<{ record: { mimeType: string } }>;
    docs[0]!.record.mimeType = 'application/x-msdownload';
  }), /MIME/i);

  await assertRejected(await reencrypt((payload) => {
    const docs = payload.documents as Array<{ record: { extension: string; fileType: string } }>;
    docs[0]!.record.extension = 'exe';
    docs[0]!.record.fileType = 'exe';
  }), /extension|file type/i);
});

test('accepts a valid v3 archive after reordering header fields', async () => {
  await resetTarget();
  const envelope = JSON.parse(await validBackup.text()) as V3Envelope;
  const reordered = {
    header: {
      createdAt: envelope.header.createdAt,
      textCount: envelope.header.textCount,
      historyCount: envelope.header.historyCount,
      activityCount: envelope.header.activityCount,
      profileRecordCount: envelope.header.profileRecordCount,
      conflictCount: envelope.header.conflictCount,
      collectionCount: envelope.header.collectionCount,
      valueCount: envelope.header.valueCount,
      documentCount: envelope.header.documentCount,
      manifestVersion: envelope.header.manifestVersion,
      schemaVersion: envelope.header.schemaVersion,
      encryptionFormat: envelope.header.encryptionFormat,
      nonce: envelope.header.nonce,
      salt: envelope.header.salt,
      iterations: envelope.header.iterations,
      kdf: envelope.header.kdf,
      cipher: envelope.header.cipher,
      backupFormat: envelope.header.backupFormat,
      application: envelope.header.application,
      payloadBytes: envelope.header.payloadBytes,
      totalBytes: envelope.header.totalBytes,
    },
    payload: envelope.payload,
    version: 3,
    format: envelope.format,
  };
  const result = await vaultExportService.importEncrypted(new Blob([JSON.stringify(reordered)]), BACKUP_PASS);
  assert.equal(result.imported, true);
  assert.equal(result.documents, 2);
  assert.equal(result.collections, 1);
});

test('accepts genuine legacy v2 archives with the original archive AAD', async () => {
  await resetTarget();
  const result = await vaultExportService.importEncrypted(await buildLegacy(2), BACKUP_PASS);
  assert.equal(result.imported, true);
  assert.equal(result.documents, 2);
});

test('accepts genuine legacy v1 archives with the original legacy AAD', async () => {
  await resetTarget();
  const result = await vaultExportService.importEncrypted(await buildLegacy(1), BACKUP_PASS);
  assert.equal(result.imported, true);
  assert.equal(result.documents, 2);
});
