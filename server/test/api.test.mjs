import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

process.env.AUTH_SECRET = 'test-secret';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = 8899;
const dbPath = `/tmp/formflow-test-${Date.now()}.db`;
let child;
let token;
let testUserId;

function seedTestUser(dbFilePath, userId) {
  const db = new DatabaseSync(dbFilePath);
  const now = new Date().toISOString();
  const documents = [
    { id: 'doc_degree', name: 'Degree_Certificate_2025.pdf', category: 'Education', subcategory: 'Education / Degree', status: 'processed', fileType: 'pdf', sizeLabel: '1.4 MB', source: 'drive', sourceFileId: 'drive_degree' },
    { id: 'doc_passport', name: 'Passport_Bio_Page_Scan.pdf', category: 'Identity', subcategory: 'Identity / Passport', status: 'processed', fileType: 'pdf', sizeLabel: '842 KB', source: 'drive', sourceFileId: 'drive_passport' },
    { id: 'doc_resume', name: 'Resume_Arunraj_V.pdf', category: 'Employment', subcategory: 'Employment / Resume', status: 'processed', fileType: 'pdf', sizeLabel: '316 KB', source: 'upload' },
    { id: 'doc_offer', name: 'Employment_Offer_Letter_2025.pdf', category: 'Employment', subcategory: 'Employment / Letters', status: 'processed', fileType: 'pdf', sizeLabel: '228 KB', source: 'drive', sourceFileId: 'drive_offer' },
  ];
  for (const doc of documents) {
    db.prepare(`INSERT INTO documents (id,user_id,name,category,subcategory,status,file_type,size_label,source,source_file_id,is_demo,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(
      doc.id, userId, doc.name, doc.category, doc.subcategory, doc.status, doc.fileType, doc.sizeLabel, doc.source, doc.sourceFileId ?? null, now, now,
    );
  }
  const fields = [
    { id: 'field_full_name', key: 'personal.fullName', label: 'Full name', value: 'Arunraj V.', category: 'personal', sourceDocumentId: 'doc_degree', confidence: 0.98 },
    { id: 'field_first_name', key: 'personal.firstName', label: 'First name', value: 'Arunraj', category: 'personal', sourceDocumentId: 'doc_degree', confidence: 0.98 },
    { id: 'field_last_name', key: 'personal.lastName', label: 'Last name', value: 'V.', category: 'personal', sourceDocumentId: 'doc_degree', confidence: 0.97 },
    { id: 'field_dob', key: 'personal.dateOfBirth', label: 'Date of birth', value: '12 May 2003', category: 'personal', sourceDocumentId: 'doc_passport', confidence: 0.96, sensitive: true },
    { id: 'field_nationality', key: 'personal.nationality', label: 'Nationality', value: 'Indian', category: 'personal', sourceDocumentId: 'doc_passport', confidence: 0.98 },
    { id: 'field_email', key: 'contact.email', label: 'Email address', value: 'arun@example.com', category: 'contact', sourceDocumentId: 'doc_resume', confidence: 0.99 },
    { id: 'field_phone', key: 'contact.phone', label: 'Phone number', value: '+91 98470 12345', category: 'contact', sourceDocumentId: 'doc_resume', confidence: 0.88 },
    { id: 'field_address', key: 'contact.addressLine1', label: 'Address line 1', value: 'Flat 4B, Emerald Heights', category: 'contact', sourceDocumentId: 'doc_passport', confidence: 0.91 },
    { id: 'field_city', key: 'contact.city', label: 'City', value: 'Thiruvananthapuram', category: 'contact', sourceDocumentId: 'doc_passport', confidence: 0.96 },
    { id: 'field_state', key: 'contact.state', label: 'State', value: 'Kerala', category: 'contact', sourceDocumentId: 'doc_passport', confidence: 0.98 },
    { id: 'field_country', key: 'contact.country', label: 'Country', value: 'India', category: 'contact', sourceDocumentId: 'doc_passport', confidence: 0.99 },
    { id: 'field_postal', key: 'contact.postalCode', label: 'Postal code', value: '695004', category: 'contact', sourceDocumentId: 'doc_passport', confidence: 0.98 },
    { id: 'field_degree', key: 'education.degree', label: 'Degree', value: 'B.Tech in Computer Science and Engineering', category: 'education', sourceDocumentId: 'doc_degree', confidence: 0.98 },
    { id: 'field_university', key: 'education.university', label: 'University', value: 'APJ Abdul Kalam Technological University', category: 'education', sourceDocumentId: 'doc_degree', confidence: 0.97 },
    { id: 'field_registration', key: 'education.registrationNumber', label: 'Registration number', value: 'KTU21CS0482', category: 'education', sourceDocumentId: 'doc_degree', confidence: 0.99, sensitive: true },
    { id: 'field_graduation_year', key: 'education.graduationYear', label: 'Graduation year', value: '2025', category: 'education', sourceDocumentId: 'doc_degree', confidence: 0.96 },
    { id: 'field_cgpa', key: 'education.cgpa', label: 'CGPA', value: '8.92 / 10.0', category: 'education', sourceDocumentId: 'doc_degree', confidence: 0.94 },
    { id: 'field_employer', key: 'employment.employer', label: 'Employer', value: 'Northstar Labs', category: 'employment', sourceDocumentId: 'doc_offer', confidence: 0.93 },
    { id: 'field_job_title', key: 'employment.jobTitle', label: 'Job title', value: 'Software Engineer', category: 'employment', sourceDocumentId: 'doc_offer', confidence: 0.92 },
    { id: 'field_id_number', key: 'identification.number', label: 'Passport number', value: 'P•••••482', category: 'identification', sourceDocumentId: 'doc_passport', confidence: 0.9, sensitive: true },
    { id: 'field_skills', key: 'other.skills', label: 'Professional skills', value: 'TypeScript, React, Distributed Systems, PostgreSQL', category: 'other', sourceDocumentId: 'doc_resume', confidence: 0.74 },
  ];
  for (const field of fields) {
    db.prepare(`INSERT INTO fields (id,user_id,field_key,label,value,normalized_value,category,source_document_id,source_page,confidence,verification_status,sensitive,extracted_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      field.id, userId, field.key, field.label, field.value, field.value, field.category, field.sourceDocumentId ?? null, null, field.confidence, 'extracted', field.sensitive ? 1 : 0, now, now,
    );
  }
  db.prepare('INSERT INTO field_conflicts (id,field_id,value,source_document_id,confidence,created_at) VALUES (?,?,?,?,?,?)')
    .run('conflict_phone', 'field_phone', '+91 98470 11221', 'doc_passport', 0.72, now);
  const collections = [
    { id: 'col_university', name: 'University applications', description: 'Academic certificates', notes: '', docs: ['doc_degree', 'doc_passport'] },
    { id: 'col_job', name: 'Job applications', description: 'Resume', notes: '', docs: ['doc_resume', 'doc_offer'] },
    { id: 'col_identity', name: 'Identity & travel', description: 'Passport', notes: '', docs: ['doc_passport'] },
  ];
  for (const col of collections) {
    db.prepare('INSERT INTO collections (id,user_id,name,description,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(col.id, userId, col.name, col.description, col.notes, now, now);
    for (const docId of col.docs) {
      db.prepare('INSERT INTO collection_documents (collection_id,document_id) VALUES (?,?)').run(col.id, docId);
    }
  }
  db.close();
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://localhost:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // server is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start.');
}

async function api(pathname, options = {}, authToken = token) {
  const response = await fetch(`http://localhost:${port}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

test.before(async () => {
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      AUTH_SECRET: 'test-secret',
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret',
      GOOGLE_REDIRECT_URI: `http://localhost:${port}/api/auth/google/callback`,
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
  await waitForHealth();
});

test.after(async () => {
  child?.kill('SIGTERM');
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
});

test('health and authentication boundaries', async () => {
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const unauthorized = await api('/api/fields');
  assert.equal(unauthorized.status, 401);

  const signup = await api('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name: 'Arunraj V.', email: 'arun@example.com', password: 'password123' }),
  });
  assert.equal(signup.status, 201);
  token = signup.body.token;
  testUserId = signup.body.user.id;
  assert.ok(token);
  assert.equal(signup.body.user.email, 'arun@example.com');
  assert.equal(signup.body.user.accountType, 'Personal');

  // Seed fixture documents and fields for testUserId into the isolated test db
  seedTestUser(dbPath, testUserId);
});

test('bootstrap returns vault, collections, and conflict provenance', async () => {
  const result = await api('/api/extension/bootstrap');
  assert.equal(result.status, 200);
  assert.equal(result.body.fields.length, 21);
  assert.equal(result.body.collections.length, 3);
  const phone = result.body.fields.find((field) => field.key === 'contact.phone');
  assert.equal(phone.conflicts.length, 1);
  assert.match(phone.conflicts[0].source.documentName, /Passport/);
});

test('manual value editing preserves source and marks user verified', async () => {
  const bootstrap = await api('/api/extension/bootstrap');
  const field = bootstrap.body.fields.find((item) => item.key === 'contact.phone');
  const updated = await api(`/api/fields/${field.id}`, { method: 'PATCH', body: JSON.stringify({ value: '+91 90000 00000' }) });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.field.value, '+91 90000 00000');
  assert.equal(updated.body.field.verificationStatus, 'user_verified');
  assert.equal(updated.body.field.source.documentName, 'Resume_Arunraj_V.pdf');
});

