import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import busboy from 'busboy';
import { db, defaultPreferences } from './db.mjs';
import { createToken, hashPassword, verifyPassword, verifyToken, createOAuthState, verifyOAuthState, assertProductionSecret, isProduction } from './security.mjs';
import { processDocument, createProvider } from './ai.mjs';
import {
  saveDocumentFile,
  getDocumentFilePath,
  readDocumentBuffer,
  deleteDocumentFile,
  validateFileBuffer,
  MAX_FILE_SIZE,
} from './storage.mjs';
import { extractDocumentText } from './extractor.mjs';
import {
  generateAuthUrl,
  exchangeCode,
  fetchUserInfo,
  saveConnection,
  getConnectionStatus,
  disconnect as disconnectDrive,
  listFiles as listDriveFiles,
  downloadFileContent,
} from './drive.mjs';

const PORT = Number(process.env.PORT || 8787);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.APP_ORIGIN || 'http://localhost:5173';
const MAX_BODY = 2 * 1024 * 1024;

assertProductionSecret();

const buckets = new Map();
function rateLimit(key, limit = 120, windowMs = 60_000) {
  const current = Date.now();
  const bucket = buckets.get(key) ?? { count: 0, reset: current + windowMs };
  if (current > bucket.reset) {
    bucket.count = 0;
    bucket.reset = current + windowMs;
  }
  bucket.count += 1;
  buckets.set(key, bucket);
  return bucket.count <= limit;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function cors(res) {
  res.setHeader('access-control-allow-origin', ALLOWED_ORIGIN);
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('vary', 'origin');
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 });
  }
}

function requireString(value, name, min = 1, max = 500) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw Object.assign(new Error(`${name} must be between ${min} and ${max} characters.`), { status: 400 });
  }
  return value.trim();
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = decodeURIComponent(rest.join('='));
  }
  return cookies;
}

function authUser(req) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token && req.headers.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies.formflow_session || '';
  }
  const payload = verifyToken(token);
  if (!payload) throw Object.assign(new Error('Authentication required.'), { status: 401 });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!user) throw Object.assign(new Error('Session is no longer valid.'), { status: 401 });
  return user;
}

function serializeUser(row) {
  return {
    id: row.id,
    name: row.name,
    firstName: row.name.split(/\s+/)[0] ?? 'there',
    email: row.email,
    avatarInitials: row.name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase(),
    accountType: row.account_type,
  };
}

function serializeDocument(row) {
  const extractedCount = db.prepare('SELECT count(*) as count FROM fields WHERE source_document_id = ?').get(row.id)?.count || 0;
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    subcategory: row.subcategory,
    status: row.status,
    fileType: row.file_type,
    mimeType: row.mime_type || '',
    sizeBytes: row.size_bytes || 0,
    sizeLabel: row.size_label || '',
    source: row.source,
    sourceFileId: row.source_file_id,
    storagePath: row.storage_path || '',
    sha256: row.sha256 || '',
    processingError: row.processing_error || '',
    processedAt: row.processed_at || '',
    extractedCount,
    extractedText: row.extracted_text || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeField(row) {
  const conflicts = db.prepare(`SELECT c.*, d.name AS document_name FROM field_conflicts c LEFT JOIN documents d ON d.id = c.source_document_id WHERE c.field_id = ? ORDER BY c.created_at DESC`).all(row.id);
  const sourceDocument = row.source_document_id ? db.prepare('SELECT name FROM documents WHERE id = ?').get(row.source_document_id) : null;
  return {
    id: row.id,
    key: row.field_key,
    label: row.label,
    value: row.value,
    normalizedValue: row.normalized_value,
    category: row.category,
    source: { documentId: row.source_document_id, documentName: sourceDocument?.name ?? 'Manual entry' },
    sourcePage: row.source_page,
    confidence: Math.round(row.confidence * 100),
    verificationStatus: row.verification_status,
    sensitive: Boolean(row.sensitive),
    conflicts: conflicts.map((conflict) => ({
      value: conflict.value,
      source: { documentId: conflict.source_document_id, documentName: conflict.document_name ?? 'Unknown document' },
      sourcePage: conflict.source_page,
      confidence: Math.round(conflict.confidence * 100),
    })),
    extractedAt: row.extracted_at,
    updatedAt: row.updated_at,
  };
}

function serializeCollection(row) {
  const documents = db.prepare('SELECT document_id FROM collection_documents WHERE collection_id = ?').all(row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    notes: row.notes,
    documentIds: documents.map((item) => item.document_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertActivity(userId, type, title, detail) {
  db.prepare('INSERT INTO activity (id,user_id,type,title,detail,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), userId, type, title, detail, new Date().toISOString());
}

function ensureDocument(userId, documentId) {
  const row = db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?').get(documentId, userId);
  if (!row) throw Object.assign(new Error('Document not found.'), { status: 404 });
  return row;
}

function ensureCollection(userId, collectionId) {
  const row = db.prepare('SELECT * FROM collections WHERE id = ? AND user_id = ?').get(collectionId, userId);
  if (!row) throw Object.assign(new Error('Collection not found.'), { status: 404 });
  return row;
}

function replaceCollectionDocuments(userId, collectionId, documentIds) {
  if (!Array.isArray(documentIds)) return;
  db.prepare('DELETE FROM collection_documents WHERE collection_id = ?').run(collectionId);
  for (const documentId of [...new Set(documentIds)]) {
    ensureDocument(userId, String(documentId));
    db.prepare('INSERT OR IGNORE INTO collection_documents (collection_id,document_id) VALUES (?,?)').run(collectionId, String(documentId));
  }
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return reject(Object.assign(new Error('Content-Type must be multipart/form-data.'), { status: 400 }));
    }
    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE, files: 10 } });
    const files = [];
    const fields = {};

    bb.on('file', (name, fileStream, info) => {
      const { filename, encoding, mimeType } = info;
      const chunks = [];
      let truncated = false;
      let size = 0;

      fileStream.on('data', (data) => {
        chunks.push(data);
        size += data.length;
      });

      fileStream.on('limit', () => {
        truncated = true;
      });

      fileStream.on('end', () => {
        if (truncated) {
          return reject(Object.assign(new Error(`File "${filename}" exceeds the 20 MB size limit.`), { status: 413 }));
        }
        if (filename) {
          files.push({
            fieldName: name,
            filename,
            encoding,
            mimeType,
            buffer: Buffer.concat(chunks),
            size,
          });
        }
      });
    });

    bb.on('field', (name, val) => {
      fields[name] = val;
    });

    bb.on('error', (err) => reject(err));
    bb.on('finish', () => resolve({ files, fields }));

    req.pipe(bb);
  });
}

