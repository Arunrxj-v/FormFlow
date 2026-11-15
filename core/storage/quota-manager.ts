import type { StorageEstimate } from '@shared/types';
import { getDb } from '../database/database';

export interface StorageQuota {
  estimate(): Promise<StorageEstimate>;
  requestPersistence(): Promise<boolean>;
  cleanupTemporaryData(): Promise<number>;
}

async function cacheSize(cacheName: string): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    let total = 0;
    for (const request of keys) {
      const response = await cache.match(request);
      if (!response) continue;
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > 0) {
        total += length;
      } else {
        total += (await response.clone().blob()).size;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export const quotaManager: StorageQuota = {
  async estimate(): Promise<StorageEstimate> {
    let usageBytes = 0;
    let quotaBytes = 0;
    let persisted = false;
    try {
      const estimate = await navigator.storage.estimate();
      usageBytes = estimate.usage ?? 0;
      quotaBytes = estimate.quota ?? 0;
      persisted = await navigator.storage.persisted();
    } catch {
      // Storage API is not available in every test environment.
    }

    let documentsBytes = 0;
    try {
      const db = await getDb();
      const files = await db.getAll('documentFiles');
      documentsBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
    } catch {
      documentsBytes = 0;
    }

    const modelBytes = await cacheSize('formflow-model-cache-v1');

    return {
      usageBytes,
      quotaBytes,
      availableBytes: Math.max(0, quotaBytes - usageBytes),
      documentsBytes,
      modelBytes,
      persisted,
    };
  },

  async requestPersistence(): Promise<boolean> {
    try {
      if (!navigator.storage?.persist) return false;
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  },

  async cleanupTemporaryData(): Promise<number> {
    const db = await getDb();
    const jobs = await db.getAll('processingJobs');
    let removed = 0;
    for (const job of jobs) {
      if (job.status === 'failed' || job.status === 'completed') {
        await db.delete('processingJobs', job.id);
        removed += 1;
      }
    }
    return removed;
  },
};
