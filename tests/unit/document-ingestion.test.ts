import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  buildDocx,
  buildTxt,
  pdfFixtures,
  toArrayBuffer,
} from '../helpers/document-fixtures';

const { resetDatabaseForTests, getDb } = await import('../../core/database/database');
const { vaultManager } = await import('../../core/vault/vault-manager');
const { vaultRepository: vaultRecordRepository } = await import('../../core/database/vault-repository');
const { documentRepository } = await import('../../core/database/repositories');
const { documentService } = await import('../../core/application/document-service');
const { vaultSession } = await import('../../core/vault/vault-session');
const { decryptJsonWithKey } = await import('../../core/encryption/crypto-service');
const { checkVaultIntegrity } = await import('../../core/vault/vault-integrity');
const { FormFlowError } = await import('../../shared/errors');
const { parseDocument } = await import('../../core/documents/parsers');

const PASSPHRASE = 'phase-4-ingestion-passphrase';
const encoder = new TextEncoder();

async function seedVault(): Promise<string> {
  await resetDatabaseForTests();
  await vaultManager.create(PASSPHRASE);
  const vault = await vaultRecordRepository.create('Ingestion vault');
  return vault.id;
}

function txtFile(text: string, name = 'notes.txt', options: { bom?: boolean; lineEndings?: 'lf' | 'crlf' } = {}) {
  const bytes = buildTxt(text, options);
  return new File([bytes], name, { type: 'text/plain' });
}

function pdfFile(bytes: Uint8Array, name = 'fixture.pdf') {
  return new File([bytes], name, { type: 'application/pdf' });
}

