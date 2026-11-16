import { EXTRACTION_VERSION } from '@shared/constants';
import { FormFlowError } from '@shared/errors';
import { normalizeExtractedText } from './text-utils';
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
  };
}
