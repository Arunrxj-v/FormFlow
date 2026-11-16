import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { resetDatabaseForTests } = await import('../../core/database/database');
const { vaultManager } = await import('../../core/vault/vault-manager');
const { vaultRepository: vaultRecordRepository } = await import('../../core/database/vault-repository');
const { documentRepository, vaultRepository } = await import('../../core/database/repositories');
const { documentStorage } = await import('../../core/storage/document-storage');
const { vaultExportService } = await import('../../core/storage/vault-export');
const { sha256Hex } = await import('../../core/encryption/crypto-service');

const SOURCE_PASS = 'source-vault-passphrase-123';
const TARGET_PASS = 'target-vault-passphrase-123';
const BACKUP_PASS = 'backup-passphrase-123';
let sourceBackup: Blob;

await resetDatabaseForTests();
await vaultManager.create(SOURCE_PASS);
const sourceVault = await vaultRecordRepository.create('Source vault');
await vaultRepository.saveProfile({ name: 'Backup User', email: 'backup@example.com' });
const checksum = await sha256Hex('hello world');
const document = await documentRepository.create(
  {
    vaultId: sourceVault.id,
    mimeType: 'text/plain',
    extension: 'txt',
    category: 'Other',
    subcategory: '',
    status: 'stored',
    fileType: 'txt',
    sizeBytes: 11,
    sizeLabel: '11 B',
    checksum,
    storageKey: '',
    source: 'device',
    ocrUsed: false,
    extractedTextStatus: 'pending',
    metadata: {},
  },
  'backup.txt',
);
await documentStorage.save(document.id, new Blob(['hello world'], { type: 'text/plain' }), 'text/plain');
await documentRepository.update(document.id, {
  storageKey: `file_${document.id}`,
  extractedTextStatus: 'extracted',
  extractionVersion: 1,
  extractedAt: new Date().toISOString(),
  ocrRequired: false,
});
await documentRepository.saveText(document.id, 'hello world', ['hello world'], 'txt', {
  version: 1,
  ocrRequired: false,
  pagesNeedingOcr: [],
  warnings: [{ code: 'BACKUP_FIXTURE', message: 'Encrypted extraction warning fixture' }],
  metadata: { encoding: 'utf-8', bom: false, lineEndings: 'lf' },
});

const ocrBytes = '%PDF-1.4\n% OCR backup fixture\n%%EOF\n';
const ocrChecksum = await sha256Hex(ocrBytes);
const ocrDocument = await documentRepository.create(
  {
    vaultId: sourceVault.id,
    mimeType: 'application/pdf',
    extension: 'pdf',
    category: 'Other',
    subcategory: '',
    status: 'stored',
    fileType: 'pdf',
    sizeBytes: ocrBytes.length,
    sizeLabel: `${ocrBytes.length} B`,
    checksum: ocrChecksum,
    storageKey: '',
    source: 'device',
    pageCount: 1,
    ocrUsed: true,
    ocrStatus: 'completed',
    ocrLanguage: 'eng',
    ocrConfidence: 91,
    ocrPagesTotal: 1,
    ocrPagesCompleted: 1,
    extractedTextStatus: 'extracted',
    extractionVersion: 1,
    extractedAt: new Date().toISOString(),
    ocrRequired: false,
    metadata: {},
  },
  'backup-ocr.pdf',
);
await documentStorage.save(ocrDocument.id, new Blob([ocrBytes], { type: 'application/pdf' }), 'application/pdf');
await documentRepository.update(ocrDocument.id, { storageKey: `file_${ocrDocument.id}` });
await documentRepository.saveText(ocrDocument.id, 'OCR BACKUP TEXT', ['OCR BACKUP TEXT'], 'ocr', {
  version: 1,
  ocrRequired: false,
  pagesNeedingOcr: [],
  warnings: [],
  metadata: {},
  ocr: {
    status: 'completed',
    engine: 'tesseract.js',
    engineVersion: '7.0.0',
    language: 'eng',
    processedAt: new Date().toISOString(),
    pagesAttempted: 1,
    pagesCompleted: 1,
    pagesFailed: 0,
    averageConfidence: 91,
    warnings: [],
    pages: [{
      page: 1,
      language: 'eng',
      confidence: 91,
      lines: [{
        text: 'OCR BACKUP TEXT',
        confidence: 91,
        bbox: { x0: 10, y0: 20, x1: 300, y1: 50 },
        words: [{ text: 'OCR', confidence: 91, bbox: { x0: 10, y0: 20, x1: 80, y1: 50 } }],
      }],
      words: [{ text: 'OCR', confidence: 91, bbox: { x0: 10, y0: 20, x1: 80, y1: 50 } }],
      warnings: [],
    }],
  },
});
await vaultRepository.addField({
  key: 'contact.email',
  label: 'Email address',
  value: 'backup@example.com',
  category: 'contact',
  source: { documentId: document.id, documentName: 'backup.txt' },
  confidence: 99,
  verificationStatus: 'user_verified',
  extractionMethod: 'manual',
});

