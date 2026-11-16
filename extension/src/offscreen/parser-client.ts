import { MAX_EXTRACTION_TIMEOUT_MS } from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type { DocumentParseInput, DocumentParseResult } from '../../../core/documents/parsers/types';
import {
  OFFSCREEN_PARSER_DOCUMENT,
  OFFSCREEN_PARSER_PORT,
  OFFSCREEN_PARSER_PROTOCOL_VERSION,
  OFFSCREEN_PARSER_VERSION,
  isOffscreenParserDocumentUrl,
  parseOffscreenErrorMessage,
  parseOffscreenProgressMessage,
  parseOffscreenResultMessage,
  type OffscreenParseRequest,
  type OffscreenParserFormat,
  type OffscreenParserResult,
} from '../../../shared/offscreen-parser-protocol';

const OFFSCREEN_CREATE_TIMEOUT_MS = 5_000;
const HARD_PARSE_TIMEOUT_MS = MAX_EXTRACTION_TIMEOUT_MS + 5_000;

interface PendingJob {
  requestId: string;
  format: OffscreenParserFormat;
  resolve: (result: DocumentParseResult) => void;
  reject: (error: FormFlowError) => void;
  signal?: AbortSignal;
  onPage?: (page: number, total: number) => void;
  onOcrProgress?: (page: number, total: number) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: () => void;
}

let offscreenPort: chrome.runtime.Port | null = null;
let creating: Promise<chrome.runtime.Port> | null = null;
const pendingJobs = new Map<string, PendingJob>();
let testDiagnostics: unknown = null;
const portWaiters = new Set<{
  resolve: (port: chrome.runtime.Port) => void;
  reject: (error: FormFlowError) => void;
}>();

function parserUnavailable(message = 'The isolated document parser is unavailable. The file was not imported.'): FormFlowError {
  return new FormFlowError('PARSER_UNAVAILABLE', message);
}