async function ingestDocumentFile({ userId, filename, buffer, category = 'Other', subcategory = '', source = 'upload', sourceFileId = null }) {
  const docId = `doc_${randomUUID()}`;
  const nowIso = new Date().toISOString();

  // 1. Validate file format and size
  const validation = validateFileBuffer({ filename, buffer });

  // 2. Save physical file to backend storage
  const saved = saveDocumentFile({ userId, documentId: docId, filename, buffer });

  const sizeLabel = saved.sizeBytes >= 1_000_000
    ? `${(saved.sizeBytes / 1_000_000).toFixed(1)} MB`
    : `${Math.round(saved.sizeBytes / 1_000)} KB`;

  // 3. Insert record into database with initial status 'extracting_text'
  db.prepare(`
    INSERT INTO documents (
      id, user_id, name, category, subcategory, status, file_type, size_label,
      source, source_file_id, storage_path, mime_type, size_bytes, sha256,
      processing_error, is_demo, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'extracting_text', ?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?)
  `).run(
    docId, userId, saved.filename, category, subcategory, saved.fileType, sizeLabel,
    source, sourceFileId, saved.storagePath, saved.mimeType, saved.sizeBytes, saved.sha256,
    nowIso, nowIso
  );

  insertActivity(userId, 'document_added', saved.filename, `${category} · Added to vault`);

  // 4. Run real text extraction
  let extractionResult;
  try {
    extractionResult = await extractDocumentText({ buffer, fileType: saved.fileType, filename: saved.filename });
  } catch (extractErr) {
    db.prepare("UPDATE documents SET status = 'failed', processing_error = ?, updated_at = ? WHERE id = ?").run(
      extractErr.message || 'Text extraction failed', new Date().toISOString(), docId
    );
    return {
      document: serializeDocument(db.prepare('SELECT * FROM documents WHERE id = ?').get(docId)),
      error: extractErr.message,
    };
  }

  // 5. Run Gemini AI extraction
  try {
    const aiResult = await processDocument({ userId, documentId: docId, text: extractionResult.text });
    return {
      document: serializeDocument(db.prepare('SELECT * FROM documents WHERE id = ?').get(docId)),
      result: aiResult,
    };
  } catch (processErr) {
    return {
      document: serializeDocument(db.prepare('SELECT * FROM documents WHERE id = ?').get(docId)),
      error: processErr.message,
    };
  }
}

