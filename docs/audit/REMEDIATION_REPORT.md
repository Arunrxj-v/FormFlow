# FormFlow Remediation Report

Audit date: 2026-11-18  
No commit was created. All audit and remediation changes remain in the working tree for owner review.

The detailed post-audit remediation record is in `docs/FORMFLOW_REMAINING_ISSUES_REMEDIATION_REPORT.md`. This file summarizes what changed and the final verification state.

## 1. Remediation summary

| Finding | Severity | Action | Retest |
|---|---|---|---|
| F-01 personal documents in Git history/public remote | Critical | Current index cleaned; history/remotes **not rewritten**. Confirmed public GitHub exposure; guarded purge script added | Current index clean; public remote remains. **Unresolved** |
| F-02 autofill approval not bound to scan/tab/page/document | High | Background approval token; tab ID/exact URL; content scan token; form fingerprint; one-time use; lock invalidation; popup wiring | Google and standard browser audits PASS |
| F-03 post-scan form mutation | Medium | Content-script form fingerprint includes top document, open shadow roots, same-origin iframes; rejection on change | Standard audit mutation test PASS |
| F-04 approval survived lock | Medium | Clear pending approvals on locked state change | Standard audit lock/unlock test PASS |
| F-05 country/city/state classification | Medium functional | Unanchored word-boundary patterns; exact `Name` shortcut; select placeholder filtering | Classifier test and standard audit PASS |
| F-06 radio/checkbox wrong option | Medium defensive | Whole-option matching; no substring collisions; actual checked state returned | Real radio/checkbox group PASS |
| F-07 dev-only Vite/fdir/picomatch advisories | Low | Vite upgraded to 6.4.6; picomatch has no patched version | Production audit clean; 4 high dev-only remain |
| F-08 backup passphrase min 8 | Low | New exports require 12 Unicode code points; old archives still restore; central validation + UI | Policy/compatibility tests PASS |
| F-09 unlock delay resets on restart | Low | Persistent IndexedDB throttling; serialized attempts; progressive 1–60 s cap | Restart/concurrency/corruption tests PASS |
| F-10 legacy server defaults | Low/Medium if exposed | Loopback bind; exact-origin CORS; headers; upload/auth/global limits; production secret policy | Server tests PASS (13) |
| F-11 model aliases not rehashed | Low | Loader and worker rebuild aliases from verified pinned bytes; re-hash at load | Real model E2E PASS |
| F-12 live CDN/CI/publication gaps | Low | CI + package script + live small-file/range checks. Full 734 MiB live download NOT RUN | Partial; documented |
| F-13 independent audit | Informational | Not performed | Documented |
| New: sensitive match downgraded by vault metadata | Medium | Scan sensitivity OR stored sensitivity; contact/address fields marked sensitive | Unit test + browser sensitivity audit PASS |
| New: onboarding/search/iframe/Shadow DOM/accessibility gaps | Medium functional | Resumable onboarding, filters, same-origin iframe/open shadow support, modal/focus/responsive improvements | New browser audits PASS |
| New: no CI/package | Medium process | `.github/workflows/ci.yml`, `scripts/package-extension.mjs`, release/privacy docs | Package built and verified |

## 2. Fixed code paths

### Autofill and freshness

- `shared/messages.ts` — `ScanPayload.scanToken`.
- `extension/src/content.ts` — per-scan token, form fingerprint across roots, rejection after token/fingerprint mismatch, token cleared after fill.
- `extension/src/background.ts` — approval map, 10-minute TTL, active-tab/exact-URL checks, one-time token, lock clearing, required `approvalToken`, token forwarded to content script.
- `extension/src/popup/Popup.tsx` — stores scan approval token; refuses fill without it.
- `extension/src/lib/matcher.ts` — sensitivity cannot be downgraded by stored metadata.

### Forms, iframes, Shadow DOM

- `extension/src/lib/dom.ts` — open shadow root and same-origin iframe traversal, depth-limited.
- `extension/src/adapters/StandardFormAdapter.ts` — cross-realm-safe controls, element registry, root-scoped labels, safe option matching.
- `extension/src/lib/classifier.ts` — fixed country/city/state, exact `Name`, sensitive email/phone/address.
- `extension/test/classifier.test.ts`, `tests/unit/ai-matcher.test.ts` — regressions.

### Vault and backup security

- `core/vault/vault-manager.ts` — persistent unlock throttling, serialized attempts, no secrets in throttle state.
- `core/encryption/crypto-service.ts`, `core/storage/vault-export.ts` — central backup passphrase policy.
- `shared/constants.ts`, `shared/types.ts`, `core/database/*` — DB v3 `securityState` store.
- `src/pages/vault/VaultMigrationPage.tsx` — 12-code-point UI policy.

