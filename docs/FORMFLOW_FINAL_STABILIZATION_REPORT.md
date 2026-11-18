# FormFlow Final Stabilization Report

> **Post-audit update (2026-11-18):** This report is historical. The subsequent remediation pass (backup policy, persistent unlock throttling, server hardening, model alias rehashing, sensitive matching, onboarding, iframe/Shadow DOM, accessibility, CI, packaging) is documented in `docs/FORMFLOW_REMAINING_ISSUES_REMEDIATION_REPORT.md`. Test counts below have been updated to the final 229-test run where applicable.


Date: 2026-11-18
Branch: `feature/phase-4-document-ingestion`
Base commit before stabilization: `cbf3de9`
Working tree: intentionally reviewed and prepared as one stabilization commit

## 1. Executive summary

FormFlow now completes the planned local-first workflow: encrypted vault → local document ingestion/OCR → deterministic and local-AI profile extraction → source-linked review/verification → extension matching → explicit user approval → verified autofill with no submission.

The stabilization pass found and fixed defect classes in:

- Model download persistence, HTTP Range resume, invalid-range handling, cancellation cleanup, and unhandled install rejections.
- Autofill false-success reporting.
- Stale extraction evidence after manual edits/conflict selection.
- Key-material duplication in the memory session backend.
- Evidence integrity coverage.
- Inert settings and misleading UI shortcut claims.
- Model install storage reservation and silent install failure feedback.
- Tracked legacy personal upload fixtures in the current Git index.

The production test suite passes: **229 tests, 229 pass, 0 fail**. Type checking, dashboard build, extension build, and production dependency audit pass. Chromium regression suites pass, including the real local-model workflow under normal-to-moderate host load.

No external AI/Drive/telemetry path exists in the production client. Model inference is local after installation. No critical or high runtime defect remains in the reviewed scope.

The highest residual repository risk is historical: three personal PDFs were tracked in an early Git checkpoint. They were removed from the current index, but they remain in existing repository history/clones and require history rewriting and remote purging to eliminate completely.

## 2. Architecture reviewed

- MV3 background service worker as the only vault-key authority.
- IndexedDB encrypted vault, AES-256-GCM v2 per-record AAD, PBKDF2-SHA256 at 600,000 iterations, random DEK wrapped by a passphrase-derived KEK.
- React dashboard, extension popup, content script, offscreen document, request-scoped parser workers, and offscreen-hosted model worker.
- PDF.js, Mammoth/DOCX layout, Tesseract.js OCR, structured extraction, and encrypted `extractionEnc`.
- Local model lifecycle: pinned registry, SHA-256 verification, Cache Storage, IndexedDB metadata, chunked/range-resumable downloads, offscreen transport, self-test, idle unload, cancellation.
- Deterministic extraction, local-AI few-shot extraction, grounding/validation, conflict handling, profile evidence, structured record synthesis.
- Deterministic-first form matching, optional local-AI matching, review/approval, native setters/events, read-back verification, no auto-submit.
- Backup/restore v3, legacy v1/v2 compatibility, migration journaling, integrity checks.
- Legacy development server and removed cloud routes.

## 3. Security findings

### Critical / high

1. **Tracked personal documents in Git history**
   - `server/storage/documents/` contained three tracked PDFs from the early backend checkpoint: one degree document and two identity documents.
   - Current-tree fix: removed the paths from the Git index with `git rm --cached`; `server/storage/` is already ignored, so future uploads are not tracked.
   - Residual risk: blobs remain in history and existing clones. History must be scrubbed with `git filter-repo` or BFG and the remote force-pushed/cleaned according to repository policy. This report does not claim that history is clean.
   - No other tracked PDFs, DOCX, database, key, or model binary files were found.

### Medium (fixed)

