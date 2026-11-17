import { EXTRACTION_VERSION } from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import type { DocumentStructureBlock } from '@shared/types';
import { finalizeStructure, structureBlock, structureBlockId, structurePage } from '../structure';
import { normalizeExtractedText } from '../text-utils';
import {
  throwIfAborted,
  type DocumentParseInput,
  type DocumentParseResult,
} from './types';

function detectLineEndings(value: string): 'lf' | 'crlf' | 'mixed' {
  const crlf = (value.match(/\r\n/g) ?? []).length;
  const lf = (value.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && lf > 0) return 'mixed';
  if (crlf > 0) return 'crlf';
  return 'lf';
}

export async function parseTxt(input: DocumentParseInput): Promise<DocumentParseResult> {
  throwIfAborted(input.signal);
  const bytes = new Uint8Array(input.bytes);
  const hadBom = bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch (error) {
    throw new FormFlowError('INVALID_ENCODING', 'This TXT file is not valid UTF-8 text.', { cause: error });
  }
  throwIfAborted(input.signal);
  if (decoded.charCodeAt(0) === 0xfeff) decoded = decoded.slice(1);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded)) {
    throw new FormFlowError('INVALID_ENCODING', 'This TXT file contains binary control characters.');
  }
  const lineEndings = detectLineEndings(decoded);
  const text = normalizeExtractedText(decoded);
  if (!text) {
    throw new FormFlowError('EMPTY_DOCUMENT', 'This TXT file contains no text.');
  }

  const blocks: DocumentStructureBlock[] = [];
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const blockIds: string[] = [];
  for (let index = 0; index < paragraphs.length; index += 1) {
    const blockId = structureBlockId(1, index + 1);
    blockIds.push(blockId);
    blocks.push(structureBlock({
      blockId,
      type: 'paragraph',
      text: paragraphs[index]!,
      pageNumber: 1,
      order: index,
      provenance: 'txt_native',
      sourceRef: `txt:paragraph${index + 1}`,
    }));
  }
  const structure = finalizeStructure({
    extractionVersion: EXTRACTION_VERSION,
    documentFormat: 'txt',
    pageSemantics: 'logical',
    pages: [structurePage({
      pageNumber: 1,
      pageKind: 'logical',
      pageType: text ? 'text' : 'blank',
      extractionMethod: 'txt_native',
      blockIds,
    })],
    blocks,
    warnings: [],
  });

  return {
    text,
    pageTexts: [text],
    pageCount: 1,
    method: 'txt',
    version: EXTRACTION_VERSION,
    ocrRequired: false,
    pagesNeedingOcr: [],
    warnings: [],
    metadata: {
      encoding: 'utf-8',
      bom: hadBom,
      lineEndings,
    },
    structure,
  };
}
