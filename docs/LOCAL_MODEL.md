# Local AI Model Lifecycle

FormFlow runs a compact local instruction model for grounded profile extraction and ambiguous form-field matching. Inference is local-only. There is no OpenAI, Gemini, OpenRouter, or other remote inference fallback.

## Model choice

| Property | Value |
|---|---|
| Repository | `onnx-community/Qwen3-0.6B-Instruct-ONNX` |
| Revision | `54250909aca286a05b9d013c8af7a21859ee6ead` |
| Base license | Apache-2.0 |
| Verified artifact | `onnx/model_quantized.onnx` (INT8 / Q8) |
| Artifact size | 753,999,618 bytes |
| Total downloaded files | 769,882,900 bytes (~734 MiB) |
| Runtime | ONNX Runtime Web via `@huggingface/transformers` 4.3.2 |
| Execution | WASM CPU; WebGPU is detected but the verified default is WASM |
| Context | Prompt bounded by FormFlow; model context window 4,096 tokens |

Qwen3-0.6B was selected because it is compact enough for an 8 GB unified-memory machine, supports instruction/chat templates, and has a verified INT8 ONNX artifact that runs on CPU/WASM without a GPU. The INT8 artifact is the verified default. Q4F16 is retained in the registry as a WebGPU-oriented experiment but is not auto-selected and is not exposed in the model settings UI.

Trade-offs:

- A 0.6B model can miss fields and may imitate example text. FormFlow validates every returned value against the source text and rejects ungrounded values.
- WASM inference is slower than a native runtime. FormFlow keeps prompts and output caps small, unloads the worker after 120 seconds of inactivity, and enforces bounded timeouts.
- The model is downloaded rather than bundled. This keeps the extension ZIP around 50 MB instead of adding roughly 734 MiB.
- WebGPU would improve throughput, but the verified Q8 path has not been validated on the WebGPU execution provider. The UI therefore reports WebGPU capability without claiming WebGPU inference.

## Configured files

The model registry (`ai/models/model-registry.ts`) pins file paths, sizes, and SHA-256 hashes:

```text
config.json
generation_config.json
tokenizer.json
tokenizer_config.json
added_tokens.json
special_tokens_map.json
merges.txt
vocab.json
chat_template.jinja
onnx/model_quantized.onnx
```

Downloads are requested from:

```text
https://huggingface.co/onnx-community/Qwen3-0.6B-Instruct-ONNX/resolve/<revision>/<file>
```

The manifest adds host permissions for `https://huggingface.co/*` and `https://*.hf.co/*` (the Hugging Face CDN). No other network request is made by the model feature.

## Storage

- Model bytes: extension-origin Cache Storage, cache name `formflow-model-cache-v1`.
- Model metadata: IndexedDB `modelMetadata`.
- Chat template: cached with the model files and applied to the tokenizer before generation.
- Partial downloads: bytes are stored in 8 MB Cache Storage chunks. A network interruption keeps the chunks; retry sends an HTTP `Range` request from the persisted byte offset and validates `Content-Range` before appending. A server that ignores Range restarts that file cleanly, never concatenating a full response. Cancellation and hash/size failures remove the chunks. Complete files are reused without re-downloading.
- Alias handling: Transformers.js 4.3.2 reads `config.json` and `tokenizer_config.json` under the `main` revision while discovering pipeline files even when a pinned revision is supplied. FormFlow keeps a local-only alias of those exact verified bytes under the `main` cache key. No unverified bytes are accepted, and removal deletes the alias too.
- Removal deletes all model cache entries and the metadata record. Vault documents and profile values are not affected.
- Storage status reports browser usage/quota plus the model cache size. The installer requires roughly twice the model size plus 128 MB of free space because resumable chunks are assembled into the final cache entry.

## Lifecycle

1. `MODEL_STATUS` reports `not_installed`, capability data, storage availability, and readiness.
2. `MODEL_INSTALL` checks available storage and requests persistent storage when possible.
3. Each file is fetched with an abort signal. Progress includes file path, file index, byte counts, and percent.
4. Every file is hashed while it streams and checked against the pinned SHA-256. Size and hash mismatches fail the file and remove the partial entry.
5. Installation records `downloading` → `verifying` → `installed`.
6. A model self-test loads the cached model in the offscreen model worker, runs a tiny JSON prompt, and reports load/inference latency.
7. First inference verifies cached files again unless a recent integrity check (within 10 minutes in the same service-worker lifetime) is available.
8. The worker is unloaded after 120 seconds idle.
9. `MODEL_CANCEL` aborts installation. `INFER_CANCEL` terminates the offscreen model worker, cancelling the active inference and unloading model memory.
10. `MODEL_REMOVE` unloads and deletes the model; the rest of the vault remains available.

A record is never treated as ready if the cache is missing, truncated, corrupt, or hash-mismatched. Verification persists `not_installed` or `corrupt` status.

## Runtime boundary

MV3 service workers cannot create Web Workers. FormFlow therefore uses the existing offscreen document as the worker host:

```text
background service worker
  │ validated prompt/request only
  ▼
offscreen document (no IndexedDB, no vault keys)
  │ MODEL_REQUEST / MODEL_DISPOSE
  ▼
model.worker.js
  │ dynamic import of bundled transformers.min.js
  ▼
Cache Storage (verified model) + ORT WASM
```

The offscreen document port is accepted only from the exact extension offscreen page. Model responses are parsed with the strict `shared/model-protocol.ts` validator. The parser still uses its own request-scoped workers; the model worker is separate.

## Download and inference limits

- Maximum AI context: 4,000 characters per extraction call.
- Maximum profile-extraction inspection: 120,000 characters, with overlong lines split at 2,000 characters to avoid pathological regex behaviour.
- Maximum returned tokens: 160 for document extraction, 96 for field matching, 32 for the self-test.
- Inference timeout: 180 seconds.
- Self-test timeout: 180 seconds.
- Install heartbeat keeps the MV3 worker alive during an active download.
- The model is not loaded while unavailable; deterministic extraction and the rest of the dashboard remain usable.

## Measured performance

The model E2E run (`scripts/dev/e2e-phase42-model.mjs`) used the real model files through a local fixture server and real browser inference:

| Measurement | Result |
|---|---|
| Cache seeding (test fixture) | ~2–3 s |
| Install + SHA-256 verification with cached files | 14–28 s |
| Fresh install through the real installer, real 734 MiB files | 157 s |
| Status response after install | 5–17 ms |
| Self-test load | 4.7–16.1 s |
| Self-test inference (32 tokens) | 3.4–22.5 s |
| AI-assisted resume extraction (160-token cap) | 27–67.5 s depending on host load |
| Offline inference after cache install | Passed |
| Node CPU reference (Q8, native) | 2.6 s load / 0.76 s inference |

These numbers vary with Chromium build, CPU load, and first-time WASM compilation. The 8 GB target machine completed every observed run without an out-of-memory failure.

## Failure modes

- **No storage**: install fails before download with an explicit storage requirement.
- **Network interruption**: verified chunks remain; retry resumes with a validated Range request. If the server ignores Range, that file restarts cleanly.
- **Corrupt file**: the record becomes `corrupt`; the model will not load.
- **Offscreen crash**: pending requests reject, the model worker is recreated on the next request, and the vault is unaffected.
- **Service-worker restart**: the model metadata and cache persist; the vault locks and requires unlock. The next inference creates a new offscreen worker.
- **Inference timeout or malformed output**: the request fails closed; deterministic extraction remains available and malformed AI output is discarded.
- **Insufficient memory**: the worker is terminated and the error is reported; the model can be removed.

See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).