2. **Memory backend retained a second raw key copy.** The extension `MemorySessionBackend` stored a base64-exported DEK in addition to the `CryptoKey`. `VaultSession.unlockWithDataKey` now keeps the `CryptoKey` directly for the memory backend and does not export/store a second raw copy. Web development still uses sessionStorage by design.
3. **Manual edits could retain stale evidence.** A user-edited value kept the previous document/page/block/model-version evidence. Manual replacement and conflict selection now clear stale `evidenceEnc`, `sourceBlockId`, and `modelVersion`, or set new explicit metadata when supplied. Covered by a regression test.
4. **Integrity check did not authenticate evidence.** `checkVaultIntegrity` now decrypts and authenticates `evidenceEnc` under the `value`/`evidence` AAD.
5. **Model download interruption only restarted the whole file.** Downloads now persist 8 MB chunks, resume with HTTP `Range`, validate `Content-Range` start/total and content length, restart cleanly if the server ignores Range, and clear chunks on cancellation/hash/size failure. Controlled 16 MB HTTP tests cover mid-stream failure, resume, Range-ignored restart, invalid `Content-Range`, cancellation cleanup, hash mismatch, and verified-cache reuse.
6. **Model install could leave an unhandled rejection.** The stored install promise is now observed, and removal waits for an aborted install to settle before deleting cache entries.
7. **Storage reservation was below transient peak.** Resumable chunks plus final assembly require roughly twice the model size; install now requires `2 × model + 128 MB` and reports it explicitly.
8. **Autofill could claim success without verifying the accepted value.** Standard and Google Forms adapters now read back the value and report rejected/overwritten fields as failures. A test injects a page that rejects an email value and confirms `filled: 0, failed: 1`.

### Low (fixed)

9. Removed inert “Confirm before autofill”, “activity notifications”, and “compact density” controls. `allowLongAnswers` is now effective for long-answer generation.
10. Removed false shortcut claims (`Alt+F`, `Alt+Shift+F`, `Alt+E`); the extension is invoked from the toolbar.
11. Fixed profile completeness always reporting 100% when any personal/contact value existed.
12. Fixed silent model-install failures in the Overview action (now toasted by AppContext).
13. Hid the verify action while a field has unresolved conflicts, so conflicts must be reviewed first.
14. Narrowed `ADD_FIELD` validation to known category/status/method values, bounded source-page values, and forwarded evidence/block/model-version metadata with length caps.

### Remaining

15. **Development-only dependency advisory:** `npm audit --omit=dev` reports 0 vulnerabilities. Full `npm audit` reports 4 high-severity advisories through Vite’s dev-only `fdir`/`picomatch`/`tinyglobby` chain. These packages are not in the extension/dashboard production bundles. A fix requires a Vite major upgrade or upstream dependency change; no safe patched dev version is currently offered by `npm audit fix`, which proposes removing packages. Not changed to avoid unrelated build churn.
16. No third-party security audit or penetration test.

## 4. Reliability findings

Verified:

- AES-GCM/AAD fail-closed behavior and cross-record ciphertext swapping.
- Lock/unlock, session generation, backup/restore, interrupted restore, migration crash resume, extension reload, service-worker termination.
- Parser worker/offscreen fault isolation, malformed/oversized responses, timeout, cancellation, concurrent parses, worker shutdown/restart.
- Model seed/cached install, fresh empty-cache install, self-test, offline inference, AI extraction, AI field matching.
- Model download interruption/resume/Range validation/cancellation through controlled HTTP tests.
- Duplicate documents, OCR-required/partial/failed states, large single-line document bounding.
- Autofill read-back rejection handling.

Issues found and fixed: entries 2–14 above.

One model E2E run under severe host contention (system load average 30–90) exceeded the 180 s inference timeout; a later run at load ~20 passed with 67.5 s extraction. This is documented as environment sensitivity, not hidden. Normal/moderate-load runs complete in 27–39 s for the same extraction.

## 5. Bugs discovered