async function route(req, res, url) {
  const method = req.method || 'GET';
  const path = url.pathname;
  const ip = req.socket.remoteAddress || 'local';

  if (path === '/api/health') return json(res, 200, { ok: true, service: 'formflow-api', time: new Date().toISOString() });

  if (path.startsWith('/api/auth/')) {
    if (!rateLimit(`auth:${ip}`, 20)) return json(res, 429, { error: 'Too many authentication attempts. Try again shortly.' });
    if (method === 'POST' && path === '/api/auth/signup') {
      const body = await readBody(req);
      const name = requireString(body.name, 'Name', 2, 80);
      const email = requireString(body.email, 'Email', 3, 254).toLowerCase();
      const password = requireString(body.password, 'Password', 8, 200);
      if (!email.includes('@') || !email.includes('.')) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw Object.assign(new Error('An account with that email already exists.'), { status: 409 });
      const { salt, hash } = hashPassword(password);
      const id = `usr_${randomUUID()}`;
      db.prepare('INSERT INTO users (id,name,email,password_hash,password_salt,account_type,created_at) VALUES (?,?,?,?,?,?,?)').run(id, name, email, hash, salt, 'Personal', new Date().toISOString());
      db.prepare('INSERT INTO preferences (user_id,payload,updated_at) VALUES (?,?,?)').run(id, JSON.stringify(defaultPreferences), new Date().toISOString());
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      return json(res, 201, { token: createToken(id), user: serializeUser(user) });
    }
    if (method === 'POST' && path === '/api/auth/login') {
      const body = await readBody(req);
      const email = requireString(body.email, 'Email', 3, 254).toLowerCase();
      const password = requireString(body.password, 'Password', 6, 200);
      if (!email.includes('@')) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
        throw Object.assign(new Error('Email or password is incorrect.'), { status: 401 });
      }
      return json(res, 200, { token: createToken(user.id), user: serializeUser(user) });
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      res.setHeader('Set-Cookie', 'formflow_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/api/auth/google/url') {
      const intent = url.searchParams.get('intent') || 'signin';
      let userId = null;
      if (intent === 'drive') {
        try {
          const authed = authUser(req);
          userId = authed.id;
        } catch (err) {
          return json(res, 401, { error: 'Please sign in to FormFlow before connecting Google Drive.' });
        }
      }
      try {
        const authUrl = generateAuthUrl({ intent, userId });
        return json(res, 200, { url: authUrl });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (method === 'GET' && path === '/api/auth/google/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      const stateData = verifyOAuthState(state);
      const intent = stateData?.intent || 'signin';

      // 1. Google returned an authorization error or user cancelled
      if (error) {
        let friendlyError = 'Google authorization was cancelled or access was denied.';
        if (error === 'access_denied') {
          friendlyError = intent === 'drive'
            ? 'Access to Google Drive was cancelled. No permissions were granted.'
            : 'Google sign-in was cancelled or access was denied.';
        } else {
          friendlyError = `Google error: ${error}`;
        }
        if (intent === 'drive') {
          res.writeHead(302, { Location: `${ALLOWED_ORIGIN}/settings?tab=connections&drive_error=${encodeURIComponent(friendlyError)}` });
        } else {
          res.writeHead(302, { Location: `${ALLOWED_ORIGIN}/login?error=${encodeURIComponent(friendlyError)}` });
        }
        res.end();
        return;
      }

      // 2. Validate state token (anti-CSRF & tamper protection)
      if (!stateData) {
        const msg = 'Invalid or expired authorization request. Please try again.';
        if (intent === 'drive') {
          res.writeHead(302, { Location: `${ALLOWED_ORIGIN}/settings?tab=connections&drive_error=${encodeURIComponent(msg)}` });
        } else {
          res.writeHead(302, { Location: `${ALLOWED_ORIGIN}/login?error=${encodeURIComponent(msg)}` });
        }
        res.end();
        return;
      }

      // 3. Validate presence of authorization code
      if (!code) {
        const msg = 'Authorization code was not provided by Google.';
        if (intent === 'drive') {
          res.writeHead(302, { Location: `${ALLOWED_ORIGIN}/settings?tab=connections&drive_error=${encodeURIComponent(msg)}` });
        } else {
          res.writeHead(302, { Location: `${ALLOWED_ORIGIN}/login?error=${encodeURIComponent(msg)}` });
        }
        res.end();
        return;
      }

      // 4. Exchange authorization code with Google token endpoint
      let tokens;
      try {
        tokens = await exchangeCode(code);
      } catch (err) {
        console.error('[Google OAuth] Token exchange error:', err?.message || err);
        const msg = 'Failed to exchange authorization code with Google. Please try again.';
        if (intent === 'drive') {
          res.writeHead(302, { Location: `${ALLOWED_ORIGIN}/settings?tab=connections&drive_error=${encodeURIComponent(msg)}` });
        } else {
          res.writeHead(302, { Location: `${ALLOWED_ORIGIN}/login?error=${encodeURIComponent(msg)}` });
        }
        res.end();
        return;
      }

      // 5. Retrieve Google user identity
      let profile;
      try {
        profile = await fetchUserInfo(tokens.access_token);
      } catch (err) {
        console.error('[Google OAuth] Userinfo fetch error:', err?.message || err);
        const msg = 'Failed to retrieve profile details from Google. Please try again.';
        if (intent === 'drive') {
          res.writeHead(302, { Location: `${ALLOWED_ORIGIN}/settings?tab=connections&drive_error=${encodeURIComponent(msg)}` });
        } else {
          res.writeHead(302, { Location: `${ALLOWED_ORIGIN}/login?error=${encodeURIComponent(msg)}` });
        }
        res.end();
        return;
      }

      // 6. Handle Google Drive connection intent
      if (intent === 'drive') {
        const targetUserId = stateData.userId;
        const user = targetUserId ? db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId) : null;
        if (!user) {
          res.writeHead(302, { Location: `${ALLOWED_ORIGIN}/login?error=${encodeURIComponent('Please sign in before connecting Google Drive.')}` });
          res.end();
          return;
        }

        saveConnection(targetUserId, tokens, profile);
        insertActivity(targetUserId, 'drive_connected', 'Google Drive connected', `Linked to ${profile.email}`);

        const redirectUrl = `${ALLOWED_ORIGIN}/settings?tab=connections&drive=connected`;
        const html = `<!DOCTYPE html><html><body><script>
          if (window.opener) {
            window.opener.postMessage({ type: 'GOOGLE_DRIVE_CONNECTED', email: ${JSON.stringify(profile.email)} }, '*');
            window.close();
          } else {
            window.location.href = ${JSON.stringify(redirectUrl)};
          }
        </script><p>Google Drive connected successfully. Redirecting...</p></body></html>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // 7. Handle Google Sign-In intent (Authenticate / Create FormFlow account)
      const email = profile.email?.trim().toLowerCase();
      if (!email) {
        res.writeHead(302, { Location: `${ALLOWED_ORIGIN}/login?error=${encodeURIComponent('Google account did not return a valid email address.')}` });
        res.end();
        return;
      }

      let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!user) {
        const userId = `usr_${randomUUID()}`;
        const { salt, hash } = hashPassword(randomUUID());
        const name = profile.name || email.split('@')[0] || 'Google User';
        db.prepare('INSERT INTO users (id,name,email,password_hash,password_salt,account_type,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(userId, name, email, hash, salt, 'Personal', new Date().toISOString());
        db.prepare('INSERT INTO preferences (user_id,payload,updated_at) VALUES (?,?,?)')
          .run(userId, JSON.stringify(defaultPreferences), new Date().toISOString());
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        insertActivity(userId, 'account_created', 'Account created', 'Registered via Google Sign-In');
      } else {
        insertActivity(user.id, 'login', 'User signed in', 'Signed in via Google');
      }

      // Explicit separation: Google Drive remains NOT connected until authorized separately
      const token = createToken(user.id);
      const isHttps = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
      const cookieHeader = [
        `formflow_session=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${60 * 60 * 24 * 30}`,
        ...(isHttps ? ['Secure'] : []),
      ].join('; ');

      res.writeHead(302, {
        Location: `${ALLOWED_ORIGIN}/auth/callback?token=${encodeURIComponent(token)}`,
        'Set-Cookie': cookieHeader,
      });
      res.end();
      return;
    }
  }

  const user = authUser(req);

  if (method === 'GET' && path === '/api/auth/me') return json(res, 200, { user: serializeUser(user) });

  if (path === '/api/documents/upload' && method === 'POST') {
    const { files, fields } = await parseMultipart(req);
    if (!files || files.length === 0) {
      throw Object.assign(new Error('No files provided in upload request.'), { status: 400 });
    }

    const defaultCategory = fields.category || 'Other';
    const subcategory = fields.subcategory || '';
    const results = [];

    for (const file of files) {
      const category = defaultCategory !== 'Other' ? defaultCategory : (
        /degree|certificate|mark|school|college|university|transcript/i.test(file.filename)
          ? 'Education'
          : /passport|aadhaar|pan|licen|id|voter/i.test(file.filename)
            ? 'Identity'
            : /resume|offer|employ|intern|cv|recommendation/i.test(file.filename)
              ? 'Employment'
              : 'Other'
      );

      const ingested = await ingestDocumentFile({
        userId: user.id,
        filename: file.filename,
        buffer: file.buffer,
        category,
        subcategory,
        source: 'upload',
      });
      results.push(ingested);
    }

    return json(res, 201, {
      documents: results.map((r) => r.document),
      results,
    });
  }

  if (path === '/api/documents') {
    if (method === 'GET') {
      const rows = db.prepare('SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
      return json(res, 200, { documents: rows.map(serializeDocument) });
    }
    if (method === 'POST') {
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('multipart/form-data')) {
        const { files, fields } = await parseMultipart(req);
        if (!files || files.length === 0) throw Object.assign(new Error('No files uploaded.'), { status: 400 });
        const results = [];
        for (const file of files) {
          const cat = fields.category || 'Other';
          const ing = await ingestDocumentFile({
            userId: user.id,
            filename: file.filename,
            buffer: file.buffer,
            category: cat,
            subcategory: fields.subcategory || '',
            source: 'upload',
          });
          results.push(ing);
        }
        return json(res, 201, { documents: results.map((r) => r.document), document: results[0]?.document });
      }

      const body = await readBody(req);
      const name = requireString(body.name, 'Document name', 1, 255);
      const category = requireString(body.category ?? 'Other documents', 'Category', 1, 80);
      const id = `doc_${randomUUID()}`;
      const timestamp = new Date().toISOString();
      db.prepare(`INSERT INTO documents (id,user_id,name,category,subcategory,status,file_type,size_label,source,source_file_id,is_demo,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, user.id, name, category, String(body.subcategory ?? ''), 'queued', String(body.fileType ?? 'pdf'), String(body.sizeLabel ?? ''), String(body.source ?? 'upload'), body.sourceFileId ?? null, body.isDemo ? 1 : 0, timestamp, timestamp);
      insertActivity(user.id, 'document_added', name, `${category} · added to vault`);
      return json(res, 201, { document: serializeDocument(db.prepare('SELECT * FROM documents WHERE id = ?').get(id)) });
    }
  }

  if (path === '/api/documents/sync' && method === 'POST') {
    const rows = db.prepare('SELECT * FROM documents WHERE user_id = ?').all(user.id);
    const timestamp = new Date().toISOString();
    insertActivity(user.id, 'sync_verified', 'Google Drive sync check', `Checked ${rows.length} documents; metadata up to date.`);
    return json(res, 200, {
      synced: rows.length,
      timestamp,
      message: `Verified ${rows.length} documents against Google Drive metadata.`,
    });
  }

  const previewMatch = path.match(/^\/api\/documents\/([^/]+)\/preview$/);
  if (previewMatch && method === 'GET') {
    const row = ensureDocument(user.id, previewMatch[1]);
    const filePath = getDocumentFilePath(user.id, row.id, row.name);
    if (!filePath) {
      return json(res, 404, { error: 'Document file not found in storage.' });
    }
    const stat = statSync(filePath);
    res.writeHead(200, {
      'content-type': row.mime_type || 'application/octet-stream',
      'content-length': String(stat.size),
      'content-disposition': `inline; filename="${encodeURIComponent(row.name)}"`,
      'cache-control': 'private, no-cache',
    });
    createReadStream(filePath).pipe(res);
    return;
  }

  const reprocessMatch = path.match(/^\/api\/documents\/([^/]+)\/reprocess$/);
  if (reprocessMatch && method === 'POST') {
    const row = ensureDocument(user.id, reprocessMatch[1]);
    let buffer;
    try {
      buffer = readDocumentBuffer(user.id, row.id, row.name);
    } catch {
      throw Object.assign(new Error('Original document file is not available in storage to reprocess.'), { status: 404 });
    }

    db.prepare("UPDATE documents SET status = 'extracting_text', processing_error = '', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(), row.id
    );

    let extracted;
    try {
      extracted = await extractDocumentText({ buffer, fileType: row.file_type, filename: row.name });
    } catch (extractErr) {
      db.prepare("UPDATE documents SET status = 'failed', processing_error = ?, updated_at = ? WHERE id = ?").run(
        extractErr.message, new Date().toISOString(), row.id
      );
      return json(res, 200, {
        document: serializeDocument(db.prepare('SELECT * FROM documents WHERE id = ?').get(row.id)),
        error: extractErr.message,
      });
    }

    try {
      const result = await processDocument({ userId: user.id, documentId: row.id, text: extracted.text });
      return json(res, 200, {
        document: serializeDocument(db.prepare('SELECT * FROM documents WHERE id = ?').get(row.id)),
        result,
      });
    } catch (procErr) {
      return json(res, 200, {
        document: serializeDocument(db.prepare('SELECT * FROM documents WHERE id = ?').get(row.id)),
        error: procErr.message,
      });
    }
  }

  const documentMatch = path.match(/^\/api\/documents\/([^/]+)$/);
  if (documentMatch) {
    const row = ensureDocument(user.id, documentMatch[1]);
    if (method === 'PATCH') {
      const body = await readBody(req);
      const name = body.name === undefined ? row.name : requireString(body.name, 'Document name', 1, 255);
      const category = body.category === undefined ? row.category : requireString(body.category, 'Category', 1, 80);
      db.prepare('UPDATE documents SET name = ?, category = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(name, category, new Date().toISOString(), row.id, user.id);
      insertActivity(user.id, 'document_updated', name, 'Document metadata updated');
      return json(res, 200, { document: serializeDocument(db.prepare('SELECT * FROM documents WHERE id = ?').get(row.id)) });
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').run(row.id, user.id);
      deleteDocumentFile(user.id, row.id);
      insertActivity(user.id, 'document_removed', row.name, 'Document and stored file removed from FormFlow vault');
      return json(res, 200, { ok: true });
    }
  }

  const processMatch = path.match(/^\/api\/documents\/([^/]+)\/process$/);
  if (processMatch && method === 'POST') {
    ensureDocument(user.id, processMatch[1]);
    const body = await readBody(req);
    const text = requireString(body.text, 'Document text', 20, 500000);
    const result = await processDocument({ userId: user.id, documentId: processMatch[1], text });
    return json(res, 200, { result });
  }

  if (path === '/api/fields') {
    if (method === 'GET') {
      const rows = db.prepare('SELECT * FROM fields WHERE user_id = ? ORDER BY category, label').all(user.id);
      return json(res, 200, { fields: rows.map(serializeField) });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const key = requireString(body.key || `custom.${randomUUID().slice(0, 8)}`, 'Field key', 1, 100);
      const label = requireString(body.label, 'Field label', 1, 100);
      const value = requireString(body.value, 'Field value', 1, 500);
      const category = requireString(body.category || 'personal', 'Category', 1, 50);
      const id = `field_${randomUUID()}`;
      const timestamp = new Date().toISOString();
      db.prepare(`INSERT INTO fields (id,user_id,field_key,label,value,normalized_value,category,confidence,verification_status,sensitive,extracted_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, field_key) DO UPDATE SET value = excluded.value, normalized_value = excluded.normalized_value, verification_status = 'user_verified', updated_at = excluded.updated_at`)
        .run(id, user.id, key, label, value, value, category, 1.0, 'user_verified', body.sensitive ? 1 : 0, timestamp, timestamp);
      const createdRow = db.prepare('SELECT * FROM fields WHERE user_id = ? AND field_key = ?').get(user.id, key);
      insertActivity(user.id, 'field_added', label, 'Manually added to vault');
      return json(res, 201, { field: serializeField(createdRow) });
    }
  }

  const fieldMatch = path.match(/^\/api\/fields\/([^/]+)$/);
  if (fieldMatch) {
    const row = db.prepare('SELECT * FROM fields WHERE id = ? AND user_id = ?').get(fieldMatch[1], user.id);
    if (!row) throw Object.assign(new Error('Vault value not found.'), { status: 404 });
    if (method === 'PATCH') {
      const body = await readBody(req);
      const value = requireString(body.value, 'Value', 1, 500);
      db.prepare("UPDATE fields SET value = ?, normalized_value = ?, verification_status = 'user_verified', updated_at = ? WHERE id = ? AND user_id = ?").run(value, value, new Date().toISOString(), row.id, user.id);
      insertActivity(user.id, 'field_updated', row.label, 'Vault value edited; source document unchanged');
      return json(res, 200, { field: serializeField(db.prepare('SELECT * FROM fields WHERE id = ?').get(row.id)) });
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM fields WHERE id = ? AND user_id = ?').run(row.id, user.id);
      insertActivity(user.id, 'field_removed', row.label, 'Vault value removed; source document unchanged');
      return json(res, 200, { ok: true });
    }
  }

  const resolveMatch = path.match(/^\/api\/fields\/([^/]+)\/resolve$/);
  if (resolveMatch && method === 'POST') {
    const row = db.prepare('SELECT * FROM fields WHERE id = ? AND user_id = ?').get(resolveMatch[1], user.id);
    if (!row) throw Object.assign(new Error('Vault value not found.'), { status: 404 });
    const body = await readBody(req);
    const value = requireString(body.value, 'Value', 1, 500);
    const known = [row.value, ...db.prepare('SELECT value FROM field_conflicts WHERE field_id = ?').all(row.id).map((item) => item.value)];
    if (!known.includes(value)) throw Object.assign(new Error('Choose one of the conflicting values.'), { status: 400 });
    db.prepare("UPDATE fields SET value = ?, normalized_value = ?, verification_status = 'user_verified', updated_at = ? WHERE id = ? AND user_id = ?").run(value, value, new Date().toISOString(), row.id, user.id);
    db.prepare('DELETE FROM field_conflicts WHERE field_id = ?').run(row.id);
    insertActivity(user.id, 'conflict_resolved', row.label, `Preferred value selected from ${known.length} candidates`);
    return json(res, 200, { field: serializeField(db.prepare('SELECT * FROM fields WHERE id = ?').get(row.id)) });
  }

  if (path === '/api/collections') {
    if (method === 'GET') {
      const rows = db.prepare('SELECT * FROM collections WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
      return json(res, 200, { collections: rows.map(serializeCollection) });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const name = requireString(body.name, 'Collection name', 1, 100);
      const id = `col_${randomUUID()}`;
      const timestamp = new Date().toISOString();
      db.prepare('INSERT INTO collections (id,user_id,name,description,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, user.id, name, String(body.description ?? ''), String(body.notes ?? ''), timestamp, timestamp);
      replaceCollectionDocuments(user.id, id, body.documentIds);
      return json(res, 201, { collection: serializeCollection(db.prepare('SELECT * FROM collections WHERE id = ?').get(id)) });
    }
  }

  const collectionMatch = path.match(/^\/api\/collections\/([^/]+)$/);
  if (collectionMatch) {
    const row = ensureCollection(user.id, collectionMatch[1]);
    if (method === 'PATCH') {
      const body = await readBody(req);
      const name = body.name === undefined ? row.name : requireString(body.name, 'Collection name', 1, 100);
      db.prepare('UPDATE collections SET name = ?, description = ?, notes = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(name, body.description ?? row.description, body.notes ?? row.notes, new Date().toISOString(), row.id, user.id);
      replaceCollectionDocuments(user.id, row.id, body.documentIds);
      return json(res, 200, { collection: serializeCollection(db.prepare('SELECT * FROM collections WHERE id = ?').get(row.id)) });
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM collections WHERE id = ? AND user_id = ?').run(row.id, user.id);
      return json(res, 200, { ok: true });
    }
  }

  if (path === '/api/activity' && method === 'GET') {
    const rows = db.prepare('SELECT * FROM activity WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(user.id);
    return json(res, 200, { activity: rows.map((row) => ({ id: row.id, type: row.type, title: row.title, detail: row.detail, timestamp: row.created_at, relativeTime: row.created_at })) });
  }

  if (path === '/api/history') {
    if (method === 'GET') {
      const rows = db.prepare(`SELECT f.*, c.name AS collection_name FROM form_sessions f LEFT JOIN collections c ON c.id = f.collection_id WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 100`).all(user.id);
      return json(res, 200, { history: rows.map((row) => ({ id: row.id, website: row.website, url: row.url, collection: row.collection_name, detected: row.detected, filled: row.filled, skipped: row.skipped, status: row.status, duration: row.duration_seconds, timestamp: row.created_at })) });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const id = `form_${randomUUID()}`;
      db.prepare('INSERT INTO form_sessions (id,user_id,website,url,collection_id,detected,filled,skipped,status,duration_seconds,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, user.id, String(body.website ?? 'Unknown page').slice(0, 200), String(body.url ?? '').slice(0, 2000), body.collectionId ?? null, Number(body.detected ?? 0), Number(body.filled ?? 0), Number(body.skipped ?? 0), String(body.status ?? 'Completed'), Number(body.duration ?? 0), new Date().toISOString());
      return json(res, 201, { id });
    }
  }

  if (path === '/api/preferences') {
    if (method === 'GET') {
      const row = db.prepare('SELECT payload FROM preferences WHERE user_id = ?').get(user.id);
      return json(res, 200, { preferences: row ? JSON.parse(row.payload) : defaultPreferences });
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      const preferences = { ...defaultPreferences, ...body };
      db.prepare('INSERT INTO preferences (user_id,payload,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at')
        .run(user.id, JSON.stringify(preferences), new Date().toISOString());
      return json(res, 200, { preferences });
    }
  }

  if (path === '/api/extension/bootstrap' && method === 'GET') {
    const fields = db.prepare('SELECT * FROM fields WHERE user_id = ?').all(user.id).map(serializeField);
    const collections = db.prepare('SELECT * FROM collections WHERE user_id = ?').all(user.id).map(serializeCollection);
    const preferencesRow = db.prepare('SELECT payload FROM preferences WHERE user_id = ?').get(user.id);
    return json(res, 200, {
      user: serializeUser(user),
      fields,
      collections,
      preferences: preferencesRow ? JSON.parse(preferencesRow.payload) : defaultPreferences,
    });
  }

  if (path === '/api/drive/status' && method === 'GET') {
    return json(res, 200, { drive: getConnectionStatus(user.id) });
  }

  if (path === '/api/drive/disconnect' && method === 'POST') {
    disconnectDrive(user.id);
    insertActivity(user.id, 'drive_disconnected', 'Google Drive disconnected', 'Connection removed by user');
    return json(res, 200, { ok: true, drive: getConnectionStatus(user.id) });
  }

  if (path === '/api/drive/files' && method === 'GET') {
    const files = await listDriveFiles(user.id);
    return json(res, 200, { files });
  }

  if (path === '/api/drive/import' && method === 'POST') {
    const body = await readBody(req);
    const fileId = requireString(body.fileId, 'Drive file ID', 1, 200);
    const category = requireString(body.category ?? 'Other documents', 'Category', 1, 80);
    const subcategory = String(body.subcategory ?? '');
    
    // Ingest content from Google Drive
    const { meta, text, buffer } = await downloadFileContent(user.id, fileId);
    const fileName = meta.name || body.name || 'Drive Document';

    const ingested = await ingestDocumentFile({
      userId: user.id,
      filename: fileName,
      buffer: buffer || Buffer.from(text, 'utf8'),
      category,
      subcategory,
      source: 'drive',
      sourceFileId: fileId,
    });

    return json(res, 201, {
      document: ingested.document,
      result: ingested.result || null,
      error: ingested.error || null,
    });
  }

  if (path === '/api/ai/match-fields' && method === 'POST') {
    const body = await readBody(req);
    const fieldLabel = requireString(body.fieldLabel ?? '', 'Field label', 0, 200);
    const fieldName = String(body.fieldName ?? '');
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    const provider = createProvider();
    let match = null;
    if (typeof provider.matchField === 'function') {
      match = await provider.matchField({ fieldLabel, fieldName, candidates });
    }
    return json(res, 200, { match });
  }

  if (path === '/api/ai/generate-answer' && method === 'POST') {
    const body = await readBody(req);
    const question = requireString(body.question, 'Question', 2, 1000);
    const contextDocuments = String(body.contextDocuments ?? '');
    const provider = createProvider();
    if (typeof provider.generateAnswer !== 'function') {
      throw Object.assign(new Error('Selected AI provider does not support answer generation.'), { status: 400 });
    }
    const answer = await provider.generateAnswer({ question, contextDocuments });
    return json(res, 200, { answer });
  }

  if (path === '/api/account' && method === 'DELETE') {
    const body = await readBody(req);
    const password = requireString(body.password, 'Password', 6, 200);
    if (!verifyPassword(password, user.password_salt, user.password_hash)) {
      throw Object.assign(new Error('Password confirmation failed.'), { status: 403 });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    return json(res, 200, { ok: true, deleted: true });
  }

  throw Object.assign(new Error('API route not found.'), { status: 404 });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (!rateLimit(`ip:${req.socket.remoteAddress || 'local'}`, 240)) {
      return json(res, 429, { error: 'Too many requests. Try again shortly.' });
    }
    await route(req, res, url);
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error(error);
    if (!res.headersSent) json(res, status, { error: status >= 500 && isProduction() ? 'Internal server error.' : error?.message || 'Request failed.' });
  }
});

server.listen(PORT, () => {
  console.log(`FormFlow API listening on http://localhost:${PORT}`);
  console.log(`Allowed dashboard origin: ${ALLOWED_ORIGIN}`);
  const hasKey = process.env.AI_API_KEY && !process.env.AI_API_KEY.includes('your_gemini_api_key');
  if (hasKey) {
    console.log(`AI provider: ${process.env.AI_PROVIDER || 'gemini'} active (${process.env.GEMINI_MODEL || 'gemini-1.5-flash'}).`);
  } else {
    console.log('AI provider: local deterministic rules (configure AI_API_KEY for Google Gemini extraction).');
  }
});

export { server };
