# FormFlow Model Reliability and Performance

Date: 2026-11-18  
Host: Apple Silicon, 8 GB RAM, macOS, Chrome for Testing 159.0.8154.6, Node 26.12.0.

## 1. Model identity

- Repository: `onnx-community/Qwen3-0.6B-Instruct-ONNX`
- Revision: `54250909aca286a05b9d013c8af7a21859ee6ead`
- Active variant: Q8 / INT8
- Runtime: ONNX Runtime Web, WASM backend
- Model download: 769,882,900 bytes (~734 MiB)
- License: Apache-2.0

Q4F16/WebGPU files exist in the registry but are not offered or loaded by the current build.

## 2. Integrity controls

- Every file has a pinned expected size and SHA-256 in `ai/models/model-registry.ts`.
- The installer hashes downloaded bytes before marking the model installed.
- Range resume validates `Content-Range`, restarts safely if the server ignores Range, and rejects invalid ranges.
- Complete cached files are re-hashed before reuse.
- Corrupt/missing files are marked `corrupt`/`not_installed`, never `ready`.
- Failed/cancelled installs clear incomplete chunks.
- `config.json` and `tokenizer_config.json` main-revision aliases are rebuilt from verified revision bytes. The model worker independently re-hashes them before pipeline load.
- The model worker has no vault keys, IndexedDB access, tools, or network fallback. Its only data source is the verified Cache Storage.

## 3. Live download-source verification

Checked against the real pinned Hugging Face source on 2026-11-18:

| Check | Result |
|---|---|
| `config.json` HEAD/redirect | HTTP 307 → final 200; `content-length: 1359`; `accept-ranges: bytes` |
| `config.json` full SHA-256 | `c62bd6…5529` — matches registry |
| `tokenizer_config.json` full SHA-256 | `443bfa…7fa0` — matches registry |
| `chat_template.jinja` full SHA-256 | `b692e0…a99d` — matches registry |
| Large model byte range 0–1023 | HTTP 302 → 206; `content-range: bytes 0-1023/753999618`; 1024 bytes returned |
| Invalid range | HTTP 416 with `content-range: bytes */1359` |
| Full 734 MiB live download | **NOT RUN** — avoided redundant transfer; local verified files and controlled fixture server were used |

This verifies HTTPS, redirects, content length, range support, content-range parsing, and live file hashes for small files. It does not prove every CDN edge or a full resume of the large model over a lossy network.

## 4. Installation and inference timings

Final run, normal-to-moderate host load:

| Operation | Result |
|---|---|
| Cached/verified install + SHA-256 | 15.0 s |
| Fresh install via local fixture (prior run) | ~157 s |
| Model status response | 33 ms |
| Self-test total | 8.3 s |
| Self-test load | 4.85 s |
| Self-test inference (32 tokens) | 3.42 s |
| AI-assisted resume extraction | 29.5 s |
| Extraction output | 13 candidates; 2 AI-method; 5 raw proposals, ground-filtered |

The model is unloaded after 120 s idle. Inference and self-test are serialized; a second request receives a clear busy error instead of sharing a generator.

## 5. Timeouts and contention

- Load: `MODEL_LOAD_TIMEOUT_MS = 240_000`.
- Generation floor: `MODEL_INFERENCE_TIMEOUT_MS = 300_000`.
- Per requested token: 1,500 ms.
- Cap: `MODEL_INFERENCE_TIMEOUT_MAX_MS = 600_000`.

Previously the fixed 180 s generation timeout could fire under heavy host contention even though the model was progressing. The timeout now scales with the requested output and distinguishes load from generation. Cancellation still disposes the worker.

A heavily contended prior run exceeded 180 s; the new policy is unit-tested, and the normal-load real-model run above passed. A repeat under deliberately saturated CPU was not performed.

## 6. Memory measurements

Measured as the sum of RSS for all Chrome processes belonging to the disposable profile. This is **process-sum**, not a per-renderer or per-worker heap; it includes browser UI, GPU process, renderers, service worker, and workers.

| Phase | Current / peak process-sum |
|---|---|
| Browser + extension start | ~748 MiB |
| After vault creation | ~816 MiB |
| After 4.08 MiB TXT import | ~1,060 MiB |
| Backup export peak | ~1,248 MiB |
| After three lock/unlock cycles | ~1,100 MiB |
| Model self-test phase peak | ~1,711 MiB |
| AI extraction phase peak | ~1,747 MiB |
| Overall model-run peak | ~1,747 MiB |

No OOM occurred on the 8 GB machine. The model run’s browser-process sum is not a claim about model-only memory. Long-run repeated-inference leak growth was not measured. A 4 MiB text import and 18.6 MiB backup export are not worst-case large-document measurements.

## 7. Storage

- Model weights: ~734 MiB.
- Recommended free space: roughly 2× model size + 128 MiB for chunk assembly and verification.
- The installer reserves space before starting and reports available quota.
- Temporary peak is still roughly twice the model size because Cache API finalization needs the chunked parts plus the assembled response. Reducing that would require a different storage design (e.g. OPFS) and was not attempted.
- Removing the model deletes cached files and metadata; the vault is unaffected.
- Clearing a failed/cancelled install removes partial chunks.

## 8. WebGPU / Q4F16 decision

- WebGPU detection is diagnostic only. On the test machine it reported an Apple Metal adapter.
- Inference remains on the verified Q8 WASM path.
- Q4F16 would require a separate model download, a different quantization, WebGPU-capable ONNX Runtime validation, numerical comparison, fallback handling, and device-loss tests. None of that was validated, so it was not enabled.
- With WebGPU disabled (`--disable-webgpu --disable-gpu`), model status reports `webgpu: false`, `wasm: true`, remains usable, and does not mark the model ready. This fallback audit passes.
- Continuing to use WASM is a deliberate reliability decision, not an oversight.

## 9. Known limitations (updated 2026-11-18)

1. Full live 734 MiB download/resume **was completed and verified** on 2026-11-18 — see `docs/FORMFLOW_MODEL_DOWNLOAD_VALIDATION.md`. Only one CDN edge was exercised.
2. No WebGPU/Q4F16 inference — see `docs/FORMFLOW_FINAL_ENGINEERING_REPORT.md` for the assessment.
3. No formal model-quality precision/recall corpus.
4. Per-worker heap is unavailable in Chromium extensions. Repeated-operation process-sum RSS and renderer-heap growth were measured — see `docs/FORMFLOW_MEMORY_AND_STORAGE_AUDIT.md`.
5. WASM throughput is environment-sensitive; extreme CPU contention can still hit the cap.
6. A versioned model lifecycle (manifest, staging, verification, atomic promotion, rollback, restart recovery) is implemented and unit-verified — see `docs/FORMFLOW_MODEL_UPGRADE_ARCHITECTURE.md`. With only one trusted release, no real upgrade was performed; the pinned model remains the known-good baseline.
