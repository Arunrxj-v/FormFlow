import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { resetDatabaseForTests } = await import('../../core/database/database');
const { documentRepository, vaultRepository } = await import('../../core/database/repositories');
const { vaultRepository: vaultRecordRepository } = await import('../../core/database/vault-repository');
const { vaultManager } = await import('../../core/vault/vault-manager');
const { extractDocumentInformation } = await import('../../core/application/extraction-service');
const { profileRecordService, profileService } = await import('../../core/application/profile-service');

const PASSPHRASE = 'extraction-service-passphrase-123';
await resetDatabaseForTests();
await vaultManager.create(PASSPHRASE);
const vault = await vaultRecordRepository.create('Extraction test vault');

let sequence = 0;
async function addDocument(name: string, text: string): Promise<string> {
  sequence += 1;
  const id = `doc_extract_${sequence}`;
  const row = await documentRepository.prepare(id, {
    vaultId: vault.id,
    mimeType: 'text/plain',
    extension: 'txt',
    category: 'Other',
    subcategory: '',
    status: 'stored',
    fileType: 'txt',
    sizeBytes: text.length,
    sizeLabel: `${text.length} B`,
    checksum: `checksum_${id}`,
    storageKey: `file_${id}`,
    source: 'device',
    pageCount: 1,
    ocrUsed: false,
    extractedTextStatus: 'extracted',
    extractionVersion: 1,
    extractedAt: new Date().toISOString(),
    ocrRequired: false,
  }, name);
  const file = await documentRepository.prepareOriginalFile(id, 'text/plain', new Blob([text], { type: 'text/plain' }));
  const storedText = await documentRepository.prepareText(id, text, [text], 'txt', {
    version: 1,
    ocrRequired: false,
    pagesNeedingOcr: [],
    warnings: [],
    metadata: {},
  });
  await documentRepository.commitIngested(row, file, storedText);
  return id;
}

test('extracts profile candidates with encrypted provenance and structured records', async () => {
  const text = [
    'Full Name: Arun Raj',
    'Email: arun@example.com',
    'Degree: B.Tech Computer Science',
    'Institution: Example Institute of Technology',
    'Graduation Year: 2021',
  ].join('\n');
  const documentId = await addDocument('resume.txt', text);
  const summary = await extractDocumentInformation(documentId);
  assert.ok(summary.candidates >= 4);
  assert.equal(summary.conflicts, 0);
  const fields = await vaultRepository.listFields();
  const email = fields.find((field) => field.key === 'contact.email');
  assert.ok(email);
  assert.equal(email?.value, 'arun@example.com');
  assert.equal(email?.source.documentId, documentId);
  assert.equal(email?.source.documentName, 'resume.txt');
  assert.ok(email?.source.evidence?.includes('arun@example.com'));
  assert.equal(email?.verificationStatus, 'extracted');

  const education = await profileRecordService.listEducation();
  assert.equal(education.length, 1);
  assert.equal(education[0]?.degree, 'B.Tech Computer Science');
  assert.equal(education[0]?.institution, 'Example Institute of Technology');
  assert.equal(education[0]?.documentId, documentId);
});

test('never overwrites a verified value and records a reviewable conflict', async () => {
  const fields = await vaultRepository.listFields();
  const email = fields.find((field) => field.key === 'contact.email');
  assert.ok(email);
  await vaultRepository.updateField(email.id, 'verified@example.com');

  const documentId = await addDocument('offer.txt', 'Email: new@example.com');
  const summary = await extractDocumentInformation(documentId);
  assert.equal(summary.conflicts, 1);
  const refreshed = (await vaultRepository.listFields()).find((field) => field.key === 'contact.email');
  assert.equal(refreshed?.value, 'verified@example.com');
  assert.equal(refreshed?.verificationStatus, 'user_verified');
  assert.equal(refreshed?.conflicts?.length, 1);
  assert.equal(refreshed?.conflicts?.[0]?.value, 'new@example.com');
});

test('model failure does not block deterministic extraction', async () => {
  const documentId = await addDocument('model-failure.txt', 'Phone: +91 98765 43210');
  const summary = await extractDocumentInformation(documentId, {
    model: async () => {
      throw new Error('model unavailable');
    },
  });
  assert.equal(summary.aiUsed, false);
  assert.ok(summary.warnings.some((warning) => /model unavailable/i.test(warning)));
  const phone = (await vaultRepository.listFields()).find((field) => field.key === 'contact.phone');
  assert.ok(phone?.value.replace(/\D/g, '').endsWith('9876543210'));
});


test('verifies a field and preserves its evidence and source', async () => {
  const fields = await vaultRepository.listFields();
  const phone = fields.find((field) => field.key === 'contact.phone');
  assert.ok(phone);
  const verified = await profileService.verifyField(phone.id);
  assert.equal(verified.verificationStatus, 'user_verified');
  assert.ok(verified.source.documentId);
  assert.ok(verified.source.evidence);
});

test('manual edits and conflict selection clear stale extraction evidence', async () => {
  const email = (await vaultRepository.listFields()).find((field) => field.key === 'contact.email');
  assert.ok(email);
  const resolved = await profileService.resolveConflict(email.id, 'new@example.com');
  assert.equal(resolved.value, 'new@example.com');
  assert.equal(resolved.verificationStatus, 'user_verified');
  assert.equal(resolved.source.evidence, undefined);
  assert.equal(resolved.source.blockId, undefined);
  assert.equal(resolved.source.modelVersion, undefined);
});
