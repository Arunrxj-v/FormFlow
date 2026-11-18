import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  hasSufficientStorage,
  insufficientStorageMessage,
  MODEL_STAGING_MARGIN_BYTES,
  requiredModelStorageBytes,
} from '../../shared/model-storage';
import { MODEL_CACHE_NAME, MODEL_METADATA_ID } from '../../shared/constants';
import { resolveModelUrl } from '../../ai/models/model-registry';

const stagingStore = new Map<string, Response>();
const activeStore = new Map<string, Response>();
function cacheFor(store: Map<string, Response>) {
  return {
    async match(key: RequestInfo | URL) { return store.get(String(key))?.clone(); },
    async put(key: RequestInfo | URL, response: Response) { store.set(String(key), response.clone()); },
    async delete(key: RequestInfo | URL) { return store.delete(String(key)); },
    // Return raw string keys; a real Cache returns Request objects, but this
    // mock normalises keys via String(), so strings keep delete() working.
    async keys() { return [...store.keys()]; },
  };
}
(globalThis as unknown as { caches: unknown }).caches = {
  async open(name: string) {
    return name === MODEL_CACHE_NAME ? cacheFor(activeStore) : cacheFor(stagingStore);
  },
};

const { resetDatabaseForTests, getDb } = await import('../../core/database/database');
const { modelLoader } = await import('../../ai/runtime/model-loader');
const { quotaManager } = await import('../../core/storage/quota-manager');

test('storage requirement reserves the final file, the assembly copy and a margin', () => {
  const modelBytes = 753_999_618;
  assert.equal(requiredModelStorageBytes(modelBytes), modelBytes * 2 + MODEL_STAGING_MARGIN_BYTES);
  assert.equal(requiredModelStorageBytes(modelBytes) > modelBytes * 2, true);
  assert.match(insufficientStorageMessage(requiredModelStorageBytes(modelBytes)), /MB of free local storage/);
  assert.match(insufficientStorageMessage(requiredModelStorageBytes(modelBytes)), /documents were left unchanged/);
});

test('unknown quota never blocks; a known small quota does', () => {
  const required = requiredModelStorageBytes(100);
  assert.equal(hasSufficientStorage(0, 0, required), true, 'unknown quota must not block');
  assert.equal(hasSufficientStorage(required, required, required), true);
  assert.equal(hasSufficientStorage(required, 10, required), false);
  assert.equal(hasSufficientStorage(required, required - 1, required), false);
});

test('quota estimation degrades safely when the Storage API is unavailable', async () => {
  const estimate = await quotaManager.estimate();
  assert.equal(typeof estimate.availableBytes, 'number');
  assert.ok(estimate.availableBytes >= 0);
  assert.equal(typeof estimate.persisted, 'boolean');
});

test('clearing staging removes corrupted temporary chunks and staging metadata only', async () => {
  await resetDatabaseForTests();
  stagingStore.clear();
  activeStore.clear();
  const db = await getDb();
  const activeId = `${MODEL_METADATA_ID}:q8`;
  await db.put('modelMetadata', {
    id: activeId,
    modelId: MODEL_METADATA_ID,
    revision: '54250909aca286a05b9d013c8af7a21859ee6ead',
    dtype: 'q8', runtime: 'wasm', status: 'ready',
    expectedBytes: 10, downloadedBytes: 10, files: [],
  });
  await db.put('modelMetadata', {
    id: `${MODEL_METADATA_ID}:staging:test-release`,
    modelId: MODEL_METADATA_ID,
    revision: 'b'.repeat(40), dtype: 'q8', runtime: 'wasm', status: 'failed',
    expectedBytes: 10, downloadedBytes: 4, files: [],
  });
  stagingStore.set(`${resolveModelUrl('config.json')}?formflow-model-part=0`, new Response('corrupt', { headers: { 'content-length': '7' } }));
  stagingStore.set(resolveModelUrl('config.json'), new Response('stale', { headers: { 'content-length': '5' } }));
  activeStore.set(resolveModelUrl('config.json'), new Response('active', { headers: { 'content-length': '6' } }));

  await modelLoader.clearStaging();

  assert.equal(stagingStore.size, 0, 'all corrupted staging entries must be removed');
  assert.equal(activeStore.size, 1, 'the active model cache must be untouched');
  const records = await db.getAll('modelMetadata');
  assert.deepEqual(records.map((record) => record.id), [activeId]);
});
