import { validateDocumentContentSignature } from '../../../core/documents/validation';
import { hasMeaningfulText, normalizeExtractedText, sanitizeWarnings } from '../../../core/documents/text-utils';
import { buildOcrPageStructure } from '../../../core/documents/ocr-structure';
import { replaceStructurePages } from '../../../core/documents/structure';
import { OCR_MAX_PAGES, OCR_PAGE_TIMEOUT_MS } from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type {
  DocumentStructureBlock,
  DocumentStructurePage,
  ExtractionWarning,
  OcrPageDetails,
} from '@shared/types';
import { createOcrWorker, ocrDetails, type OcrWorkerHandle } from './ocr';
import { openPdfRenderer, renderPdfPage, type PdfRenderSession } from './pdf-renderer';
import { publishOffscreenDiagnostics } from './diagnostics';
import {
  OFFSCREEN_MODEL_DISPOSE,
  OFFSCREEN_MODEL_RESPONSE,
  OFFSCREEN_PARSER_MAX_CONCURRENT,
  OFFSCREEN_PARSER_PORT,
  OFFSCREEN_PARSER_PROTOCOL_VERSION,
  OFFSCREEN_PARSER_WORKER,
  parseModelDisposeEnvelope,
  parseModelRequestEnvelope,
  parseOffscreenCancelRequest,
  parseOffscreenErrorMessage,
  parseOffscreenParseRequest,
  parseOffscreenProgressMessage,
  parseOffscreenParserResult,
  parseOffscreenResultMessage,
  parseWorkerParseRequest,
  parserErrorFromUnknown,
  type OffscreenParserResult,
  type OffscreenCancelRequest,
  type OffscreenErrorMessage,
  type OffscreenParseRequest,
  type WorkerParseRequest,
} from '../../../shared/offscreen-parser-protocol';
import {
  MODEL_WORKER_PROTOCOL_VERSION,
  parseModelWorkerResponse,
  type ModelWorkerResponse,
} from '../../../shared/model-protocol';

interface ParseJob {
  requestId: string;
  format: OffscreenParseRequest['format'];
  worker: Worker;
  startedAt: number;
  ocrLanguage: string;
  bytes: Uint8Array;
  nativeResult?: OffscreenParserResult;
  ocrAbort?: AbortController | null;
  ocrWorker?: OcrWorkerHandle | null;
  pdfSession?: PdfRenderSession | null;
}

interface Diagnostics {
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
  malformedRequests: number;
  malformedResponses: number;
  active: number;
  lastFormat: string | null;
  lastPageCount: number | null;
  lastRequestId: string | null;
  lastRequestKeys: string[];
  lastResultKeys: string[];
  lastErrorCode: string | null;
  ocrStarted: number;
  ocrCompleted: number;
  ocrPartial: number;
  ocrFailed: number;
  lastOcrLanguage: string | null;
  lastOcrConfidence: number | null;
  lastOcrPagesCompleted: number | null;
  lastOcrPagesFailed: number | null;
  lastOcrStage: string | null;
  memoryUsedBytes: number | null;
  peakOcrMemoryBytes: number | null;
  lastWorkerType: string | null;
  lastWorkerKeys: string[];
  lastWorkerShape: string;
  lastProtocolError: string | null;
  indexedDbBlocked: boolean;
  runtimeRpcResult: string | null;
}


const diagnostics: Diagnostics = {
  started: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  malformedRequests: 0,
  malformedResponses: 0,
  active: 0,
  lastFormat: null,
  lastPageCount: null,
  lastRequestId: null,
  lastRequestKeys: [],
  lastResultKeys: [],
  lastErrorCode: null,
  ocrStarted: 0,
  ocrCompleted: 0,
  ocrPartial: 0,
  ocrFailed: 0,
  lastOcrLanguage: null,
  lastOcrConfidence: null,
  lastOcrPagesCompleted: null,
  lastOcrPagesFailed: null,
  lastOcrStage: null,
  memoryUsedBytes: null,
  peakOcrMemoryBytes: null,
  lastWorkerType: null,
  lastWorkerKeys: [],
  lastWorkerShape: '',
  lastProtocolError: null,
  indexedDbBlocked: false,
  runtimeRpcResult: null,
};

