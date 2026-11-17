import { FIELD_BY_KEY, FIELD_CATALOG } from '@shared/field-catalog';
import type { DocumentStructure, DocumentStructureBlock } from '@shared/types';
import {
  classifyDocument,
  extractDeterministic,
  type DocumentClassification,
  type ExtractedCandidate,
} from './deterministic';
import { normalizeValue, validateValueForKey, valueAppearsInSource } from './normalize';

const MAX_AI_CONTEXT_CHARS = 4_000;
const MAX_EXTRACTION_TEXT_CHARS = 120_000;
const MAX_EXTRACTION_PAGE_CHARS = 80_000;
const MAX_EXTRACTION_LINE_CHARS = 2_000;
const MAX_AI_FACTS = 80;
const MAX_TOTAL_CANDIDATES = 120;

export interface LocalModelMessages {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LocalModelRunner {
  (messages: LocalModelMessages[], options?: { maxNewTokens?: number }): Promise<{ text: string }>;
}

export interface ExtractionInput {
  documentId: string;
  documentName: string;
  text: string;
  pageTexts: string[];
  structure?: DocumentStructure;
  category?: string;
  model?: LocalModelRunner;
  modelVersion?: string;
}

export interface ExtractionOutcome {
  classification: DocumentClassification;
  candidates: ExtractedCandidate[];
  deterministicCount: number;
  aiCount: number;
  aiUsed: boolean;
  conflicts: number;
  warnings: string[];
  modelVersion?: string;
}

interface AiFact {
  key: string;
  value: string;
  evidence?: string;
  page?: number;
  confidence?: number;
}

function selectRelevantContent(text: string, pageTexts: string[]): string {
  if (pageTexts.length === 0) return text.slice(0, MAX_AI_CONTEXT_CHARS);
  const keyword = /(?:name|email|phone|address|date of birth|degree|university|college|institution|graduation|cgpa|gpa|percentage|employer|company|job title|designation|experience|skills|certification|passport|aadhaar|aadhar|identification|registration|roll number|issue date|expiry|valid until|father|mother|nationality)/i;
  const selected: string[] = [];
  let length = 0;
  for (let index = 0; index < pageTexts.length; index += 1) {
    const page = pageTexts[index]!.trim();
    if (!page || (!keyword.test(page) && index > 1)) continue;
    const excerpt = page.slice(0, Math.max(500, Math.floor(MAX_AI_CONTEXT_CHARS / Math.max(1, Math.min(4, pageTexts.length)))));
    const marker = `[Page ${index + 1}]\n${excerpt}`;
    if (length + marker.length > MAX_AI_CONTEXT_CHARS) break;
    selected.push(marker);
    length += marker.length + 2;
  }
  if (selected.length === 0) return text.slice(0, MAX_AI_CONTEXT_CHARS);
  return selected.join('\n\n');
}

function extractJsonFacts(raw: string): unknown[] {
  const clean = raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const candidates: string[] = [clean];
  const objectStart = clean.indexOf('{');
  const arrayStart = clean.indexOf('[');
  if (objectStart >= 0 || arrayStart >= 0) {
    const start = arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart) ? arrayStart : objectStart;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < clean.length; index += 1) {
      const char = clean[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(clean.slice(start, index + 1));
          break;
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') {
        const facts = (value as { facts?: unknown }).facts;
        if (Array.isArray(facts)) return facts;
        const single = (value as { fact?: unknown }).fact;
        if (single && typeof single === 'object') return [single];
      }
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}

function pageForValue(value: string, pageTexts: string[]): number | undefined {
  const needle = value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!needle) return undefined;
  const index = pageTexts.findIndex((page) => page.toLowerCase().replace(/\s+/g, ' ').includes(needle));
  return index >= 0 ? index + 1 : undefined;
}

function blockForValue(value: string, structure: DocumentStructure | undefined): string | undefined {
  if (!structure) return undefined;
  const needle = value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!needle) return undefined;
  for (const block of structure.blocks) {
    if (!block.text || block.text.length > 20_000) continue;
    if (block.text.toLowerCase().replace(/\s+/g, ' ').includes(needle)) return block.blockId;
  }
  return undefined;
}

