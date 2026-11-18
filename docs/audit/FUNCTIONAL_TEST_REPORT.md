# Functional Test Report

Audit date: 2026-11-18  
Environment: macOS Apple Silicon (8 GB target), Chrome for Testing 159.0.8154.6, Node v26.12.0, npm 11.20.0.  
Extension build: `extension/dist`, production 111 files / 51,061.6 KB.  
Model: real pinned Qwen3-0.6B INT8 files exercised through a controlled local fixture server.

## 1. Results overview

| Area | Result | Evidence |
|---|---|---|
| Full automated suite | PASS: 229/229 | `/tmp/audit-npm-final.log` |
| Typecheck | PASS | `npm run typecheck` |
| Dashboard build | PASS | `npm run build` |
| Extension build | PASS | `npm run build:extension` |
| Production dependency audit | PASS: 0 vulnerabilities | `npm audit --omit=dev` |
| Full dependency audit | 4 high, dev-only Vite/fdir/picomatch chain | `npm audit` |
| Vault/backup/encryption E2E | PASS | `e2e-phase3.mjs` |
| PDF/DOCX/TXT ingestion E2E | PASS | `e2e-phase4-ingestion.mjs` |
| OCR E2E (with fault hooks) | PASS | `e2e-phase412-ocr.mjs` |
| Offscreen fault isolation | PASS | `e2e-phase4-offscreen.mjs` with test hooks |
| Extension reload | PASS | `e2e-extension-reload.mjs` |
| Import interruption | PASS | `e2e-phase4-interruption.mjs` |
| Restore process crash | PASS | `e2e-recovery-crash.mjs` |
| Migration crash/resume | PASS with test hooks | `e2e-migration-crash.mjs` |
| Content isolation | PASS | `e2e-content-isolation.mjs` |
| Router navigation | PASS | `e2e-router-navigation.mjs` |
| Real model install/inference/extraction/matching | PASS | `e2e-phase42-model.mjs` |
| Google Forms approval binding | PASS | `audit-autofill-binding.mjs` |
| Standard HTML form autofill | PASS (text/email/select/long-answer/radio/checkbox/read-back/cross-tab/mutation/iframe/open Shadow DOM/sensitive flags) | `audit-standard-form.mjs` |
| Onboarding | PASS (fresh, resume, skip, complete, reopen) | `e2e-onboarding.mjs` |
| UI search/filter/accessibility | PASS (1280/768, filters, modal focus, keyboard) | `audit-ui-accessibility.mjs` |
| WebGPU fallback | PASS (WebGPU-disabled reports false, WASM remains) | `audit-webgpu-fallback.mjs` |
| Chrome 113 compatibility | PASS (onboarding + standard form/iframe/shadow) | headed Chrome 113 |

## 2. End-to-end workflow

The intended workflow was exercised in segments rather than one monolithic script:

1. **Extension load** — production build loaded in Chromium; dashboard/popup accessible. PASS.
2. **Vault creation** — passphrase-validated encrypted vault created. PASS.
3. **Onboarding** — resumable multi-step guide (welcome, optional model, documents, review, ready), first-run dashboard card, skip/reopen. PASS.
4. **Model install** — real pinned files installed; SHA-256 verified; fresh install and cached/repair paths exercised. PASS (live small files/range verified; full 734 MiB live download not run).
5. **Model self-test** — real local WASM inference; 8.3 s total in final audit run (4.85 s load, 3.42 s inference). PASS.
6. **Document import** — PDF, scanned PDF, DOCX, TXT, mixed/OCR, corrupted/password inputs tested. PASS.
7. **OCR** — clear, rotated, partial, low-quality, missing language, timeout, cancellation, crash/restart. PASS with test hooks for fault injection.
8. **Structured extraction** — PDF/DOCX structure, pagination, images, tables, validation limits. PASS.
9. **Deterministic profile extraction** — runs automatically during import; source evidence persisted. PASS.
10. **AI-assisted extraction** — real model produced 13 candidates (2 AI-method) in 29.5 s; deterministic precedence preserved. PASS for representative resume.
11. **Profile review/edit/verify/conflict** — unit/integration tested; UI source-reviewed; phase3 UI flows for values/backups. PASS/partial browser coverage.
12. **Form detection** — Google Forms and standard HTML forms. PASS.
13. **Matching** — deterministic first; local AI for empty ambiguous fields; source/review flags. PASS.
14. **User approval and fill** — explicit selection; sensitive approval path; no auto-submit. PASS in Google/standard audits.
15. **Read-back verification** — transformed/rejected phone reported as failed, not filled. PASS.
16. **Lock/unlock** — lock invalidates pending autofill approval; data persists. PASS.
17. **Backup/restore** — export, empty-target import, legacy v1/v2, tamper, crash/interruption. PASS.
18. **Browser restart/extension reload** — locks and restores vault data. PASS.
19. **Single continuous clean-install → backup restore script** — not executed as one script. Segmented evidence only. See gaps.

## 3. Feature-specific results

### Vault and encryption

- AES-256-GCM, per-record AAD, PBKDF2-SHA256 600,000 iterations, random salts/nonces, DEK/KEK separation: source-reviewed and unit-tested.
- Wrong passphrase, repeated attempts, lock/unlock, session generation, service-worker termination, extension reload, browser restart: tested and passing.
- Tampered ciphertext, wrong AAD, cross-record swaps, labels/evidence tamper, backup header tamper: tested and fail closed.
- Model/parser workers have no DEK/IDB access; phase3/offscreen tests assert no key-like fields in messages/diagnostics.
- No plaintext extracted text/document names in IndexedDB; structural metadata remains plaintext by design.
- Backup v3 does not expose plaintext values/text/passphrases; evidence/model provenance round-trips.

