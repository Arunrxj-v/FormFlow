import {
  OCR_ENGINE,
  OCR_ENGINE_VERSION,
  OCR_FAILED_CONFIDENCE,
  OCR_LANGUAGE_ASSETS,
  OCR_LOW_CONFIDENCE,
  OCR_MAX_LINES_PER_PAGE,
  OCR_MAX_WORDS_PER_PAGE,
  OCR_MAX_WORDS_TOTAL,
  OCR_RENDER_DPI,
} from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type {
  ExtractionWarning,
  OcrBoundingBox,
  OcrExtractionDetails,
  OcrLine,
  OcrPageDetails,
  OcrWord,
} from '@shared/types';
import { createWorker, OEM, PSM } from 'tesseract.js';

export interface OcrPageRecognition {
  text: string;
  details: OcrPageDetails;
  confidence?: number;
  failed: boolean;
}

interface OcrLog {
  status: string;
  progress: number;
}

export interface OcrWorkerHandle {
  recognize: (
    canvas: HTMLCanvasElement,
    pageNumber: number,
    signal?: AbortSignal,
    onLog?: (log: OcrLog) => void,
  ) => Promise<OcrPageRecognition>;
  terminate: () => Promise<void>;
}

const languageCache = new Map<string, Uint8Array>();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function loadLanguage(language: string): Promise<Uint8Array> {
  const cached = languageCache.get(language);
  if (cached) return cached;
  const asset = OCR_LANGUAGE_ASSETS[language];
  if (!asset) {
    throw new FormFlowError('OCR_LANGUAGE_UNAVAILABLE', `OCR language "${language}" is not bundled with this extension.`);
  }
  let response: Response;
  try {
    response = await fetch(chrome.runtime.getURL(asset.file));
  } catch (error) {
    throw new FormFlowError('OCR_LANGUAGE_UNAVAILABLE', `The local OCR language asset for ${language} could not be loaded.`, { cause: error });
  }
  if (!response.ok) {
    throw new FormFlowError('OCR_LANGUAGE_UNAVAILABLE', `The local OCR language asset for ${language} is missing.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== asset.bytes) {
    throw new FormFlowError('OCR_INTEGRITY_FAILED', `The local OCR language asset for ${language} has an unexpected size.`);
  }
  const digest = toHex(await crypto.subtle.digest('SHA-256', bytes));
  if (digest !== asset.sha256) {
    throw new FormFlowError('OCR_INTEGRITY_FAILED', `The local OCR language asset for ${language} failed integrity verification.`);
  }
  languageCache.set(language, bytes);
  return bytes;
}

function parseBoundingBox(value: unknown): OcrBoundingBox | null {
  if (!value || typeof value !== 'object') return null;
  const bbox = value as { x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown };
  if (typeof bbox.x0 !== 'number' || typeof bbox.y0 !== 'number' || typeof bbox.x1 !== 'number' || typeof bbox.y1 !== 'number') return null;
  if (![bbox.x0, bbox.y0, bbox.x1, bbox.y1].every(Number.isFinite)) return null;
  if (bbox.x1 < bbox.x0 || bbox.y1 < bbox.y0) return null;
  return {
    x0: Math.max(0, Math.round(bbox.x0)),
    y0: Math.max(0, Math.round(bbox.y0)),
    x1: Math.max(0, Math.round(bbox.x1)),
    y1: Math.max(0, Math.round(bbox.y1)),
  };
}

function confidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function extractBlocks(
  data: { blocks?: Array<{ paragraphs?: Array<{ lines?: Array<{ text?: string; confidence?: number; bbox?: unknown; words?: Array<{ text?: string; confidence?: number; bbox?: unknown }> }> }> }> | null },
  pageNumber: number,
  language: string,
  wordBudget: { remaining: number },
): OcrPageDetails {
  const lines: OcrLine[] = [];
  const words: OcrWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        if (lines.length >= OCR_MAX_LINES_PER_PAGE) break;
        const text = typeof line.text === 'string' ? line.text.replace(/\s+/g, ' ').trim() : '';
        const bbox = parseBoundingBox(line.bbox);
        if (!text || !bbox) continue;
        const lineWords: OcrWord[] = [];
        for (const word of line.words ?? []) {
          if (words.length >= OCR_MAX_WORDS_TOTAL || wordBudget.remaining <= 0) break;
          const wordText = typeof word.text === 'string' ? word.text.trim() : '';
          const wordBox = parseBoundingBox(word.bbox);
          const wordConfidence = confidence(word.confidence);
          if (!wordText || !wordBox || wordConfidence === undefined) continue;
          const entry = { text: wordText.slice(0, 300), confidence: wordConfidence, bbox: wordBox };
          lineWords.push(entry);
          if (words.length < OCR_MAX_WORDS_PER_PAGE) words.push(entry);
          wordBudget.remaining -= 1;
        }
        const lineConfidence = confidence(line.confidence) ?? 0;
        lines.push({ text: text.slice(0, 1_000), confidence: lineConfidence, bbox, ...(lineWords.length ? { words: lineWords } : {}) });
      }
    }
  }
  return {
    page: pageNumber,
    language,
    ...(lines.length ? { lines } : {}),
    ...(words.length ? { words } : {}),
  };
}

function pageWarnings(text: string, pageConfidence: number | undefined, pageNumber: number): ExtractionWarning[] {
  const warnings: ExtractionWarning[] = [];
  if (!text.trim()) {
    warnings.push({ code: 'OCR_PAGE_EMPTY', message: 'OCR did not recognize text on this page.', page: pageNumber });
  } else if (pageConfidence !== undefined && pageConfidence < OCR_LOW_CONFIDENCE) {
    warnings.push({ code: 'OCR_LOW_CONFIDENCE', message: `OCR confidence is low (${pageConfidence}%).`, page: pageNumber });
  }
  return warnings;
}

export async function createOcrWorker(
  language: string,
  onLog?: (log: OcrLog) => void,
  signal?: AbortSignal,
): Promise<OcrWorkerHandle> {
  await loadLanguage(language);
  if (signal?.aborted) throw new FormFlowError('CANCELLED', 'OCR was cancelled.');
  let cancelled = false;
  const workerPromise = createWorker(
    language,
    OEM.LSTM_ONLY,
    {
      workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
      corePath: chrome.runtime.getURL('tesseract/tesseract-core-simd-lstm.wasm.js'),
      langPath: chrome.runtime.getURL('tessdata'),
      workerBlobURL: false,
      gzip: true,
      cacheMethod: 'none',
      logger: (message: { status?: string; progress?: number }) => {
        if (message && typeof message.status === 'string') {
          onLog?.({ status: message.status, progress: typeof message.progress === 'number' ? message.progress : 0 });
        }
      },
    },
  );
  // The language asset was SHA-256 verified above; Tesseract's worker fetches
  // the same immutable extension resource through its documented langPath.
  const onAbort = () => {
    cancelled = true;
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let worker;
  try {
    worker = await workerPromise;
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: '1',
      user_defined_dpi: String(OCR_RENDER_DPI),
    });
  } catch (error) {
    signal?.removeEventListener('abort', onAbort);
    await worker?.terminate().catch(() => undefined);
    throw new FormFlowError('OCR_ENGINE_FAILED', 'The local OCR engine could not initialize.', { cause: error });
  }
  signal?.removeEventListener('abort', onAbort);
  if (cancelled || signal?.aborted) {
    await worker.terminate().catch(() => undefined);
    throw new FormFlowError('CANCELLED', 'OCR was cancelled.');
  }
  let terminated = false;
  const wordBudget = { remaining: OCR_MAX_WORDS_TOTAL };
  return {
    async recognize(canvas, pageNumber, recognitionSignal, log) {
      if (recognitionSignal?.aborted) throw new FormFlowError('CANCELLED', 'OCR was cancelled.');
      let abortHandler: (() => void) | null = null;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        abortHandler = () => {
          void worker.terminate().catch(() => undefined);
          reject(new FormFlowError('CANCELLED', 'OCR was cancelled.'));
        };
        recognitionSignal?.addEventListener('abort', abortHandler, { once: true });
      });
      try {
        const result = await Promise.race([
          worker.recognize(canvas, { rotateAuto: true }, { text: true, blocks: true }),
          abortPromise,
        ]);
        const pageConfidence = confidence(result.data.confidence);
        const text = typeof result.data.text === 'string' ? result.data.text.replace(/\r\n?/g, '\n').replace(/\f/g, '\n').trim() : '';
        const details = extractBlocks(result.data, pageNumber, language, wordBudget);
        const warnings = pageWarnings(text, pageConfidence, pageNumber);
        details.warnings = warnings;
        if (pageConfidence !== undefined) details.confidence = pageConfidence;
        return {
          text,
          details,
          ...(pageConfidence !== undefined ? { confidence: pageConfidence } : {}),
          failed: text.length === 0 || (pageConfidence !== undefined && pageConfidence < OCR_FAILED_CONFIDENCE),
        };
      } catch (error) {
        if (recognitionSignal?.aborted) throw new FormFlowError('CANCELLED', 'OCR was cancelled.');
        if (error instanceof FormFlowError) throw error;
        throw new FormFlowError('OCR_ENGINE_FAILED', `The local OCR engine failed on page ${pageNumber}.`, { cause: error });
      } finally {
        if (abortHandler) recognitionSignal?.removeEventListener('abort', abortHandler);
      }
    },
    async terminate() {
      if (terminated) return;
      terminated = true;
      await worker.terminate().catch(() => undefined);
    },
  };
}

export function ocrDetails(
  language: string,
  pagesAttempted: number,
  pagesCompleted: number,
  pagesFailed: number,
  pages: OcrPageDetails[],
  warnings: ExtractionWarning[],
): OcrExtractionDetails {
  const confidences = pages
    .map((page) => page.confidence)
    .filter((value): value is number => typeof value === 'number' && value > 0);
  const averageConfidence = confidences.length
    ? Math.round(confidences.reduce((sum, value) => sum + value, 0) / confidences.length)
    : undefined;
  return {
    status: pagesFailed === 0 && pagesCompleted > 0 ? 'completed' : pagesCompleted > 0 ? 'partial' : 'failed',
    engine: OCR_ENGINE,
    engineVersion: OCR_ENGINE_VERSION,
    language,
    processedAt: new Date().toISOString(),
    pagesAttempted,
    pagesCompleted,
    pagesFailed,
    ...(averageConfidence !== undefined ? { averageConfidence } : {}),
    warnings,
    pages,
  };
}