const jobs = new Map<string, ParseJob>();
let port: chrome.runtime.Port | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let modelWorker: Worker | null = null;
let modelRequestIds = new Set<string>();
let closed = false;
let testParseDelayMs = 0;
let testOcrDelayMs = 0;
let testOcrPageTimeoutMs = OCR_PAGE_TIMEOUT_MS;

function denyIndexedDb(): void {
  try {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: false,
      enumerable: false,
      get() {
        throw new Error('The offscreen parser cannot access IndexedDB.');
      },
    });
  } catch {
    try {
      (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    } catch {
      // No DB imports exist; this is a best-effort runtime guard.
    }
  }
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function publishDiagnostics(): void {
  publishOffscreenDiagnostics(port, diagnostics);
}

function currentHeapBytes(): number | null {
  const memory = (performance as { memory?: { usedJSHeapSize?: number } }).memory;
  return typeof memory?.usedJSHeapSize === 'number' && Number.isFinite(memory.usedJSHeapSize)
    ? memory.usedJSHeapSize
    : null;
}

function updateActive(): void {
  diagnostics.active = jobs.size;
  publishDiagnostics();
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdleClose(): void {
  clearIdleTimer();
  if (jobs.size > 0 || modelWorker) return;
  idleTimer = setTimeout(() => {
    if (jobs.size === 0 && !modelWorker) shutdown();
  }, 15_000);
}

function send(message: unknown): void {
  if (!port) return;
  try {
    port.postMessage(message);
  } catch {
    shutdown();
  }
}

function errorMessage(requestId: string, code: string, message: string): OffscreenErrorMessage {
  return {
    type: 'PARSE_ERROR',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId,
    error: { code, message },
  };
}

function terminateJob(requestId: string): ParseJob | null {
  const job = jobs.get(requestId);
  if (!job) return null;
  try {
    job.ocrAbort?.abort();
  } catch {
    // Already aborted.
  }
  void job.ocrWorker?.terminate().catch(() => undefined);
  void job.pdfSession?.destroy().catch(() => undefined);
  try {
    job.worker.terminate();
  } catch {
    // Worker already gone.
  }
  jobs.delete(requestId);
  updateActive();
  if (jobs.size === 0) scheduleIdleClose();
  return job;
}

function failJob(requestId: string, code: string, message: string): void {
  if (!terminateJob(requestId)) return;
  diagnostics.failed += 1;
  diagnostics.lastErrorCode = code;
  publishDiagnostics();
  send(errorMessage(requestId, code, message));
}

function shutdown(): void {
  if (closed) return;
  closed = true;
  clearIdleTimer();
  for (const job of [...jobs.values()]) {
    try {
      job.ocrAbort?.abort();
      void job.ocrWorker?.terminate().catch(() => undefined);
      void job.pdfSession?.destroy().catch(() => undefined);
      job.worker.terminate();
    } catch {
      // Already terminated.
    }
  }
  jobs.clear();
  if (modelWorker) {
    try {
      modelWorker.terminate();
    } catch {
      // Already terminated.
    }
    modelWorker = null;
    modelRequestIds = new Set();
  }
  updateActive();
  try {
    port?.disconnect();
  } catch {
    // Already disconnected.
  }
  port = null;
  window.close();
}

function withPageTimeout<T>(promise: Promise<T>, pageNumber: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new FormFlowError('OCR_TIMEOUT', `OCR page ${pageNumber} exceeded the local processing limit.`));
    }, testOcrPageTimeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

async function runOcrForJob(job: ParseJob): Promise<void> {
  const native = job.nativeResult;
  if (!native) return;
  const requestId = job.requestId;
  const allPages = [...native.pagesNeedingOcr];
  const limitedPages = allPages.slice(0, OCR_MAX_PAGES);
  const unprocessedPages = allPages.slice(OCR_MAX_PAGES);
  const pageTexts = [...native.pageTexts];
  const failedPages = new Set<number>(allPages);
  const ocrPages: OcrPageDetails[] = [];
  const ocrWarnings: ExtractionWarning[] = [];
  const structureReplacements: Array<{ page: DocumentStructurePage; blocks: DocumentStructureBlock[] }> = [];
  const structureWarnings: ExtractionWarning[] = [];
  let completedPages = 0;
  let ocrWorker: OcrWorkerHandle | null = null;
  let pdfSession: PdfRenderSession | null = null;
  let workerBroken = false;
  const abort = new AbortController();
  job.ocrAbort = abort;
  diagnostics.ocrStarted += 1;
  diagnostics.lastOcrLanguage = job.ocrLanguage;
  diagnostics.lastOcrStage = 'starting';
  diagnostics.memoryUsedBytes = currentHeapBytes();
  diagnostics.peakOcrMemoryBytes = diagnostics.memoryUsedBytes;
  publishDiagnostics();

  const stage = (value: string) => {
    diagnostics.lastOcrStage = value;
    const heap = currentHeapBytes();
    if (heap !== null) {
      diagnostics.memoryUsedBytes = heap;
      diagnostics.peakOcrMemoryBytes = Math.max(diagnostics.peakOcrMemoryBytes ?? heap, heap);
    }
    publishDiagnostics();
  };

  const progress = (page: number, total: number, value: number) => {
    send({
      type: 'PARSE_PROGRESS',
      protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
      requestId,
      progress: Math.max(0, Math.min(100, Math.round(value))),
      ...(page > 0 && total > 0 ? { page, totalPages: total, stage: 'ocr' as const } : { stage: 'ocr' as const }),
    });
  };

  try {
    if (abort.signal.aborted) throw new FormFlowError('CANCELLED', 'OCR was cancelled.');
    progress(0, 0, 60);
    if (unprocessedPages.length > 0) {
      ocrWarnings.push({
        code: 'OCR_PAGE_LIMIT',
        message: `Only ${OCR_MAX_PAGES} pages are processed per OCR attempt; ${unprocessedPages.length} page(s) remain OCR-required.`,
      });
    }
    pdfSession = await openPdfRenderer(job.bytes);
    job.pdfSession = pdfSession;
    stage('engine_init');
    ocrWorker = await createOcrWorker(
      job.ocrLanguage,
      (log) => stage(`engine:${log.status}`),
      abort.signal,
    );
    job.ocrWorker = ocrWorker;
    stage('engine_ready');

    for (let index = 0; index < limitedPages.length; index += 1) {
      if (abort.signal.aborted) throw new FormFlowError('CANCELLED', 'OCR was cancelled.');
      if (workerBroken) break;
      const pageNumber = limitedPages[index]!;
      progress(index + 1, limitedPages.length, 60 + ((index + 1) / Math.max(1, limitedPages.length)) * 30);
      const pageAbort = new AbortController();
      const onAbort = () => pageAbort.abort();
      abort.signal.addEventListener('abort', onAbort, { once: true });
      let rendered: Awaited<ReturnType<typeof renderPdfPage>> | null = null;
      try {
        stage(`page_render:${pageNumber}`);
        rendered = await withPageTimeout(renderPdfPage(pdfSession, pageNumber, pageAbort.signal, stage), pageNumber);
        stage(`page_recognize:${pageNumber}`);
        const canvas = rendered.canvas;
        const recognizePromise = (async () => {
          if (__FORMFLOW_TEST_HOOKS__ && testOcrDelayMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, testOcrDelayMs));
          }
          return ocrWorker.recognize(canvas, pageNumber, pageAbort.signal);
        })();
        const recognized = await withPageTimeout(recognizePromise, pageNumber);
        stage(`page_complete:${pageNumber}`);
        if (recognized.failed) {
          failedPages.add(pageNumber);
          ocrPages.push(recognized.details);
          const warnings = recognized.details.warnings ?? [];
          ocrWarnings.push(...warnings);
          if (!warnings.length) {
            ocrWarnings.push({
              code: 'OCR_PAGE_FAILED',
              message: 'OCR did not produce reliable text for this page.',
              page: pageNumber,
            });
          }
        } else {
          completedPages += 1;
          failedPages.delete(pageNumber);
          const nativeText = pageTexts[pageNumber - 1] ?? '';
          const ocrText = recognized.text.trim();
          let pageTextReplaced = false;
          if (!nativeText.trim()) {
            pageTexts[pageNumber - 1] = ocrText;
            pageTextReplaced = true;
          } else if (ocrText.length > nativeText.trim().length * 1.2) {
            pageTexts[pageNumber - 1] = ocrText;
            pageTextReplaced = true;
          } else if (ocrText) {
            ocrWarnings.push({
              code: 'OCR_NATIVE_OVERLAP',
              message: 'OCR text overlapped existing native PDF text; the native text and native structure were kept to avoid duplication.',
              page: pageNumber,
            });
          }
          ocrPages.push(recognized.details);
          const warnings = recognized.details.warnings ?? [];
          ocrWarnings.push(...warnings);
          if (pageTextReplaced && native.structure && rendered) {
            const built = buildOcrPageStructure({
              pageNumber,
              details: recognized.details,
              text: recognized.text,
              renderWidth: rendered.width,
              renderHeight: rendered.height,
              pageWidthPoints: rendered.pageWidth,
              pageHeightPoints: rendered.pageHeight,
            });
            structureReplacements.push({ page: built.page, blocks: built.blocks });
            for (const item of built.warnings) {
              const duplicate = (list: ExtractionWarning[]) => list.some((entry) => (
                entry.code === item.code && entry.message === item.message && entry.page === item.page
              ));
              if (!duplicate(structureWarnings)) structureWarnings.push(item);
              if (!duplicate(ocrWarnings)) ocrWarnings.push(item);
            }
          }
        }
      } catch (error) {
        if (abort.signal.aborted || pageAbort.signal.aborted) throw new FormFlowError('CANCELLED', 'OCR was cancelled.');
        const code = error instanceof FormFlowError ? error.code : 'OCR_ENGINE_FAILED';
        if (code === 'OCR_TIMEOUT') {
          workerBroken = true;
          ocrWarnings.push({
            code: 'OCR_PAGE_TIMEOUT',
            message: 'OCR took too long on this page and was stopped.',
            page: pageNumber,
          });
          ocrPages.push({ page: pageNumber, language: job.ocrLanguage, warnings: [{ code: 'OCR_PAGE_TIMEOUT', message: 'OCR page timed out.', page: pageNumber }] });
          break;
        }
        if (code === 'OCR_ENGINE_FAILED' || code === 'OCR_LANGUAGE_UNAVAILABLE' || code === 'OCR_INTEGRITY_FAILED') {
          workerBroken = true;
          ocrWarnings.push({
            code,
            message: error instanceof Error ? error.message : 'The local OCR engine failed.',
            page: pageNumber,
          });
          ocrPages.push({ page: pageNumber, language: job.ocrLanguage, warnings: [{ code, message: 'OCR engine page failure.', page: pageNumber }] });
          break;
        }
        ocrWarnings.push({
          code: code === 'OCR_RENDER_FAILED' ? 'OCR_RENDER_FAILED' : 'OCR_PAGE_FAILED',
          message: error instanceof Error ? error.message : 'OCR page processing failed.',
          page: pageNumber,
        });
        ocrPages.push({ page: pageNumber, language: job.ocrLanguage, warnings: [{ code: 'OCR_PAGE_FAILED', message: 'OCR page processing failed.', page: pageNumber }] });
      } finally {
        abort.signal.removeEventListener('abort', onAbort);
        rendered?.cleanup();
      }
    }
  } catch (error) {
    if (abort.signal.aborted) {
      if (jobs.has(requestId)) failJob(requestId, 'CANCELLED', 'Document parsing was cancelled.');
      return;
    }
    // Initialization/render failures still preserve the original document and
    // native text; the final result reports OCR failure instead of losing it.
    const code = error instanceof FormFlowError ? error.code : 'OCR_ENGINE_FAILED';
    ocrWarnings.push({
      code,
      message: error instanceof Error ? error.message : 'The local OCR engine failed.',
    });
  } finally {
    await ocrWorker?.terminate().catch(() => undefined);
    await pdfSession?.destroy().catch(() => undefined);
    job.ocrWorker = null;
    job.pdfSession = null;
    job.ocrAbort = null;
  }

  if (!jobs.has(requestId)) return;
  const pagesNeedingOcr = [...failedPages].sort((a, b) => a - b);
  const ocrRequired = pagesNeedingOcr.length > 0;
  const ocr = ocrDetails(
    job.ocrLanguage,
    allPages.length,
    completedPages,
    pagesNeedingOcr.length,
    ocrPages,
    sanitizeWarnings(ocrWarnings),
  );
  if (ocrRequired) {
    ocrWarnings.push({
      code: completedPages > 0 ? 'OCR_PARTIAL' : 'OCR_FAILED',
      message: completedPages > 0
        ? 'OCR completed for some pages; other pages still require OCR.'
        : 'OCR did not complete for the scanned pages.',
    });
  }
  const text = normalizeExtractedText(pageTexts.join('\n\n'));
  let structure = native.structure;
  if (structure && structureReplacements.length > 0) {
    try {
      structure = replaceStructurePages(structure, structureReplacements, structureWarnings);
    } catch {
      ocrWarnings.push({
        code: 'OCR_STRUCTURE_INVALID',
        message: 'OCR layout could not be merged into the structured representation; native structure was preserved.',
      });
    }
  }
  const nativeTextPages = native.pageTexts.filter(hasMeaningfulText).length;
  const method = completedPages > 0
    ? (nativeTextPages > 0 ? 'mixed' : 'ocr')
    : 'pdf-text';
  const remainingPages = new Set(pagesNeedingOcr);
  const retainedNativeWarnings = native.warnings.filter((warning) => {
    if (warning.code === 'OCR_REQUIRED') return false;
    if (warning.code === 'PAGE_REQUIRES_OCR'
      && typeof warning.page === 'number'
      && !remainingPages.has(warning.page)) {
      return false;
    }
    return true;
  });
  const finalResult: OffscreenParserResult = {
    ...native,
    text,
    pageTexts,
    method,
    ocrRequired,
    pagesNeedingOcr,
    warnings: sanitizeWarnings([...retainedNativeWarnings, ...ocrWarnings]),
    ocr,
    ...(structure ? { structure } : {}),
  };
  let validated: OffscreenParserResult;
  try {
    validated = parseOffscreenParserResult(finalResult, 'pdf');
  } catch {
    // OCR output is untrusted. If any field fails validation, discard it but
    // still return the already-validated native extraction so the original
    // document is not lost. The failed OCR attempt remains retryable.
    diagnostics.lastProtocolError = 'OCR result failed validation.';
    const invalidOcr = ocrDetails(
      job.ocrLanguage,
      allPages.length,
      0,
      pagesNeedingOcr.length,
      [],
      [{
        code: 'OCR_RESULT_INVALID',
        message: 'OCR output could not be verified. The original document and native extracted text were preserved.',
      }],
    );
    const fallback: OffscreenParserResult = {
      ...native,
      ocrRequired: true,
      pagesNeedingOcr,
      warnings: sanitizeWarnings([...native.warnings, ...invalidOcr.warnings]),
      ocr: invalidOcr,
    };
    try {
      validated = parseOffscreenParserResult(fallback, 'pdf');
    } catch {
      failJob(requestId, 'PARSER_PROTOCOL_ERROR', 'The OCR result failed background validation.');
      return;
    }
  }
  if (validated.ocr) {
    if (validated.ocr.status === 'completed') diagnostics.ocrCompleted += 1;
    else if (validated.ocr.status === 'partial') diagnostics.ocrPartial += 1;
    else diagnostics.ocrFailed += 1;
    diagnostics.lastOcrConfidence = validated.ocr.averageConfidence ?? null;
    diagnostics.lastOcrPagesCompleted = validated.ocr.pagesCompleted;
    diagnostics.lastOcrPagesFailed = validated.ocr.pagesFailed;
  }
  diagnostics.completed += 1;
  diagnostics.lastPageCount = validated.pageCount;
  diagnostics.lastResultKeys = Object.keys(validated).sort();
  diagnostics.lastErrorCode = ocrRequired ? null : null;
  publishDiagnostics();
  send({
    type: 'PARSE_RESULT',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId,
    result: validated,
  });
  terminateJob(requestId);
}

