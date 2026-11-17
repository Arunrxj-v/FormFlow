import { OCR_MAX_PAGE_PIXELS, OCR_MAX_RENDER_SCALE, OCR_RENDER_DPI } from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface RenderedPdfPage {
  pageNumber: number;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
  cleanup: () => void;
}

export interface PdfRenderSession {
  document: PDFDocumentProxy;
  destroy: () => Promise<void>;
}

type PdfModule = typeof import('pdfjs-dist');
let pdfModule: PdfModule | null = null;

async function loadPdfModule(): Promise<PdfModule> {
  if (pdfModule) return pdfModule;
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.mjs');
  // A Window context does not auto-initialize PDF.js's worker module. Use its
  // loopback handler so rendering stays local and requires no extra worker
  // asset or dynamic code evaluation.
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
  pdfModule = pdfjs;
  return pdfjs;
}

export async function openPdfRenderer(bytes: Uint8Array): Promise<PdfRenderSession> {
  const pdfjs = await loadPdfModule();
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWasm: false,
    verbosity: 0,
    stopAtErrors: false,
  });
  try {
    const document = await loadingTask.promise;
    return {
      document,
      destroy: async () => {
        await loadingTask.destroy().catch(() => undefined);
      },
    };
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined);
    throw new FormFlowError('OCR_RENDER_FAILED', 'The PDF page renderer could not open this document.', { cause: error });
  }
}

export async function renderPdfPage(
  session: PdfRenderSession,
  pageNumber: number,
  signal?: AbortSignal,
  onStage?: (stage: string) => void,
): Promise<RenderedPdfPage> {
  if (signal?.aborted) throw new FormFlowError('CANCELLED', 'OCR was cancelled.');
  onStage?.(`renderer_page_load:${pageNumber}`);
  let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null;
  let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null;
  let onAbort: (() => void) | null = null;
  try {
    page = await session.document.getPage(pageNumber);
    onStage?.(`renderer_viewport:${pageNumber}`);
    const base = page.getViewport({ scale: 1 });
    let scale = Math.min(OCR_MAX_RENDER_SCALE, OCR_RENDER_DPI / 72);
    const pixelsAtScale = base.width * scale * base.height * scale;
    if (pixelsAtScale > OCR_MAX_PAGE_PIXELS) {
      scale *= Math.sqrt(OCR_MAX_PAGE_PIXELS / pixelsAtScale);
    }
    scale = Math.max(0.05, Math.min(OCR_MAX_RENDER_SCALE, scale));
    if (base.width * scale * base.height * scale > OCR_MAX_PAGE_PIXELS) {
      throw new FormFlowError('OCR_RENDER_FAILED', `PDF page ${pageNumber} exceeds the local OCR rendering limit.`);
    }
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new FormFlowError('OCR_RENDER_FAILED', 'The local PDF renderer could not create a canvas context.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    onStage?.(`renderer_draw:${pageNumber}`);
    renderTask = page.render({ canvas, viewport, background: '#ffffff', intent: 'print' });
    onAbort = () => {
      try {
        renderTask?.cancel();
      } catch {
        // Render task already completed or cancelled.
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    await renderTask.promise;
    onStage?.(`renderer_done:${pageNumber}`);
    return {
      pageNumber,
      canvas,
      width: canvas.width,
      height: canvas.height,
      pageWidth: base.width,
      pageHeight: base.height,
      cleanup: () => {
        try {
          page?.cleanup();
        } catch {
          // Page already cleaned up.
        }
        canvas.width = 0;
        canvas.height = 0;
      },
    };
  } catch (error) {
    if (signal?.aborted) throw new FormFlowError('CANCELLED', 'OCR was cancelled.', { cause: error });
    if (error instanceof FormFlowError) throw error;
    throw new FormFlowError('OCR_RENDER_FAILED', `PDF page ${pageNumber} could not be rendered for OCR.`, { cause: error });
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (page && !signal?.aborted) {
      try {
        page.cleanup();
      } catch {
        // Page already cleaned up.
      }
    }
  }
}
