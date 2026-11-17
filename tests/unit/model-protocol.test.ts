import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_WORKER_PROTOCOL_VERSION,
  parseModelWorkerRequest,
  parseModelWorkerResponse,
} from '../../shared/model-protocol';

test('model worker protocol accepts strict load and inference requests', () => {
  const load = parseModelWorkerRequest({
    protocol: MODEL_WORKER_PROTOCOL_VERSION,
    type: 'load',
    requestId: 'load_123',
    variantId: 'q8',
  });
  assert.equal(load.type, 'load');

  const infer = parseModelWorkerRequest({
    protocol: MODEL_WORKER_PROTOCOL_VERSION,
    type: 'infer',
    requestId: 'infer_123',
    messages: [
      { role: 'system', content: 'Return JSON.' },
      { role: 'user', content: 'Extract.' },
    ],
    maxNewTokens: 128,
    temperature: 0,
  });
  assert.equal(infer.type, 'infer');
  if (infer.type === 'infer') assert.equal(infer.maxNewTokens, 128);
});

test('model worker protocol rejects malformed requests and unbounded output', () => {
  assert.throws(() => parseModelWorkerRequest({ protocol: 2, type: 'load', requestId: 'x' }), /protocol/i);
  assert.throws(() => parseModelWorkerRequest({
    protocol: MODEL_WORKER_PROTOCOL_VERSION,
    type: 'infer',
    requestId: 'infer_123',
    messages: [{ role: 'user', content: 'x' }],
    maxNewTokens: 9999,
    temperature: 0,
  }), /token limit/i);
  assert.throws(() => parseModelWorkerRequest({
    protocol: MODEL_WORKER_PROTOCOL_VERSION,
    type: 'infer',
    requestId: 'infer_123',
    messages: [{ role: 'user', content: 'x'.repeat(25_000) }],
    maxNewTokens: 64,
    temperature: 0,
  }), /content is invalid/i);
  assert.throws(() => parseModelWorkerResponse({
    protocol: MODEL_WORKER_PROTOCOL_VERSION,
    type: 'result',
    requestId: 'infer_123',
    text: 'x'.repeat(70_000),
    lengthMs: 1,
  }), /output is invalid/i);
});

test('model worker protocol forwards cancellation and typed failures', () => {
  const cancel = parseModelWorkerRequest({
    protocol: MODEL_WORKER_PROTOCOL_VERSION,
    type: 'cancel',
    requestId: 'cancel_123',
    targetRequestId: 'infer_123',
  });
  assert.equal(cancel.type, 'cancel');
  const failure = parseModelWorkerResponse({
    protocol: MODEL_WORKER_PROTOCOL_VERSION,
    type: 'error',
    requestId: 'infer_123',
    code: 'MODEL_CANCELLED',
    message: 'Cancelled.',
  });
  assert.equal(failure.type, 'error');
});
