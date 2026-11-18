# FormFlow Full-Size Model Download Validation

Date: 2026-11-18  
Status: **FIXED AND VERIFIED** (full-size live download + interrupt + resume + independent SHA-256)

## Scope

This document records the full-size live download validation that was previously outstanding. It uses the real pinned production model distribution endpoint and an independent SHA-256 digest from the source registry. The validation harness lives at `scripts/dev/validate-model-live-download.mjs` and is run with `npm run validate:model-live-download`.

The harness is a **validation tool, not a second product downloader**. The application still uses `ai/runtime/model-loader.ts` exclusively. Bytes are streamed to a temporary file in the OS temp directory and deleted afterwards; `.model-cache/`, IndexedDB, Cache Storage and the installed extension are untouched.

## Target

| Field | Value |
|---|---|
| Repository | `onnx-community/Qwen3-0.6B-Instruct-ONNX` |
| Pinned revision | `54250909aca286a05b9d013c8af7a21859ee6ead` (immutable commit, never `main`) |
| File | `onnx/model_quantized.onnx` |
| Expected size | 753,999,618 bytes (719 MiB) |
| Trusted SHA-256 | `5f939904362dc83215b0d029280a4b68aa4a97ba82ec9f23aaa8044efecfeb25` |
| Digest source | `ai/models/model-registry.ts`, verified against local pinned copy before the run |

## Live results

Run at 2026-11-18T08:10:12Z. Result: **PASS**.

| Check | Observed |
|---|---|
| Initial URL | `https://huggingface.co/…/resolve/5425…/onnx/model_quantized.onnx` |
| Redirect chain | HTTP 302 → `us.aws.cdn.hf.co` (Xet bridge) → HTTP 200 |
| `accept-ranges` | `bytes` |
| `content-length` | 753999618 (matches manifest) |
| ETag | `"71513aae24a5954faebeaf638cc48c147e917ce8190e6515f6daa2f334e29c44"` |
| CDN PoP | `aws-ap-southeast-1` |
| Controlled interruption | Triggered at byte 67,122,079 (after ~64 MiB; 4,338 TLS chunks) |
| Resume request | `Range: bytes=67123079-` |
| Resume redirect chain | HTTP 302 → HTTP 206 |
| Resume `content-range` | `bytes 67123079-753999617/753999618` — validated against the expected total |
| Resume `content-length` | 686876539 (matches total − offset) |
| Final assembled size | 753,999,618 bytes |
| Final SHA-256 | `5f939904…feb25` — **matches the trusted digest** |
| Initial phase throughput | ~1.46 MB/s over 45.99 s |
| Resume phase throughput | ~1.39 MB/s over 493.85 s |
| Total elapsed | ~539.8 s (~9 min) |
| Average throughput | ~1.40 MB/s |

The CDN delivered small TLS frames (first chunks ~14–16 KB). The product downloader aggregates these into 8 MiB `Cache Storage` parts before final assembly; the harness deliberately did not replicate that aggregation because it would duplicate the downloader under test.

## Integrity boundary

- The CDN checksum/ETag was **not** treated as the integrity source. Verification used the digest pinned in source.
- The interrupt/resume boundary was byte-exact: the resume started at the exact persisted offset and the `Content-Range` total was checked before any bytes were written.
- A byte-identical pinned copy already exists in `.model-cache/` (independently hashed before this run), so this live transfer was performed once to validate the real endpoint/resume path rather than repeatedly.

## Product-side controls covered by unit regression tests

`tests/unit/model-download.test.ts` and `tests/unit/model-integrity.test.ts` cover the cases that cannot be safely provoked against the live CDN:

- First-chunk and several-chunk interruption; retry resumes from verified bytes.
- Server ignoring `Range` → safe full restart, never concatenation.
- Invalid `Content-Range` → rejected, partial chunks cleaned up.
- HTTP 416 → rejected with a retryable error.
- Non-contiguous chunks → discarded, not concatenated.
- Corrupt chunk / incorrect final SHA-256 → never installed; status `corrupt`/`failed`, never `ready`.
- Cancellation → temporary state removed.
- Verified complete cached file → reused without a second download.

## CI

Ordinary CI uses fixture tests (`npm run test:local`) and never downloads the production model. A manually gated `live-download-validation` workflow job runs this harness only when `workflow_dispatch` and `vars.RUN_LIVE_MODEL_DOWNLOAD == '1'` are set.

## Remaining limitations

- A single CDN edge/region was exercised (`aws-ap-southeast-1`); other edges were not tested.
- The real download was interrupted once, not repeatedly under a lossy connection.
- Browser-level install through the real Cache Storage was validated earlier via the fixture-server E2E (`e2e-phase42-model.mjs`), not by re-running a second 734 MiB transfer through the browser here.