### Model integrity and inference

- `ai/runtime/model-loader.ts` — verified alias rebuild, incomplete-part cleanup.
- `extension/src/model/model-worker.ts` — independent alias re-hash before load.
- `extension/src/model/model-manager.ts`, `shared/model-timeouts.ts`, `shared/constants.ts` — split load/generation timeouts, token scaling, concurrency guard.

### Server

- `server/index.mjs` — loopback bind, exact-origin CORS, headers, upload limit, origin validation, safe startup.
- `server/security.mjs` — production secret minimum/uniqueness.
- `server/test/api.test.mjs` — CORS/preflight tests.

### Onboarding, search, accessibility

- `src/pages/onboarding/OnboardingPage.tsx`, `src/App.tsx`, `src/pages/dashboard/OverviewPage.tsx`, `src/pages/settings/SettingsPage.tsx` — resumable first-run guide.
- `core/application/vault-service.ts` — new vaults start onboarding incomplete.
- `src/pages/documents/DocumentsPage.tsx`, `src/pages/records/PersonalProfilePage.tsx` — filters/search/reset.
- `src/components/ui/Modal.tsx`, `src/context/ToastContext.tsx` — focus trap/restore, alert semantics.

### Release/CI

- `scripts/package-extension.mjs`, `package.json`, `.github/workflows/ci.yml`, `.gitignore`.
- `scripts/security/purge-history.sh` — guarded manual history-purge procedure; not executed.

## 3. Tests added

- `tests/unit/unlock-throttle.test.ts`
- `tests/unit/backup-passphrase.test.ts`
- `tests/unit/model-timeouts.test.ts`
- `tests/unit/model-download.test.ts` (stale chunk cleanup)
- `tests/unit/ai-matcher.test.ts` (sensitivity downgrade)
- `extension/test/classifier.test.ts` (sensitive classification)
- `server/test/api.test.mjs` (CORS)
- `scripts/dev/e2e-onboarding.mjs`
- `scripts/dev/audit-ui-accessibility.mjs`
- `scripts/dev/audit-memory.mjs`
- `scripts/dev/audit-webgpu-fallback.mjs`
- expanded `scripts/dev/audit-standard-form.mjs` (iframe/shadow/sensitive/radio/checkbox/mutation/cross-tab/lock)

Existing assertions were not weakened or deleted. Test-hook builds were used only for fault-injection suites; production was rebuilt afterward and contains zero test-hook markers.

## 4. Final retest results

- `npm test`: **229 tests, 229 pass, 0 fail**
  - local/unit 200
  - extension 16
  - server 13
- Typecheck: pass.
- Dashboard build: pass (4.41 s; large-chunk warning only).
- Extension build: pass; 111 files; 51,061.6 KB.
- `npm audit --omit=dev`: 0 vulnerabilities.
- Full audit: 4 high dev-only picomatch-chain advisories, no patched version.
- Package: `release/formflow-extension-2.0.0.zip`, 111 files, SHA-256 `a5654173…c78a`.
- Browser suites: phase3, phase4 ingestion, OCR (hooks), offscreen (hooks), interruption, reload, recovery crash, migration crash (hooks), content isolation, router, real model, onboarding, UI accessibility, WebGPU fallback, Google Forms binding, standard form/iframe/shadow — all PASS.
- Chrome 113 headed onboarding + standard-form audits — PASS.
- Chrome 159 headless full set — PASS.

## 5. Unresolved / not safely fixable here

1. **F-01 public Git history exposure** — requires immediate owner action: make private/delete, mirror, rewrite, force-push, purge forks/caches, rotate/replace the identity document.
2. **Dev-only picomatch ReDoS** — no upstream patch; not shipped.
3. **Full 734 MiB live model download/resume** — not run; small live files/range/redirect/416 verified.
4. **WebGPU/Q4F16** — not enabled; WASM-only is deliberate and fallback-tested.
5. **Word reference pagination** — genuine Word output unavailable.
6. **Physical disk-full, per-worker heap, long-run leak growth** — not measured.
7. **Full WCAG/screen-reader accessibility audit** — practical checks only.
8. **Firefox/Safari** — unsupported; Edge/Brave not tested.
9. **Independent security/privacy review** — not performed.
10. **Store signing/submission/privacy listing** — not configured.
11. **Model repository upgrade** — not implemented.

## 6. Git status

All changes remain uncommitted. HEAD at final verification is `1f3d185 security audit`; the owner committed the prior audit during remediation. Baseline audit commit was `fc09d3c`. `.model-cache/`, `extension/dist`, `dist`, `release/`, `tests/.build/`, and `server/storage/` remain ignored. No model binaries, secrets, or new personal documents were added to the index.
