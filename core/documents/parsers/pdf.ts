import { EXTRACTION_VERSION, MAX_PDF_PAGES } from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type { DocumentExtractionMetadata, ExtractionWarning } from '@shared/types';
import {
  hasMeaningfulText,
  normalizeExtractedText,
  sanitizeMetadata,
  sanitizeMetadataValue,
  sanitizeWarnings,
} from '../text-utils';
import {
  throwIfAborted,
  warning,
  type DocumentParseInput,
  type DocumentParseResult,
} from './types';

type PdfModule = typeof import('pdfjs-dist');
type PdfDocument = Awaited<ReturnType<PdfModule['getDocument']>['promise']>;

const IMAGE_OPERATORS = new Set<number>();

function pdfError(error: unknown, signal?: AbortSignal): FormFlowError {
  if (signal?.aborted) return new FormFlowError('CANCELLED', 'Document processing was cancelled.', { cause: error });
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (name === 'PasswordException' || /password/i.test(detail)) {
    return new FormFlowError(
      'PASSWORD_PROTECTED',
      'This PDF is password-protected. FormFlow does not decrypt password-protected PDFs in this phase.',
      { cause: error },
    );
  }
  if (name === 'InvalidPDFException' || /invalid pdf|corrupt|malformed/i.test(detail)) {
    return new FormFlowError('CORRUPTED_DOCUMENT', 'This PDF is corrupted or malformed and could not be read.', {
      cause: error,
    });
  }
  if (name === 'AbortException') {
    return new FormFlowError('CANCELLED', 'Document processing was cancelled.', { cause: error });
  }
  return new FormFlowError('EXTRACTION_FAILED', detail || 'PDF text extraction failed.', { cause: error });
}

async function installPdfLoopbackWorker(pdfjs: PdfModule): Promise<void> {
  if (typeof self !== 'undefined' && typeof Worker === 'function') {
    const workerScope = self as unknown as {
      postMessage: (...args: unknown[]) => void;
      onmessage: ((event: MessageEvent<unknown>) => void) | null;
    };
    const previousPostMessage = workerScope.postMessage;
    const previousOnMessage = workerScope.onmessage;
    try {
      // pdf.worker.mjs auto-initializes on a dedicated worker and would post
      // PDF.js protocol messages to our parent. Suppress that handshake during
      // import; our worker's own protocol handler is restored immediately.
      try {
        Object.defineProperty(workerScope, 'postMessage', {
          configurable: true,
          writable: true,
          value: () => undefined,
        });
      } catch {
        workerScope.postMessage = () => undefined;
      }
      const worker = await import('pdfjs-dist/build/pdf.worker.mjs');
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    } finally {
      try {
        Object.defineProperty(workerScope, 'postMessage', {
          configurable: true,
          writable: true,
          value: previousPostMessage,
        });
      } catch {
        workerScope.postMessage = previousPostMessage;
      }
      workerScope.onmessage = previousOnMessage;
    }
    return;
  }
  const worker = await import('pdfjs-dist/build/pdf.worker.mjs');
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
}

async function loadPdf(bytes: ArrayBuffer): Promise<{ pdfjs: PdfModule; document: PdfDocument }> {
  const pdfjs = await import('pdfjs-dist');
  await installPdfLoopbackWorker(pdfjs);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWasm: false,
    verbosity: 0,
    stopAtErrors: false,
  });
  try {
    return { pdfjs, document: await loadingTask.promise };
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined);
    throw error;
  }
}

function textItemsToText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let output = '';
  for (const item of items) {
    const value = typeof item.str === 'string' ? item.str : '';
    if (value) {
      if (output && !/\s$/.test(output) && !/^\s/.test(value)) output += ' ';
      output += value;
    }
    if (item.hasEOL) output += '\n';
  }
  return normalizeExtractedText(output);
}

function metadataFromPdf(info: Record<string, unknown>, xmp: Record<string, unknown>): DocumentExtractionMetadata {
  const read = (key: string): string | undefined => sanitizeMetadataValue(info[key], 1000);
  const xmpValue = (key: string): string | undefined => sanitizeMetadataValue(xmp[key], 1000);
  return sanitizeMetadata({
    title: xmpValue('dc:title') ?? read('Title'),
    author: xmpValue('dc:creator') ?? read('Author'),
    subject: xmpValue('dc:description') ?? read('Subject'),
    keywords: xmpValue('pdf:Keywords') ?? read('Keywords'),
    creator: read('Creator'),
    producer: read('Producer'),
    creationDate: read('CreationDate'),
    modDate: read('ModDate'),
  });
}

