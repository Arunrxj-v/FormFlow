import { db } from './db.mjs';
import { createOAuthState } from './security.mjs';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';

export const GOOGLE_SIGNIN_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export const GOOGLE_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export function getGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8787/api/auth/google/callback';
  const isConfigured = Boolean(clientId && !clientId.includes('your_google_client_id') && clientSecret && !clientSecret.includes('your_google_client_secret'));
  return { clientId, clientSecret, redirectUri, isConfigured };
}

export function generateAuthUrl(optionsOrState = {}) {
  const options = typeof optionsOrState === 'string' ? { state: optionsOrState } : optionsOrState;
  const { intent = 'signin', userId = null } = options;
  let state = options.state;
  if (!state) {
    state = createOAuthState({ intent, userId });
  }
  const { clientId, redirectUri, isConfigured } = getGoogleConfig();
  if (!isConfigured) {
    throw new Error('Google OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) are not configured.');
  }
  const scopes = intent === 'drive' ? GOOGLE_DRIVE_SCOPES : GOOGLE_SIGNIN_SCOPES;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: intent === 'drive' ? 'offline' : 'online',
    prompt: intent === 'drive' ? 'consent' : 'select_account',
    state,
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCode(code) {
  const { clientId, clientSecret, redirectUri } = getGoogleConfig();
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Google token exchange failed (${response.status}): ${errText}`);
  }
  return response.json();
}

export async function fetchUserInfo(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error('Failed to fetch Google user profile.');
  return response.json();
}

export async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = getGoogleConfig();
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) throw new Error('Failed to refresh Google access token.');
  return response.json();
}

export function saveConnection(userId, tokens, profile = {}) {
  const now = new Date().toISOString();
  const expiry = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null;
  const existing = db.prepare('SELECT refresh_token FROM google_connections WHERE user_id = ?').get(userId);
  const refreshToken = tokens.refresh_token || existing?.refresh_token || null;

  db.prepare(`
    INSERT INTO google_connections (user_id, access_token, refresh_token, token_expiry, scope, email, account_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, google_connections.refresh_token),
      token_expiry = excluded.token_expiry,
      scope = excluded.scope,
      email = COALESCE(excluded.email, google_connections.email),
      account_name = COALESCE(excluded.account_name, google_connections.account_name),
      updated_at = excluded.updated_at
  `).run(
    userId,
    tokens.access_token,
    refreshToken,
    expiry,
    tokens.scope || SCOPES.join(' '),
    profile.email || null,
    profile.name || null,
    now,
    now,
  );
}

export async function getValidAccessToken(userId) {
  const conn = db.prepare('SELECT * FROM google_connections WHERE user_id = ?').get(userId);
  if (!conn) return null;
  const now = Date.now();
  if (conn.token_expiry && conn.token_expiry - now < 60_000 && conn.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(conn.refresh_token);
      saveConnection(userId, refreshed, { email: conn.email, name: conn.account_name });
      return refreshed.access_token;
    } catch (err) {
      console.error('Failed to refresh Google token:', err);
      return null;
    }
  }
  return conn.access_token;
}

export function getConnectionStatus(userId) {
  const conn = db.prepare('SELECT * FROM google_connections WHERE user_id = ?').get(userId);
  if (!conn) {
    return {
      connected: false,
      accountEmail: '',
      accountName: '',
      lastSync: 'Not synced',
      isConfigured: getGoogleConfig().isConfigured,
    };
  }
  return {
    connected: true,
    accountEmail: conn.email || '',
    accountName: conn.account_name || 'Google Account',
    lastSync: conn.updated_at,
    isConfigured: getGoogleConfig().isConfigured,
  };
}

export function disconnect(userId) {
  db.prepare('DELETE FROM google_connections WHERE user_id = ?').run(userId);
}

export async function listFiles(userId) {
  const token = await getValidAccessToken(userId);
  if (!token) throw Object.assign(new Error('Google Drive is not connected.'), { status: 401 });

  const params = new URLSearchParams({
    fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink, iconLink)',
    pageSize: '50',
    orderBy: 'modifiedTime desc',
    q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
  });

  const response = await fetch(`${GOOGLE_DRIVE_FILES_ENDPOINT}?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Google Drive API error (${response.status}): ${errText}`);
  }
  const data = await response.json();
  return (data.files || []).map((file) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: Number(file.size || 0),
    sizeLabel: file.size ? `${(Number(file.size) / (1024 * 1024)).toFixed(1)} MB` : 'Google Doc',
    modifiedTime: file.modifiedTime,
    webViewLink: file.webViewLink,
  }));
}

export async function downloadFileContent(userId, fileId) {
  const token = await getValidAccessToken(userId);
  if (!token) throw Object.assign(new Error('Google Drive is not connected.'), { status: 401 });

  // First fetch metadata to inspect mimeType
  const metaRes = await fetch(`${GOOGLE_DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) throw new Error('Failed to fetch Drive file metadata.');
  const meta = await metaRes.json();

  let text = '';
  let buffer = null;
  if (meta.mimeType === 'application/vnd.google-apps.document') {
    // Export Google Docs as plain text
    const exportRes = await fetch(`${GOOGLE_DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}/export?mimeType=text/plain`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!exportRes.ok) throw new Error('Failed to export Google Document as text.');
    text = await exportRes.text();
    buffer = Buffer.from(text, 'utf8');
    if (!meta.name.endsWith('.txt')) meta.name = `${meta.name}.txt`;
  } else {
    // Regular binary or text file
    const fileRes = await fetch(`${GOOGLE_DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!fileRes.ok) throw new Error('Failed to download Google Drive file media.');
    buffer = Buffer.from(await fileRes.arrayBuffer());
    if (meta.mimeType.startsWith('text/') || meta.name.endsWith('.txt')) {
      text = buffer.toString('utf8');
    }
  }

  return {
    meta,
    text,
    buffer,
  };
}