function protocolError(message: string): FormFlowError {
  return new FormFlowError('PARSER_PROTOCOL_ERROR', message);
}

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < view.length; index += chunk) {
    binary += String.fromCharCode(...view.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function waitForOffscreenPort(): { promise: Promise<chrome.runtime.Port>; cancel: () => void } {
  let waiter: { resolve: (port: chrome.runtime.Port) => void; reject: (error: FormFlowError) => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<chrome.runtime.Port>((resolve, reject) => {
    waiter = {
      resolve: (port) => {
        if (timer) clearTimeout(timer);
        if (waiter) portWaiters.delete(waiter);
        resolve(port);
      },
      reject: (error) => {
        if (timer) clearTimeout(timer);
        if (waiter) portWaiters.delete(waiter);
        reject(error);
      },
    };
    portWaiters.add(waiter);
    timer = setTimeout(() => {
      if (waiter) {
        portWaiters.delete(waiter);
        waiter.reject(parserUnavailable('The isolated parser did not start in time.'));
      }
    }, OFFSCREEN_CREATE_TIMEOUT_MS);
  });
  return {
    promise,
    cancel: () => {
      if (waiter) {
        portWaiters.delete(waiter);
        waiter.reject(parserUnavailable('The isolated parser could not be started.'));
      }
      if (timer) clearTimeout(timer);
    },
  };
}

function cleanupJob(job: PendingJob): void {
  if (job.timer) clearTimeout(job.timer);
  job.timer = null;
  job.signal?.removeEventListener('abort', job.onAbort);
  pendingJobs.delete(job.requestId);
}

function rejectJob(job: PendingJob, error: FormFlowError): void {
  cleanupJob(job);
  job.reject(error);
}

function sendCancel(requestId: string): void {
  if (!offscreenPort) return;
  try {
    offscreenPort.postMessage({
      type: 'CANCEL_PARSE',
      protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
      requestId,
    });
  } catch {
    // The port may already be gone; the job is rejected locally.
  }
}

function handlePortMessage(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  if (__FORMFLOW_TEST_HOOKS__ && (raw as { type?: unknown }).type === '__TEST_DIAGNOSTICS') {
    testDiagnostics = (raw as { diagnostics?: unknown }).diagnostics ?? null;
    return;
  }
  const requestId = typeof (raw as { requestId?: unknown }).requestId === 'string'
    ? (raw as { requestId: string }).requestId
    : null;
  if (!requestId) return;
  const job = pendingJobs.get(requestId);
  if (!job) return;
  const type = (raw as { type?: unknown }).type;
  try {
    if (type === 'PARSE_PROGRESS') {
      const progress = parseOffscreenProgressMessage(raw);
      if (progress.requestId !== requestId) throw protocolError('Progress request id mismatch.');
      if (progress.stage === 'ocr') {
        if (progress.page !== undefined && progress.totalPages !== undefined) {
          job.onOcrProgress?.(progress.page, progress.totalPages);
        } else {
          job.onOcrProgress?.(0, 0);
        }
      } else if (progress.page !== undefined && progress.totalPages !== undefined) {
        job.onPage?.(progress.page, progress.totalPages);
      }
      return;
    }
    if (type === 'PARSE_RESULT') {
      const message = parseOffscreenResultMessage(raw, job.format);
      if (message.requestId !== requestId) throw protocolError('Result request id mismatch.');
      const result = message.result as OffscreenParserResult;
      cleanupJob(job);
      job.resolve(result as DocumentParseResult);
      return;
    }
    if (type === 'PARSE_ERROR') {
      const message = parseOffscreenErrorMessage(raw);
      if (message.requestId !== requestId) throw protocolError('Error request id mismatch.');
      cleanupJob(job);
      job.reject(new FormFlowError(message.error.code as FormFlowError['code'], message.error.message));
      return;
    }
    throw protocolError('The isolated parser returned an unsupported response.');
  } catch (error) {
    sendCancel(requestId);
    rejectJob(job, error instanceof FormFlowError ? error : protocolError('The isolated parser returned a malformed response.'));
  }
}

function attachOffscreenPort(port: chrome.runtime.Port): void {
  if (offscreenPort === port) return;
  if (offscreenPort) {
    try {
      offscreenPort.disconnect();
    } catch {
      // Already disconnected.
    }
  }
  offscreenPort = port;
  port.onMessage.addListener((message: unknown) => handlePortMessage(message));
  port.onDisconnect.addListener(() => {
    if (offscreenPort !== port) return;
    offscreenPort = null;
    for (const job of [...pendingJobs.values()]) {
      rejectJob(job, parserUnavailable('The isolated parser document closed before returning a result.'));
    }
  });
  for (const waiter of [...portWaiters]) {
    waiter.resolve(port);
  }
}

/** Background-only: accept the exact offscreen document port and no other. */
export function acceptOffscreenParserPort(port: chrome.runtime.Port): boolean {
  if (port.sender?.id !== chrome.runtime.id) {
    port.disconnect();
    return false;
  }
  if (!isOffscreenParserDocumentUrl(port.sender?.url, chrome.runtime.id)) {
    port.disconnect();
    return false;
  }
  attachOffscreenPort(port);
  return true;
}

async function createOffscreenParser(): Promise<chrome.runtime.Port> {
  if (offscreenPort) return offscreenPort;
  if (typeof chrome.offscreen === 'undefined') {
    throw parserUnavailable('This Chrome version does not provide the Offscreen API. Chrome 109 or newer is required.');
  }
  const wait = waitForOffscreenPort();
  try {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PARSER_DOCUMENT,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Runs locally bundled PDF, DOCX, and TXT parsers in a dedicated worker outside the service worker that owns the vault key.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/single offscreen document|already exists|only one offscreen/i.test(message)) {
        await chrome.offscreen.closeDocument().catch(() => undefined);
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_PARSER_DOCUMENT,
          reasons: [chrome.offscreen.Reason.WORKERS],
          justification: 'Runs locally bundled PDF, DOCX, and TXT parsers in a dedicated worker outside the service worker that owns the vault key.',
        });
      } else {
        wait.cancel();
        throw error;
      }
    }
    return await wait.promise;
  } catch (error) {
    wait.cancel();
    if (error instanceof FormFlowError) throw error;
    throw parserUnavailable(
      error instanceof Error
        ? `The isolated parser could not be created: ${error.message}`
        : 'The isolated parser could not be created.',
    );
  }
}