function handleWorkerMessage(requestId: string, raw: unknown): void {
  const job = jobs.get(requestId);
  if (!job) return;
  if (!raw || typeof raw !== 'object') {
    diagnostics.malformedResponses += 1;
    failJob(requestId, 'PARSER_PROTOCOL_ERROR', 'The parser worker returned a malformed response.');
    return;
  }
  const type = (raw as { type?: unknown }).type;
  diagnostics.lastWorkerType = typeof type === 'string' ? type : null;
  diagnostics.lastWorkerKeys = Object.keys(raw as Record<string, unknown>).slice(0, 12);
  diagnostics.lastWorkerShape = Object.prototype.toString.call(raw);
  try {
    if (type === 'PARSE_PROGRESS') {
      const progress = parseOffscreenProgressMessage(raw);
      if (progress.requestId !== requestId) throw new Error('Progress requestId mismatch.');
      send(progress);
      return;
    }
    if (type === 'PARSE_RESULT') {
      const result = parseOffscreenResultMessage(raw, job.format);
      if (result.requestId !== requestId) throw new Error('Result requestId mismatch.');
      if (job.format === 'pdf' && result.result.pagesNeedingOcr.length > 0) {
        job.nativeResult = result.result;
        try {
          job.worker.terminate();
        } catch {
          // Parser worker already terminated.
        }
        void runOcrForJob(job);
        return;
      }
      diagnostics.completed += 1;
      diagnostics.lastPageCount = result.result.pageCount;
      diagnostics.lastResultKeys = Object.keys(result.result).sort();
      diagnostics.lastErrorCode = null;
      publishDiagnostics();
      send(result);
      terminateJob(requestId);
      return;
    }
    if (type === 'PARSE_ERROR') {
      const error = parseOffscreenErrorMessage(raw);
      if (error.requestId !== requestId) throw new Error('Error requestId mismatch.');
      diagnostics.failed += 1;
      diagnostics.lastErrorCode = error.error.code;
      publishDiagnostics();
      send(error);
      terminateJob(requestId);
      return;
    }
    throw new Error('Unknown parser worker response.');
  } catch (error) {
    diagnostics.malformedResponses += 1;
    diagnostics.lastProtocolError = error instanceof Error ? error.message : 'Unknown protocol error.';
    failJob(requestId, 'PARSER_PROTOCOL_ERROR', 'The parser worker returned an invalid response.');
  }
}

