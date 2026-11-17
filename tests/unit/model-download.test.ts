import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import 'fake-indexeddb/auto';
import { MODEL_CACHE_NAME } from '../../shared/constants';
import type { ModelVariant } from '../../ai/models/model-registry';

const cacheStore = new Map<string, Response>();
const memoryCache = {
  async match(key: RequestInfo | URL) {
    return cacheStore.get(String(key))?.clone();
  },
  async put(key: RequestInfo | URL, response: Response) {
    const body = await response.arrayBuffer();
    cacheStore.set(String(key), new Response(body, {
      status: response.status,
      headers: response.headers,
    }));
  },
  async delete(key: RequestInfo | URL) {
    return cacheStore.delete(String(key));
  },
  async keys() {
    return [...cacheStore.keys()].map((key) => new Request(key));
  },
};
(globalThis as unknown as { caches: unknown }).caches = {
  async open(name: string) {
    assert.equal(name, MODEL_CACHE_NAME);
    return memoryCache;
  },
};

const payload = randomBytes(16 * 1024 * 1024);
const payloadHash = createHash('sha256').update(payload).digest('hex');
const variant = {
  id: 'q8',
  label: 'download fixture',
  dtype: 'q8',
  runtime: 'wasm',
  quantization: 'INT8',
  files: [{ path: 'onnx/download-fixture.bin', size: payload.byteLength, sha256: payloadHash }],
  totalBytes: payload.byteLength,
  chatTemplateFile: 'chat_template.jinja',
  modelFile: 'onnx/download-fixture.bin',
} as ModelVariant;
const cacheUrl = `https://huggingface.co/onnx-community/Qwen3-0.6B-Instruct-ONNX/resolve/54250909aca286a05b9d013c8af7a21859ee6ead/onnx/download-fixture.bin`;

let requestCount = 0;
let interruptFirstRequest = false;
let ignoreRange = false;
let invalidRange = false;
const rangeStarts: number[] = [];
const server = createServer((req, res) => {
  requestCount += 1;
  const range = req.headers.range;
  if (interruptFirstRequest && requestCount === 1) {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.byteLength),
    });
    res.write(payload.subarray(0, 10 * 1024 * 1024));
    setTimeout(() => res.destroy(), 400);
    return;
  }
  if (range && !ignoreRange) {
    const match = /^bytes=(\d+)-$/.exec(range);
    const start = match ? Number(match[1]) : -1;
    rangeStarts.push(start);
    if (invalidRange) {
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${payload.byteLength - 1}/${payload.byteLength + 1}`,
        'content-length': String(payload.byteLength - start),
      });
      res.end(payload.subarray(start));
      return;
    }
    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-range': `bytes ${start}-${payload.byteLength - 1}/${payload.byteLength}`,
      'content-length': String(payload.byteLength - start),
    });
    res.end(payload.subarray(start));
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(payload.byteLength),
  });
  res.end(payload);
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
const base = `http://127.0.0.1:${address.port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('https://huggingface.co/')) return realFetch(`${base}/fixture`, init);
  return realFetch(input, init);
}) as typeof fetch;

const { downloadFile } = await import('../../ai/runtime/model-loader');

test('a mid-stream failure persists verified bytes but never reports success', async () => {
  cacheStore.clear();
  requestCount = 0;
  rangeStarts.length = 0;
  interruptFirstRequest = true;
  await assert.rejects(
    () => downloadFile(variant, 0, 0, () => undefined, new AbortController().signal),
    /interrupted|incomplete|terminated|fetch|socket/i,
  );
  assert.equal(await memoryCache.match(cacheUrl), undefined, 'partial bytes must not be exposed as a complete file');
  const partKeys = [...cacheStore.keys()].filter((key) => key.includes('formflow-model-part='));
  assert.ok(partKeys.length > 0, 'downloaded chunks must remain available for resume');
});

test('a retry uses a validated range request and completes the same file', async () => {
  interruptFirstRequest = false;
  const result = await downloadFile(variant, 0, 0, () => undefined, new AbortController().signal);
  assert.equal(result.size, payload.byteLength);
  assert.equal(result.sha256, payloadHash);
  assert.ok(rangeStarts.length > 0, 'retry must use an HTTP Range request');
  assert.ok(rangeStarts[0]! > 0, 'range must start after the persisted bytes');
  const cached = await memoryCache.match(cacheUrl);
  assert.ok(cached);
  const bytes = Buffer.from(await cached.arrayBuffer());
  assert.equal(bytes.byteLength, payload.byteLength);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), payloadHash);
  assert.equal([...cacheStore.keys()].filter((key) => key.includes('formflow-model-part=')).length, 0);
});

test('existing complete files are verified and not downloaded again', async () => {
  const before = requestCount;
  const result = await downloadFile(variant, 0, 0, () => undefined, new AbortController().signal);
  assert.equal(result.sha256, payloadHash);
  assert.equal(requestCount, before, 'a verified cached file must be reused');
});

test('non-contiguous chunks are discarded rather than concatenated', async () => {
  cacheStore.clear();
  requestCount = 0;
  for (const index of [0, 2]) {
    await memoryCache.put(`${cacheUrl}?formflow-model-part=${index}`, new Response(payload.subarray(index * 8 * 1024 * 1024, (index + 1) * 8 * 1024 * 1024), {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(8 * 1024 * 1024) },
    }));
  }
  const result = await downloadFile(variant, 0, 0, () => undefined, new AbortController().signal);
  assert.equal(result.sha256, payloadHash);
  assert.equal([...cacheStore.keys()].filter((key) => key.includes('formflow-model-part=')).length, 0);
});

test('a server that ignores Range causes a safe full restart, never concatenation', async () => {
  cacheStore.clear();
  requestCount = 0;
  rangeStarts.length = 0;
  await memoryCache.put(`${cacheUrl}?formflow-model-part=0`, new Response(payload.subarray(0, 8 * 1024 * 1024), {
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(8 * 1024 * 1024) },
  }));
  ignoreRange = true;
  const result = await downloadFile(variant, 0, 0, () => undefined, new AbortController().signal);
  ignoreRange = false;
  assert.equal(result.sha256, payloadHash);
  const cached = await memoryCache.match(cacheUrl);
  assert.ok(cached);
  assert.equal((await cached.arrayBuffer()).byteLength, payload.byteLength);
});

test('an invalid Content-Range is rejected and partial bytes are cleaned up', async () => {
  cacheStore.clear();
  requestCount = 0;
  await memoryCache.put(`${cacheUrl}?formflow-model-part=0`, new Response(payload.subarray(0, 8 * 1024 * 1024), {
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(8 * 1024 * 1024) },
  }));
  invalidRange = true;
  await assert.rejects(
    () => downloadFile(variant, 0, 0, () => undefined, new AbortController().signal),
    /invalid range response/i,
  );
  invalidRange = false;
  assert.equal(await memoryCache.match(cacheUrl), undefined);
  assert.equal([...cacheStore.keys()].filter((key) => key.includes('formflow-model-part=')).length, 0);
});

test('cancellation removes partial bytes', async () => {
  cacheStore.clear();
  requestCount = 0;
  await memoryCache.put(`${cacheUrl}?formflow-model-part=0`, new Response(payload.subarray(0, 8 * 1024 * 1024), {
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(8 * 1024 * 1024) },
  }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => downloadFile(variant, 0, 0, () => undefined, controller.signal),
    /cancelled/i,
  );
  assert.equal([...cacheStore.keys()].filter((key) => key.includes('formflow-model-part=')).length, 0);
});

test.after(() => {
  globalThis.fetch = realFetch;
  server.close();
});
