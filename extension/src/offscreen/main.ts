import { validateDocumentContentSignature } from '../../../core/documents/validation';
import { publishOffscreenDiagnostics } from './diagnostics';
import {
  OFFSCREEN_PARSER_MAX_CONCURRENT,
  OFFSCREEN_PARSER_PORT,
  OFFSCREEN_PARSER_PROTOCOL_VERSION,
  OFFSCREEN_PARSER_WORKER,
  parseOffscreenCancelRequest,
  parseOffscreenErrorMessage,
  parseOffscreenParseRequest,
  parseOffscreenProgressMessage,
  parseOffscreenResultMessage,
  parseWorkerParseRequest,
  parserErrorFromUnknown,
  type OffscreenCancelRequest,
  type OffscreenErrorMessage,
  type OffscreenParseRequest,
  type WorkerParseRequest,
} from '../../../shared/offscreen-parser-protocol';

interface ParseJob {
  requestId: string;
  format: OffscreenParseRequest['format'];
  worker: Worker;
  startedAt: number;
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
let closed = false;
let testParseDelayMs = 0;

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
  if (jobs.size > 0) return;
  idleTimer = setTimeout(() => {
    if (jobs.size === 0) shutdown();
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
      job.worker.terminate();
    } catch {
      // Already terminated.
    }
  }
  jobs.clear();
  updateActive();
  try {
    port?.disconnect();
  } catch {
    // Already disconnected.
  }
  port = null;
  window.close();
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
      worker.postMessage(workerRequest, [workerRequest.bytes]);
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
