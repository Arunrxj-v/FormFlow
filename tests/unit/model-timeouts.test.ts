import test from 'node:test';
import assert from 'node:assert/strict';
import { inferenceTimeoutMsForTokens } from '../../shared/model-timeouts';
import {
  MODEL_INFERENCE_TIMEOUT_MAX_MS,
  MODEL_INFERENCE_TIMEOUT_MS,
} from '../../shared/constants';

test('inference timeout keeps a floor for slow WASM hosts', () => {
  assert.equal(inferenceTimeoutMsForTokens(16), MODEL_INFERENCE_TIMEOUT_MS);
  assert.equal(inferenceTimeoutMsForTokens(160), MODEL_INFERENCE_TIMEOUT_MS);
  assert.ok(inferenceTimeoutMsForTokens(512) > MODEL_INFERENCE_TIMEOUT_MS);
  assert.equal(inferenceTimeoutMsForTokens(99_999), MODEL_INFERENCE_TIMEOUT_MAX_MS);
});
