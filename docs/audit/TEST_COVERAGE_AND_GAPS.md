# Test Coverage and Gaps

Audit date: 2026-11-18  
Test environment: macOS Apple Silicon, Chromium 156.0.8078.4 for Testing, Node.js runtime used by `node --test`.

## 1. Executive coverage summary

- Automated suite: **216 tests, 216 pass, 0 fail**.
  - Local/unit: **189 pass**, 25 suites.
  - Extension: **15 pass**.
  - Server: **12 pass**.
- TypeScript typecheck: pass.
- Dashboard production build: pass.
- Extension production build: pass (111 files, 51,041.0 KB at final audit build).
- Production dependency audit: 0 vulnerabilities.
- Full dependency audit: 4 high dev-only Vite/fdir/picomatch/tinyglobby advisories.
- Browser E2E: vault/backup/encryption, ingestion, OCR (test-hooks for fault injection), extension reload/interruption/crash/migration, content isolation, router, real model workflow, Google Forms autofill binding, and standard HTML form autofill.

## 2. Test type by area

| Area | Unit/integration | Server | Browser E2E | Notes |
|---|---|---|---|---|
| Crypto/AAD/tamper | Yes (`crypto-aad`, hostile backup) | — | Phase3 | Strong negative coverage |
| Vault create/unlock/lock/session | Yes | — | Phase3, reload, model E2E | Service-worker kill tested |
| Backup/restore | Yes (`backup`, `backup-hostile`, `restore-atomicity`) | — | Phase3, recovery crash | v1/v2/v3, tamper, crash |
| Migration | Yes | — | Migration crash | SIGKILL and fault injection |
| PDF parser | Yes | Legacy server upload | Phase4 | Text/scanned/mixed/limits |
| DOCX parser/structure | Yes | — | Phase4 | Tables/images/fonts/pagination |
| TXT | Yes | Legacy server upload | Phase4 | UTF-8/BOM/control rejection |
| OCR | Yes | — | Phase4.1.2 OCR | Test hooks for timeout/cancel/crash |
| Structure validation | Yes | — | Phase4 | Duplicate/foreign refs/limits |
| Parser isolation | Yes | — | Offscreen E2E | Malformed/oversized/cancel/crash |
| Model download | Yes (`model-download`, `model-integrity`) | — | Model E2E | Range/restart/hash/cancel |
| Model inference | Protocol tests | — | Real model E2E | Offline, extraction, AI match |
| Deterministic extraction | Yes | Legacy server | Model E2E | Prompt/grounding/merge |
| AI extraction/prompt injection | Yes | — | Real model E2E | Grounding and catalogue checks |
| Profile CRUD/conflict/verify | Yes | Legacy server | Phase3/model E2E | Some UI flows only source-reviewed |
| Structured records | Yes | — | Model E2E education | Education/employment/address/skills |
| Form classification | Yes | — | Standard/Google audits | Country/city/state regression fixed |
| Deterministic matching | Yes | — | Standard/Google audits | Options/selects/read-back |
| AI matching | Unit | — | Real model E2E | Review flag verified |
| Autofill approval binding | — | — | Standard/Google audits | New high-severity fix; radio/checkbox group verified |
| Read-back/rejection/no submit | Yes | — | Standard/Google audits | Phone transform rejected |
| Cross-tab/navigation | — | — | Standard audit | Stale token rejected |
| Lock during pending approval | — | — | Standard audit | Token invalidated |
| Content-script isolation | Unit/protocol | — | Content isolation | Page cannot use extension APIs |
| Backup evidence roundtrip | Yes | — | Phase3 | Evidence/source metadata |
| Settings | — | — | Phase3/router | Some controls code-reviewed only |
| Accessibility/iframe/Shadow DOM | — | — | — | Gap |

## 3. Gaps and weak spots

### High-priority gaps

1. **Git-history personal documents.**
   - Not a code test gap; a repository exposure finding. Current branch index is clean, but `main`/remote history contains personal PDFs. Needs history rewrite and remote purge.

