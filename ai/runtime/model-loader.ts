import { sha256 } from '@noble/hashes/sha2.js';
import { MODEL_CACHE_NAME, MODEL_METADATA_ID } from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type { InstalledModelRecord, ModelCapabilities, ModelRuntime } from '@shared/types';
import { getDb } from '../../core/database/database';
import { MODEL_VARIANTS, resolveModelUrl, variantById, type ModelVariant } from '../models/model-registry';

export interface DownloadProgress {
  phase: 'checking' | 'downloading' | 'verifying' | 'ready';
  filePath: string;
  fileIndex: number;
  fileCount: number;
  fileBytes: number;
  fileTotalBytes: number;
  totalBytes: number;
  totalTotalBytes: number;
  percent: number;
}

export interface ModelInstallResult {
  record: InstalledModelRecord;
  variant: ModelVariant;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function detectModelCapabilities(): Promise<ModelCapabilities> {
  const capabilities: ModelCapabilities = {
    webgpu: false,
    wasm: typeof WebAssembly === 'object',
    hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4,
    deviceMemoryGb: typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined,
  };
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown | null> } }).gpu;
    if (gpu) {
      const adapter = (await gpu.requestAdapter()) as { info?: { vendor?: string; architecture?: string; device?: string; description?: string } } | null;
      if (adapter) {
        capabilities.webgpu = true;
        const info = adapter.info;
        capabilities.webgpuAdapter = [info?.vendor, info?.architecture, info?.device, info?.description].filter(Boolean).join(' ') || 'WebGPU adapter';
      }
    }
  } catch {
    capabilities.webgpu = false;
  }
  return capabilities;
}

export function preferredVariant(capabilities: ModelCapabilities): ModelVariant {
  // INT8 is the verified-compatible artifact across WebGPU and WASM. Q4F16 is
  // offered as an optional WebGPU-optimised download, never silently substituted.
  return capabilities.webgpu ? MODEL_VARIANTS.q4f16 : MODEL_VARIANTS.q8;
}

export function defaultVariant(): ModelVariant {
  return MODEL_VARIANTS.q8;
}

async function openCache(): Promise<Cache> {
  return caches.open(MODEL_CACHE_NAME);
}

async function cachedResponse(variant: ModelVariant, filePath: string): Promise<Response | null> {
  const cache = await openCache();
  return (await cache.match(resolveModelUrl(filePath))) ?? null;
}

async function hashResponse(response: Response, expectedSize: number, onBytes?: (bytes: number) => void): Promise<{ sha256: string; bytes: number }> {
  const hasher = sha256.create();
  let bytes = 0;
  const body = response.body;
  if (!body) {
    const buffer = await response.arrayBuffer();
    hasher.update(new Uint8Array(buffer));
    onBytes?.(buffer.byteLength);
    return { sha256: bytesToHex(hasher.digest()), bytes: buffer.byteLength };
  }
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      hasher.update(value);
      bytes += value.byteLength;
      onBytes?.(bytes);
    }
  }
  if (bytes !== expectedSize) {
    throw new FormFlowError('MODEL_HASH_MISMATCH', `Model file size mismatch (${bytes} bytes, expected ${expectedSize}).`);
  }
  return { sha256: bytesToHex(hasher.digest()), bytes };
}

