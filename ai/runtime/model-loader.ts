import { sha256 } from '@noble/hashes/sha2.js';
import { MODEL_CACHE_NAME, MODEL_METADATA_ID, MODEL_REVISION } from '@shared/constants';
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
  // Q8 is the artifact verified for local CPU/WASM execution. Q4F16 remains
  // an explicit opt-in WebGPU experiment and is never auto-selected.
  return MODEL_VARIANTS.q8;
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

const MODEL_PART_QUERY = '?formflow-model-part=';
const MODEL_PART_CHUNK_BYTES = 8 * 1024 * 1024;

function partKey(url: string, index: number): string {
  return `${url}${MODEL_PART_QUERY}${index}`;
}

function partIndex(key: string, url: string): number | null {
  const prefix = `${url}${MODEL_PART_QUERY}`;
  if (!key.startsWith(prefix)) return null;
  const value = Number(key.slice(prefix.length));
  return Number.isInteger(value) && value >= 0 ? value : null;
}

async function listParts(cache: Cache, url: string): Promise<Array<{ key: string; index: number }>> {
  const requests = await cache.keys();
  const entries: Array<{ key: string; index: number }> = [];
  for (const request of requests) {
    const key = request.url;
    const index = partIndex(key, url);
    if (index !== null) entries.push({ key, index });
  }
  return entries.sort((a, b) => a.index - b.index);
}

async function clearParts(cache: Cache, url: string): Promise<void> {
  for (const entry of await listParts(cache, url)) await cache.delete(entry.key);
}

async function readParts(
  cache: Cache,
  url: string,
  filePath: string,
  fileSize: number,
  expectedTotal: number,
  onProgress: (progress: DownloadProgress) => void,
  fileIndex: number,
  fileCount: number,
  totalCompleted: number,
  signal: AbortSignal,
): Promise<{ parts: Array<{ key: string; index: number }>; bytes: number; hasher: ReturnType<typeof sha256.create>; nextIndex: number }> {
  const parts = await listParts(cache, url);
  const hasher = sha256.create();
  let bytes = 0;
  let nextIndex = 0;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index]!.index !== index) {
      // A gap would make Range offsets and concatenation unsafe. Restart the
      // file rather than combining non-contiguous chunks.
      await clearParts(cache, url);
      return { parts: [], bytes: 0, hasher: sha256.create(), nextIndex: 0 };
    }
  }
  for (const part of parts) {
    if (signal.aborted) {
      await clearParts(cache, url);
      throw new FormFlowError('MODEL_CANCELLED', 'Model download was cancelled.');
    }
    const response = await cache.match(part.key);
    if (!response) {
      await clearParts(cache, url);
      return { parts: [], bytes: 0, hasher: sha256.create(), nextIndex: 0 };
    }
    const reader = response.body?.getReader();
    if (!reader) {
      await clearParts(cache, url);
      return { parts: [], bytes: 0, hasher: sha256.create(), nextIndex: 0 };
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) {
        await clearParts(cache, url);
        throw new FormFlowError('MODEL_CANCELLED', 'Model download was cancelled.');
      }
      if (value) {
        hasher.update(value);
        bytes += value.byteLength;
        if (bytes > fileSize) {
          await clearParts(cache, url);
          return { parts: [], bytes: 0, hasher: sha256.create(), nextIndex: 0 };
        }
      }
    }
    nextIndex = Math.max(nextIndex, part.index + 1);
  }
  if (bytes > 0) {
    onProgress({
      phase: 'verifying',
      filePath,
      fileIndex,
      fileCount,
      fileBytes: bytes,
      fileTotalBytes: fileSize,
      totalBytes: totalCompleted + bytes,
      totalTotalBytes: expectedTotal,
      percent: Math.min(99, ((totalCompleted + bytes) / expectedTotal) * 100),
    });
  }
  return { parts, bytes, hasher, nextIndex };
}