export async function parsePdf(input: DocumentParseInput): Promise<DocumentParseResult> {
  throwIfAborted(input.signal);
  let loaded: { pdfjs: PdfModule; document: PdfDocument } | null = null;
  try {
    loaded = await loadPdf(input.bytes);
    await initializePdfOperators();
    const { document } = loaded;
    if (document.numPages > MAX_PDF_PAGES) {
      throw new FormFlowError(
        'EXTRACTION_TOO_LARGE',
        `This PDF has ${document.numPages} pages; the local limit is ${MAX_PDF_PAGES}.`,
      );
    }
    if (document.numPages <= 0) {
      throw new FormFlowError('EMPTY_DOCUMENT', 'This PDF contains no pages.');
    }

    const warnings: ExtractionWarning[] = [];
    const pageTexts: string[] = [];
    const pagesNeedingOcr: number[] = [];
    let textPages = 0;
    let imageOnlyPages = 0;
    let blankPages = 0;
    let pageFailures = 0;

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      throwIfAborted(input.signal);
      let pageText = '';
      try {
        const page = await document.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          const items = content.items
            .map((item) => ('str' in item ? { str: item.str, hasEOL: item.hasEOL } : null))
            .filter((item): item is { str: string; hasEOL: boolean } => item !== null);
          pageText = textItemsToText(items);

          const meaningful = hasMeaningfulText(pageText);
          if (meaningful) {
            textPages += 1;
          } else {
            // Operator-list inspection is intentionally limited to pages without
            // meaningful text so large text PDFs do not pay a render-analysis cost.
            let hasImages = false;
            try {
              const operators = await page.getOperatorList();
              hasImages = operators.fnArray.some((operator) => IMAGE_OPERATORS.has(operator));
            } catch {
              warnings.push(warning(
                'IMAGE_DETECTION_FAILED',
                'FormFlow could not inspect this page for embedded images.',
                pageNumber,
              ));
            }

            if (hasImages) {
              imageOnlyPages += 1;
              pagesNeedingOcr.push(pageNumber);
              warnings.push(warning(
                'PAGE_REQUIRES_OCR',
                'This page has little or no extractable text and appears to be scanned or image-only.',
                pageNumber,
              ));
            } else {
              blankPages += 1;
              warnings.push(warning(
                'PAGE_WITHOUT_TEXT',
                'This page contains no extractable text.',
                pageNumber,
              ));
            }
          }
          if (pageText && !meaningful) {
            warnings.push(warning(
              'LOW_TEXT_PAGE',
              'This page contains very little extractable text.',
              pageNumber,
            ));
          }
        } finally {
          page.cleanup();
        }
      } catch (error) {
        if (input.signal?.aborted) throw error;
        pageFailures += 1;
        warnings.push(warning(
          'PAGE_EXTRACTION_FAILED',
          'FormFlow could not extract text from this page.',
          pageNumber,
        ));
      }
      pageTexts.push(pageText);
      input.onPage?.(pageNumber, document.numPages);
      throwIfAborted(input.signal);
    }

    if (pageFailures === document.numPages) {
      throw new FormFlowError('CORRUPTED_DOCUMENT', 'No page in this PDF could be read.');
    }

    const text = normalizeExtractedText(pageTexts.join('\n\n'));
    if (!text && imageOnlyPages === 0 && blankPages === document.numPages) {
      throw new FormFlowError('EMPTY_DOCUMENT', 'This PDF contains no extractable text or images.');
    }
    if (!text && imageOnlyPages === 0) {
      throw new FormFlowError('EMPTY_DOCUMENT', 'This PDF contains no extractable text.');
    }

    const ocrRequired = pagesNeedingOcr.length > 0;
    if (ocrRequired) {
      warnings.push(warning(
        'OCR_REQUIRED',
        'One or more pages require OCR. FormFlow will run local OCR for these pages.',
      ));
    }
    if (textPages > 0 && imageOnlyPages > 0) {
      warnings.push(warning(
        'MIXED_TEXT_AND_IMAGE_PAGES',
        'This PDF mixes text pages with image-only pages. Local OCR is used for image-only pages.',
      ));
    }
    if (blankPages > 0 && textPages > 0) {
      warnings.push(warning('BLANK_PAGES', `${blankPages} page(s) contain no extractable text.`));
    }
    if (pageFailures > 0) {
      warnings.push(warning('PARTIAL_PDF_EXTRACTION', `${pageFailures} page(s) could not be fully parsed.`));
    }

    let metadata: DocumentExtractionMetadata = {};
    try {
      const pdfMetadata = await document.getMetadata();
      const info = (pdfMetadata.info ?? {}) as Record<string, unknown>;
      const xmpObject = pdfMetadata.metadata as { getAll?: () => Record<string, unknown> } | null;
      const xmp = xmpObject?.getAll?.() ?? {};
      metadata = metadataFromPdf(info, xmp);
    } catch {
      warnings.push(warning('METADATA_UNAVAILABLE', 'PDF metadata could not be read.'));
    }

    return {
      text,
      pageTexts,
      pageCount: document.numPages,
      method: 'pdf-text',
      version: EXTRACTION_VERSION,
      ocrRequired,
      pagesNeedingOcr,
      warnings: sanitizeWarnings(warnings),
      metadata,
    };
  } catch (error) {
    if (error instanceof FormFlowError) throw error;
    throw pdfError(error, input.signal);
  } finally {
    if (loaded) {
      await loaded.document.loadingTask.destroy().catch(() => undefined);
    }
  }
}

// Populate the operator set lazily after the PDF module is available. The
// numeric values are stable in the installed PDF.js version and are also
// checked against the exported OPS enum by the parser tests.
export async function initializePdfOperators(): Promise<void> {
  if (IMAGE_OPERATORS.size > 0) return;
  const { OPS } = await import('pdfjs-dist');
  for (const operator of [
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintImageMaskXObjectRepeat,
    OPS.paintImageXObjectRepeat,
    OPS.paintSolidColorImageMask,
  ]) {
    if (typeof operator === 'number') IMAGE_OPERATORS.add(operator);
  }
}