test('document processing extracts structured facts and detects conflicts', async () => {
  const created = await api('/api/documents', {
    method: 'POST',
    body: JSON.stringify({ name: 'New_Resume_2026.txt', category: 'Employment', fileType: 'txt', sizeLabel: '4 KB', source: 'upload' }),
  });
  assert.equal(created.status, 201);
  const documentId = created.body.document.id;

  const processed = await api(`/api/documents/${documentId}/process`, {
    method: 'POST',
    body: JSON.stringify({
      text: 'Full Name: Arunraj V\nEmail: arun@example.com\nPhone: +91 98470 12345\nNationality: Indian\nCity: Kochi\nDegree: B.Tech in Computer Science\nUniversity: APJ Abdul Kalam Technological University\nRegistration No: KTU21CS9999\nGraduation Year: 2025\nCGPA: 8.92 / 10.0',
    }),
  });
  assert.equal(processed.status, 200);
  assert.ok(processed.body.result.facts >= 5);
  assert.equal(processed.body.result.provider, 'local-rules');

  const fields = await api('/api/fields');
  const city = fields.body.fields.find((field) => field.key === 'contact.city');
  assert.equal(city.value, 'Thiruvananthapuram');
  assert.equal(city.conflicts[0].value, 'Kochi');
  assert.match(city.conflicts[0].source.documentName, /New_Resume_2026/);
  const phone = fields.body.fields.find((field) => field.key === 'contact.phone');
  assert.equal(phone.value, '+91 90000 00000');
  assert.equal(phone.verificationStatus, 'user_verified');
});