### Document ingestion

- Real Chromium PDF (multi-page), scanned PDF, mixed PDF, DOCX tables/headings/pagination/images, TXT/BOM/CRLF, duplicate files, corrupted/password PDFs: pass.
- Large 5,000-paragraph DOCX imported within bounds (phase4 log: ~2.6 s for 105 pages in that run).
- OCR-only and image-only PDFs stored with explicit review/failure states; no fabricated text.
- Interrupted import left no partial document/file/text triple; retry succeeded.
- Offscreen parser failure/crash/cancel/timeout left no partial records.
- DOCX ZIP/XML/image limits and structure validation tested.
- DOCX pagination is renderer-derived, not Word-verified.

### Local AI

- Cached and fresh real model install; SHA-256; corrupt/missing files fail closed.
- Chunked download with Range resume and Range-ignored restart; invalid Content-Range rejection; cancellation cleanup; hash mismatch cleanup; verified-cache reuse.
- Real inference, offline inference, self-test, idle/worker lifecycle, model removal/repair paths.
- Final audit metrics: install 15.8 s, self-test 10.7 s (load 6.1 s, inference 4.5 s), extraction 34.2 s, 2 accepted AI-method candidates, 13 total candidates.
- Prompt-injection unit test confirms ungrounded vault-like output is rejected; model has no vault access.
- Model-quality precision/recall not measured; only representative documents.

### Profile

- Deterministic extraction, grounded AI supplementation, evidence/page/block/model provenance, conflict creation, verified-value protection, stale evidence clearing, field verification, structured record synthesis: unit/integration pass.
- Manual edits/conflict selection clear stale evidence; backup round-trips evidence.
- UI source-reviewed; profile completeness fixed. Search/filter and some record-page flows are not full browser-tested.

### Autofill

- Google Forms scan/fill and standard HTML text/email/select/long-answer: pass.
- Manual approval token bound to tab/URL/content scan token/form fingerprint; one-time; rejected after navigation, cross-tab switch, lock, mutation, forged token, or reuse.
- Sensitive field approval logic exists; full browser E2E with a sensitive standard/Google field is limited.
- Read-back verification: a phone page that strips digits reports failure, not success.
- No submit observed in Google/standard audit.
- Standard radio/checkbox groups are browser-tested: only the approved gender/skill is selected; substring collisions are rejected.
- Same-origin iframes and open Shadow DOM are browser-tested; cross-origin/closed roots are explicitly unsupported.

### Backup/recovery

- v3 export/import, v1/v2 legacy import, wrong passphrase, tampered header, truncated payload, duplicate restore, non-empty target, process kill during restore, retry, migration SIGKILL, extension reload, service-worker termination: pass.
- Physical disk-full not tested; quota error simulated.
- Evidence and OCR/structure data survive restore.

### Settings/UI

- Model settings, security settings, passphrase, delete vault, preferences, backup page, router: pass.
- Inert controls previously identified were removed; `allowLongAnswers` now affects matching.
- Extension setup page uses a preview/demo; shortcut claims corrected.
- Accessibility/responsive behavior not systematically tested.
- CI workflow and local packaging were added; store signing/submission is still missing.

## 4. Defects found and fixed during audit

1. **High:** autofill approval not bound to scan/tab/page; fixed with approvals/tokens/fingerprint and retested.
2. **Medium:** form mutation after scan was not detected; fixed with fingerprint and retested.
3. **Medium:** pending approval survived vault lock; fixed and retested.
4. **Medium (functional):** country/city/state classification failed on normal repeated label/name/id; fixed and retested.
5. **Medium (functional):** standard select included placeholder and returned empty country; fixed and retested.
6. **Medium (defensive):** standard radio/checkbox did not require option-value matching; fixed and verified with a real radio/checkbox group, including the `Male`/`Female` substring collision.
7. **Low:** no prompt-injection regression test; added and passing.
8. **Low:** audit scripts for standard forms and approval binding were missing; added.

## 5. Test failures encountered and resolution

- First OCR run used the production build and failed timing/cancel/crash injection checks because those tests require test hooks. Rebuilt with `FORMFLOW_TEST_HOOKS=1`; OCR suite passed all checks. Production was rebuilt afterward.
- First migration-crash run used the production build and could not seed the v1 fixture; rerun with test hooks passed. Production was rebuilt afterward.
- One full `npm test` run under severe host load failed because the legacy server health check timed out; the immediate rerun passed 12/12 server tests. Recorded as test-harness flakiness, not a product failure.
- The suite expanded from 213 baseline tests to 229 after prompt-injection, classifier, option-matching, throttling, backup-policy, model-timeout, alias/chunk-cleanup, sensitivity, CORS, and audit regressions.

## 6. Untested / not fully verified

- Live Hugging Face CDN download under real network loss/throttling; controlled fixture only.
- WebGPU/Q4F16 inference.
- Model repository upgrades.
- Microsoft Word reference validation.
- Closed Shadow DOM and cross-origin frames remain unsupported by design.
- Accessibility, keyboard-only use, screen readers, responsive layouts.
- Peak browser/worker memory and long-run leak growth.
- Physical disk-full and browser quota exhaustion.
- Labeled document corpus precision/recall.
- Public distribution (store signing, privacy policy, update channel).
- Independent security audit.

## 7. Conclusion

Core daily-use workflows are functionally verified within the tested scope. Remaining gaps are concentrated in model quality/hardware coverage, advanced form surfaces, accessibility, live-network validation, and repository-history privacy. See `FINAL_AUDIT_SUMMARY.md` for readiness classification.
