import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { MODEL_CACHE_NAME, MODEL_METADATA_ID } from '../../shared/constants';
import { resolveModelUrl } from '../../ai/models/model-registry';

const store = new Map<string, Response>();
const memoryCache = {
  async match(key: RequestInfo | URL) {
    return store.get(String(key))?.clone();
  },
  async put(key: RequestInfo | URL, response: Response) {
    store.set(String(key), response.clone());
  },
  async delete(key: RequestInfo | URL) {
    return store.delete(String(key));
  },
  async keys() {
    return [...store.keys()].map((key) => new Request(key));
  },
};
(globalThis as unknown as { caches: unknown }).caches = {
  async open(name: string) {
    assert.equal(name, MODEL_CACHE_NAME);
    return memoryCache;
  },
};

const { resetDatabaseForTests, getDb } = await import('../../core/database/database');
const { modelLoader } = await import('../../ai/runtime/model-loader');

await resetDatabaseForTests();

async function seedRecord() {
  const db = await getDb();
  await db.put('modelMetadata', {
    id: `${MODEL_METADATA_ID}:q8`,
    modelId: MODEL_METADATA_ID,
    revision: '54250909aca286a05b9d013c8af7a21859ee6ead',
    dtype: 'q8',
    runtime: 'wasm',
    status: 'installed',
    expectedBytes: 1,
    downloadedBytes: 1,
    files: [],
  });
}

test('missing cached assets cannot be treated as installed', async () => {
  store.clear();
  await seedRecord();
  const result = await modelLoader.verify('q8');
  assert.equal(result?.status, 'not_installed');
  assert.match(result?.error ?? '', /Missing model file/);
  assert.equal((await modelLoader.getRecord('q8'))?.status, 'not_installed');
});

test('corrupt cached assets are marked corrupt and never ready', async () => {
  store.clear();
  await seedRecord();
  store.set(
    resolveModelUrl('config.json'),
    new Response('not-the-real-config', { headers: { 'content-length': '1359' } }),
  );
  const result = await modelLoader.verify('q8');
  assert.equal(result?.status, 'corrupt');
  assert.match(result?.error ?? '', /Corrupt or tampered/);
  const stored = await modelLoader.getRecord('q8');
  assert.equal(stored?.status, 'corrupt');
  assert.notEqual(stored?.status, 'ready');
});