2. **Live model download/CDN.**
   - Actual install path is tested with real files over a controlled HTTP fixture, including mid-stream interruption, Range resume, Range-ignored restart, invalid Content-Range, cancellation, and hash mismatch.
   - A live Hugging Face CDN download was not run. Network routing/TLS/CDN behavior remains an integration risk.

3. **Iframes and Shadow DOM.**
   - Google Forms content script runs in all frames; standard injection targets the tab.
   - No dedicated iframe or open/closed Shadow DOM test.

5. **Accessibility and responsive UI.**
   - Labels, keyboard controls, focus behavior, and screen-reader semantics were source-reviewed but not systematically tested with an accessibility tool or keyboard-only browser run.

6. **Dedicated onboarding.**
   - Vault setup and first-run model card exist; there is no multi-step onboarding wizard (the old Drive-based onboarding was removed).

### Medium gaps

7. **Model quality/recall.**
   - Real extraction passes for a representative resume, but no labeled precision/recall corpus was measured. The 0.6B model can miss fields.

8. **Peak memory.**
   - No browser process memory instrumentation. No OOM observed on the 8 GB target; peak memory is not claimed.

9. **Physical disk-full.**
   - Quota failures are simulated with `QuotaExceededError`; no physical disk-full test.

10. **Word reference validation.**
    - DOCX layout is compared against LibreOffice; Microsoft Word references are unavailable. `verified_physical` remains unclaimed.

11. **Model upgrade/WebGPU.**
    - No model repository switch; Q4F16 WebGPU is not validated.

12. **Security fuzzing.**
    - Parser/ZIP/XML/model-output fuzz campaigns are not present. Existing adversarial fixtures are bounded and targeted.

13. **Flaky server startup.**
    - One full-suite run under high host load failed because the local test server did not start within the health-check window; an immediate rerun passed all server tests. This is test-harness flakiness, not a reproduced product failure. CI should retry/isolate servers or increase startup timeout.

### Low gaps

14. Backup passphrase strength test (8 chars accepted).
15. Unlock delay persistence across service-worker restart.
16. Dev-only dependency advisories.
17. No public-release signing/store/privacy-policy test.
18. No independent security audit.

## 4. Tests that use real vs mocked implementation

- Real model: `scripts/dev/e2e-phase42-model.mjs` uses the pinned real files and real WASM inference; no mocked inference in production.
- Real parser/OCR: Phase4 and Phase4.1.2 use real Chromium, PDF.js, Mammoth, and Tesseract assets. Offscreen fault tests use test-only delay/injection hooks; production hooks are compiled out.
- Mocked boundaries: some unit tests use fake-indexeddb, fake Cache, or an in-memory session backend. These are test doubles for storage, not replacements for production cryptography/parser/model code.
- Browser Google Forms origin is served through Playwright route interception; it is not a live Google production network request. DOM structure is representative and matches the adapter contract.

## 5. Assertion quality

- Negative assertions cover invalid ciphertext, wrong passphrase, tampered backup headers, invalid structure references, oversized/malformed worker messages, cancellation cleanup, rejected phone values, model corruption, invalid Range, forged scan token, stale approval, mutation, and cross-tab fill.
- Some UI checks are text/DOM-level and would not catch subtle accessibility/copy defects.
- Security tests exercise real browser contexts for autofill and worker boundaries, not just unit mocks.

## 6. Recommended next tests

1. Iframe/Shadow DOM standard forms with duplicate labels.
2. Iframe and Shadow DOM form detection/fill safety.
3. Labeled extraction corpus with measured precision/recall and error categories.
4. Live CDN download under throttling/loss with Range and hash verification.
5. Browser memory sampling during repeated model load/inference and large OCR.
6. Accessibility (axe-like) and keyboard-only runs.
7. CI workflow with isolated temporary test servers and retry on startup flake.
