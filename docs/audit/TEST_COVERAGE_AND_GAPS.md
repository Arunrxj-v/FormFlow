# Test Coverage and Gaps

Audit/remediation date: 2026-11-18  
Environment: macOS Apple Silicon, Chrome for Testing 159.0.8154.6 (headless) and 113.0.5672.0 (headed), Node 26.12.0.

## 1. Executive coverage summary

- Automated suite: **229 tests, 229 pass, 0 fail**
  - local/unit: **200 pass**
  - extension: **16 pass**
  - server: **13 pass**
- Typecheck: pass.
- Dashboard build: pass.
- Extension build: pass (111 files, 51,061.6 KB).
- Production dependency audit: 0 vulnerabilities.
- Full dependency audit: 4 high dev-only `picomatch`-chain advisories (no patched version).
- Browser E2E: vault/backup/encryption, ingestion, OCR (fault hooks), offscreen isolation, reload/interruption/crash/migration, content isolation, router, real model install/self-test/offline inference/extraction, Google Forms and standard-form autofill, onboarding, UI accessibility, WebGPU fallback, iframe/Shadow DOM.

## 2. Test type by area

| Area | Unit/integration | Server | Browser E2E | Notes |
|---|---|---|---|---|
| Crypto/AAD/tamper | Yes | — | Phase3 | Strong negative coverage |
| Vault create/unlock/lock/session | Yes + throttle tests | — | Phase3, reload, model E2E | Persistent restart throttling, concurrency |
| Backup/restore | Yes + passphrase policy | — | Phase3, recovery crash | v1/v2/v3, tamper, crash, Unicode policy |
| Migration | Yes | — | Migration crash | SIGKILL and fault injection |
| PDF parser | Yes | Legacy server upload | Phase4 | Text/scanned/mixed/limits |
| DOCX parser/structure | Yes | — | Phase4 | Tables/images/fonts/pagination |
| TXT | Yes | Legacy server upload | Phase4 | UTF-8/BOM/control rejection |
| OCR | Yes | — | Phase4.1.2 OCR | Test hooks for timeout/cancel/crash |
| Structure validation | Yes | — | Phase4 | Duplicate/foreign refs/limits |
| Parser isolation | Yes | — | Offscreen E2E | Malformed/oversized/cancel/crash |
| Model download | Yes | — | Model E2E | Range/restart/hash/cancel/chunk cleanup |
| Model aliases | Loader/worker logic | — | Real model E2E | Revision re-hash + alias rebuild |
| Model inference | Timeout/protocol tests | — | Real model E2E | Offline, extraction, AI match, concurrency guard |
| Deterministic extraction | Yes | Legacy server | Model E2E | Prompt/grounding/merge |
| AI extraction/prompt injection | Yes | — | Real model E2E | Grounding and catalogue checks |
| Profile CRUD/conflict/verify | Yes | Legacy server | Phase3/model E2E | Search/filter browser-tested |
| Structured records | Yes | — | Model E2E education | Education/employment/address/skills |
| Form classification | Yes | — | Standard/Google audits | Country/city/state + sensitivity |
| Deterministic matching | Yes | — | Standard/Google audits | Options/selects/read-back |
| AI matching | Unit | — | Real model E2E | Review flag verified |
| Autofill approval binding | — | — | Standard/Google audits | Tab/URL/scan/fingerprint, single-use, lock |
| Read-back/rejection/no submit | Yes | — | Standard/Google audits | Phone transform rejected |
| Cross-tab/navigation/lock | — | — | Standard audit | All rejected |
| Iframe/Shadow DOM | — | — | Standard audit | Same-origin open roots filled; cross-origin skipped |
| Content-script isolation | Unit/protocol | — | Content isolation | Page cannot use extension APIs |
| Onboarding | — | — | Onboarding E2E | Fresh/resume/reopen/skip/completion |
| UI filter/search/accessibility | — | — | UI audit | 1280/768 overflow, filters, modal focus |
| WebGPU fallback | — | — | WebGPU audit | Disabled GPU reports false; WASM remains |
| Server CORS/limits | — | API tests | — | Exact origin, preflight, uploads |
| Packaging | Script checks | — | Manual package | 111 files, SHA-256 sidecar |

## 3. Gaps and weak spots

### Critical/high

1. **Public Git history exposure (F-01).** Not a test gap; a repository privacy incident. The remote default branch serves a personal identity PDF. History rewrite/remote purge is owner-only and was not performed.

2. **Full live model download.** Live Hugging Face redirects, byte ranges, 416 handling, and small-file SHA-256 values were checked. A full 734 MiB download/resume under network loss was **not run**.

### Medium

3. **WebGPU/Q4F16.** Capability detection and WASM fallback are tested; GPU inference is not implemented or validated.

4. **Model quality/recall.** Real extraction passes for a representative resume, but no labeled precision/recall corpus was measured. The 0.6B model can miss fields.

5. **Memory.** Process-sum RSS was measured for text import, backup export, lock/unlock, model self-test, and AI extraction. Per-worker heap, peak allocation, and long-run leak growth are not measured.

6. **Physical disk-full.** Quota failures are simulated; actual disk exhaustion is not tested.

7. **Word reference pagination.** Renderer-derived pagination is compared with LibreOffice; Microsoft Word references are unavailable. `verified_physical` remains unclaimed.

8. **Accessibility.** Dialog focus/trap/restore, Escape, labels, live regions, keyboard focus, reduced motion, and 1280/768 overflow were tested. No full WCAG audit or screen-reader matrix.

9. **Security fuzzing.** Parser/ZIP/XML/model-output fuzz campaigns are not present. Existing adversarial fixtures are bounded and targeted.

10. **Browser matrix.** Chrome 113 and 159 tested. Edge/Brave/Arc/Opera, Firefox, and Safari are not.

11. **Server flakiness.** One full-suite run under high host load previously timed out at health-check startup; reruns pass. CI should isolate/retry the server.

### Low

12. Dev-only picomatch advisories with no upstream patch.
13. No store signing/listing/privacy-policy test.
14. No independent security/cryptographic audit.
15. Model upgrade/migration mechanism absent.
16. Legacy development server must not be exposed publicly.

## 4. Real vs mocked implementation

- Real model: `e2e-phase42-model.mjs` uses pinned real files and real WASM inference.
- Real parser/OCR: Phase4 and Phase4.1.2 use real Chromium, PDF.js, Mammoth, and Tesseract. Offscreen fault tests use test-only hooks; production hooks are compiled out.
- Some unit tests use fake-indexeddb, fake Cache, or an in-memory session backend. These are storage doubles, not replacements for production cryptography/parser/model code.
- Google Forms origin is served through Playwright route interception, not a live Google request. DOM structure matches the adapter contract.

## 5. Assertion quality

Negative assertions cover invalid ciphertext, wrong passphrase, tampered backup headers, invalid structure references, oversized/malformed worker messages, cancellation cleanup, rejected phone values, model corruption, invalid Range, forged scan tokens, stale/cross-tab/mutated/locked approvals, sensitive downgrade attempts, and cross-origin frame exclusion. Some UI checks are text/DOM-level; they do not replace a full accessibility audit.

## 6. Recommended next tests

1. Full live model download/resume with throttling and connection loss.
2. Labeled extraction corpus with precision/recall/error categories.
3. Full WCAG/axe and screen-reader pass.
4. Physical disk-full and long-run memory/leak sampling.
5. Edge/Brave and current-stable Chrome regression.
6. WebGPU/Q4F16 numerical and device-loss validation if that backend is pursued.
7. CI-run browser smoke with isolated test servers and retries.