/** Test-only; tree-shaken from production. */
export function injectOffscreenMessageForTests(message: unknown): boolean {
  if (!__FORMFLOW_TEST_HOOKS__ || !offscreenPort) return false;
  try {
    offscreenPort.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/** Test-only; tree-shaken from production. */
export function getPendingOffscreenJobsForTests(): string[] {
  return __FORMFLOW_TEST_HOOKS__ ? [...pendingJobs.keys()] : [];
}

/** Test-only; tree-shaken from production. */
export function getOffscreenDiagnosticsForTests(): unknown {
  return __FORMFLOW_TEST_HOOKS__ ? testDiagnostics : null;
}

/** Test-only; tree-shaken from production. */
export function injectOffscreenWorkerResponseForTests(requestId: string, message: unknown): boolean {
  if (!__FORMFLOW_TEST_HOOKS__ || !offscreenPort || !pendingJobs.has(requestId)) return false;
  try {
    offscreenPort.postMessage({ type: '__TEST_INJECT_WORKER', requestId, message });
    return true;
  } catch {
    return false;
  }
}

/** Test-only; tree-shaken from production. */
export async function closeOffscreenForTests(): Promise<void> {
  if (!__FORMFLOW_TEST_HOOKS__) return;
  await chrome.offscreen.closeDocument().catch(() => undefined);
}

async function ensureOffscreenPort(): Promise<chrome.runtime.Port> {
  if (offscreenPort) return offscreenPort;
  if (!creating) {
    creating = createOffscreenParser().finally(() => {
      creating = null;
    });
  }
  return creating;
}

/**
 * Background parser dependency. Only document bytes and non-secret protocol
 * fields cross this boundary; no DEK, KEK, AAD, vault session, or DB handle.
 */
export async function parseDocumentInOffscreen(
  input: DocumentParseInput,
  signal?: AbortSignal,
): Promise<DocumentParseResult> {
  if (signal?.aborted) throw new FormFlowError('CANCELLED', 'Document processing was cancelled.');
  const port = await ensureOffscreenPort();
  if (signal?.aborted) throw new FormFlowError('CANCELLED', 'Document processing was cancelled.');
  const requestId = `parse_${crypto.randomUUID()}`;
  const request: OffscreenParseRequest = {
    type: 'PARSE_DOCUMENT',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId,
    parserVersion: OFFSCREEN_PARSER_VERSION,
    format: input.format,
    fileName: input.fileName,
    sizeBytes: input.bytes.byteLength,
    ocrLanguage: input.ocrLanguage ?? 'eng',
    dataBase64: toBase64(input.bytes),
  };

  return await new Promise<DocumentParseResult>((resolve, reject) => {
    const job: PendingJob = {
      requestId,
      format: input.format,
      resolve,
      reject,
      signal,
      onPage: input.onPage,
      onOcrProgress: input.onOcrProgress,
      timer: null,
      onAbort: () => {
        sendCancel(requestId);
        rejectJob(job, new FormFlowError('CANCELLED', 'Document processing was cancelled.'));
      },
    };
    job.timer = setTimeout(() => {
      sendCancel(requestId);
      rejectJob(job, new FormFlowError('EXTRACTION_TIMEOUT', 'Document extraction took too long and was stopped.'));
    }, HARD_PARSE_TIMEOUT_MS);
    signal?.addEventListener('abort', job.onAbort, { once: true });
    pendingJobs.set(requestId, job);
    try {
      port.postMessage(request);
    } catch {
      rejectJob(job, parserUnavailable('The document could not be sent to the isolated parser.'));
    }
  });
}
