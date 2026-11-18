# FormFlow Remaining Issues Remediation Report

Date: 2026-11-18  
Branch: `feature/phase-4-document-ingestion`  
HEAD at final verification: `1f3d185 security audit` (owner committed/pushed the prior audit during this remediation; baseline was `fc09d3c`)  
Working tree: **uncommitted remediation + audit changes**; no commit was created unless the owner commits them.

## 1. Executive result

This pass closed the backup-policy, unlock-throttling, server-default, model-alias, sensitive-classification, onboarding, search/filter, iframe/Shadow DOM, accessibility, packaging, and CI gaps. It also re-verified autofill approval binding and the real model workflow.

One critical issue remains unresolved and is **worse than previously stated**: the GitHub repository is public and the default remote branch still serves a personal identity PDF from history. That is a confirmed public exposure requiring owner action. Details are in `docs/FORMFLOW_SECURITY_HARDENING.md` and `docs/audit/SECURITY_AUDIT_REPORT.md`.

## 2. Audit issue closure

| Issue | Original status | Final status | Evidence |
|---|---|---|---|
| F-01 personal PDFs in Git history | Critical, unresolved | **Confirmed critical, unresolved**. Public GitHub repo; `raw.githubusercontent.com/.../migration/local-first/.../ArunrajV_aadhar.pdf` returned HTTP 200, 2,654,171 bytes. Current index is clean. | Remote refs, raw HEAD response, local OCR classification; no content printed. Manual purge script provided; not executed. |
| F-02 autofill approval not tab/page-bound | High | Fixed in audit; re-verified | `audit-autofill-binding.mjs`, `audit-standard-form.mjs`; tab/URL/scan/fingerprint binding, single-use, lock clearing |
| F-03 post-scan form mutation | Medium | Fixed; re-verified | Form fingerprint includes iframe/shadow roots; mutation rejected |
| F-04 approval survived lock | Medium | Fixed; re-verified | Lock/unlock audit rejects old token |
| F-05 country/city/state classifier | Medium | Fixed; re-verified | Classifier tests; standard audit fills Country |
| F-06 radio/checkbox wrong option | Medium | Fixed; browser-verified | Real radio/checkbox groups select only approved values; `Male`/`Female` collision tested |
| F-07 dev dependency advisories | Low | **Partially resolved** | Vite 6.4.6 removed Vite advisories; `picomatch <=4.0.7` has no patched version. Full audit: 4 high dev-only; production audit clean. |
| F-08 backup passphrase | Low | Fixed | New exports require 12 Unicode code points; old archives still restore; tests added |
| F-09 unlock delay resets | Low | Fixed | Persistent IndexedDB throttle, serialized attempts, restart/concurrency/corruption tests |
| F-10 legacy server defaults | Low/Medium if exposed | Hardened | Loopback bind, exact-origin CORS, upload/auth/global limits, security headers, production secret policy, tests |
| F-11 model aliases not rehashed | Low | Fixed | Loader and worker rebuild aliases from verified bytes and re-hash them; real model E2E passes |
| F-12 live CDN / CI / release gaps | Low | **Partially resolved** | Live small-file hashes + range/redirect/416 verified; full 734 MiB live download NOT RUN. CI workflow and packaging added. |
| F-13 no independent audit | Informational | Unresolved | No external security/crypto review performed |
| New: sensitive match could be downgraded | Medium | Fixed | `buildSuggestions` uses scan sensitivity OR stored sensitivity; browser audit checks email/phone/address/DOB/ID |
| New: iframe/Shadow DOM unsupported | Medium functional gap | Implemented and verified for same-origin iframes + open Shadow DOM | Standard audit scans/fills both; cross-origin and closed roots explicitly unsupported |
| New: onboarding incomplete | Medium functional gap | Implemented and verified | `/onboarding` wizard, persisted/resumable state, dashboard first-run card, skip/reopen; `e2e-onboarding.mjs` passes |
| New: search/filter gaps | Low functional | Implemented and verified | Document type/status/category/search/reset; profile search/verification filter/reset; `audit-ui-accessibility.mjs` |
| New: accessibility gaps | Low/Medium | Improved, partially verified | Dialog focus entry/restore/trap, Escape, aria-modal, live alerts, visible focus, reduced motion, responsive 1280/768; no full WCAG audit |
| New: browser floor unverified | Low | Defined and tested | Manifest minimum Chrome 113; tested 113 headed and 159 headless |
| New: no release packaging/CI | Medium process gap | Implemented | `scripts/package-extension.mjs`, `.github/workflows/ci.yml`, release/privacy docs; store signing/submission still absent |
| WebGPU/Q4F16 | Not implemented | **Deliberately not enabled** | Capability probe + WASM fallback audit; Q4F16 requires separate unvalidated artifact/runtime |
| Word reference pagination | Unverified | Still unverified | Renderer-derived pagination remains labelled unverified; no Microsoft Word reference |
| Model upgrade/migration | Missing | Still missing | Pinned model remains known-good; no upgrade mechanism |
| Full live model download | Unverified | **Not run** | Avoided 734 MiB re-download; small live files and range responses verified |
| Physical disk-full, peak per-worker heap, long-run leak | Unverified | Unverified | Quota simulated; process-sum RSS measured; no per-worker heap |
| Independent security/privacy review | Missing | Missing | Required before public release |

