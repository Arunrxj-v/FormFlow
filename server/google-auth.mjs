import { createOAuthState, verifyOAuthState } from './security.mjs';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8787/api/auth/google/callback';

export function isGoogleSignInConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

/** Legacy account sign-in only. Google Drive document access is intentionally removed. */
export function generateAuthUrl({ intent = 'signin' } = {}) {
  if (intent !== 'signin') {
    throw Object.assign(new Error('Google Drive document storage has been removed from FormFlow.'), { status: 410 });
  }
  if (!isGoogleSignInConfigured()) {
    throw new Error('Google sign-in is not configured on this server.');
  }
  const state = createOAuthState({ intent: 'signin' });
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCode(code) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status}).`);
  return response.json();
}

export async function fetchUserInfo(accessToken) {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Google userinfo failed (${response.status}).`);
  const profile = await response.json();
  return {
    email: String(profile.email || ''),
    name: String(profile.name || profile.email || ''),
    picture: profile.picture ? String(profile.picture) : '',
  };
}

export { verifyOAuthState };
