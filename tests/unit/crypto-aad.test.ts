import test from 'node:test';
import assert from 'node:assert/strict';
import type { RecordAad } from '../../core/encryption/crypto-service';

const {
  decryptBytesWithKey,
  decryptBytesWithLegacyAad,
  decryptJsonWithKey,
  encryptBytesWithKey,
  encryptBytesWithLegacyAad,
  encryptJsonWithKey,
  encryptJsonWithLegacyAad,
  generateDataKey,
  randomBytes,
} = await import('../../core/encryption/crypto-service');

const base: RecordAad = {
  vaultId: 'vault_alpha',
  recordType: 'value',
  recordId: 'val_1',
  field: 'value',
  schemaVersion: 2,
};

const variant = (patch: Partial<RecordAad>): RecordAad => ({ ...base, ...patch });

test('per-record AAD round-trips and rejects every identity change', async () => {
  const key = await generateDataKey();
  const payload = await encryptJsonWithKey(key, { secret: 'alpha' }, base);
  assert.deepEqual(await decryptJsonWithKey(key, payload, base), { secret: 'alpha' });

  const changes: Array<[string, RecordAad]> = [
    ['record id', variant({ recordId: 'val_2' })],
    ['record type', variant({ recordType: 'document' })],
    ['vault id', variant({ vaultId: 'vault_beta' })],
    ['field', variant({ field: 'normalizedValue' })],
    ['schema version', variant({ schemaVersion: 3 })],
  ];
  for (const [label, context] of changes) {
    await assert.rejects(
      () => decryptJsonWithKey(key, payload, context),
      /authenticated|malformed/i,
      `${label} change must fail authentication`,
    );
  }
  await assert.rejects(() => decryptJsonWithKey(key, payload), /missing its authenticated context/i);
});

test('swapping ciphertext between records or types fails closed', async () => {
  const key = await generateDataKey();
  const first = await encryptJsonWithKey(key, 'first secret', base);
  const second = await encryptJsonWithKey(key, 'second secret', variant({ recordId: 'val_2' }));
  await assert.rejects(() => decryptJsonWithKey(key, first, variant({ recordId: 'val_2' })), /authenticated/i);
  await assert.rejects(() => decryptJsonWithKey(key, second, base), /authenticated/i);
  await assert.rejects(
    () => decryptJsonWithKey(key, first, variant({ recordType: 'collection', recordId: 'col_1' })),
    /authenticated/i,
  );
});

test('tampered nonce, ciphertext and tag are rejected', async () => {
  const key = await generateDataKey();
  const payload = JSON.parse(await encryptJsonWithKey(key, { secret: 'value' }, base)) as {
    v: number;
    iv: string;
    data: string;
  };
  const tamperIv = { ...payload, iv: Buffer.from(randomBytes(12)).toString('base64') };
  await assert.rejects(() => decryptJsonWithKey(key, JSON.stringify(tamperIv), base), /authenticated/i);

  const ciphertext = Buffer.from(payload.data, 'base64');
  ciphertext[0] ^= 1;
  await assert.rejects(
    () => decryptJsonWithKey(key, JSON.stringify({ ...payload, data: ciphertext.toString('base64') }), base),
    /authenticated/i,
  );

  const tagged = Buffer.from(payload.data, 'base64');
  tagged[tagged.length - 1] ^= 1;
  await assert.rejects(
    () => decryptJsonWithKey(key, JSON.stringify({ ...payload, data: tagged.toString('base64') }), base),
    /authenticated/i,
  );

  await assert.rejects(
    () => decryptJsonWithKey(key, JSON.stringify({ ...payload, v: 3 }), base),
    /malformed|unsupported/i,
  );
});

test('AES-GCM uses a fresh nonce for every operation', async () => {
  const key = await generateDataKey();
  const nonces = new Set<string>();
  for (let index = 0; index < 40; index += 1) {
    const envelope = JSON.parse(await encryptJsonWithKey(key, 'same value', base)) as { iv: string };
    assert.ok(!nonces.has(envelope.iv), 'nonce reused');
    nonces.add(envelope.iv);
  }
});

test('legacy envelopes remain readable for migration', async () => {
  const key = await generateDataKey();
  const legacy = await encryptJsonWithLegacyAad(key, { legacy: true });
  assert.deepEqual(await decryptJsonWithKey(key, legacy), { legacy: true });

  const bytes = new TextEncoder().encode('legacy bytes').buffer;
  const encrypted = await encryptBytesWithLegacyAad(key, bytes);
  const decrypted = await decryptBytesWithLegacyAad(key, encrypted.iv, encrypted.data);
  assert.equal(new TextDecoder().decode(decrypted), 'legacy bytes');
  await assert.rejects(
    () => decryptBytesWithKey(key, encrypted.iv, encrypted.data, base),
    /authenticated/i,
  );
});