async function downloadFile(
  variant: ModelVariant,
  fileIndex: number,
  totalCompleted: number,
  onProgress: (progress: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<{ sha256: string; size: number; totalBytes: number }> {
  const file = variant.files[fileIndex];
  const url = resolveModelUrl(file.path);
  const cache = await openCache();

  const existing = await cache.match(url);
  if (existing) {
    const length = Number(existing.headers.get('content-length') ?? 0);
    if (length === file.size) {
      const verified = await hashResponse(existing.clone(), file.size, (bytes) => {
        onProgress({
          phase: 'verifying',
          filePath: file.path,
          fileIndex,
          fileCount: variant.files.length,
          fileBytes: bytes,
          fileTotalBytes: file.size,
          totalBytes: totalCompleted + bytes,
          totalTotalBytes: variant.totalBytes,
          percent: Math.min(99, ((totalCompleted + bytes) / variant.totalBytes) * 100),
        });
      });
      if (!file.sha256 || verified.sha256 === file.sha256) {
        return { sha256: verified.sha256, size: file.size, totalBytes: verified.bytes };
      }
      await cache.delete(url);
    } else {
      await cache.delete(url);
    }
  }

  const response = await fetch(url, { signal, redirect: 'follow', credentials: 'omit' });
  if (!response.ok) {
    throw new FormFlowError('MODEL_DOWNLOAD_FAILED', `Model download failed (HTTP ${response.status}) for ${file.path}.`);
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (signal.aborted) throw new FormFlowError('MODEL_CANCELLED', 'Model download was cancelled.');
    const bytes = new Uint8Array(buffer);
    const digest = bytesToHex(sha256(bytes));
    if (file.sha256 && digest !== file.sha256) {
      throw new FormFlowError('MODEL_HASH_MISMATCH', `Integrity check failed for ${file.path}.`);
    }
    await cache.put(url, new Response(buffer, { headers: response.headers }));
    onProgress({
      phase: 'downloading',
      filePath: file.path,
      fileIndex,
      fileCount: variant.files.length,
      fileBytes: buffer.byteLength,
      fileTotalBytes: file.size,
      totalBytes: totalCompleted + buffer.byteLength,
      totalTotalBytes: variant.totalBytes,
      percent: Math.min(99, ((totalCompleted + buffer.byteLength) / variant.totalBytes) * 100),
    });
    return { sha256: digest, size: buffer.byteLength, totalBytes: totalCompleted + buffer.byteLength };
  }

  const [hashStream, cacheStream] = response.body.tee();
  const hashResponseForCache = new Response(cacheStream, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.size) },
  });
  const cachePut = cache.put(url, hashResponseForCache);

  let downloaded = 0;
  const hasher = sha256.create();
  const reader = hashStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) throw new FormFlowError('MODEL_CANCELLED', 'Model download was cancelled.');
      if (value) {
        hasher.update(value);
        downloaded += value.byteLength;
        onProgress({
          phase: 'downloading',
          filePath: file.path,
          fileIndex,
          fileCount: variant.files.length,
          fileBytes: downloaded,
          fileTotalBytes: file.size,
          totalBytes: totalCompleted + downloaded,
          totalTotalBytes: variant.totalBytes,
          percent: Math.min(99, ((totalCompleted + downloaded) / variant.totalBytes) * 100),
        });
      }
    }
    await cachePut;
  } catch (error) {
    if (signal.aborted || (error instanceof FormFlowError && error.code === 'MODEL_CANCELLED')) {
      await cache.delete(url);
      throw new FormFlowError('MODEL_CANCELLED', 'Model download was cancelled.');
    }
    await cache.delete(url);
    throw error;
  }

  if (downloaded !== file.size) {
    await cache.delete(url);
    throw new FormFlowError('MODEL_HASH_MISMATCH', `Downloaded ${file.path} has an unexpected size.`);
  }
  const digest = bytesToHex(hasher.digest());
  if (file.sha256 && digest !== file.sha256) {
    await cache.delete(url);
    throw new FormFlowError('MODEL_HASH_MISMATCH', `Integrity check failed for ${file.path}.`);
  }
  return { sha256: digest, size: downloaded, totalBytes: totalCompleted + downloaded };
}

