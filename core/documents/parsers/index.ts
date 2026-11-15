import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { isTextEmpty } from '../validation';

export interface ExtractedDocumentText {
  pageTexts: string[];
  text: string;
  method: 'pdf-text' | 'docx' | 'txt';
  pagesNeedingOcr: number[];
  imagesForOcr: Blob[];
}

export async function extractPdfText(
  bytes: ArrayBuffer,
  onPage?: (page: number, total: number) => void,
  renderOcrPages = true,
): Promise<ExtractedDocumentText> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const document: PDFDocumentProxy = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pageTexts: string[] = [];
  const pagesNeedingOcr: number[] = [];
  const imagesForOcr: Blob[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pageTexts.push(text);
      onPage?.(pageNumber, document.numPages);

      if (renderOcrPages && isTextEmpty(text)) {
        pagesNeedingOcr.push(pageNumber);
        imagesForOcr.push(await renderPdfPageToBlob(page));
      }
      page.cleanup();
    }
  } finally {
    await document.loadingTask.destroy();
  }

  return {
    pageTexts,
    text: pageTexts.join('\n\n'),
    method: 'pdf-text',
    pagesNeedingOcr,
    imagesForOcr,
  };
}

async function renderPdfPageToBlob(page: PDFPageProxy): Promise<Blob> {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(2400, Math.max(1, Math.floor(viewport.width)));
  canvas.height = Math.min(3200, Math.max(1, Math.floor(viewport.height)));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable for OCR rendering.');
  await page.render({ canvasContext: context, viewport, canvas }).promise;
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not render PDF page for OCR.'))), 'image/png');
  });
}

export async function extractDocxText(bytes: ArrayBuffer): Promise<ExtractedDocumentText> {
  const mammothModule = await import('mammoth/mammoth.browser.js');
  const mammoth = (mammothModule.default ?? mammothModule) as {
    extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
  };
  const result = await mammoth.extractRawText({ arrayBuffer: bytes });
  const text = result.value.replace(/\r\n/g, '\n').trim();
  return {
    pageTexts: [text],
    text,
    method: 'docx',
    pagesNeedingOcr: [],
    imagesForOcr: [],
  };
}

export function extractPlainText(bytes: ArrayBuffer): ExtractedDocumentText {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
  return {
    pageTexts: [text],
    text,
    method: 'txt',
    pagesNeedingOcr: [],
    imagesForOcr: [],
  };
}
