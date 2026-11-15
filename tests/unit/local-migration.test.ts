import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { resetDatabaseForTests } from '../../core/database/database';
import { documentRepository, vaultRepository } from '../../core/database/repositories';
import { vaultRepository as vaultRecordRepository } from '../../core/database/vault-repository';
import { legacyMigrationService } from '../../core/migration/legacy-migration-service';
import { vaultManager } from '../../core/vault/vault-manager';

const PASSPHRASE = 'migration-test-passphrase-123';
await resetDatabaseForTests();
await vaultManager.create(PASSPHRASE);

interface LegacyRow {
  id: string;
  name: string;
  category: string;
  subcategory?: string;
  status?: string;
  mimeType?: string;
  extractedText?: string;
  sha256?: string;
  sizeBytes?: number;
}

const legacyDocuments: LegacyRow[] = [
  {
    id: 'legacy_doc_1',
    name: 'legacy-resume.pdf',
    category: 'Employment',
    subcategory: 'Resume',
    status: 'completed',
    mimeType: 'application/pdf',
    extractedText: 'Legacy resume text',
    sha256: 'legacy-checksum-1',
  },
  {
    id: 'legacy_doc_2',
    name: 'legacy-degree.pdf',
    category: 'Education',
    status: 'completed',
    mimeType: 'application/pdf',
    extractedText: 'Legacy degree text',
    sha256: 'legacy-checksum-2',
  },
];

const legacyFields = [
  {
    id: 'legacy_field_1',
    key: 'contact.email',
    label: 'Email address',
    value: 'legacy@example.com',
    normalizedValue: 'legacy@example.com',
    category: 'contact' as const,
    source: { documentId: 'legacy_doc_1', documentName: 'legacy-resume.pdf' },
    sourcePage: 1,
    confidence: 99,
    verificationStatus: 'extracted' as const,
    sensitive: false,
  },
];

const legacyCollections = [
  {
    id: 'legacy_col_1',
    name: 'Legacy job applications',
    description: 'Legacy collection',
    notes: '',
    documentIds: ['legacy_doc_1'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const legacyHistory = [
  {
    id: 'legacy_hist_1',
    website: 'legacy.example.com',
    url: 'https://legacy.example.com/form',
    dateLabel: 'Legacy',
    fieldsDetected: 12,
    fieldsFilled: 10,
    fieldsReview: 2,
    status: 'Partially completed' as const,
    documentsUsed: ['legacy-resume.pdf'],
    duration: 18,
    timestamp: new Date().toISOString(),
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const realFetch = globalThis.fetch.bind(globalThis);

async function installLegacyBackend() {
  (globalThis as { fetch: unknown }).fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/auth/login')) {
      return jsonResponse({ token: 'legacy-session-token', user: { id: 'legacy_user', name: 'Legacy User', email: 'legacy@example.com' } });
    }
    if (url.endsWith('/api/auth/me')) return jsonResponse({ user: { id: 'legacy_user', name: 'Legacy User', email: 'legacy@example.com' } });
    if (url.endsWith('/api/documents')) return jsonResponse({ documents: legacyDocuments });
    if (url.endsWith('/api/fields')) return jsonResponse({ fields: legacyFields });
    if (url.endsWith('/api/collections')) return jsonResponse({ collections: legacyCollections });
    if (url.endsWith('/api/history')) return jsonResponse({ history: legacyHistory });
    const match = url.match(/\/api\/documents\/([^/]+)\/preview$/);
    if (match) {
      const document = legacyDocuments.find((row) => row.id === match[1]);
      if (!document) return new Response('Not found', { status: 404 });
      return new Response(new Blob([document.extractedText ?? ''], { type: 'application/pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }
    return new Response('Not found', { status: 404 });
  };
}

await installLegacyBackend();
const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
};
storage.set('formflow.auth.token', 'legacy-token');

test('logs into the legacy backend and stores a temporary migration token', async () => {
  const user = await legacyMigrationService.login('legacy@example.com', 'correct horse battery staple');
  assert.equal(user.email, 'legacy@example.com');
  assert.equal(storage.get('formflow.auth.token'), 'legacy-session-token');
});

test('migrates legacy data into local IndexedDB and is idempotent', async () => {
  await vaultRecordRepository.create('Migration test vault');
  const first = await legacyMigrationService.migrate();
  assert.equal(first.documents.imported, 2);
  assert.equal(first.values.imported, 1);
  assert.equal(first.collections.imported, 1);
  assert.equal(first.history.imported, 1);

  const documents = await documentRepository.list();
  assert.equal(documents.length, 2);
  const fields = await vaultRepository.listFields();
  assert.equal(fields.length, 1);
  assert.equal(fields[0]!.source.documentName, 'legacy-resume.pdf');

  const second = await legacyMigrationService.migrate();
  assert.equal(second.documents.imported, 0);
  assert.equal(second.documents.skipped, 2);
  assert.equal(second.values.imported, 1);
  assert.equal(second.collections.imported, 0);
  assert.equal(second.history.imported, 1);

  const documentsAfterRetry = await documentRepository.list();
  assert.equal(documentsAfterRetry.length, 2);
  const blob = await documentRepository.getOriginalFile(documentsAfterRetry[0]!.row.id);
  assert.ok(blob);
  assert.ok((await blob.text()).includes('Legacy'));
  assert.match(documentsAfterRetry[0]!.row.checksum, /^[0-9a-f]{64}$/i);
});

test('preserves existing local records when migration fails or is retried', async () => {
  const documentsBefore = await documentRepository.list();
  const localDocument = await documentRepository.create(
    {
      vaultId: (await vaultRecordRepository.getActive())!.id,
      mimeType: 'application/pdf',
      extension: 'pdf',
      category: 'Other',
      subcategory: '',
      status: 'stored',
      fileType: 'pdf',
      sizeBytes: 10,
      sizeLabel: '10 B',
      checksum: 'local-existing-checksum',
      storageKey: '',
      source: 'device',
      ocrUsed: false,
      extractedTextStatus: 'pending',
      metadata: {},
    },
    'local-existing.pdf',
  );
  const result = await legacyMigrationService.migrate();
  assert.equal(result.documents.skipped, 2);
  const documentsAfter = await documentRepository.list();
  assert.equal(documentsAfter.length, documentsBefore.length + 1);
  const stillThere = await documentRepository.get(localDocument.id);
  assert.ok(stillThere);
  assert.equal(stillThere.name, 'local-existing.pdf');
});

test.after(() => {
  globalThis.fetch = realFetch;
});
