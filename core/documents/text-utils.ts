import { MAX_EXTRACTION_WARNINGS } from '@shared/constants';
import type { DocumentExtractionMetadata, ExtractionWarning } from '@shared/types';

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Removes unsafe control characters while retaining tabs and line breaks. */
export function stripControlCharacters(value: string): string {
  return value.replace(CONTROL_CHARACTERS, '');
}

/**
 * Normalizes extracted text without flattening paragraphs:
 * - CRLF/CR -> LF
 * - trailing spaces removed
 * - runs of more than two blank lines collapsed to one blank line
 * - leading/trailing blank lines removed
 */
export function normalizeExtractedText(value: string): string {
  return stripControlCharacters(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function hasMeaningfulText(value: string): boolean {
  return value.replace(/\s+/g, '').length >= 12;
}

export function sanitizeMetadataValue(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = stripControlCharacters(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLength);
}

export function sanitizeMetadata(input: DocumentExtractionMetadata): DocumentExtractionMetadata {
  const output: DocumentExtractionMetadata = {};
  const mappings: Array<[keyof DocumentExtractionMetadata, number]> = [
    ['title', 500],
    ['author', 300],
    ['subject', 1000],
    ['keywords', 1000],
    ['creator', 300],
    ['producer', 300],
    ['creationDate', 80],
    ['modDate', 80],
    ['encoding', 40],
  ];
  for (const [key, maxLength] of mappings) {
    const value = sanitizeMetadataValue(input[key], maxLength);
    if (value !== undefined) {
      (output as Record<string, unknown>)[key] = value;
    }
  }
  if (input.lineEndings === 'lf' || input.lineEndings === 'crlf' || input.lineEndings === 'mixed') {
    output.lineEndings = input.lineEndings;
  }
  if (typeof input.bom === 'boolean') output.bom = input.bom;
  if (typeof input.tableCount === 'number' && Number.isFinite(input.tableCount)) {
    output.tableCount = Math.max(0, Math.trunc(input.tableCount));
  }
  if (typeof input.rowCount === 'number' && Number.isFinite(input.rowCount)) {
    output.rowCount = Math.max(0, Math.trunc(input.rowCount));
  }
  if (Array.isArray(input.headings)) {
    output.headings = input.headings
      .filter((heading) => heading && Number.isFinite(heading.level) && typeof heading.text === 'string')
      .slice(0, 200)
      .map((heading) => ({
        level: Math.max(1, Math.min(9, Math.trunc(heading.level))),
        text: sanitizeMetadataValue(heading.text, 500) ?? '',
      }))
      .filter((heading) => heading.text.length > 0);
  }
  return output;
}

export function sanitizeWarnings(warnings: ExtractionWarning[]): ExtractionWarning[] {
  return warnings
    .slice(0, MAX_EXTRACTION_WARNINGS)
    .map((item) => {
      const normalized: ExtractionWarning = {
        code: sanitizeMetadataValue(item.code, 80) ?? 'EXTRACTION_WARNING',
        message: sanitizeMetadataValue(item.message, 500) ?? 'Document extraction reported a warning.',
      };
      if (typeof item.page === 'number' && Number.isFinite(item.page) && item.page > 0) {
        normalized.page = Math.trunc(item.page);
      }
      return normalized;
    });
}