function aiPrompt(documentName: string, category: string | undefined, text: string, excludeKeys: Set<string>): LocalModelMessages[] {
  const keys = FIELD_CATALOG
    .filter((field) => !excludeKeys.has(field.key))
    .map((field) => field.key)
    .join(', ');
  const example = `DOCUMENT:
Name: Jane Example
Email: jane@example.invalid
City: Sampletown
Degree: Sample Degree
Marital Status: Sample Status
Employment Type: Sample Type

OUTPUT:
{"facts":[{"key":"personal.fullName","value":"Jane Example"},{"key":"contact.email","value":"jane@example.invalid"},{"key":"contact.city","value":"Sampletown"},{"key":"education.degree","value":"Sample Degree"},{"key":"personal.maritalStatus","value":"Sample Status"},{"key":"employment.employmentType","value":"Sample Type"}]}`;
  return [
    {
      role: 'system',
      content: 'Extract facts into JSON. Copy values exactly from the document. Use only allowed keys. Omit missing fields. Return only the JSON object.',
    },
    {
      role: 'user',
      content: `Allowed keys: ${keys}.\nExtract every allowed field that appears in the DOCUMENT, even if the example has fewer fields. Never copy a value from the example. Document name: ${documentName}. Document type: ${category ?? 'unknown'}.\n\n${example}\n\nDOCUMENT:\n${text}\n\nOUTPUT:`,
    },
  ];
}
function parseAiFacts(
  raw: string,
  input: ExtractionInput,
): { facts: AiFact[]; warnings: string[] } {
  const warnings: string[] = [];
  const parsed = extractJsonFacts(raw);
  const facts: AiFact[] = [];
  for (const entry of parsed.slice(0, MAX_AI_FACTS)) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    const value = typeof item.value === 'string' ? item.value.trim() : '';
    if (!fieldExists(key) || !value || value.length > 2_000) continue;
    if (!validateValueForKey(key, value).ok) {
      warnings.push(`Local model returned an invalid ${key} value and it was ignored.`);
      continue;
    }
    if (!valueAppearsInSource(value, input.text)) {
      warnings.push(`Local model returned a ${key} value that could not be grounded in the source text and it was ignored.`);
      continue;
    }
    const evidence = typeof item.evidence === 'string' && item.evidence.trim()
      ? item.evidence.trim().slice(0, 500)
      : undefined;
    if (evidence && !valueAppearsInSource(evidence, input.text)) {
      // A paraphrased evidence excerpt is not sufficient proof; keep only the grounded value.
      continue;
    }
    const page = Number.isInteger(item.page) && Number(item.page) >= 1
      ? Math.min(input.pageTexts.length || 1, Number(item.page))
      : pageForValue(value, input.pageTexts);
    const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
      ? Math.max(50, Math.min(90, Math.round(item.confidence)))
      : 78;
    facts.push({ key, value, ...(evidence ? { evidence } : {}), ...(page ? { page } : {}), confidence });
  }
  return { facts, warnings };
}

function fieldExists(key: string): boolean {
  return Boolean(FIELD_BY_KEY[key]);
}