test('exports an encrypted archive without plaintext sensitive data', async () => {
  const blob = await vaultExportService.exportEncrypted(BACKUP_PASS);
  sourceBackup = blob;
  const text = await blob.text();
  assert.ok(text.includes('formflow-encrypted-backup'));
  assert.ok(!text.includes('backup@example.com'));
  assert.ok(!text.includes('hello world'));
  assert.ok(!text.includes(BACKUP_PASS));
});

test('rejects a wrong backup passphrase and imports into an empty vault', async () => {
  const blob = await vaultExportService.exportEncrypted(BACKUP_PASS);

  await vaultManager.lock();
  await resetDatabaseForTests();
  await vaultManager.create(TARGET_PASS);
  await vaultRecordRepository.create('Target vault');
  await vaultRepository.saveProfile({ name: 'Target vault', email: '' });
  await assert.rejects(() => vaultExportService.importEncrypted(blob, 'wrong-passphrase'), /incorrect|corrupted/i);

  const envelope = JSON.parse(await blob.text()) as { payload: string };
  const payloadBytes = Buffer.from(envelope.payload, 'base64');
  payloadBytes[0] ^= 1;
  const tampered = new Blob([JSON.stringify({ ...envelope, payload: payloadBytes.toString('base64') })], { type: 'application/json' });
  await assert.rejects(() => vaultExportService.importEncrypted(tampered, BACKUP_PASS), /incorrect|corrupted|authenticated/i);

  const result = await vaultExportService.importEncrypted(blob, BACKUP_PASS);
  assert.equal(result.imported, true);
  assert.equal(result.documents, 2);
  assert.equal(result.values, 1);

  const importedDocuments = await documentRepository.list();
  const importedDoc = importedDocuments.find((item) => item.name === 'backup.txt');
  assert.ok(importedDoc);
  assert.equal(importedDoc.name, 'backup.txt');
  const file = await documentRepository.getOriginalFile(importedDoc.row.id);
  assert.ok(file);
  assert.equal(await file.text(), 'hello world');
  const text = await documentRepository.getText(importedDoc.row.id);
  assert.ok(text);
  assert.equal(text.text, 'hello world');
  assert.deepEqual(text.pageTexts, ['hello world']);
  assert.equal(text.extraction?.metadata.encoding, 'utf-8');
  assert.equal(text.extraction?.warnings[0]?.code, 'BACKUP_FIXTURE');

  const importedOcr = importedDocuments.find((item) => item.name === 'backup-ocr.pdf');
  assert.ok(importedOcr);
  assert.equal(importedOcr.row.ocrStatus, 'completed');
  assert.equal(importedOcr.row.ocrLanguage, 'eng');
  assert.equal(importedOcr.row.ocrConfidence, 91);
  assert.equal(importedOcr.row.ocrPagesTotal, 1);
  assert.equal(importedOcr.row.ocrPagesCompleted, 1);
  const ocrText = await documentRepository.getText(importedOcr.row.id);
  assert.ok(ocrText);
  assert.equal(ocrText.method, 'ocr');
  assert.equal(ocrText.text, 'OCR BACKUP TEXT');
  assert.equal(ocrText.extraction?.ocr?.status, 'completed');
  assert.equal(ocrText.extraction?.ocr?.averageConfidence, 91);
  assert.equal(ocrText.extraction?.ocr?.pages[0]?.lines?.[0]?.text, 'OCR BACKUP TEXT');
  assert.deepEqual(ocrText.extraction?.ocr?.pages[0]?.words?.[0]?.bbox, { x0: 10, y0: 20, x1: 80, y1: 50 });
  const fields = await vaultRepository.listFields();
  assert.equal(fields[0]!.value, 'backup@example.com');
});

test('rejects importing into a non-empty vault', async () => {
  const blob = await vaultExportService.exportEncrypted(BACKUP_PASS);
  await assert.rejects(() => vaultExportService.importEncrypted(blob, BACKUP_PASS), /already contains data/i);
});

test('rejects importing into a vault with a customized profile', async () => {
  await vaultManager.lock();
  await resetDatabaseForTests();
  await vaultManager.create(TARGET_PASS);
  await vaultRecordRepository.create('Personalized vault');
  await vaultRepository.saveProfile({ name: 'Custom Person', email: 'custom@example.com' });
  await assert.rejects(
    () => vaultExportService.importEncrypted(sourceBackup, BACKUP_PASS),
    /already contains data/i,
  );
});