async function finalizeParts(
  cache: Cache,
  url: string,
  fileSize: number,
  parts: Array<{ key: string; index: number }>,
): Promise<void> {
  if (parts.length === 0) throw new FormFlowError('MODEL_DOWNLOAD_FAILED', 'No downloaded model chunks are available.');
  const ordered = [...parts].sort((a, b) => a.index - b.index);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const part of ordered) {
          const response = await cache.match(part.key);
          const reader = response?.body?.getReader();
          if (!reader) throw new Error('A downloaded model chunk is missing.');
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  await cache.put(url, new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(fileSize),
    },
  }));
  await clearParts(cache, url);
}

export async function downloadFile(
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
    try {
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
          await clearParts(cache, url);
          return { sha256: verified.sha256, size: file.size, totalBytes: totalCompleted + verified.bytes };
        }
        await cache.delete(url);
      } else {
        await cache.delete(url);
      }
    } catch {
      await cache.delete(url);
    }
  }

  let resume = await readParts(cache, url, file.path, file.size, variant.totalBytes, onProgress, fileIndex, variant.files.length, totalCompleted, signal);
  let { bytes: downloaded, hasher, nextIndex } = resume;
  let parts = resume.parts;

  if (downloaded === file.size) {
    const digest = bytesToHex(hasher.digest());
    if (file.sha256 && digest !== file.sha256) {
      await clearParts(cache, url);
      throw new FormFlowError('MODEL_HASH_MISMATCH', `Integrity check failed for ${file.path}.`);
    }
    await finalizeParts(cache, url, file.size, parts);
    return { sha256: digest, size: downloaded, totalBytes: totalCompleted + downloaded };
  }

  const headers: Record<string, string> = {};
  if (downloaded > 0) headers.Range = `bytes=${downloaded}-`;

  let response: Response;
  try {
    response = await fetch(url, { signal, redirect: 'follow', credentials: 'omit', headers });
  } catch (error) {
    if (signal.aborted) {
      await clearParts(cache, url);
      throw new FormFlowError('MODEL_CANCELLED', 'Model download was cancelled.');
    }
    throw new FormFlowError(
      'MODEL_DOWNLOAD_FAILED',
      `Model download was interrupted for ${file.path}. Retry will resume from ${downloaded} verified bytes.`,
      { cause: error },
    );
  }

  if (downloaded > 0 && response.status === 200) {
    // The server ignored the Range request. Start this file over rather than
    // concatenating a full response onto already-downloaded bytes.
    await clearParts(cache, url);
    downloaded = 0;
    nextIndex = 0;
    hasher = sha256.create();
    parts = [];
  } else if (downloaded > 0 && response.status === 416) {
    await clearParts(cache, url);
    throw new FormFlowError('MODEL_DOWNLOAD_FAILED', `The model server rejected the resume range for ${file.path}. Retry the installation.`);
  } else if (response.status === 206) {
    const contentRange = response.headers.get('content-range') ?? '';
    const match = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (!match
      || Number(match[1]) !== downloaded
      || Number(match[3]) !== file.size
      || Number(match[2]) < downloaded
      || Number(match[2]) >= file.size) {
      await clearParts(cache, url);
      throw new FormFlowError('MODEL_DOWNLOAD_FAILED', `The model server returned an invalid range response for ${file.path}.`);
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) !== file.size - downloaded) {
      await clearParts(cache, url);
      throw new FormFlowError('MODEL_DOWNLOAD_FAILED', `The model server returned an unexpected range length for ${file.path}.`);
    }
  }

  if (!response.ok) {
    throw new FormFlowError('MODEL_DOWNLOAD_FAILED', `Model download failed (HTTP ${response.status}) for ${file.path}.`);
  }

  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let nextPartIndex = nextIndex;
  const flush = async (): Promise<void> => {
    if (pendingBytes === 0) return;
    const combined = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const chunk of pending) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await cache.put(partKey(url, nextPartIndex), new Response(combined, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(pendingBytes),
      },
    }));
    nextPartIndex += 1;
    pending = [];
    pendingBytes = 0;
  };

  try {
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      if (signal.aborted) throw new FormFlowError('MODEL_CANCELLED', 'Model download was cancelled.');
      const value = new Uint8Array(buffer);
      hasher.update(value);
      downloaded += value.byteLength;
      pending.push(value);
      pendingBytes = value.byteLength;
      await flush();
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
    } else {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) throw new FormFlowError('MODEL_CANCELLED', 'Model download was cancelled.');
        if (!value) continue;
        hasher.update(value);
        downloaded += value.byteLength;
        if (downloaded > file.size) {
          await clearParts(cache, url);
          throw new FormFlowError('MODEL_DOWNLOAD_FAILED', `Downloaded ${file.path} exceeded its declared size.`);
        }
        pending.push(value);
        pendingBytes += value.byteLength;
        if (pendingBytes >= MODEL_PART_CHUNK_BYTES) await flush();
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
      await flush();
    }
  } catch (error) {
    if (signal.aborted || (error instanceof FormFlowError && error.code === 'MODEL_CANCELLED')) {
      await clearParts(cache, url);
      throw new FormFlowError('MODEL_CANCELLED', 'Model download was cancelled.');
    }
    if (error instanceof FormFlowError) throw error;
    throw new FormFlowError(
      'MODEL_DOWNLOAD_FAILED',
      `Model download was interrupted for ${file.path}. Retry will resume from ${downloaded} verified bytes.`,
      { cause: error },
    );
  }

  if (downloaded !== file.size) {
    throw new FormFlowError(
      'MODEL_DOWNLOAD_FAILED',
      `Model download is incomplete for ${file.path}. Retry will resume from ${downloaded} verified bytes.`,
    );
  }
  const digest = bytesToHex(hasher.digest());
  if (file.sha256 && digest !== file.sha256) {
    await clearParts(cache, url);
    throw new FormFlowError('MODEL_HASH_MISMATCH', `Integrity check failed for ${file.path}.`);
  }
  parts = await listParts(cache, url);
  await finalizeParts(cache, url, file.size, parts);
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
      revision: MODEL_REVISION,
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

      // transformers.js 4.3.2 reads config.json under the main revision while
      // discovering pipeline files even when a pinned revision is supplied.
      // Alias the exact verified config bytes so discovery remains local-only.
      const modelCache = await openCache();
      for (const alias of ['config.json', 'tokenizer_config.json']) {
        const cachedAlias = await modelCache.match(resolveModelUrl(alias, MODEL_REVISION));
        if (cachedAlias) await modelCache.put(resolveModelUrl(alias, 'main'), cachedAlias.clone());
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
      if (!response) {
        const missing: InstalledModelRecord = { ...record, status: 'not_installed', error: `Missing model file: ${file.path}` };
        if (!readonly) {
          const db = await getDb();
          await db.put('modelMetadata', missing);
        }
        return missing;
      }
      let verified: { sha256: string; bytes: number };
      try {
        verified = await hashResponse(response.clone(), file.size);
      } catch {
        verified = { sha256: '', bytes: 0 };
      }
      total += verified.bytes;
      files.push({ path: file.path, size: file.size, sha256: file.sha256, sha256Computed: verified.sha256 || undefined });
      if (verified.bytes !== file.size || (file.sha256 && verified.sha256 !== file.sha256)) {
        const corrupt: InstalledModelRecord = { ...record, status: 'corrupt', files, error: `Corrupt or tampered model file: ${file.path}` };
        if (!readonly) {
          const db = await getDb();
          await db.put('modelMetadata', corrupt);
        }
        return corrupt;
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
      const url = resolveModelUrl(file.path);
      await cache.delete(url);
      await clearParts(cache, url);
    }
    await cache.delete(resolveModelUrl('config.json', 'main'));
    await cache.delete(resolveModelUrl('tokenizer_config.json', 'main'));
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
