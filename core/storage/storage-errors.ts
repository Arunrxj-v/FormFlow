import { FormFlowError } from '@shared/errors';

export function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'QuotaExceededError' || error.code === 22 || /quota/i.test(error.message);
  }
  return Boolean(error && typeof error === 'object' && /quota/i.test(String((error as { name?: string; message?: string }).name ?? (error as { message?: string }).message ?? '')));
}

export function asStorageError(error: unknown): unknown {
  if (!isQuotaExceededError(error)) return error;
  return new FormFlowError(
    'INSUFFICIENT_STORAGE',
    'There is not enough local storage to complete this operation. Existing data was not changed; free space and retry.',
    { cause: error },
  );
}