function aiCandidates(facts: AiFact[], input: ExtractionInput): ExtractedCandidate[] {
  const candidates: ExtractedCandidate[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    const definition = FIELD_BY_KEY[fact.key];
    if (!definition) continue;
    const normalizedValue = normalizeValue(fact.key, fact.value);
    const dedupeKey = `${fact.key}:${normalizedValue}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    candidates.push({
      key: fact.key,
      label: definition.label,
      value: fact.value,
      normalizedValue,
      category: definition.category,
      ...(fact.page ? { page: fact.page } : {}),
      confidence: Math.min(88, fact.confidence ?? 78),
      method: 'ai',
      sensitive: Boolean(definition.sensitive),
      needsReview: true,
      reason: `Local model extracted ${definition.label.toLowerCase()} from the document text.`,
      ...(fact.evidence ? { supportingText: fact.evidence } : {}),
      ...(input.modelVersion ? { modelVersion: input.modelVersion } : {}),
      ...(blockForValue(fact.value, input.structure) ? { sourceBlockId: blockForValue(fact.value, input.structure) } : {}),
    });
  }
  return candidates;
}

export async function extractInformation(input: ExtractionInput): Promise<ExtractionOutcome> {
  const warnings: string[] = [];
  const boundForExtraction = (value: string, limit: number): string => value
    .slice(0, limit)
    .split('\n')
    .map((line) => {
      if (line.length <= MAX_EXTRACTION_LINE_CHARS) return line;
      const chunks: string[] = [];
      for (let index = 0; index < line.length; index += MAX_EXTRACTION_LINE_CHARS) {
        chunks.push(line.slice(index, index + MAX_EXTRACTION_LINE_CHARS));
      }
      return chunks.join('\n');
    })
    .join('\n');
  const boundedText = boundForExtraction(input.text, MAX_EXTRACTION_TEXT_CHARS);
  const boundedPages = input.pageTexts.map((page) => boundForExtraction(page, MAX_EXTRACTION_PAGE_CHARS));
  if (boundedText.length < input.text.length) {
    warnings.push(`Profile extraction inspected the first ${MAX_EXTRACTION_TEXT_CHARS.toLocaleString()} characters of this large document. The full encrypted text remains stored.`);
  }
  const classification = classifyDocument(boundedText, input.documentName);
  const deterministic = extractDeterministic(boundedText, boundedPages, classification, input.documentName);
  let aiUsed = false;
  let aiFacts: AiFact[] = [];
  if (input.model && boundedText.trim()) {
    try {
      const excerpt = selectRelevantContent(boundedText, boundedPages);
      const deterministicKeys = new Set(deterministic.map((candidate) => candidate.key));
      const result = await input.model(
        aiPrompt(input.documentName, input.category ?? classification.documentType, excerpt, deterministicKeys),
        { maxNewTokens: 160 },
      );
      const parsed = parseAiFacts(result.text, { ...input, text: boundedText, pageTexts: boundedPages });
      aiFacts = parsed.facts;
      warnings.push(...parsed.warnings);
      if (aiFacts.length === 0 && result.text.trim()) {
        warnings.push('Local AI output did not contain valid grounded facts and was ignored.');
      }
      aiUsed = true;
    } catch (error) {
      warnings.push(error instanceof Error
        ? `Local AI extraction was unavailable: ${error.message.slice(0, 300)}`
        : 'Local AI extraction was unavailable.');
    }
  }

  const merged = new Map<string, ExtractedCandidate>();
  for (const candidate of deterministic) merged.set(candidate.key, candidate);
  const aiCandidatesList = aiCandidates(aiFacts, { ...input, text: boundedText, pageTexts: boundedPages });
  for (const candidate of aiCandidatesList) {
    const existing = merged.get(candidate.key);
    if (!existing) {
      merged.set(candidate.key, candidate);
      continue;
    }
    if (normalizeValue(existing.key, existing.value) === normalizeValue(candidate.key, candidate.value)) {
      existing.confidence = Math.min(99, Math.max(existing.confidence, candidate.confidence + 8));
      existing.needsReview = false;
      existing.reason = `${existing.reason} Corroborated by local AI extraction.`;
      if (!existing.supportingText && candidate.supportingText) existing.supportingText = candidate.supportingText;
      if (!existing.modelVersion && candidate.modelVersion) existing.modelVersion = candidate.modelVersion;
      continue;
    }
    warnings.push(`Local AI proposed a different ${existing.label.toLowerCase()}; deterministic rules kept the grounded value.`);
  }

  for (const candidate of merged.values()) {
    if (!candidate.sourceBlockId) {
      const blockId = blockForValue(candidate.value, input.structure);
      if (blockId) candidate.sourceBlockId = blockId;
    }
    if (!candidate.supportingText) {
      const needle = candidate.value.toLowerCase().replace(/\s+/g, ' ').trim();
      const line = boundedText
        .split(/\n+/)
        .map((entry) => entry.trim())
        .find((entry) => entry.length <= 500 && entry.toLowerCase().replace(/\s+/g, ' ').includes(needle));
      if (line) candidate.supportingText = line.slice(0, 500);
    }
  }
  const candidates = [...merged.values()].slice(0, MAX_TOTAL_CANDIDATES);
  return {
    classification,
    candidates,
    deterministicCount: deterministic.length,
    // Count AI-method values that survived deterministic precedence, not raw
    // proposals that merely corroborated an existing deterministic value.
    aiCount: candidates.filter((candidate) => candidate.method === 'ai').length,
    aiUsed,
    conflicts: 0,
    warnings,
    ...(input.modelVersion ? { modelVersion: input.modelVersion } : {}),
  };
}

export function candidateSource(candidate: ExtractedCandidate, documentId: string, documentName: string) {
  return {
    documentId,
    documentName,
    ...(candidate.page ? { page: candidate.page } : {}),
    ...(candidate.supportingText ? { evidence: candidate.supportingText } : {}),
    ...(candidate.sourceBlockId ? { blockId: candidate.sourceBlockId } : {}),
    ...(candidate.modelVersion ? { modelVersion: candidate.modelVersion } : {}),
  };
}

export type { ExtractedCandidate };
export type { DocumentStructureBlock };
