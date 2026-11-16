export type FormFlowErrorCode =
  | 'VAULT_LOCKED'
  | 'VAULT_NOT_FOUND'
  | 'VAULT_EXISTS'
  | 'SESSION_EXPIRED'
  | 'VAULT_FORMAT_UNSUPPORTED'
  | 'INVALID_PASSWORD'
  | 'WEAK_PASSWORD'
  | 'UNSUPPORTED_FILE'
  | 'FILE_TOO_LARGE'
  | 'DUPLICATE_DOCUMENT'
  | 'EXTRACTION_FAILED'
  | 'EXTRACTION_TIMEOUT'
  | 'EXTRACTION_TOO_LARGE'
  | 'EMPTY_DOCUMENT'
  | 'CORRUPTED_DOCUMENT'
  | 'PASSWORD_PROTECTED'
  | 'INVALID_ENCODING'
  | 'PARSER_UNAVAILABLE'
  | 'PARSER_BUSY'
  | 'PARSER_PROTOCOL_ERROR'
  | 'OCR_UNAVAILABLE'
  | 'MODEL_NOT_INSTALLED'
  | 'MODEL_LOAD_FAILED'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'MODEL_CANCELLED'
  | 'MODEL_HASH_MISMATCH'
  | 'INFERENCE_TIMEOUT'
  | 'INFERENCE_FAILED'
  | 'INVALID_AI_OUTPUT'
  | 'INSUFFICIENT_STORAGE'
  | 'BACKUP_INVALID'
  | 'BACKUP_VERSION_UNSUPPORTED'
  | 'BACKUP_PASSWORD_INVALID'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CANCELLED'
  | 'UNKNOWN';

export class FormFlowError extends Error {
  readonly code: FormFlowErrorCode;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(
    code: FormFlowErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'FormFlowError';
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function isFormFlowError(error: unknown): error is FormFlowError {
  return error instanceof FormFlowError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof FormFlowError) return error.message;
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'An unexpected error occurred.';
}

export function errorCode(error: unknown): FormFlowErrorCode {
  return isFormFlowError(error) ? error.code : 'UNKNOWN';
}

export class VaultLockedError extends FormFlowError {
  constructor(message = 'The vault is locked. Unlock it to continue.') {
    super('VAULT_LOCKED', message);
    this.name = 'VaultLockedError';
  }
}

export class InvalidPasswordError extends FormFlowError {
  constructor(message = 'That vault password is incorrect.') {
    super('INVALID_PASSWORD', message);
    this.name = 'InvalidPasswordError';
  }
}
