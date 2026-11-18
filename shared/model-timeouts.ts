import {
  MODEL_INFERENCE_TIMEOUT_MAX_MS,
  MODEL_INFERENCE_TIMEOUT_MS,
  MODEL_INFERENCE_TIMEOUT_PER_TOKEN_MS,
} from './constants';

/**
 * Generation budget: a fixed floor for normal replies, scaled for larger token
 * budgets, and capped so a stuck worker still fails eventually.
 */
export function inferenceTimeoutMsForTokens(maxNewTokens: number): number {
  const tokens = Math.max(16, Math.min(512, Math.trunc(maxNewTokens)));
  return Math.min(
    MODEL_INFERENCE_TIMEOUT_MAX_MS,
    Math.max(MODEL_INFERENCE_TIMEOUT_MS, tokens * MODEL_INFERENCE_TIMEOUT_PER_TOKEN_MS),
  );
}