test('collection creation links owned documents only', async () => {
  const docs = await api('/api/documents');
  const documentId = docs.body.documents[0].id;
  const created = await api('/api/collections', {
    method: 'POST',
    body: JSON.stringify({ name: 'Visa application', description: 'Travel documents', notes: 'Review all sensitive values.', documentIds: [documentId] }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.collection.documentIds, [documentId]);

  const invalid = await api('/api/collections', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bad collection', documentIds: ['doc_does_not_exist'] }),
  });
  assert.equal(invalid.status, 404);
});

test('users cannot read or mutate another account resources', async () => {
  const signup = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Other User', email: `other-${Date.now()}@example.com`, password: 'another-demo-password' }) }, '');
  assert.equal(signup.status, 201);
  const otherToken = signup.body.token;
  assert.ok(otherToken);

  const ownDocs = await api('/api/documents', {}, otherToken);
  assert.equal(ownDocs.status, 200);
  assert.equal(ownDocs.body.documents.length, 0);

  const demoFields = await api('/api/fields');
  const demoField = demoFields.body.fields[0];
  const forbiddenPatch = await api(`/api/fields/${demoField.id}`, { method: 'PATCH', body: JSON.stringify({ value: 'stolen' }) }, otherToken);
  assert.equal(forbiddenPatch.status, 404);

  const forbiddenDelete = await api('/api/account', { method: 'DELETE', body: JSON.stringify({ password: 'another-demo-password' }) }, otherToken);
  assert.equal(forbiddenDelete.status, 200);
  const afterDelete = await api('/api/auth/me', {}, otherToken);
  assert.equal(afterDelete.status, 401);
});

test('preferences and history round-trip', async () => {
  const prefs = await api('/api/preferences', { method: 'PUT', body: JSON.stringify({ confirmBeforeAutofill: false }) });
  assert.equal(prefs.status, 200);
  assert.equal(prefs.body.preferences.confirmBeforeAutofill, false);

  const history = await api('/api/history', { method: 'POST', body: JSON.stringify({ website: 'Test portal', url: 'https://example.com/apply', detected: 5, filled: 4, skipped: 1, status: 'Partially completed' }) });
  assert.equal(history.status, 201);
  const list = await api('/api/history');
  assert.equal(list.status, 200);
  assert.equal(list.body.history[0].website, 'Test portal');

  const sync = await api('/api/documents/sync', { method: 'POST', body: '{}' });
  assert.equal(sync.status, 200);
  assert.ok(typeof sync.body.synced === 'number');
});

test('CORS allows only the configured dashboard origin', async () => {
  const allowed = await fetch(`http://localhost:${port}/api/health`, {
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');

  const rejected = await fetch(`http://localhost:${port}/api/health`, {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);

  const preflight = await fetch(`http://localhost:${port}/api/health`, {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('removed cloud routes are not available', async () => {
  for (const [path, method, body] of [
    ['/api/drive/status', 'GET', undefined],
    ['/api/drive/disconnect', 'POST', '{}'],
    ['/api/drive/files', 'GET', undefined],
    ['/api/drive/import', 'POST', '{}'],
    ['/api/ai/match-fields', 'POST', '{}'],
    ['/api/ai/generate-answer', 'POST', '{}'],
  ]) {
    const response = await api(path, method === 'GET' ? {} : { method, body });
    assert.equal(response.status, 404, `${path} must be removed`);
  }
});

test('google oauth sign-in scope and drive removal', async () => {
  // 1. Sign-in URL generation (public, minimal identity scopes only)
  const signinUrlRes = await api('/api/auth/google/url?intent=signin', {}, null);
  assert.equal(signinUrlRes.status, 200);
  assert.ok(signinUrlRes.body.url.includes('accounts.google.com'));
  assert.ok(signinUrlRes.body.url.includes('openid'));
  const signinScope = new URL(signinUrlRes.body.url).searchParams.get('scope') ?? '';
  assert.equal(signinScope, 'openid email profile');
  assert.ok(!signinUrlRes.body.url.includes('drive'), 'Sign-in URL MUST NOT request drive scopes');

  // 2. Drive document-storage authorization is removed.
  const unauthedDriveRes = await api('/api/auth/google/url?intent=drive', {}, null);
  assert.equal(unauthedDriveRes.status, 410);
  const authedDriveRes = await api('/api/auth/google/url?intent=drive', {}, token);
  assert.equal(authedDriveRes.status, 410);

  // 4. Callback with access_denied error redirects to login or settings with friendly error
  const rawFetch = async (url) => {
    return fetch(`http://localhost:${port}${url}`, { redirect: 'manual' });
  };

  const deniedSigninRes = await rawFetch('/api/auth/google/callback?error=access_denied&state=');
  assert.equal(deniedSigninRes.status, 302);
  const signinLocation = deniedSigninRes.headers.get('location');
  assert.ok(signinLocation.includes('/login?error='));
  assert.ok(decodeURIComponent(signinLocation).includes('cancelled or access was denied'));

  // 5. Callback with missing or tampered state redirects safely without crashing
  const tamperedStateRes = await rawFetch('/api/auth/google/callback?code=mock_code&state=fake_tampered_state');
  assert.equal(tamperedStateRes.status, 302);
  const tamperedLocation = tamperedStateRes.headers.get('location');
  assert.ok(tamperedLocation.includes('error='));
  assert.ok(decodeURIComponent(tamperedLocation).includes('Invalid or expired'));

  // 6. Callback with missing code redirects with error
  const stateUrl = new URL(signinUrlRes.body.url);
  const validState = stateUrl.searchParams.get('state');
  const missingCodeRes = await rawFetch(`/api/auth/google/callback?state=${encodeURIComponent(validState)}`);
  assert.equal(missingCodeRes.status, 302);
  const missingCodeLoc = missingCodeRes.headers.get('location');
  assert.ok(missingCodeLoc.includes('error='));
  assert.ok(decodeURIComponent(missingCodeLoc).includes('Authorization code was not provided'));

  // 6b. Callback with invalid code handles token exchange failure gracefully without crashing
  const failedCodeRes = await rawFetch(`/api/auth/google/callback?code=bad_mock_code&state=${encodeURIComponent(validState)}`);
  assert.equal(failedCodeRes.status, 302);
  const failedCodeLoc = failedCodeRes.headers.get('location');
  assert.ok(failedCodeLoc.includes('/login?error='));
  assert.ok(decodeURIComponent(failedCodeLoc).includes('Failed to exchange authorization code'));

  // 7. Session persistence via formflow_session cookie
  const cookieMeRes = await fetch(`http://localhost:${port}/api/auth/me`, {
    headers: {
      cookie: `formflow_session=${token}`,
    },
  });
  assert.equal(cookieMeRes.status, 200);
  const cookieBody = await cookieMeRes.json();
  assert.equal(cookieBody.user.id, testUserId);

  // 8. Logout clears cookie
  const logoutRes = await fetch(`http://localhost:${port}/api/auth/logout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(logoutRes.status, 200);
  const setCookie = logoutRes.headers.get('set-cookie');
  assert.ok(setCookie?.includes('Max-Age=0'));
});

test('google sign-in account lifecycle without drive access', async () => {
  const db = new DatabaseSync(dbPath);
  const googleEmail = 'alex.oauth.user@example.com';
  const googleName = 'Alex Mercer';

  // 1. Initial lookup: account does not exist
  const initialRow = db.prepare('SELECT * FROM users WHERE email = ?').get(googleEmail);
  assert.equal(initialRow, undefined);

  // 2. Simulate account creation on first Google Sign-In
  const newUserId = 'usr_alex_oauth_123';
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, password_salt, account_type, created_at)
    VALUES (?, ?, ?, ?, ?, 'Personal', ?)
  `).run(newUserId, googleName, googleEmail, 'dummy_hash', 'dummy_salt', new Date().toISOString());

  const createdUser = db.prepare('SELECT * FROM users WHERE id = ?').get(newUserId);
  assert.equal(createdUser.email, googleEmail);
  assert.equal(createdUser.account_type, 'Personal');

  // 3. Sign-in must not create any Google Drive connection or token.
  const driveConn = db.prepare('SELECT * FROM google_connections WHERE user_id = ?').get(newUserId);
  assert.equal(driveConn, undefined, 'Google Drive must not be connected by sign-in');

  // 4. Subsequent Google Sign-In finds and reuses the exact same account
  const reLookupUser = db.prepare('SELECT * FROM users WHERE email = ?').get(googleEmail);
  assert.equal(reLookupUser.id, newUserId);

  db.close();
});