export const modelLoader = {
  async getRecord(variantId = 'q8'): Promise<InstalledModelRecord | null> {
    const db = await getDb();
    return (await db.get('modelMetadata', `${MODEL_METADATA_ID}:${variantId}`)) ?? null;
  },

  async listRecords(): Promise<InstalledModelRecord[]> {
    const db = await getDb();
    return db.getAll('modelMetadata');
  },

  async isCached(variant: ModelVariant): Promise<boolean> {
    const cache = await openCache();
    for (const file of variant.files) {
      const response = await cache.match(resolveModelUrl(file.path));
      if (!response) return false;
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length !== file.size) return false;
    }
    return true;
  },

  async install(
    variantId: 'q8' | 'q4f16',
    onProgress: (progress: DownloadProgress) => void,
    signal: AbortSignal,
  ): Promise<ModelInstallResult> {
    const variant = variantById(variantId);
    const db = await getDb();
    const recordId = `${MODEL_METADATA_ID}:${variant.id}`;
    const started: InstalledModelRecord = {
      id: recordId,
      modelId: MODEL_METADATA_ID,
      revision: '54250909aca286a05b9d013c8af7a21859ee6ead',
      dtype: variant.dtype,
      runtime: variant.runtime,
      status: 'downloading',
      expectedBytes: variant.totalBytes,
      downloadedBytes: 0,
      files: variant.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
    };
    await db.put('modelMetadata', started);

    let total = 0;
    const computed: InstalledModelRecord['files'] = [];
    try {
      for (let index = 0; index < variant.files.length; index += 1) {
        if (signal.aborted) throw new FormFlowError('MODEL_CANCELLED', 'Model download was cancelled.');
        const file = variant.files[index];
        onProgress({
          phase: 'checking',
          filePath: file.path,
          fileIndex: index,
          fileCount: variant.files.length,
          fileBytes: 0,
          fileTotalBytes: file.size,
          totalBytes: total,
          totalTotalBytes: variant.totalBytes,
          percent: (total / variant.totalBytes) * 100,
        });
        const result = await downloadFile(variant, index, total, onProgress, signal);
        total = result.totalBytes;
        computed.push({ path: file.path, size: file.size, sha256: file.sha256, sha256Computed: result.sha256 });
        const dbNow = await getDb();
        await dbNow.put('modelMetadata', {
          ...started,
          downloadedBytes: total,
          files: computed,
          status: total >= variant.totalBytes ? 'verifying' : 'downloading',
        });
      }

      const installed: InstalledModelRecord = {
        ...started,
        status: 'installed',
        downloadedBytes: total,
        files: computed,
        installedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
      };
      await db.put('modelMetadata', installed);
      onProgress({
        phase: 'ready',
        filePath: variant.modelFile,
        fileIndex: variant.files.length - 1,
        fileCount: variant.files.length,
        fileBytes: total,
        fileTotalBytes: total,
        totalBytes: total,
        totalTotalBytes: variant.totalBytes,
        percent: 100,
      });
      return { record: installed, variant };
    } catch (error) {
      const failed: InstalledModelRecord = {
        ...started,
        status: signal.aborted ? 'not_installed' : 'failed',
        downloadedBytes: total,
        files: computed,
        error: error instanceof Error ? error.message : 'Model download failed.',
      };
      await db.put('modelMetadata', failed);
      throw error;
    }
  },

  async verify(variantId: 'q8' | 'q4f16', readonly = false): Promise<InstalledModelRecord | null> {
    const variant = variantById(variantId);
    const record = await this.getRecord(variant.id);
    if (!record) return null;
    const cache = await openCache();
    let total = 0;
    const files: InstalledModelRecord['files'] = [];
    for (const file of variant.files) {
      const response = await cache.match(resolveModelUrl(file.path));
      if (!response) return { ...record, status: 'not_installed', error: `Missing model file: ${file.path}` };
      const length = Number(response.headers.get('content-length') ?? 0);
      const hash = response.headers.get('x-formflow-sha256');
      total += length;
      files.push({ path: file.path, size: file.size, sha256: file.sha256, sha256Computed: hash ?? undefined });
      if (length !== file.size) {
        return { ...record, status: 'corrupt', error: `Corrupt model file: ${file.path}` };
      }
    }
    const updated: InstalledModelRecord = {
      ...record,
      status: record.status === 'ready' ? 'ready' : 'installed',
      downloadedBytes: total,
      files,
      lastVerifiedAt: new Date().toISOString(),
      error: undefined,
    };
    if (!readonly) {
      const db = await getDb();
      await db.put('modelMetadata', updated);
    }
    return updated;
  },

  async markStatus(variantId: 'q8' | 'q4f16', status: InstalledModelRecord['status'], patch: Partial<InstalledModelRecord> = {}): Promise<void> {
    const record = await this.getRecord(variantId);
    if (!record) return;
    const db = await getDb();
    await db.put('modelMetadata', { ...record, ...patch, status });
  },

  async remove(variantId: 'q8' | 'q4f16'): Promise<void> {
    const variant = variantById(variantId);
    const cache = await openCache();
    for (const file of variant.files) {
      await cache.delete(resolveModelUrl(file.path));
    }
    const db = await getDb();
    await db.delete('modelMetadata', `${MODEL_METADATA_ID}:${variant.id}`);
  },

  async cachedChatTemplate(variant: ModelVariant): Promise<string> {
    const cache = await openCache();
    const response = await cache.match(resolveModelUrl(variant.chatTemplateFile));
    if (!response) throw new FormFlowError('MODEL_NOT_INSTALLED', 'The local model is missing its chat template.');
    return response.text();
  },
};

export const SUPPORTED_RUNTIME: ModelRuntime = 'wasm';