## 3. Root causes and implementation details

### 3.1 Backup policy

Root cause: a hard-coded `passphrase.length < 8` check in `vaultExportService.exportEncrypted` and an 8-character background validator. There was no central policy, and UTF-16 `.length` would miscount emoji.

Fix: `validateBackupPassphrase` in `core/encryption/crypto-service.ts` uses `Array.from(...).length` (code points), rejects empty/whitespace-only, enforces 12–200 for new exports. Import/restore leaves archive compatibility untouched. UI counts code points and explains the new minimum.

Files: `shared/constants.ts`, `core/encryption/crypto-service.ts`, `core/storage/vault-export.ts`, `extension/src/background.ts`, `src/pages/vault/VaultMigrationPage.tsx`, `tests/unit/backup-passphrase.test.ts`.

### 3.2 Persistent unlock throttling

Root cause: `VaultManager.failedAttempts` was a module field; MV3 worker restarts discarded it.

Fix: new `securityState` IndexedDB store (DB v3), `UnlockThrottleRecord`, serialized `unlockQueue`, progressive 1–60 s lockout, success/passphrase-change clears state, corrupt metadata fails open. No secrets stored.

Files: `shared/types.ts`, `shared/errors.ts`, `shared/constants.ts`, `core/database/schema.ts`, `core/database/database.ts`, `core/vault/vault-manager.ts`, `tests/unit/unlock-throttle.test.ts`.

### 3.3 Server hardening

Root cause: dev server bound all interfaces, set CORS allow-origin unconditionally, and only checked that `AUTH_SECRET` existed in production.

Fix: loopback default, exact-origin CORS with 403, security headers, explicit origin validation, 20/min upload limit, production secret minimum/uniqueness, development warnings. Development server remains non-production.

Files: `server/index.mjs`, `server/security.mjs`, `server/test/api.test.mjs`.

### 3.4 Model alias integrity and install cleanup

Root cause: main-revision aliases were copied only when missing, trusting prior cache contents; failed installs left resumable chunks.

Fix: `syncVerifiedAliases` in the loader and a re-hashing alias builder in the model worker; aliases are always rebuilt from pinned revision bytes. Failed/cancelled installs call `clearIncompleteParts`. `verify()` marks corrupt if alias sync fails.

Files: `ai/runtime/model-loader.ts`, `extension/src/model/model-worker.ts`, `tests/unit/model-download.test.ts`.

### 3.5 Inference timeout and concurrency

Root cause: one fixed 180 s generation timeout, shared across model load and inference; concurrent inference could share a generator.

