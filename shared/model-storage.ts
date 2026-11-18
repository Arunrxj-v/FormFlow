/**
 * Storage preflight helpers for large local operations.
 *
 * Chunked downloads are assembled into a second full-size cache entry before
 * the parts are removed, so the transient peak is roughly twice the final model
 * size plus a safety margin. These helpers centralise that estimate so the
 * installer, upgrade planner and UI all agree.
 */

export const MODEL_STAGING_MARGIN_BYTES = 128 * 1024 * 1024;

export function requiredModelStorageBytes(modelBytes: number): number {
  return modelBytes * 2 + MODEL_STAGING_MARGIN_BYTES;
}

/**
 * Quota is often unavailable or reported as zero in test/private environments.
 * Only a known, positive quota is treated as a hard constraint: an unknown
 * quota must never block an operation nor silently promise success.
 */
export function hasSufficientStorage(quotaBytes: number, availableBytes: number, requiredBytes: number): boolean {
  if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) return true;
  if (!Number.isFinite(availableBytes) || availableBytes < 0) return true;
  return availableBytes >= requiredBytes;
}

export function insufficientStorageMessage(requiredBytes: number): string {
  const mb = Math.ceil(requiredBytes / (1024 * 1024));
  return `At least ${mb} MB of free local storage is required to download, stage and verify this model. The previous verified model and all documents were left unchanged.`;
}
