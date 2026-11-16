import { FormFlowError } from '@shared/errors';
import { parseDocx } from './docx';
import { parsePdf } from './pdf';
import { parseTxt } from './txt';
import type { DocumentParseInput, DocumentParseResult } from './types';

export { parsePdf } from './pdf';
export { parseDocx } from './docx';
export { parseTxt } from './txt';
export type { DocumentFormat, DocumentParseInput, DocumentParseResult, DocumentParser } from './types';

/**
 * Format-specific parser entry point.
 *
 * Parsers receive document bytes only. They do not receive a vault session,
 * DEK, KEK, AAD, or any database handle, and they never perform persistence.
 */
export async function parseDocument(input: DocumentParseInput): Promise<DocumentParseResult> {
  if (input.format === 'pdf') return parsePdf(input);
  if (input.format === 'docx') return parseDocx(input);
  if (input.format === 'txt') return parseTxt(input);
  throw new FormFlowError('UNSUPPORTED_FILE', 'This document format is not supported by the local parser.');
}
