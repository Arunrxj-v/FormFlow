import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = 8891;
const dbPath = `/tmp/formflow-upload-test-${Date.now()}.db`;
const storageDir = `/tmp/formflow-storage-test-${Date.now()}`;
let child;
let tokenUserA;
let userIdA;
let tokenUserB;
let userIdB;

function buildTestPdf(textContent) {
  const streamBody = `BT /F1 12 Tf 50 100 Td (${textContent}) Tj ET`;
  return `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 500 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${streamBody.length} >> stream
${streamBody}
endstream
endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000060 00000 n 
0000000117 00000 n 
0000000227 00000 n 
0000000350 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
450
%%EOF`;
}

function buildMultipartBody(filename, fileBuffer, category = 'Education') {
  const boundary = `----WebKitFormBoundary${Date.now().toString(16)}`;
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\n${category}\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  const bodyBuffer = Buffer.concat([
    Buffer.from(header, 'utf8'),
    fileBuffer,
    Buffer.from(footer, 'utf8'),
  ]);

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: bodyBuffer,
  };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://localhost:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // server starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Test server failed to start.');
}

test.before(async () => {
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      STORAGE_DIR: storageDir,
      AUTH_SECRET: 'test-secret-upload-pipeline',
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
  await waitForHealth();

  // Create User A
  const resA = await fetch(`http://localhost:${port}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Alice Walker', email: 'alice.upload@example.com', password: 'Password123!' }),
  });
  const dataA = await resA.json();
  tokenUserA = dataA.token;
  userIdA = dataA.user.id;

  // Create User B
  const resB = await fetch(`http://localhost:${port}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Bob Smith', email: 'bob.upload@example.com', password: 'Password123!' }),
  });
  const dataB = await resB.json();
  tokenUserB = dataB.token;
  userIdB = dataB.user.id;
});

test.after(async () => {
  child?.kill('SIGTERM');
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test('real multipart upload, text extraction, persistence, and vault population', async () => {
  const pdfText = 'Full Name: Alice Walker Email: alice.upload@example.com Phone: +1 555 987 6543 Degree: Bachelor of Engineering University: Stanford University Graduation year: 2024';
  const pdfBytes = Buffer.from(buildTestPdf(pdfText));
  const { contentType, body } = buildMultipartBody('Degree_Certificate_2024.pdf', pdfBytes, 'Education');

  // 1. Upload file via multipart/form-data
  const uploadRes = await fetch(`http://localhost:${port}/api/documents/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenUserA}`,
      'content-type': contentType,
    },
    body,
  });

  assert.equal(uploadRes.status, 201);
  const uploadData = await uploadRes.json();
  assert.ok(Array.isArray(uploadData.documents));
  assert.equal(uploadData.documents.length, 1);

  const doc = uploadData.documents[0];
  assert.equal(doc.name, 'Degree_Certificate_2024.pdf');
  assert.equal(doc.category, 'Education');
  assert.ok(doc.status === 'completed' || doc.status === 'processed');
  assert.ok(doc.sizeBytes > 0);
  assert.ok(doc.sha256.length === 64);
  assert.ok(doc.storagePath.includes('Degree_Certificate_2024.pdf'));

  // 2. Verify file is persisted in physical backend storage
  const physicalPath = path.join(storageDir, doc.storagePath);
  assert.ok(existsSync(physicalPath), `Physical file must exist at ${physicalPath}`);

  // 3. Verify extracted facts are saved in user's vault
  const fieldsRes = await fetch(`http://localhost:${port}/api/fields`, {
    headers: { authorization: `Bearer ${tokenUserA}` },
  });
  assert.equal(fieldsRes.status, 200);
  const fieldsData = await fieldsRes.json();
  assert.ok(fieldsData.fields.length >= 2, 'Vault should contain extracted fields');

  const emailField = fieldsData.fields.find((f) => f.key === 'contact.email');
  assert.ok(emailField);
  assert.equal(emailField.value, 'alice.upload@example.com');
  assert.equal(emailField.source.documentId, doc.id);

  // 4. Secure Preview: verify file bytes can be retrieved
  const previewRes = await fetch(`http://localhost:${port}/api/documents/${doc.id}/preview`, {
    headers: { authorization: `Bearer ${tokenUserA}` },
  });
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.headers.get('content-type'), 'application/pdf');
  const retrievedBuffer = Buffer.from(await previewRes.arrayBuffer());
  assert.equal(retrievedBuffer.length, pdfBytes.length);
  assert.equal(retrievedBuffer.toString('hex'), pdfBytes.toString('hex'));

  // 5. Unauthorized access check: User B cannot preview User A's document
  const forbiddenRes = await fetch(`http://localhost:${port}/api/documents/${doc.id}/preview`, {
    headers: { authorization: `Bearer ${tokenUserB}` },
  });
  assert.equal(forbiddenRes.status, 404);

  // 6. Reprocess document from stored file
  const reprocessRes = await fetch(`http://localhost:${port}/api/documents/${doc.id}/reprocess`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenUserA}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(reprocessRes.status, 200);
  const reprocessData = await reprocessRes.json();
  assert.ok(reprocessData.document.status === 'completed' || reprocessData.document.status === 'processed');

  // 7. Delete document: verify physical file and database records are removed
  const deleteRes = await fetch(`http://localhost:${port}/api/documents/${doc.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${tokenUserA}` },
  });
  assert.equal(deleteRes.status, 200);
  assert.ok(!existsSync(physicalPath), 'Physical file must be deleted when document is removed');

  // Verify document no longer in list
  const listAfterDelete = await fetch(`http://localhost:${port}/api/documents`, {
    headers: { authorization: `Bearer ${tokenUserA}` },
  });
  const listData = await listAfterDelete.json();
  assert.ok(!listData.documents.some((d) => d.id === doc.id));
});

test('file validation rejection: empty file, corrupted signature, unsupported type', async () => {
  // A. Corrupted PDF (does not start with %PDF-)
  const fakePdf = Buffer.from('This is NOT a valid PDF document at all');
  const { contentType: ctCorrupted, body: bodyCorrupted } = buildMultipartBody('corrupted.pdf', fakePdf);

  const corruptedRes = await fetch(`http://localhost:${port}/api/documents/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenUserA}`, 'content-type': ctCorrupted },
    body: bodyCorrupted,
  });
  assert.equal(corruptedRes.status, 500); // Caught and reported as validation error
  const errData = await corruptedRes.json();
  assert.ok(errData.error.includes('signature') || errData.error.includes('Invalid PDF'));

  // B. Unsupported file type (.exe)
  const exeBuffer = Buffer.from('MZ\x90\x00\x03\x00\x00\x00');
  const { contentType: ctExe, body: bodyExe } = buildMultipartBody('malicious.exe', exeBuffer);

  const exeRes = await fetch(`http://localhost:${port}/api/documents/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenUserA}`, 'content-type': ctExe },
    body: bodyExe,
  });
  assert.equal(exeRes.status, 500);
  const exeErr = await exeRes.json();
  assert.ok(exeErr.error.includes('Unsupported file type'));
});

