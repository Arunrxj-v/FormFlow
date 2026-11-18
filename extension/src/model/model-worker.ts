import { MODEL_CACHE_NAME, MODEL_REPOSITORY, MODEL_REVISION } from '@shared/constants';
import { resolveModelUrl, variantById } from '../../../ai/models/model-registry';
import {
  MODEL_WORKER_PROTOCOL_VERSION,
  parseModelWorkerRequest,
  type ModelWorkerRequest,
  type ModelWorkerResponse,
} from '../../../shared/model-protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  location: Location;
}

const scope = self as unknown as WorkerScope;

let generator: any = null;
let loadedVariant: 'q8' | 'q4f16' | null = null;
let loading: Promise<void> | null = null;
let cancelled = new Set<string>();

function post(message: ModelWorkerResponse): void {
  scope.postMessage(message);
}

function fail(requestId: string, code: Extract<ModelWorkerResponse, { type: 'error' }>['code'], message: string): void {
  post({ protocol: MODEL_WORKER_PROTOCOL_VERSION, type: 'error', requestId, code, message: message.slice(0, 1_000) });
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function configureTransformers(variantId: 'q8' | 'q4f16'): Promise<any> {
  const transformersUrl = new URL('transformers.min.js', scope.location.href).href;
  const transformers = await import(transformersUrl);
  const cache = await caches.open(MODEL_CACHE_NAME);
  const variant = variantById(variantId);
  const revisionConfig = await cache.match(resolveModelUrl('config.json'));
  if (!revisionConfig) {
    const keys = await cache.keys();
    throw new Error(`Local model cache is not visible to the isolated model worker (${keys.length} cached request(s)).`);
  }
  // transformers.js 4.3.2 discovers text-generation files by reading
  // config.json without forwarding the pipeline revision. Re-hash the pinned
  // revision files here and rebuild the main-revision aliases from those bytes
  // rather than trusting an alias that may have been altered on disk.
  for (const alias of ['config.json', 'tokenizer_config.json']) {
    const expected = variant.files.find((file) => file.path === alias);
    const revisionResponse = await cache.match(resolveModelUrl(alias));
    if (!expected || !revisionResponse) {
      throw new Error(`The verified model file ${alias} is missing from the local cache.`);
    }
    const bytes = await revisionResponse.clone().arrayBuffer();
    if (bytes.byteLength !== expected.size) {
      throw new Error(`The verified model file ${alias} has an unexpected size.`);
    }
    if (expected.sha256 && await sha256Hex(bytes) !== expected.sha256) {
      throw new Error(`The verified model file ${alias} failed integrity verification.`);
    }
    const mainUrl = resolveModelUrl(alias, 'main');
    await cache.delete(mainUrl);
    await cache.put(mainUrl, new Response(bytes, {
      headers: { 'content-type': revisionResponse.headers.get('content-type') ?? 'application/json' },
    }));
  }
  transformers.env.allowRemoteModels = false;
  transformers.env.allowLocalModels = true;
  transformers.env.localModelPath = new URL('models/', scope.location.href).href;
  transformers.env.useBrowserCache = false;
  transformers.env.useFSCache = false;
  transformers.env.useCustomCache = true;
  transformers.env.customCache = cache;
  transformers.env.useWasmCache = false;
  transformers.env.backends.onnx.wasm.numThreads = 1;
  transformers.env.backends.onnx.wasm.proxy = false;
  transformers.env.backends.onnx.wasm.wasmPaths = {
    mjs: new URL('ort/ort-wasm-simd-threaded.asyncify.mjs', scope.location.href).href,
    wasm: new URL('ort/ort-wasm-simd-threaded.asyncify.wasm', scope.location.href).href,
  };
  if (transformers.env.useCustomCache !== true || transformers.env.customCache !== cache) {
    throw new Error('The isolated model worker could not attach the local model cache.');
  }
  return transformers;
}

async function loadModel(requestId: string, variantId: 'q8' | 'q4f16'): Promise<void> {
  if (loadedVariant === variantId && generator) {
    post({ protocol: MODEL_WORKER_PROTOCOL_VERSION, type: 'loaded', requestId, lengthMs: 0 });
    return;
  }
  if (loading) {
    await loading;
    if (loadedVariant === variantId && generator) {
      post({ protocol: MODEL_WORKER_PROTOCOL_VERSION, type: 'loaded', requestId, lengthMs: 0 });
      return;
    }
  }
  loading = (async () => {
    const started = performance.now();
    const variant = variantById(variantId);
    if (variant.runtime !== 'wasm') throw new Error('Only the verified WASM model artifact is supported in this build.');
    const transformers = await configureTransformers(variant.id);
    if (generator) {
      try {
        await generator.dispose();
      } catch {
        // Already disposed.
      }
      generator = null;
      loadedVariant = null;
    }
    let lastProgress = -1;
    generator = await transformers.pipeline('text-generation', MODEL_REPOSITORY, {
      dtype: variant.dtype,
      device: 'wasm',
      revision: MODEL_REVISION,
      progress_callback: (event: { status?: string; progress?: number; file?: string }) => {
        if (event.status !== 'progress' || typeof event.progress !== 'number') return;
        const rounded = Math.floor(event.progress / 5) * 5;
        if (rounded === lastProgress) return;
        lastProgress = rounded;
        post({
          protocol: MODEL_WORKER_PROTOCOL_VERSION,
          type: 'load-progress',
          requestId,
          progress: Math.max(0, Math.min(100, event.progress)),
          ...(event.file ? { file: event.file } : {}),
        });
      },
    });
    if (!generator?.tokenizer) {
      const shape = generator && typeof generator === 'object' ? Object.keys(generator).join(', ') : typeof generator;
      throw new Error(`The local model loaded without a tokenizer (${shape}).`);
    }
    const template = await caches.open(MODEL_CACHE_NAME).then((cache) => cache.match(resolveModelUrl(variant.chatTemplateFile)));
    if (template) generator.tokenizer.chat_template = await template.text();
    loadedVariant = variantId;
    post({
      protocol: MODEL_WORKER_PROTOCOL_VERSION,
      type: 'loaded',
      requestId,
      lengthMs: Math.round(performance.now() - started),
    });
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
}

async function infer(request: Extract<ModelWorkerRequest, { type: 'infer' }>): Promise<void> {
  if (!generator || loadedVariant !== 'q8') {
    fail(request.requestId, 'MODEL_LOAD_FAILED', 'The local model is not loaded.');
    return;
  }
  const started = performance.now();
  let generatedTokens = 0;
  const transformers = await configureTransformers('q8');
  const streamer = new transformers.TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: () => {
      generatedTokens += 1;
      if (cancelled.has(request.requestId)) throw new Error('MODEL_CANCELLED');
      if (generatedTokens % 4 === 0) {
        post({
          protocol: MODEL_WORKER_PROTOCOL_VERSION,
          type: 'infer-progress',
          requestId: request.requestId,
          generatedTokens,
        });
      }
    },
  });
  try {
    const output = await generator(request.messages, {
      max_new_tokens: request.maxNewTokens,
      do_sample: false,
      temperature: request.temperature,
      streamer,
      return_full_text: false,
    });
    if (cancelled.has(request.requestId)) {
      fail(request.requestId, 'MODEL_CANCELLED', 'Model inference was cancelled.');
      return;
    }
    const first = Array.isArray(output) ? output[0] : output;
    const generated = first?.generated_text;
    let text = '';
    if (Array.isArray(generated)) {
      const last = generated[generated.length - 1];
      text = typeof last === 'string' ? last : typeof last?.content === 'string' ? last.content : '';
    } else if (typeof generated === 'string') {
      text = generated;
    }
    post({
      protocol: MODEL_WORKER_PROTOCOL_VERSION,
      type: 'result',
      requestId: request.requestId,
      text,
      lengthMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Model inference failed.';
    fail(
      request.requestId,
      cancelled.has(request.requestId) || message.includes('MODEL_CANCELLED') ? 'MODEL_CANCELLED' : 'INFERENCE_FAILED',
      message,
    );
  } finally {
    cancelled.delete(request.requestId);
  }
}

scope.onmessage = (event: MessageEvent<unknown>) => {
  void (async () => {
    let request: ModelWorkerRequest;
    try {
      request = parseModelWorkerRequest(event.data);
    } catch (error) {
      post({
        protocol: MODEL_WORKER_PROTOCOL_VERSION,
        type: 'error',
        requestId: 'invalid-request',
        code: 'INFERENCE_FAILED',
        message: error instanceof Error ? error.message : 'Malformed model worker request.',
      });
      return;
    }
    try {
      if (request.type === 'load') {
        await loadModel(request.requestId, request.variantId);
        return;
      }
      if (request.type === 'infer') {
        await infer(request);
        return;
      }
      if (request.type === 'cancel') {
        cancelled.add(request.targetRequestId);
        return;
      }
      if (request.type === 'dispose') {
        if (generator) {
          try {
            await generator.dispose();
          } catch {
            // Already disposed.
          }
        }
        generator = null;
        loadedVariant = null;
        post({ protocol: MODEL_WORKER_PROTOCOL_VERSION, type: 'loaded', requestId: request.requestId, lengthMs: 0 });
      }
    } catch (error) {
      fail(request.requestId, request.type === 'load' ? 'MODEL_LOAD_FAILED' : 'INFERENCE_FAILED', error instanceof Error ? error.message : 'Model worker failed.');
    }
  })();
};
