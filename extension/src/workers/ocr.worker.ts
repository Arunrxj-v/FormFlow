/// <reference lib="webworker" />

interface OcrRequest {
  type: 'ocr';
  id: string;
  images: ArrayBuffer[];
  lang: string;
  mimeType: string;
}

type WorkerMessage =
  | { type: 'progress'; id: string; status: string; progress: number }
  | { type: 'result'; id: string; texts: string[] }
  | { type: 'error'; id: string; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function assetBase(): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) return chrome.runtime.getURL('');
  return new URL('/', ctx.location.href).href;
}

async function handle(request: OcrRequest): Promise<void> {
  const { createWorker } = await import('tesseract.js');
  const base = assetBase();
  const worker = await createWorker(request.lang, 1, {
    workerPath: `${base}tesseract/worker.min.js`,
    corePath: `${base}tesseract/`,
    langPath: `${base}tessdata`,
    logger: (message: { status?: string; progress?: number }) => {
      ctx.postMessage({
        type: 'progress',
        id: request.id,
        status: message.status ?? 'recognizing text',
        progress: typeof message.progress === 'number' ? message.progress : 0,
      } satisfies WorkerMessage);
    },
    errorHandler: (error: unknown) => {
      ctx.postMessage({
        type: 'error',
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerMessage);
    },
  });

  try {
    const texts: string[] = [];
    for (const image of request.images) {
      const blob = new Blob([image], { type: request.mimeType || 'image/png' });
      const result = await worker.recognize(blob);
      texts.push(String(result.data.text ?? '').replace(/\r\n/g, '\n').trim());
    }
    ctx.postMessage({ type: 'result', id: request.id, texts } satisfies WorkerMessage);
  } finally {
    await worker.terminate();
  }
}

ctx.addEventListener('message', (event: MessageEvent<OcrRequest>) => {
  if (event.data?.type !== 'ocr') return;
  void handle(event.data).catch((error: unknown) => {
    ctx.postMessage({
      type: 'error',
      id: event.data.id,
      error: error instanceof Error ? error.message : 'OCR failed.',
    } satisfies WorkerMessage);
  });
});
