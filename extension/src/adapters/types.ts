import type { FieldKind } from '../lib/classifier';

export type QuestionType =
  | 'text'
  | 'paragraph'
  | 'radio'
  | 'checkbox'
  | 'dropdown'
  | 'date'
  | 'email'
  | 'number'
  | 'file'
  | 'unknown';

export interface DetectedField {
  index: number;
  label: string;
  kind: FieldKind;
  confidence: number;
  sensitive: boolean;
  tag: string;
  type: string;
  questionType: QuestionType;
  required: boolean;
  currentValue: string;
  options?: string[];
  selector: string;
  unsupported?: boolean;
  unsupportedReason?: string;
  metadata?: {
    containerSelector?: string;
    optionSelectors?: Record<string, string>;
    ariaLabel?: string;
    description?: string;
  };
}

export interface DetectedUploadField {
  index: number;
  label: string;
  name: string;
  id: string;
  accept: string;
  required: boolean;
  selector: string;
}

export interface ScanResult {
  url: string;
  title: string;
  adapter: string;
  isGoogleForms?: boolean;
  isEditor?: boolean;
  editorMessage?: string;
  fields: DetectedField[];
  uploadFields: DetectedUploadField[];
  forms: number;
  summary?: {
    total: number;
    matched: number;
    needsReview: number;
    unsupported: number;
  };
}

export interface FillRequestItem {
  index: number;
  value: string;
}

export interface FillResultItem {
  index: number;
  success: boolean;
  reason?: string;
  valueSet?: string;
}

export interface FillResult {
  filled: number;
  failed: number;
  skipped: Array<{ index: number; reason: string }>;
  details?: FillResultItem[];
}

export interface FormAdapter {
  readonly name: string;
  isApplicable(doc: Document, url: string): boolean;
  detectEditor?(doc: Document, url: string): { isEditor: boolean; message: string } | null;
  scan(doc: Document): ScanResult;
  fill(fills: FillRequestItem[], doc: Document): Promise<FillResult> | FillResult;
}