Fix: separate 240 s load, 300 s base generation, 1.5 s/token scaling capped at 600 s; `inferenceInFlight` rejects concurrent self-test/inference with a clear error; cancellation still disposes the worker. Deterministic extraction remains independent.

Files: `shared/constants.ts`, `shared/model-timeouts.ts`, `extension/src/model/model-manager.ts`, `tests/unit/model-timeouts.test.ts`.

### 3.6 Sensitive-field downgrade

Root cause: `sensitive: Boolean(item?.sensitive ?? field.sensitive)` let a stored non-sensitive flag override the scanned field classification.

Fix: logical OR, so either source can require extra review. Email/phone/address now sensitive in classifier; DOB/registration/ID already were.

Files: `extension/src/lib/matcher.ts`, `extension/src/lib/classifier.ts`, `tests/unit/ai-matcher.test.ts`, `extension/test/classifier.test.ts`, standard audit.

### 3.7 Iframe and Shadow DOM

Root cause: standard adapter used top-document `querySelectorAll`, top-realm `instanceof`, and top-document label lookup.

Fix: `extension/src/lib/dom.ts` traverses open shadow roots and same-origin iframes (depth 3, visible frames only). Standard adapter keeps an element registry, uses tag/property duck-typing, owner-document prototypes, and root-scoped labels. Fingerprint includes all roots. Cross-origin/closed roots are skipped.

Files: `extension/src/lib/dom.ts`, `extension/src/adapters/StandardFormAdapter.ts`, `extension/src/content.ts`, `scripts/dev/audit-standard-form.mjs`.

### 3.8 Onboarding

Root cause: vault creation marked onboarding complete and the old Drive-based onboarding was deleted; no local workflow existed.

Fix: `OnboardingPage` with welcome, optional model, documents, review, ready steps; persisted `currentStep/completed`; dashboard first-run card; Settings reopen; skip/reopen; no forced upload; no duplicate vault/model creation. Vault creation now starts onboarding incomplete.

Files: `src/pages/onboarding/OnboardingPage.tsx`, `src/App.tsx`, `src/pages/dashboard/OverviewPage.tsx`, `src/pages/settings/SettingsPage.tsx`, `src/pages/vault/VaultSetupPage.tsx` (unchanged navigation), `core/application/vault-service.ts`, setup-state messages/client, `scripts/dev/e2e-onboarding.mjs`.

### 3.9 Search, filters, accessibility

- Document filters: file type added; reset covers search/category/status/type.
- Profile: search over label/key/value/source, verification-state filter, reset, match count.
- Modal: focus entry, Tab trap, Escape, focus restore, `role=dialog`, `aria-modal`.
- Toasts: errors use `role=alert`.
- Responsive/accessibility audit at 1280 and 768; visible focus and reduced motion already existed.

Files: `src/pages/documents/DocumentsPage.tsx`, `src/pages/records/PersonalProfilePage.tsx`, `src/components/ui/Modal.tsx`, `src/context/ToastContext.tsx`, `scripts/dev/audit-ui-accessibility.mjs`.

### 3.10 Packaging and CI

- `scripts/package-extension.mjs` verifies required files, rejects model binaries/source/tests/maps/test hooks, scans secrets, produces ZIP + SHA-256 + metadata.
- `.github/workflows/ci.yml` runs install/typecheck/tests/builds/audits/package plus browser smoke; model validation is a separate manual job.
- `npm run package:extension` added.

## 4. Tests added or updated

