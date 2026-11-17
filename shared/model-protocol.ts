import type { ModelRuntime } from './types';

export const MODEL_WORKER_PROTOCOL_VERSION = 1;

export interface ModelChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ModelWorkerRequest =
  | {
    protocol: typeof MODEL_WORKER_PROTOCOL_VERSION;
    type: 'load';
    requestId: string;
    variantId: 'q8' | 'q4f16';
  }
  | {
    protocol: typeof MODEL_WORKER_PROTOCOL_VERSION;
    type: 'infer';
    requestId: string;
    messages: ModelChatMessage[];
    maxNewTokens: number;
    temperature: number;
  }
  | {
    protocol: typeof MODEL_WORKER_PROTOCOL_VERSION;
    type: 'cancel';
    requestId: string;
    targetRequestId: string;
  }
  | {
    protocol: typeof MODEL_WORKER_PROTOCOL_VERSION;
    type: 'dispose';
    requestId: string;
  };

export type ModelWorkerResponse =
  | {
    protocol: typeof MODEL_WORKER_PROTOCOL_VERSION;
    type: 'load-progress';
    requestId: string;
    progress: number;
    file?: string;
  }
  | {
    protocol: typeof MODEL_WORKER_PROTOCOL_VERSION;
    type: 'loaded';
    requestId: string;
    lengthMs: number;
  }
  | {
    protocol: typeof MODEL_WORKER_PROTOCOL_VERSION;
    type: 'infer-progress';
    requestId: string;
    generatedTokens: number;
  }
  | {
    protocol: typeof MODEL_WORKER_PROTOCOL_VERSION;
    type: 'result';
    requestId: string;
    text: string;
    lengthMs: number;
  }
  | {
    protocol: typeof MODEL_WORKER_PROTOCOL_VERSION;
    type: 'error';
    requestId: string;
    code: 'MODEL_LOAD_FAILED' | 'INFERENCE_FAILED' | 'INFERENCE_TIMEOUT' | 'MODEL_CANCELLED' | 'INVALID_AI_OUTPUT';
    message: string;
  };

export interface ModelWorkerLoadedState {
  status: 'unloaded' | 'loading' | 'ready' | 'failed';
  runtime?: ModelRuntime;
  variantId?: 'q8' | 'q4f16';
  loadMs?: number;
  error?: string;
}

export function parseModelWorkerRequest(value: unknown): ModelWorkerRequest {
  if (!value || typeof value !== 'object') throw new Error('Malformed model worker request.');
  const request = value as Record<string, unknown>;
  if (request.protocol !== MODEL_WORKER_PROTOCOL_VERSION) throw new Error('Unsupported model worker protocol.');
  if (typeof request.requestId !== 'string' || request.requestId.length < 3 || request.requestId.length > 120) {
    throw new Error('Model worker requestId is invalid.');
  }
  if (request.type === 'load') {
    if (request.variantId !== 'q8' && request.variantId !== 'q4f16') throw new Error('Unknown model variant.');
    return { protocol: MODEL_WORKER_PROTOCOL_VERSION, type: 'load', requestId: request.requestId, variantId: request.variantId };
  }
  if (request.type === 'infer') {
    if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > 8) {
      throw new Error('Model messages are invalid.');
    }
    const messages: ModelChatMessage[] = request.messages.map((entry, index) => {
      if (!entry || typeof entry !== 'object') throw new Error(`Model message ${index} is invalid.`);
      const message = entry as Record<string, unknown>;
      if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') {
        throw new Error(`Model message ${index} role is invalid.`);
      }
      if (typeof message.content !== 'string' || message.content.length === 0 || message.content.length > 24_000) {
        throw new Error(`Model message ${index} content is invalid.`);
      }
      return { role: message.role, content: message.content };
    });
    const maxNewTokens = Number(request.maxNewTokens);
    if (!Number.isInteger(maxNewTokens) || maxNewTokens < 16 || maxNewTokens > 512) throw new Error('Model token limit is invalid.');
    const temperature = Number(request.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) throw new Error('Model temperature is invalid.');
    return {
      protocol: MODEL_WORKER_PROTOCOL_VERSION,
      type: 'infer',
      requestId: request.requestId,
      messages,
      maxNewTokens,
      temperature,
    };
  }
  if (request.type === 'cancel') {
    if (typeof request.targetRequestId !== 'string' || request.targetRequestId.length < 3) throw new Error('Model cancel target is invalid.');
    return {
      protocol: MODEL_WORKER_PROTOCOL_VERSION,
      type: 'cancel',
      requestId: request.requestId,
      targetRequestId: request.targetRequestId,
    };
  }
  if (request.type === 'dispose') {
    return { protocol: MODEL_WORKER_PROTOCOL_VERSION, type: 'dispose', requestId: request.requestId };
  }
  throw new Error('Unknown model worker operation.');
}

export function parseModelWorkerResponse(value: unknown): ModelWorkerResponse {
  if (!value || typeof value !== 'object') throw new Error('Malformed model worker response.');
  const response = value as Record<string, unknown>;
  if (response.protocol !== MODEL_WORKER_PROTOCOL_VERSION) throw new Error('Unsupported model worker response protocol.');
  if (typeof response.requestId !== 'string') throw new Error('Model worker response requestId is invalid.');
  if (response.type === 'load-progress') {
    return {
      protocol: MODEL_WORKER_PROTOCOL_VERSION,
      type: 'load-progress',
      requestId: response.requestId,
      progress: Number(response.progress) || 0,
      ...(typeof response.file === 'string' ? { file: response.file.slice(0, 200) } : {}),
    };
  }
  if (response.type === 'loaded') {
    return { protocol: MODEL_WORKER_PROTOCOL_VERSION, type: 'loaded', requestId: response.requestId, lengthMs: Number(response.lengthMs) || 0 };
  }
  if (response.type === 'infer-progress') {
    return {
      protocol: MODEL_WORKER_PROTOCOL_VERSION,
      type: 'infer-progress',
      requestId: response.requestId,
      generatedTokens: Math.max(0, Number(response.generatedTokens) || 0),
    };
  }
  if (response.type === 'result') {
    if (typeof response.text !== 'string' || response.text.length > 64_000) throw new Error('Model output is invalid.');
    return {
      protocol: MODEL_WORKER_PROTOCOL_VERSION,
      type: 'result',
      requestId: response.requestId,
      text: response.text,
      lengthMs: Number(response.lengthMs) || 0,
    };
  }
  if (response.type === 'error') {
    const allowed = new Set(['MODEL_LOAD_FAILED', 'INFERENCE_FAILED', 'INFERENCE_TIMEOUT', 'MODEL_CANCELLED', 'INVALID_AI_OUTPUT']);
    const code = String(response.code ?? 'INFERENCE_FAILED');
    if (!allowed.has(code)) throw new Error('Model error code is invalid.');
    return {
      protocol: MODEL_WORKER_PROTOCOL_VERSION,
      type: 'error',
      requestId: response.requestId,
      code: code as Extract<ModelWorkerResponse, { type: 'error' }>['code'],
      message: typeof response.message === 'string' ? response.message.slice(0, 1_000) : 'Model inference failed.',
    };
  }
  throw new Error('Unknown model worker response.');
}
