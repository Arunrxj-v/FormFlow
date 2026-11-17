import type { DocumentParseInput } from '../../../core/documents/parsers/types';
import { parseDocument } from '../../../core/documents/parsers';
import { paginateDocxWithLocalRenderer } from './docx-layout';
import {
  OFFSCREEN_PARSER_PROTOCOL_VERSION,
  parserErrorFromUnknown,
  parseOffscreenCancelRequest,
  parseOffscreenParserResult,
  parseWorkerParseRequest,
  type OffscreenErrorMessage,
  type OffscreenProgressMessage,
  type OffscreenResultMessage,
} from '../../../shared/offscreen-parser-protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;
let activeRequestId: string | null = null;
let activeController: AbortController | null = null;

/** The parser worker has no vault role and must not open extension storage. */
function denyIndexedDb(): void {
  try {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: false,
      enumerable: false,
      get() {
        throw new Error('The offscreen parser worker cannot access IndexedDB.');
      },
    });
  } catch {
    try {
      (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    } catch {
      // The worker still has no DB imports; this is a best-effort runtime guard.
    }
  }
}

function denyChildWorkerSpawn(): void {
  try {
    Object.defineProperty(globalThis, 'Worker', {
      configurable: false,
      enumerable: false,
      value: function BlockedWorker(): never {
        throw new Error('The offscreen parser worker cannot spawn child workers.');
      },
    });
  } catch {
    // No child-worker creation exists in the parser runtime.
  }
}

function post(message: OffscreenProgressMessage | OffscreenResultMessage | OffscreenErrorMessage): void {
  scope.postMessage(message);
}

function errorMessage(requestId: string, error: unknown): OffscreenErrorMessage {
  return {
    type: 'PARSE_ERROR',
    protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
    requestId,
    error: parserErrorFromUnknown(error),
  };
}

denyIndexedDb();
denyChildWorkerSpawn();

scope.onmessage = (event: MessageEvent<unknown>) => {
  const raw = event.data;
  if (!raw || typeof raw !== 'object') return;
  const candidate = raw as { type?: unknown; requestId?: unknown };
  if (candidate.type === 'CANCEL_PARSE') {
    try {
      const cancel = parseOffscreenCancelRequest(raw);
      if (activeController && activeRequestId === cancel.requestId) {
        activeController.abort();
      }
    } catch {
      // Ignore malformed cancellation; the worker has no response channel for it.
    }
    return;
  }
  if (candidate.type !== 'PARSE_DOCUMENT') return;
  if (activeRequestId) {
    const requestId = typeof candidate.requestId === 'string' && candidate.requestId.length <= 120
      ? candidate.requestId
      : 'invalid_request';
    post(errorMessage(requestId, new Error('The parser worker is already processing a document.')));
    return;
  }

  let request;
  try {
    request = parseWorkerParseRequest(raw);
  } catch (error) {
    const requestId = typeof candidate.requestId === 'string' && candidate.requestId.length <= 120
      ? candidate.requestId
      : 'invalid_request';
    post(errorMessage(requestId, error));
    return;
  }

  activeRequestId = request.requestId;
  activeController = new AbortController();
  const controller = activeController;
  const input: DocumentParseInput = {
    format: request.format,
    bytes: request.bytes,
    fileName: request.fileName,
    signal: controller.signal,
    onPage: (page, total) => {
      post({
        type: 'PARSE_PROGRESS',
        protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
        requestId: request.requestId,
        progress: Math.max(0, Math.min(100, Math.round((page / Math.max(1, total)) * 100))),
        page,
        totalPages: total,
      });
    },
  };

  void (async () => {
    try {
      const parsed = await parseDocument(input);
      if (request.format === 'docx' && parsed.structure) {
        const rendered = await paginateDocxWithLocalRenderer(request.bytes, parsed.structure, controller.signal);
        if (rendered) {
          const superseded = new Set([
            'DOCX_PAGE_COUNT_UNAVAILABLE',
            'DOCX_PAGINATION_UNAVAILABLE',
            'DOCX_EXPLICIT_BREAK_PAGINATION',
            'DOCX_RENDERER_REPORTED_BREAKS',
            'DOCX_RENDERER_DERIVED_PAGINATION',
            'DOCX_PAGINATION_MAPPING_APPROXIMATE',
            'DOCX_PAGINATION_FONT_SUBSTITUTION',
            'DOCX_RENDERER_CONTENT_WARNING',
            'DOCX_PAGINATION_RENDERER_UNAVAILABLE',
          ]);
          parsed.structure = {
            ...parsed.structure,
            pagination: rendered.pagination,
            ...(parsed.structure.docxLayout && (rendered.fonts || rendered.embeddedFonts) ? {
              docxLayout: {
                ...parsed.structure.docxLayout,
                ...(rendered.fonts ? { fonts: rendered.fonts } : {}),
                ...(rendered.embeddedFonts ? { embeddedFonts: rendered.embeddedFonts } : {}),
              },
            } : {}),
            warnings: [
              ...parsed.structure.warnings.filter((item) => !superseded.has(item.code) && !rendered.warnings.some((next) => next.code === item.code)),
              ...rendered.warnings,
            ],
          };
          parsed.warnings = parsed.structure.warnings;
        } else if (parsed.structure.pagination) {
          const fallbackWarning = {
            code: 'DOCX_PAGINATION_RENDERER_UNAVAILABLE',
            message: 'Automatic local DOCX layout did not complete. Page boundaries fall back to WordprocessingML break evidence and are not a physical page count.',
          };
          const fallbackWarnings = [...parsed.structure.warnings, fallbackWarning].slice(0, 100);
          parsed.structure = {
            ...parsed.structure,
            pagination: {
              ...parsed.structure.pagination,
              warnings: [...parsed.structure.pagination.warnings, fallbackWarning].slice(0, 100),
            },
            warnings: fallbackWarnings,
          };
          parsed.warnings = parsed.structure.warnings;
        }
      }
      const result = parseOffscreenParserResult(parsed, request.format);
      post({
        type: 'PARSE_RESULT',
        protocol: OFFSCREEN_PARSER_PROTOCOL_VERSION,
        requestId: request.requestId,
        result,
      });
    } catch (error) {
      post(errorMessage(request.requestId, error));
    } finally {
      if (activeRequestId === request.requestId) {
        activeRequestId = null;
        activeController = null;
      }
    }
  })();
};
