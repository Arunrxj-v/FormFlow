import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const DEVELOPMENT_SECRET = 'formflow-local-development-secret-change-me';
const SECRET = process.env.AUTH_SECRET || DEVELOPMENT_SECRET;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expected) {
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(input) {
  return createHmac('sha256', SECRET).update(input).digest('base64url');
}

export function createToken(userId) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }));
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.sub || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export function createOAuthState(payload = {}) {
  const data = {
    ...payload,
    nonce: randomBytes(16).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + 600, // 10 minutes
  };
  const jsonStr = JSON.stringify(data);
  const encoded = Buffer.from(jsonStr).toString('base64url');
  const signature = sign(encoded);
  return `${encoded}.${signature}`;
}

export function verifyOAuthState(stateString) {
  if (!stateString || typeof stateString !== 'string') return null;
  const parts = stateString.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  const expected = sign(encoded);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export function isProduction() {
  return process.env.NODE_ENV === 'production';
}

export function assertProductionSecret() {
  if (!isProduction()) return;
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET must be configured in production.');
  }
  if (secret === DEVELOPMENT_SECRET || secret.length < 32) {
    throw new Error('AUTH_SECRET must be a unique secret of at least 32 characters in production.');
  }
}

export function isDevelopmentSecret() {
  return !process.env.AUTH_SECRET || process.env.AUTH_SECRET === DEVELOPMENT_SECRET;
}
