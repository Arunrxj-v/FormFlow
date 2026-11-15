import { z } from 'zod';

export const extractedFieldSchema = z.object({
  key: z.string().min(1).max(80),
  value: z.string().min(1).max(2000),
  source_page: z.number().int().min(1).max(200).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const extractionResultSchema = z.object({
  document_type: z.enum([
    'resume',
    'degree_certificate',
    'identity_document',
    'employment_letter',
    'address_proof',
    'certificate',
    'financial_document',
    'other',
  ]),
  fields: z.array(extractedFieldSchema).max(60),
});

export const semanticMatchResultSchema = z.object({
  selected_key: z.string().min(1).max(120).nullable(),
  reason: z.string().max(300).default(''),
  confidence: z.number().min(0).max(1).default(0),
});

export const contextualAnswerSchema = z.object({
  answer: z.string().min(1).max(1200),
  used_keys: z.array(z.string()).max(20).default([]),
});

export type AiExtractionResult = z.infer<typeof extractionResultSchema>;
export type AiSemanticMatch = z.infer<typeof semanticMatchResultSchema>;
export type AiContextualAnswer = z.infer<typeof contextualAnswerSchema>;

export const backupManifestSchema = z.object({
  format: z.literal('formflow-encrypted-backup'),
  version: z.number().int(),
  createdAt: z.string(),
  kdf: z.object({
    name: z.literal('PBKDF2-SHA256'),
    iterations: z.number().int().min(100_000),
    salt: z.string(),
  }),
  cipher: z.object({
    name: z.literal('AES-GCM'),
    iv: z.string(),
  }),
  manifest: z.object({
    schemaVersion: z.number().int(),
    documentCount: z.number().int(),
    valueCount: z.number().int(),
    collectionCount: z.number().int(),
    conflictCount: z.number().int(),
    totalBytes: z.number().int(),
    incomplete: z.boolean().optional(),
  }),
  payload: z.string(),
});

export type BackupEnvelope = z.infer<typeof backupManifestSchema>;
