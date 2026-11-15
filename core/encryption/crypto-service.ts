import { FormFlowError } from '@shared/errors';
import { ENCRYPTION_FORMAT_VERSION, PBKDF2_ITERATIONS, VAULT_SCHEMA_VERSION } from '@shared/constants';

export interface EncryptedEnvelope {
  v: 1 | 2;
  alg: 'AES-GCM';
  iv: string;
  data: string;
}

export interface WrappedKey {
  salt: string;
  iterations: number;
  wrapped: EncryptedEnvelope;
}

/**
 * Canonical authenticated context for one encrypted field.
 *
 * The AAD is a length-prefixed encoding, not string concatenation, so
 * attacker-controlled IDs cannot shift field boundaries.
 */
export interface RecordAad {
  vaultId: string;
  recordType: string;
  recordId: string;
  field: string;
  schemaVersion: number;
}

const LEGACY_AAD = new TextEncoder().encode('formflow:vault:v1');
const textEncoder = new TextEncoder();

function lengthPrefixed(parts: string[]): Uint8Array {
  return textEncoder.encode(parts.map((part) => `${textEncoder.encode(part).length}:${part}`).join('|'));
}

export function recordAad(context: RecordAad): Uint8Array {
  return lengthPrefixed([
    'formflow',
    'record',
    String(ENCRYPTION_FORMAT_VERSION),
    String(context.schemaVersion),
    context.vaultId,
    context.recordType,
    context.recordId,
    context.field,
  ]);
}

export const BACKUP_AAD: RecordAad = {
  vaultId: 'formflow-backup',
  recordType: 'backup',
  recordId: 'archive',
  field: 'payload',
  schemaVersion: 3,
};

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function bufferToBase64(bytes: ArrayBuffer | Uint8Array): string {
  return toBase64(bytes);
}

export function base64ToArrayBuffer(value: string): ArrayBuffer {
  const bytes = fromBase64(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string'
    ? textEncoder.encode(data)
    : data instanceof Uint8Array
      ? data
      : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function generateDataKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportKeyRaw(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}

export async function importDataKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM', length: 256 }, extractable, [
    'encrypt',
    'decrypt',
  ]);
}

async function encryptBytesWithAad(
  key: CryptoKey,
  bytes: ArrayBuffer | Uint8Array,
  additionalData: Uint8Array,
): Promise<{ iv: string; data: ArrayBuffer }> {
  const iv = randomBytes(12);
  const plaintext = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: additionalData as BufferSource, tagLength: 128 },
    key,
    plaintext as BufferSource,
  );
  return { iv: toBase64(iv), data: ciphertext };
}

async function decryptBytesWithAad(
  key: CryptoKey,
  ivBase64: string,
  ciphertext: ArrayBuffer,
  additionalData: Uint8Array,
): Promise<ArrayBuffer> {
  let iv: Uint8Array;
  try {
    iv = fromBase64(ivBase64);
  } catch (error) {
    throw new FormFlowError('VALIDATION_FAILED', 'Encrypted data has malformed nonce metadata.', { cause: error });
  }
  if (iv.byteLength !== 12) {
    throw new FormFlowError('VALIDATION_FAILED', 'Encrypted data has an invalid nonce length.');
  }
  if (ciphertext.byteLength < 16) {
    throw new FormFlowError('VALIDATION_FAILED', 'Encrypted data is truncated.');
  }
  try {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: additionalData as BufferSource, tagLength: 128 },
      key,
      ciphertext,
    );
  } catch (error) {
    throw new FormFlowError('VALIDATION_FAILED', 'Encrypted data could not be authenticated.', { cause: error });
  }
}

/** Encrypt record bytes with per-record AAD. */
export async function encryptBytesWithKey(
  key: CryptoKey,
  bytes: ArrayBuffer | Uint8Array,
  context: RecordAad,
): Promise<{ iv: string; data: ArrayBuffer }> {
  return encryptBytesWithAad(key, bytes, recordAad(context));
}

/** Decrypt record bytes with per-record AAD. */
export async function decryptBytesWithKey(
  key: CryptoKey,
  ivBase64: string,
  ciphertext: ArrayBuffer,
  context: RecordAad,
): Promise<ArrayBuffer> {
  return decryptBytesWithAad(key, ivBase64, ciphertext, recordAad(context));
}

/** Legacy helper for the wrapped data key, which is not a vault record. */
export async function encryptBytesWithLegacyAad(
  key: CryptoKey,
  bytes: ArrayBuffer | Uint8Array,
): Promise<{ iv: string; data: ArrayBuffer }> {
  return encryptBytesWithAad(key, bytes, LEGACY_AAD);
}

/** Legacy helper for reading Phase 2/3 data before the record-AAD migration. */
export async function decryptBytesWithLegacyAad(
  key: CryptoKey,
  ivBase64: string,
  ciphertext: ArrayBuffer,
): Promise<ArrayBuffer> {
  return decryptBytesWithAad(key, ivBase64, ciphertext, LEGACY_AAD);
}