function docxFile(bytes: Uint8Array, name = 'fixture.docx') {
  return new File([bytes], name, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

function importDocument(
  input: Parameters<typeof documentService.importDocument>[0],
  deps: Parameters<typeof documentService.importDocument>[1] = {},
) {
  return documentService.importDocument(input, { parse: parseDocument, ...deps });
}

function retryExtraction(
  id: string,
  deps: Parameters<typeof documentService.retryExtraction>[1] = {},
) {
  return documentService.retryExtraction(id, { parse: parseDocument, ...deps });
}

async function rows() {
  const db = await getDb();
  const [documents, files, text] = await Promise.all([
    db.getAll('documents'),
    db.getAll('documentFiles'),
    db.getAll('documentText'),
  ]);
  return { documents, files, text };
}

test('background ingestion requires an injected isolated parser', async () => {
  await seedVault();
  await assert.rejects(
    () => documentService.importDocument({ file: txtFile('no parser configured') }),
    (error: unknown) => error instanceof FormFlowError && error.code === 'PARSER_UNAVAILABLE',
  );
  const state = await rows();
  assert.equal(state.documents.length, 0);
  assert.equal(state.files.length, 0);
  assert.equal(state.text.length, 0);
});

test('TXT ingestion persists encrypted original, text, and extraction details', async () => {
  const vaultId = await seedVault();
  const secret = 'Private address: 42 Example Street\nBengaluru 560001';
  const file = txtFile(secret, 'private-address.txt', { bom: true, lineEndings: 'crlf' });
  const result = await importDocument({ file });
  assert.equal(result.duplicate, false);
  assert.equal(result.document.pageCount, 1);
  assert.equal(result.document.extractedTextStatus, 'extracted');
  assert.equal(result.document.ocrRequired, false);
  assert.equal(result.document.extractionVersion, 1);
  assert.ok(result.document.extractedAt);

  const state = await rows();
  assert.equal(state.documents.length, 1);
  assert.equal(state.files.length, 1);
  assert.equal(state.text.length, 1);
  const document = state.documents[0]!;
  const text = state.text[0]!;
  assert.equal(document.vaultId, vaultId);
  assert.ok(document.nameEnc.includes('"v":2'));
  assert.ok(!JSON.stringify(document).includes(secret));
  assert.ok(text.textEnc.includes('"v":2'));
  assert.ok(text.pageTextsEnc.includes('"v":2'));
  assert.ok(text.extractionEnc?.includes('"v":2'));
  assert.ok(!JSON.stringify(state).includes(secret));
  assert.ok(!JSON.stringify(state).includes('private-address.txt'));

  const stored = await documentRepository.getText(document.id);
  assert.ok(stored);
  assert.equal(stored.text, secret);
  assert.deepEqual(stored.pageTexts, [secret]);
  assert.equal(stored.extraction?.metadata.bom, true);
  assert.equal(stored.extraction?.metadata.lineEndings, 'crlf');
  const original = await documentRepository.getOriginalFile(document.id);
  assert.ok(original);
  assert.equal(new TextDecoder().decode(await original.arrayBuffer()), secret.replace(/\n/g, '\r\n'));
});

test('extracted text is bound to the document, format, and field by AAD', async () => {
  await seedVault();
  const file = txtFile('AAD binding check content');
  const result = await importDocument({ file });
  const state = await rows();
  const document = state.documents[0]!;
  const text = state.text[0]!;
  const key = await vaultSession.getDataKey();
  const identity = { vaultId: document.vaultId, schemaVersion: 2 };
  const good = {
    ...identity,
    recordType: 'documentText',
    recordId: document.id,
    field: 'text',
  };
  assert.equal(await decryptJsonWithKey<string>(key, text.textEnc, good), 'AAD binding check content');
  await assert.rejects(() => decryptJsonWithKey<string>(key, text.textEnc, { ...good, field: 'pageTexts' }));
  await assert.rejects(() => decryptJsonWithKey<string>(key, text.textEnc, { ...good, recordId: result.document.id + '_other' }));
  await assert.rejects(() => decryptJsonWithKey<string>(key, text.textEnc, { ...good, recordType: 'document' }));
});

test('PDF ingestion preserves pages and PDF metadata in encrypted extraction details', async () => {
  await seedVault();
  const result = await importDocument({
    file: pdfFile(pdfFixtures.multiPage(), 'academic.pdf'),
    category: 'Education',
  });
  assert.equal(result.document.pageCount, 2);
  assert.equal(result.document.status, 'stored');
  const stored = await documentRepository.getText(result.document.id);
  assert.ok(stored);
  assert.equal(stored.pageTexts.length, 2);
  assert.match(stored.pageTexts[0]!, /First page/);
  assert.match(stored.pageTexts[1]!, /Second page/);
  assert.equal(stored.extraction?.version, 1);
  assert.deepEqual(stored.extraction?.pagesNeedingOcr, []);
});

test('DOCX ingestion preserves headings and table cells in encrypted text', async () => {
  await seedVault();
  const bytes = buildDocx({
    paragraphs: [
      { text: 'Employment Record', heading: 1 },
      { text: 'Line one\nLine two' },
    ],
    tables: [[['Employer', 'Northstar Labs'], ['Role', 'Engineer']]],
    core: { title: 'Employment DOCX', author: 'Fixture Author' },
  });
  const result = await importDocument({ file: docxFile(bytes, 'employment.docx') });
  const stored = await documentRepository.getText(result.document.id);
  assert.ok(stored);
  assert.match(stored.text, /Employment Record/);
  assert.match(stored.text, /Line one\nLine two/);
  assert.match(stored.text, /Employer\tNorthstar Labs/);
  assert.equal(stored.extraction?.metadata.title, 'Employment DOCX');
  assert.equal(stored.extraction?.metadata.headings?.[0]?.text, 'Employment Record');
  assert.equal(stored.extraction?.metadata.tableCount, 1);
});

test('scanned PDFs are stored as OCR-required without external OCR', async () => {
  await seedVault();
  const result = await importDocument({
    file: pdfFile(pdfFixtures.imageOnly(), 'scanned.pdf'),
    category: 'Identity',
  });
  assert.equal(result.document.ocrRequired, true);
  assert.equal(result.document.status, 'review_required');
  assert.equal(result.document.extractedTextStatus, 'extracted');
  const stored = await documentRepository.getText(result.document.id);
  assert.ok(stored);
  assert.equal(stored.text, '');
  assert.deepEqual(stored.extraction?.pagesNeedingOcr, [1, 2]);
  assert.ok(stored.extraction?.warnings.some((item) => item.code === 'OCR_REQUIRED'));
  assert.ok(stored.extraction?.warnings.some((item) => item.code === 'MIXED_TEXT_AND_IMAGE_PAGES') === false);
});

test('identical files are detected by SHA-256 and never create a second record', async () => {
  await seedVault();
  const first = await importDocument({ file: txtFile('duplicate content', 'first.txt') });
  const second = await importDocument({ file: txtFile('duplicate content', 'second.txt') });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.document.id, first.document.id);
  assert.equal(second.document.name, 'first.txt');
  const state = await rows();
  assert.equal(state.documents.length, 1);
  assert.equal(state.files.length, 1);
  assert.equal(state.text.length, 1);
});

test('empty, corrupted, unsupported, and password-protected files leave no records', async () => {
  await seedVault();
  const cases: Array<{ file: File; code: string }> = [
    { file: txtFile(''), code: 'EMPTY_DOCUMENT' },
    { file: pdfFile(pdfFixtures.corrupted(), 'corrupt.pdf'), code: 'CORRUPTED_DOCUMENT' },
    { file: pdfFile(pdfFixtures.password(), 'locked.pdf'), code: 'PASSWORD_PROTECTED' },
    {
      file: new File([encoder.encode('not a pdf')], 'renamed.pdf', { type: 'application/pdf' }),
      code: 'UNSUPPORTED_FILE',
    },
    {
      file: new File([encoder.encode('plain text')], 'renamed.jpg', { type: 'image/jpeg' }),
      code: 'UNSUPPORTED_FILE',
    },
  ];
  for (const item of cases) {
    await assert.rejects(
      () => importDocument({ file: item.file }),
      (error: unknown) => error instanceof FormFlowError && error.code === item.code,
    );
    const state = await rows();
    assert.equal(state.documents.length, 0);
    assert.equal(state.files.length, 0);
    assert.equal(state.text.length, 0);
  }
});

test('extraction timeout aborts bounded processing and leaves no partial record', async () => {
  await seedVault();
  await assert.rejects(
    () => importDocument(
      { file: txtFile('timeout content') },
      {
        timeoutMs: 20,
        parse: () => new Promise(() => undefined),
      },
    ),
    (error: unknown) => error instanceof FormFlowError && error.code === 'EXTRACTION_TIMEOUT',
  );
  const state = await rows();
  assert.equal(state.documents.length, 0);
  assert.equal(state.files.length, 0);
  assert.equal(state.text.length, 0);
});

test('cancellation during extraction leaves no partial document or text', async () => {
  await seedVault();
  const controller = new AbortController();
  await assert.rejects(
    () => importDocument(
      { file: txtFile('cancel this import'), signal: controller.signal },
      {
        signal: controller.signal,
        parse: async () => {
          controller.abort();
          const error = new Error('cancelled by test');
          error.name = 'AbortError';
          throw error;
        },
      },
    ),
    (error: unknown) => error instanceof FormFlowError && error.code === 'CANCELLED',
  );
  const state = await rows();
  assert.equal(state.documents.length, 0);
  assert.equal(state.files.length, 0);
  assert.equal(state.text.length, 0);
});

test('vault locking during extraction prevents the atomic commit', async () => {
  await seedVault();
  await assert.rejects(
    () => importDocument(
      { file: txtFile('lock during parse') },
      {
        parse: async () => {
          await vaultManager.lock();
          return {
            text: 'lock during parse',
            pageTexts: ['lock during parse'],
            pageCount: 1,
            method: 'txt',
            version: 1,
            ocrRequired: false,
            pagesNeedingOcr: [],
            warnings: [],
            metadata: {},
          };
        },
      },
    ),
    (error: unknown) => error instanceof FormFlowError && ['VAULT_LOCKED', 'SESSION_EXPIRED'].includes(error.code),
  );
  await vaultManager.unlock(PASSPHRASE);
  const state = await rows();
  assert.equal(state.documents.length, 0);
  assert.equal(state.files.length, 0);
  assert.equal(state.text.length, 0);
});

test('a storage failure during commit rolls back document, file, and text together', async () => {
  await seedVault();
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patched(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === 'documentText') throw new DOMException('Quota exceeded', 'QuotaExceededError');
    return originalPut.call(this, value as never, key as never);
  } as typeof IDBObjectStore.prototype.put;
  try {
    await assert.rejects(
      () => importDocument({ file: txtFile('quota rollback content') }),
      /storage|quota/i,
    );
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  const state = await rows();
  assert.equal(state.documents.length, 0);
  assert.equal(state.files.length, 0);
  assert.equal(state.text.length, 0);
});

test('retry extraction replaces encrypted text without creating another document', async () => {
  await seedVault();
  const imported = await importDocument({ file: txtFile('original extracted text') });
  const retried = await retryExtraction(
    imported.document.id,
    {
      parse: async () => ({
        text: 'refreshed extracted text',
        pageTexts: ['refreshed extracted text'],
        pageCount: 1,
        method: 'txt',
        version: 1,
        ocrRequired: false,
        pagesNeedingOcr: [],
        warnings: [{ code: 'RETRY_TEST', message: 'retry used a deterministic stub' }],
        metadata: { encoding: 'utf-8' },
      }),
    },
  );
  assert.equal(retried.document.id, imported.document.id);
  const state = await rows();
  assert.equal(state.documents.length, 1);
  assert.equal(state.files.length, 1);
  assert.equal(state.text.length, 1);
  const stored = await documentRepository.getText(imported.document.id);
  assert.ok(stored);
  assert.equal(stored.text, 'refreshed extracted text');
  assert.equal(stored.extraction?.warnings[0]?.code, 'RETRY_TEST');
});

test('tampered extraction details are reported by the vault integrity checker', async () => {
  await seedVault();
  const imported = await importDocument({ file: txtFile('integrity protected text') });
  const db = await getDb();
  const text = await db.get('documentText', imported.document.id);
  assert.ok(text?.extractionEnc);
  const envelope = JSON.parse(text.extractionEnc) as { data: string };
  const bytes = Buffer.from(envelope.data, 'base64');
  bytes[0] ^= 1;
  envelope.data = bytes.toString('base64');
  await db.put('documentText', { ...text, extractionEnc: JSON.stringify(envelope) });
  const report = await checkVaultIntegrity();
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === 'INVALID_CIPHERTEXT' && issue.recordType === 'documentText'));
});

test('no plaintext extracted text is stored in the IndexedDB record shape', async () => {
  await seedVault();
  const text = 'No plaintext should survive at rest 938475';
  await importDocument({ file: txtFile(text) });
  const db = await getDb();
  const rawRows = await db.getAll('documentText');
  assert.ok(!JSON.stringify(rawRows).includes(text));
  assert.ok(rawRows.every((row) => row.textEnc.includes('"v":2') && row.pageTextsEnc.includes('"v":2')));
  const documents = JSON.stringify(await db.getAll('documents'));
  assert.ok(!documents.includes('notes.txt'));
  assert.ok(!documents.includes(text));
});