function startParse(request: OffscreenParseRequest): void {
  if (jobs.size >= OFFSCREEN_PARSER_MAX_CONCURRENT) {
    send(errorMessage(request.requestId, 'PARSER_BUSY', 'The local parser is at its concurrency limit. Retry the document.'));
    return;
  }
  if (jobs.has(request.requestId)) {
    send(errorMessage(request.requestId, 'PARSER_PROTOCOL_ERROR', 'This parse request is already active.'));
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(request.dataBase64);
    if (bytes.byteLength !== request.sizeBytes) throw new Error('Decoded document size mismatch.');
    validateDocumentContentSignature(bytes, request.format, request.fileName);
  } catch (error) {
    const serialized = parserErrorFromUnknown(error);
    send(errorMessage(request.requestId, serialized.code, serialized.message));
    return;
  }
  const workerRequest = {
    type: 'PARSE_DOCUMENT',
    protocol: request.protocol,
    requestId: request.requestId,
    parserVersion: request.parserVersion,
    format: request.format,
    fileName: request.fileName,
    sizeBytes: request.sizeBytes,
    ocrLanguage: request.ocrLanguage,
    bytes: (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
      ? bytes.buffer as ArrayBuffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  } satisfies WorkerParseRequest;
  try {
    parseWorkerParseRequest(workerRequest);
  } catch (error) {
    const serialized = parserErrorFromUnknown(error);
    send(errorMessage(request.requestId, serialized.code, serialized.message));
    return;
  }

  let worker: Worker;
  try {
    worker = new Worker(chrome.runtime.getURL(OFFSCREEN_PARSER_WORKER), { type: 'module' });
  } catch {
    send(errorMessage(request.requestId, 'PARSER_UNAVAILABLE', 'The isolated parser worker could not be created.'));
    return;
  }

  clearIdleTimer();
  const job: ParseJob = {
    requestId: request.requestId,
    format: request.format,
    worker,
    startedAt: Date.now(),
    ocrLanguage: request.ocrLanguage,
    bytes,
  };
  jobs.set(request.requestId, job);
  updateActive();
  diagnostics.started += 1;
  diagnostics.lastFormat = request.format;
  diagnostics.lastRequestId = request.requestId;
  diagnostics.lastRequestKeys = Object.keys(request).sort();
  publishDiagnostics();

  worker.onmessage = (event: MessageEvent<unknown>) => handleWorkerMessage(request.requestId, event.data);
  worker.onerror = () => {
    diagnostics.malformedResponses += 1;
    diagnostics.lastProtocolError = 'Parser worker crashed.';
    failJob(request.requestId, 'PARSER_UNAVAILABLE', 'The isolated parser worker crashed.');
  };
  worker.onmessageerror = () => {
    diagnostics.malformedResponses += 1;
    diagnostics.lastProtocolError = 'Parser worker returned an unreadable response.';
    failJob(request.requestId, 'PARSER_PROTOCOL_ERROR', 'The isolated parser returned an unreadable response.');
  };

  const postToWorker = () => {
    try {
      worker.postMessage(workerRequest);
    } catch {
      failJob(request.requestId, 'PARSER_UNAVAILABLE', 'The document could not be transferred to the isolated parser.');
    }
  };
  if (__FORMFLOW_TEST_HOOKS__ && testParseDelayMs > 0) {
    setTimeout(postToWorker, testParseDelayMs);
  } else {
    postToWorker();
  }
}

function cancelParse(request: OffscreenCancelRequest): void {
  if (!terminateJob(request.requestId)) {
    send(errorMessage(request.requestId, 'PARSER_PROTOCOL_ERROR', 'No matching parse request is active.'));
    return;
  }
  diagnostics.cancelled += 1;
  diagnostics.lastErrorCode = 'CANCELLED';
  publishDiagnostics();
  send(errorMessage(request.requestId, 'CANCELLED', 'Document parsing was cancelled.'));
}

function requestIdFrom(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = (raw as { requestId?: unknown }).requestId;
  return typeof value === 'string' && value.length >= 3 && value.length <= 160 ? value : null;
}

function sendModelError(requestId: string, code: 'MODEL_LOAD_FAILED' | 'INFERENCE_FAILED', message: string): void {
  const response: ModelWorkerResponse = {
    protocol: MODEL_WORKER_PROTOCOL_VERSION,
    type: 'error',
    requestId,
    code,
    message: message.slice(0, 1_000),
  };
  send({
    type: OFFSCREEN_MODEL_RESPONSE,
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId,
    response,
  });
}

function ensureModelWorker(): Worker {
  if (modelWorker) return modelWorker;
  const worker = new Worker(chrome.runtime.getURL('model.worker.js'), { type: 'module' });
  worker.onmessage = (event: MessageEvent<unknown>) => {
    let response: ModelWorkerResponse;
    try {
      response = parseModelWorkerResponse(event.data);
    } catch {
      return;
    }
    modelRequestIds.delete(response.requestId);
    send({
      type: OFFSCREEN_MODEL_RESPONSE,
      protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
      requestId: response.requestId,
      response,
    });
  };
  worker.onerror = () => {
    const pendingIds = [...modelRequestIds];
    modelRequestIds = new Set();
    try {
      worker.terminate();
    } catch {
      // Already terminated.
    }
    if (modelWorker === worker) modelWorker = null;
    for (const requestId of pendingIds) {
      sendModelError(requestId, 'MODEL_LOAD_FAILED', 'The local model worker crashed.');
    }
    scheduleIdleClose();
  };
  modelWorker = worker;
  return worker;
}

function disposeModelWorker(): void {
  if (modelWorker) {
    try {
      modelWorker.terminate();
    } catch {
      // Already terminated.
    }
  }
  modelWorker = null;
  modelRequestIds = new Set();
  scheduleIdleClose();
}

function handlePortMessage(raw: unknown): void {
  if (!raw || typeof raw !== 'object') {
    diagnostics.malformedRequests += 1;
    return;
  }
  const type = (raw as { type?: unknown }).type;
  const requestId = typeof (raw as { requestId?: unknown }).requestId === 'string'
    ? (raw as { requestId: string }).requestId
    : 'invalid_request';
  if (__FORMFLOW_TEST_HOOKS__ && type === '__TEST_SET_PARSE_DELAY') {
    const delay = Number((raw as { delayMs?: unknown }).delayMs);
    testParseDelayMs = Number.isFinite(delay) ? Math.max(0, Math.min(5_000, Math.trunc(delay))) : 0;
    return;
  }
  if (__FORMFLOW_TEST_HOOKS__ && type === '__TEST_SET_OCR_DELAY') {
    const delay = Number((raw as { delayMs?: unknown }).delayMs);
    testOcrDelayMs = Number.isFinite(delay) ? Math.max(0, Math.min(60_000, Math.trunc(delay))) : 0;
    return;
  }
  if (__FORMFLOW_TEST_HOOKS__ && type === '__TEST_SET_OCR_TIMEOUT') {
    const timeout = Number((raw as { timeoutMs?: unknown }).timeoutMs);
    testOcrPageTimeoutMs = Number.isFinite(timeout)
      ? Math.max(100, Math.min(120_000, Math.trunc(timeout)))
      : OCR_PAGE_TIMEOUT_MS;
    return;
  }
  if (__FORMFLOW_TEST_HOOKS__ && type === '__TEST_RUNTIME_RPC') {
    void chrome.runtime.sendMessage({
      protocol: 1,
      requestId: 'offscreen_runtime_probe',
      operation: 'LIST_DOCUMENTS',
      payload: {},
    }).then((response: { ok?: boolean; code?: string }) => {
      diagnostics.runtimeRpcResult = response?.code ?? (response?.ok ? 'OK' : 'NO_CODE');
      publishDiagnostics();
    }).catch(() => {
      diagnostics.runtimeRpcResult = 'MESSAGE_REJECTED';
      publishDiagnostics();
    });
    return;
  }
  if (__FORMFLOW_TEST_HOOKS__ && type === '__TEST_INJECT_WORKER') {
    const injection = raw as { requestId?: unknown; message?: unknown };
    if (typeof injection.requestId === 'string' && injection.requestId.length <= 120) {
      handleWorkerMessage(injection.requestId, injection.message);
    } else {
      diagnostics.malformedRequests += 1;
      publishDiagnostics();
    }
    return;
  }
  if (type === 'MODEL_REQUEST') {
    try {
      const envelope = parseModelRequestEnvelope(raw);
      const worker = ensureModelWorker();
      modelRequestIds.add(envelope.requestId);
      worker.postMessage(envelope.request);
    } catch (error) {
      const invalidRequestId = requestIdFrom(raw) ?? 'model_invalid';
      sendModelError(invalidRequestId, 'INFERENCE_FAILED', error instanceof Error ? error.message : 'Malformed model request.');
    }
    return;
  }
  if (type === OFFSCREEN_MODEL_DISPOSE) {
    try {
      parseModelDisposeEnvelope(raw);
      disposeModelWorker();
    } catch {
      // Invalid dispose requests are ignored.
    }
    return;
  }
  try {
    if (type === 'PARSE_DOCUMENT') {
      const request = parseOffscreenParseRequest(raw);
      startParse(request);
      return;
    }
    if (type === 'CANCEL_PARSE') {
      cancelParse(parseOffscreenCancelRequest(raw));
      return;
    }
    throw new Error('Unsupported parser operation.');
  } catch {
    diagnostics.malformedRequests += 1;
    publishDiagnostics();
    send(errorMessage(requestId, 'PARSER_PROTOCOL_ERROR', 'The parser request was rejected.'));
  }
}

denyIndexedDb();
try {
  const probe = indexedDB.open('formflow-local');
  probe.onerror = () => undefined;
  diagnostics.indexedDbBlocked = false;
} catch {
  diagnostics.indexedDbBlocked = true;
}
(globalThis as { __formflowOffscreenDiagnostics?: Diagnostics }).__formflowOffscreenDiagnostics = diagnostics;
publishDiagnostics();

try {
  port = chrome.runtime.connect({ name: OFFSCREEN_PARSER_PORT });
  port.onMessage.addListener((message: unknown) => handlePortMessage(message));
  port.onDisconnect.addListener(() => shutdown());
  scheduleIdleClose();
} catch {
  shutdown();
}