export async function encryptJsonWithKey(key: CryptoKey, value: unknown, context: RecordAad): Promise<string> {
  const encoded = textEncoder.encode(JSON.stringify(value));
  const { iv, data } = await encryptBytesWithKey(key, encoded, context);
  const envelope: EncryptedEnvelope = {
    v: 2,
    alg: 'AES-GCM',
    iv,
    data: toBase64(data),
  };
  return JSON.stringify(envelope);
}

/** Legacy writer used only to construct fixtures or read old data. */
export async function encryptJsonWithLegacyAad(key: CryptoKey, value: unknown): Promise<string> {
  const encoded = textEncoder.encode(JSON.stringify(value));
  const { iv, data } = await encryptBytesWithLegacyAad(key, encoded);
  const envelope: EncryptedEnvelope = {
    v: 1,
    alg: 'AES-GCM',
    iv,
    data: toBase64(data),
  };
  return JSON.stringify(envelope);
}

function parseEnvelope(payload: string): EncryptedEnvelope {
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(payload) as EncryptedEnvelope;
  } catch (error) {
    throw new FormFlowError('VALIDATION_FAILED', 'Encrypted payload is not valid JSON.', { cause: error });
  }
  if (
    !envelope ||
    (envelope.v !== 1 && envelope.v !== 2) ||
    envelope.alg !== 'AES-GCM' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.data !== 'string'
  ) {
    throw new FormFlowError('VALIDATION_FAILED', 'Unsupported or malformed encryption envelope.');
  }
  return envelope;
}

export function envelopeVersion(payload: string): 1 | 2 {
  return parseEnvelope(payload).v;
}

export function isV2Envelope(payload: string): boolean {
  try {
    return parseEnvelope(payload).v === 2;
  } catch {
    return false;
  }
}

export async function decryptJsonWithKey<T>(
  key: CryptoKey,
  payload: string,
  context?: RecordAad,
): Promise<T> {
  const envelope = parseEnvelope(payload);
  let plaintext: ArrayBuffer;
  if (envelope.v === 2) {
    if (!context) throw new FormFlowError('VALIDATION_FAILED', 'Encrypted record is missing its authenticated context.');
    plaintext = await decryptBytesWithKey(key, envelope.iv, base64ToArrayBuffer(envelope.data), context);
  } else {
    plaintext = await decryptBytesWithLegacyAad(key, envelope.iv, base64ToArrayBuffer(envelope.data));
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as T;
  } catch (error) {
    throw new FormFlowError('VALIDATION_FAILED', 'Decrypted payload is not valid JSON.', { cause: error });
  }
}

export async function wrapDataKey(password: string, iterations = PBKDF2_ITERATIONS): Promise<WrappedKey> {
  const salt = randomBytes(16);
  const kek = await deriveKeyFromPassword(password, salt, iterations);
  const dataKey = await generateDataKey();
  const raw = await exportKeyRaw(dataKey);
  const encrypted = await encryptBytesWithLegacyAad(kek, raw);
  return {
    salt: toBase64(salt),
    iterations,
    wrapped: {
      v: 1,
      alg: 'AES-GCM',
      iv: encrypted.iv,
      data: toBase64(encrypted.data),
    },
  };
}

export async function unwrapDataKey(password: string, saltBase64: string, iterations: number, wrapped: EncryptedEnvelope): Promise<CryptoKey> {
  const salt = fromBase64(saltBase64);
  const kek = await deriveKeyFromPassword(password, salt, iterations);
  try {
    const raw = await decryptBytesWithLegacyAad(kek, wrapped.iv, base64ToArrayBuffer(wrapped.data));
    return importDataKey(new Uint8Array(raw), true);
  } catch (error) {
    throw new FormFlowError('INVALID_PASSWORD', 'That vault password is incorrect.', { cause: error });
  }
}

export async function rewrapDataKey(
  password: string,
  saltBase64: string,
  iterations: number,
  wrapped: EncryptedEnvelope,
  newPassword: string,
): Promise<WrappedKey> {
  const dataKey = await unwrapDataKey(password, saltBase64, iterations, wrapped);
  const raw = await exportKeyRaw(dataKey);
  const newSalt = randomBytes(16);
  const newKek = await deriveKeyFromPassword(newPassword, newSalt);
  const encrypted = await encryptBytesWithLegacyAad(newKek, raw);
  return {
    salt: toBase64(newSalt),
    iterations: PBKDF2_ITERATIONS,
    wrapped: {
      v: 1,
      alg: 'AES-GCM',
      iv: encrypted.iv,
      data: toBase64(encrypted.data),
    },
  };
}

export function validatePasswordStrength(password: string): { ok: boolean; message?: string } {
  if (password.length < 10) return { ok: false, message: 'Use at least 10 characters for your vault password.' };
  if (/^(.)\1+$/.test(password)) return { ok: false, message: 'Choose a less repetitive password.' };
  if (/^\d+$/.test(password)) return { ok: false, message: 'A password made only of digits is too weak.' };
  return { ok: true };
}

export function isSupportedSchemaVersion(value: unknown): value is number {
  return value === VAULT_SCHEMA_VERSION;
}
