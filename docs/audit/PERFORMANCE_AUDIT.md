# Performance Audit

Audit date: 2026-11-18  
Environment: macOS Apple Silicon, 8 GB target, Chromium 156.0.8078.4 for Testing, Node v26.12.0.  
Host load varied significantly during the audit; timing-sensitive runs are labeled where load was abnormal.

## 1. Build and package sizes

| Measurement | Result |
|---|---|
| Dashboard production build time | 5.66 s (one measured run; a loaded-host run took longer) |
| Dashboard output | 62 files, 3.7 MB |
| Dashboard main JS | ~747.5 KB (gzip ~207.9 KB) |
| PDF worker asset | ~1.245 MB (gzip ~389 KB) |
| Mammoth chunk | ~305 KB |
| Extension production build | 111 files, 51,041.0 KB (~49.8 MiB) |
| Extension background | ~286 KB (before final audit changes; final build ~similar) |
| Popup | ~174 KB |
| Content script | ~20 KB |
| Model worker | ~7.7 KB |
| Transformers.js | ~574 KB |
| ONNX Runtime asyncify WASM | ~26 MB |
| DOCX parser worker | ~4.6 MB |
| Offscreen parser | ~1.7 MB |
| Bundled OCR assets | ~? (Tesseract worker/core/language; included in 51 MB total) |
| Model weights | Not bundled |
| `.model-cache` local test cache | 1.8 GB (ignored) |
| `server/storage` working files | ~5.1 MB (ignored; includes historical personal PDFs) |

Large chunks remain above Vite's 500 KB warning threshold. This is a build warning, not a runtime failure. The extension package is dominated by ONNX Runtime WASM and parser/OCR/font assets, which are intentional local-only dependencies.

## 2. Model lifecycle and inference

Final audit model E2E (real pinned files through local fixture; host load moderate):

| Measurement | Result |
|---|---|
| Model download size | 769,882,900 bytes (~734 MiB) |
| Seeded/cached install + SHA-256 verification | 15.8 s |
| Fresh empty-cache install through real installer | 157 s (prior run on heavily loaded host; real 734 MiB local transfer) |
| Model status response | 8 ms |
| Self-test total | 10.7 s |
| Self-test load | 6.1 s |
| Self-test inference (32 tokens) | 4.5 s |
| AI-assisted resume extraction | 34.2 s |
| Extraction result | 13 candidates; 2 accepted AI-method; 5 raw AI proposals |
| Offline inference | Passed |
| Node native Q8 reference | 2.6 s load / 0.76 s inference (prior reference) |

Observed model timing variability:

- Prior normal-load runs: 8.3–11 s self-test, ~27–34 s extraction.
- Severely contended host (load average 30–90): self-test up to 197.8 s total; one extraction exceeded the 180 s inference timeout.
- Fresh install peaks around 2× model disk usage transiently due to resumable chunks + final assembly.

Do not treat these as hardware guarantees. No direct peak RSS measurement was available.

## 3. Document processing and OCR

Measured/observed browser E2E values:

| Measurement | Result |
|---|---|
| 5,000-paragraph DOCX | ~2.6 s import in phase4 log; 105 derived pages; mapping truncated at limits |
| OCR page-timeout fault test | ~632 ms to bounded failure (test timeout value, not production latency) |
| OCR real pages | Chromium E2E completed clear/rotated/low-quality pages without hang |
| Phase4 ingestion suite | Browser suite passed; exact per-file total not separately instrumented |
| Failed parser/timeout/cancel | Bounded; no partial records; offscreen shutdown/recreation passed |

Production limits: 20 MB upload; 1,000 PDF pages; 10M extracted chars; 300 s ingestion; 30 s per OCR page; 100 OCR pages; DOCX XML 24 MB, uncompressed 96 MB, images 200/12 MB each/64 MB total; structure 20k blocks/2k sections/1k tables/20k cells; extraction text bounded to 120k chars for profile rules.

## 4. Autofill latency

Not separately benchmarked. Audit behavior:

- Google Forms scan + fill and standard scan + fill completed within Playwright timeouts (5–6 s per operation).
- Read-back verification adds negligible work per field.
- Local AI matching is optional and model-dependent (tens of seconds under load); deterministic matching is immediate.

No claim of sub-second autofill latency is made.

## 5. Memory and CPU

- No reliable browser-process peak-RSS instrumentation was available. No OOM occurred in Chromium runs on the 8 GB machine.
- Model is ~734 MiB on disk; ONNX Runtime/WASM memory is additional and not measured.
- The model worker is unloaded after 120 seconds idle; model cache is not loaded into the parser worker.
- Parser workers are capped at 2 concurrent; model worker is single-instance.
- Long-run repeated-inference or repeated-OCR memory growth was not tested.
- CPU usage was not instrumented; host load materially affected model inference.

**Explicit limitation:** peak memory and sustained memory growth remain unverified. The model file size must not be interpreted as peak RAM.

## 6. Storage usage

- Vault: IndexedDB, encrypted records plus plaintext structural metadata.
- Model: Cache Storage model weights + IndexedDB metadata.
- Installer storage requirement: roughly twice model size + 128 MB for chunk assembly.
- No quota exhaustion on the target test profile (quota ~10 GB available).
- Storage quota failures are simulated in tests; physical disk-full is untested.

## 7. Concurrency and responsiveness

- Concurrent parser imports through separate request-scoped workers passed; cancellation of one did not terminate the other.
- Model inference is serialized by the single offscreen model worker.
- Dashboard remained responsive after model install/status; model status measured 8 ms.
- During heavy model inference, the dashboard UI is a separate renderer but the host CPU can starve it; no formal latency-under-load benchmark was run.
- Model download heartbeat keeps the MV3 service worker alive; user cancellation aborts fetch.

## 8. Performance findings

| Severity | Finding | Status |
|---|---|---|
| Medium | WASM inference is slow and environment-sensitive; one loaded-host extraction exceeded the 180 s timeout. | Limitation; no safe speed fix without validated WebGPU/upgrade |
| Medium | Fresh model install requires large transient storage and can take minutes. | Documented; storage check reserves 2× + 128 MB |
| Low | Dashboard/extension includes all Inter font subsets (~960 KB of assets). | Not changed; cosmetic/performance only |
| Low | Main JS/PDF chunks exceed 500 KB warning. | Not changed; code-splitting would be a build optimization |
| Low | No peak-memory or sustained-leak measurement. | Unverified |

## 9. Conclusion

Build sizes and storage requirements are consistent with a local model application. Deterministic paths and UI status calls are fast. Model inference is the dominant latency and memory risk; performance is acceptable only for user-triggered, review-based extraction on the tested 8 GB environment, with significant host-load sensitivity. No performance improvement is claimed beyond measured bounds.
