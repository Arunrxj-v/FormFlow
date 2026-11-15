export const PROTOCOL_VERSION = 1;

export interface ExtensionRequest<T = Record<string, unknown>> {
  protocol: typeof PROTOCOL_VERSION;
  requestId: string;
  operation: string;
  payload: T;
}

export interface ExtensionResponse<T = unknown> {
  protocol: typeof PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export function isTrustedExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  return Boolean(sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`));
}

export function parseRequest(value: unknown): ExtensionRequest {
  if (!value || typeof value !== 'object') throw new Error('Malformed extension request.');
  const request = value as Partial<ExtensionRequest>;
  if (request.protocol !== PROTOCOL_VERSION) throw new Error('Unsupported extension protocol version.');
  if (typeof request.requestId !== 'string' || request.requestId.length < 3 || request.requestId.length > 120) {
    throw new Error('Extension request is missing a valid requestId.');
  }
  if (typeof request.operation !== 'string' || !request.operation) throw new Error('Extension request is missing an operation.');
  if (request.payload !== undefined && (typeof request.payload !== 'object' || request.payload === null)) {
    throw new Error('Extension request payload must be an object.');
  }
  return { protocol: PROTOCOL_VERSION, requestId: request.requestId, operation: request.operation, payload: (request.payload ?? {}) as Record<string, unknown> };
}

export function success<T>(requestId: string, data: T): ExtensionResponse<T> {
  return { protocol: PROTOCOL_VERSION, requestId, ok: true, data };
}

export function failure(requestId: string, error: string, code = 'UNKNOWN'): ExtensionResponse {
  return { protocol: PROTOCOL_VERSION, requestId, ok: false, error, code };
}

export function requireString(payload: Record<string, unknown>, key: string, min = 1, max = 500): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new Error(`${key} must be a string between ${min} and ${max} characters.`);
  }
  return value.trim();
}

export function optionalString(payload: Record<string, unknown>, key: string, max = 2000): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new Error(`${key} must be a string.`);
  return value;
}

export function requireBoolean(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`);
  return value;
}