- Stale evidence persisted after user edits/conflict selection.
- Evidence ciphertext was not included in integrity authentication.
- Memory session backend duplicated the raw DEK.
- Autofill adapters could report success without read-back verification.
- Google Forms adapter manually set `aria-checked`, masking page rejection.
- Model interruption restarted entire large files; no Range resume.
- Invalid/ignored Range responses were not handled.
- Model install had an unobserved promise rejection and a remove/install race.
- Storage check under-reserved transient chunk+final space.
- `allowLongAnswers` setting was inert.
- Several settings were inert; shortcut labels were false.
- Profile completeness was always 100% once any value existed.
- Overview model-install failure was silent.
- `ADD_FIELD` dropped new evidence/model metadata and accepted unvalidated status/method strings.
- Verify action remained available with unresolved conflicts.
- Three personal PDFs were tracked in Git from an early checkpoint.

## 6. Fixes applied

All issues above except the historical Git exposure, dev-only Vite advisory, unvalidated WebGPU/Q4F16, model-repository upgrades, and Word reference validation were fixed in code and covered by tests where practical. Details and file references are in the completion report’s changed-files list and this report’s security findings.

## 7. Tests executed and exact results

### Automated suites

- `npm test`: **229 tests, 229 pass, 0 fail**.
  - Local/unit: 200 pass across 25 suites.
  - Extension: 16 pass.
  - Server: 13 pass.
- `npm run typecheck`: pass.
- `npm run build`: pass (Vite large-chunk warning only).
- `npm run build:extension`: pass — 111 files, 51,061.6 KB.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `npm audit`: 4 high dev-only findings (Vite/fdir/picomatch/tinyglobby).

### Chromium E2E

| Suite | Result |
|---|---|
| `e2e-phase3.mjs` (final rerun) | PASS — vault, AAD, lock, backup, import, restore journal, passphrase, XSS, protocol rejection |
| `e2e-phase4-ingestion.mjs` | PASS (worktree completion pass) |
| `e2e-phase4-offscreen.mjs` (test-hooks build) | PASS — malformed/oversized, timeout, crash, cancellation, concurrency, idle shutdown |
| `e2e-phase4-interruption.mjs` | PASS |
| `e2e-recovery-crash.mjs` | PASS |
| `e2e-migration-crash.mjs` | PASS |
| `e2e-extension-reload.mjs` | PASS |
| `e2e-content-isolation.mjs` | PASS |
| `e2e-router-navigation.mjs` | PASS |
| `e2e-phase42-model.mjs` (final rerun) | PASS — install, integrity, offscreen transport, real WASM self-test, offline inference, AI extraction, provenance, AI matching |
| `e2e-phase42-model.mjs` fresh mode (`FORMFLOW_MODEL_E2E_FRESH=1`) | PASS — empty cache, real 734 MiB files, chunked install + final assembly |

The offscreen fault-injection suite requires `FORMFLOW_TEST_HOOKS=1 npm run build:extension`; production was rebuilt afterward.

## 8. Performance measurements

Final model E2E run at host load ~20 (Apple Silicon, 8 GB target):

| Measurement | Result |
|---|---|
| Seeded install + SHA-256 verification | 27.9 s |
| Fresh empty-cache install, real 734 MiB files | 157 s |
| Model status response | 7 ms |
| Self-test total | 38.7 s |
| Self-test load | 16.1 s |
| Self-test inference (32 tokens) | 22.5 s |
| AI-assisted resume extraction | 67.5 s |
| Candidates | 13 total, 2 accepted AI-method |
| Offline inference | Passed |
| Model download size | 769,882,900 bytes (~734 MiB) |
| Extension build | 111 files, 51,061.6 KB (~49.8 MiB) |
| Dashboard build | 62 files, 3.7 MB |
| Node Q8 CPU reference | 2.6 s load / 0.76 s inference |
| Large single-line document extraction bound | 120,000 chars, 2,000-char line wrapping; pathological 8 MB input no longer hangs |