- `tests/unit/unlock-throttle.test.ts` — progressive delay, restart persistence, concurrency, corruption, future deadline.
- `tests/unit/backup-passphrase.test.ts` — empty/short/long/Unicode policy, export, restore compatibility.
- `tests/unit/model-timeouts.test.ts` — timeout scaling/cap.
- `tests/unit/model-download.test.ts` — stale chunk cleanup.
- `tests/unit/ai-matcher.test.ts` — scan-level sensitivity cannot be downgraded.
- `extension/test/classifier.test.ts` — sensitive classification for contact/address/DOB/ID.
- `server/test/api.test.mjs` — exact-origin CORS/preflight.
- `scripts/dev/e2e-onboarding.mjs` — fresh onboarding, resume, skip, completion, reopen.
- `scripts/dev/audit-standard-form.mjs` — same-origin iframe, open Shadow DOM, cross-origin exclusion, sensitive flags, radio/checkbox, mutation/cross-tab/lock.
- `scripts/dev/audit-ui-accessibility.mjs` — responsive overflow, filters, empty states, modal focus/Escape, keyboard focus.
- `scripts/dev/audit-memory.mjs` — process-sum memory sampling.
- `scripts/dev/audit-webgpu-fallback.mjs` — WebGPU-disabled fallback.
- `scripts/dev/e2e-phase42-model.mjs` — RSS phase sampling.

## 5. Exact test results

Final full automated suite:

- **229 tests, 229 pass, 0 fail**
  - local/unit: **200**
  - extension: **16**
  - server: **13**
- Typecheck: pass.
- Dashboard build: pass, 4.41 s; main JS 765.07 kB (gzip 211.91 kB); large-chunk warning remains.
- Extension build: pass; 111 files; 51,061.6 KB.
- Production audit: 0 vulnerabilities.
- Full audit: 4 high dev-only (`picomatch` chain, no upstream patch).
- Package: `release/formflow-extension-2.0.0.zip`, 111 files, SHA-256 `a5654173…c78a`.

Browser suites:

- `e2e-phase3` — PASS
- `e2e-phase4-ingestion` — PASS
- `e2e-phase412-ocr` (test hooks) — PASS
- `e2e-phase4-offscreen` (test hooks) — PASS
- `e2e-phase4-interruption` — PASS
- `e2e-extension-reload` — PASS
- `e2e-recovery-crash` — PASS
- `e2e-migration-crash` (test hooks) — PASS
- `e2e-content-isolation` — PASS
- `e2e-router-navigation` — PASS
- `e2e-phase42-model` — PASS (install 15.0 s; self-test 8.3 s; extraction 29.5 s)
- `audit-autofill-binding` — PASS
- `audit-standard-form` — PASS
- `e2e-onboarding` — PASS
- `audit-ui-accessibility` — PASS
- `audit-webgpu-fallback` — PASS
- Chrome 113 headed: onboarding + standard-form/iframe/shadow/autofill — PASS
- Chrome 159 headless: full browser set — PASS

Production build after test-hook runs was rebuilt; `background.js`, `offscreen-parser.js`, and `content.js` contain zero test-hook markers.

## 6. Known limitations

1. F-01 public Git history exposure remains.
2. Dev-only `picomatch` ReDoS has no patched version.
3. Full 734 MiB live download/resume not repeated.
4. WebGPU/Q4F16 inference not enabled.
5. Word reference pagination unavailable.
6. Physical disk-full, per-worker peak heap, long-run leak growth not measured.
7. Accessibility audit is practical, not a full WCAG/screen-reader certification.
8. Browser compatibility beyond Chrome 113/159 not tested; Firefox/Safari unsupported.
9. No independent security/cryptographic/privacy review.
10. Store signing, listing, data-use disclosure, and update ownership not configured.
11. Model upgrade/migration mechanism still absent.
12. Legacy development server must never be exposed publicly.

## 7. Git state

- No commit was created by this remediation. HEAD is `1f3d185`; the owner committed the prior audit changes during the task.
- The working tree contains the prior audit changes plus this remediation.
- `.model-cache/` remains ignored/untracked.
- `extension/dist`, `dist`, `release/`, `tests/.build/`, and `server/storage/` remain ignored.
- No model binaries, secrets, or new personal documents were added to the index.
- `release/formflow-extension-2.0.0.zip` is a local artifact and must not be committed.
