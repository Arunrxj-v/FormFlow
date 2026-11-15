import { FormFlowError } from '@shared/errors';

interface OcrProgress {
  status: string;
  progress: number;
}

interface PendingJob {
  resolve: (texts: string[]) => void;
  reject: (error: unknown) => void;
  onProgress?: (progress: OcrProgress) => void;
}

class OcrClient {
  private worker: Worker | null = null;
  private jobs = new Map<string, PendingJob>();
  private activeId: string | null = null;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('../../../extension/src/workers/ocr.worker.ts', import.meta.url), {
      type: 'module',
      name: 'formflow-ocr',
    });
    this.worker.addEventListener('message', (event: MessageEvent) => {
      const message = event.data as
        | { type: 'progress'; id: string; status: string; progress: number }
        | { type: 'result'; id: string; texts: string[] }
        | { type: 'error'; id: string; error: string };
      const job = this.jobs.get(message.id);
      if (!job) return;
      if (message.type === 'progress') {
        job.onProgress?.({ status: message.status, progress: message.progress });
        return;
      }
      this.jobs.delete(message.id);
      this.activeId = null;
      if (message.type === 'result') job.resolve(message.texts);
      else job.reject(new FormFlowError('OCR_UNAVAILABLE', message.error));
    });
    this.worker.addEventListener('error', (event) => {
      const error = new FormFlowError('OCR_UNAVAILABLE', event.message || 'The local OCR worker crashed.');
      for (const job of this.jobs.values()) job.reject(error);
      this.jobs.clear();
      this.activeId = null;
      this.worker?.terminate();
      this.worker = null;
    });
    return this.worker;
  }

  async recognizeImages(
    images: Blob[],
    options: { lang: string; onProgress?: (progress: OcrProgress) => void; signal?: AbortSignal },
  ): Promise<string[]> {
    if (!images.length) return [];
    if (options.signal?.aborted) throw new FormFlowError('CANCELLED', 'OCR was cancelled.');
    const buffers = await Promise.all(images.map((image) => image.arrayBuffer()));
    const jobId = `ocr_${crypto.randomUUID()}`;
    const worker = this.ensureWorker();
    this.activeId = jobId;

    return await new Promise<string[]>((resolve, reject) => {
      this.jobs.set(jobId, { resolve, reject, onProgress: options.onProgress });
      const onAbort = () => {
        this.cancel(jobId);
        reject(new FormFlowError('CANCELLED', 'OCR was cancelled.'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      worker.postMessage({
        type: 'ocr',
        id: jobId,
        images: buffers,
        lang: options.lang,
        mimeType: images[0]?.type || 'image/png',
      });
    });
  }

  cancel(jobId?: string): void {
    if (!jobId || jobId === this.activeId) {
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
      const error = new FormFlowError('CANCELLED', 'OCR was cancelled.');
      for (const job of this.jobs.values()) job.reject(error);
      this.jobs.clear();
      this.activeId = null;
    }
  }

  dispose(): void {
    this.cancel();
  }
}

export const ocrClient = new OcrClient();