Earlier normal-load model runs measured 8.3 s self-test (4.7 s load, 3.6 s inference), 14.4 s seeded install, and 27.0 s extraction. Under severe host contention, one run timed out at 180 s. Peak process memory was not directly instrumented; no OOM was observed in Chromium runs on the 8 GB machine. Do not interpret these numbers as guarantees.

## 9. Known limitations

- Qwen3-0.6B can miss information and can imitate example values; grounding rejects unsupported values, but recall is incomplete.
- WASM inference is slower than native CPU/WebGPU and environment-sensitive.
- Q4F16 WebGPU is not a validated production option.
- Model repository upgrades are not validated.
- Microsoft Word reference validation is unavailable; `verified_physical` remains unclaimed.
- Live large-file internet download reliability is not proven beyond controlled local fixtures and the real installer path.
- OCR is English-only.
- Legacy identity-only Google sign-in remains in the development server; no Drive document access or production-client cloud dependency.
- No model memory measurement instrumented; only no-OOM observation.
- No independent security audit.
- Git history still contains the previously tracked personal PDFs.

## 10. Remaining risks

1. **Git-history personal-document exposure** — highest residual risk. Current index is clean, history is not.
2. **Model quality/recall** — mandatory review remains; do not treat AI confidence as correctness.
3. **WASM latency under contention** — 180 s inference timeout can fail on severely overloaded hosts.
4. **Live CDN/network behavior** — controlled Range/resume tests pass, but live CDN routing is untested.
5. **Dev-only dependency advisories** — not in production output, but remain in the dev toolchain.
6. **WebGPU/Q4F16** — capability is detected, not validated for inference.
7. **Word fidelity** — renderer-derived pagination only.
8. **No formal security audit** — targeted tests and threat modeling only.

## 11. Build sizes

- Extension: 111 files, 51,061.6 KB. Largest assets include ONNX Runtime WASM (~26 MB), parser worker (4.6 MB), offscreen parser (1.7 MB), and Transformers.js (574 KB). Model weights are not bundled.
- Dashboard: 3.7 MB across 62 files; main JS chunk ~744 KB, PDF worker ~1.2 MB, PDF chunk ~501 KB, Mammoth ~305 KB. Vite warns about chunks >500 KB; no functional failure.
- Extension background: ~286 KB; popup: ~174 KB; content script: ~20 KB; model worker: ~7.7 KB.

## 12. Repository and Git status

- Branch: `feature/phase-4-document-ingestion`.
- Base: `cbf3de9`.
- Initial state: all Phase 4.2–4.4 implementation changes were uncommitted; working tree verified and preserved; `.model-cache/` (1.8 GB) is ignored (`git check-ignore` confirmed).
- Final production build is present in `extension/dist` and ignored.
- No model binaries, secrets, `.env`, database files, or generated screenshots are staged/tracked.
- Three tracked legacy personal PDFs were removed from the current index; working copies remain ignored on disk.
- The intended commit includes only FormFlow stabilization changes, documentation, tests, and the personal-document index removal.
- Commit message: `chore: finalize FormFlow stabilization`.

No unrelated user work was identified in the current changes; the entire working-tree diff belongs to the completed FormFlow implementation/stabilization effort. A single commit is safe after the final staged-diff inspection.

## 13. Verification status distinction

**Verified by execution:** unit/integration/server tests, typecheck, builds, production audit, vault/backup/lock/restore/reload/migration Chromium suites, parser isolation/fault injection, content isolation, router, autofill read-back rejection, model fresh/cached install, SHA-256 verification, Range resume tests, offline WASM inference, AI extraction/matching, and no-submit behavior.

**Verified by code inspection:** worker boundaries, absence of external AI/Drive/telemetry calls in production, key lifecycle, model cache isolation, disabled legacy Drive routes.

**Not verified:** live internet model download under real CDN conditions, WebGPU inference, Q4F16, model repository upgrades, Word-reference pagination, peak memory instrumentation, non-English OCR, independent security audit, and complete Git history sanitization.
