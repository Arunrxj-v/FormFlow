import test from 'node:test';
import assert from 'node:assert/strict';

(globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'test-extension-id' } };
const { parseRequest, isTrustedExtensionSender, success, failure, PROTOCOL_VERSION } = await import('../../extension/src/messaging/protocol');

test('parses a valid protocol request', () => {
  const request = parseRequest({
    protocol: PROTOCOL_VERSION,
    requestId: 'req_123',
    operation: 'GET_STATE',
    payload: {},
  });
  assert.equal(request.operation, 'GET_STATE');
  assert.equal(request.requestId, 'req_123');
});

test('rejects malformed, versioned, or unidentified requests', () => {
  assert.throws(() => parseRequest(null), /Malformed/);
  assert.throws(() => parseRequest({ requestId: 'req_123', operation: 'GET_STATE' }), /protocol/);
  assert.throws(() => parseRequest({ protocol: 99, requestId: 'req_123', operation: 'GET_STATE' }), /protocol/);
  assert.throws(() => parseRequest({ protocol: PROTOCOL_VERSION, operation: 'GET_STATE' }), /requestId/);
  assert.throws(() => parseRequest({ protocol: PROTOCOL_VERSION, requestId: 'x', operation: 'GET_STATE' }), /requestId/);
  assert.throws(() => parseRequest({ protocol: PROTOCOL_VERSION, requestId: 'req_123', operation: '' }), /operation/);
  assert.throws(() => parseRequest({ protocol: PROTOCOL_VERSION, requestId: 'req_123', operation: 'GET_STATE', payload: 3 }), /payload/);
});

test('accepts only trusted extension pages', () => {
  assert.equal(isTrustedExtensionSender({ id: 'test-extension-id', url: 'chrome-extension://test-extension-id/popup.html' }), true);
  assert.equal(isTrustedExtensionSender({ id: 'test-extension-id', url: 'chrome-extension://test-extension-id/dashboard.html#/dashboard' }), true);
  assert.equal(isTrustedExtensionSender({ id: 'test-extension-id', url: 'https://example.com/form' }), false);
  assert.equal(isTrustedExtensionSender({ id: 'other-extension', url: 'chrome-extension://other-extension/popup.html' }), false);
});

test('creates typed success and failure responses', () => {
  assert.deepEqual(success('req_1', { ok: true }), {
    protocol: PROTOCOL_VERSION,
    requestId: 'req_1',
    ok: true,
    data: { ok: true },
  });
  assert.deepEqual(failure('req_2', 'Denied', 'UNAUTHORIZED'), {
    protocol: PROTOCOL_VERSION,
    requestId: 'req_2',
    ok: false,
    error: 'Denied',
    code: 'UNAUTHORIZED',
  });
});
