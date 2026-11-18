# FormFlow Security Audit Report

Audit date: 2026-11-18  
Scope: source review, encrypted-vault review, worker/message boundaries, model lifecycle, autofill, legacy server, dependency/Git history review, adversarial tests, and selected Chromium execution.

No claim of being vulnerability-free is made. This is a targeted source and runtime assessment, not a formal cryptographic audit or penetration test.

## Findings summary

| ID | Severity | Title | Status |
|---|---|---|---|
| F-01 | Critical | Personal documents remain in reachable Git history and a PUBLIC remote branch | **Confirmed public exposure; unresolved**; current index clean |
| F-02 | High | Autofill approval was not bound to the scanned tab/page/document | Fixed and verified |
| F-03 | Medium | Form could be mutated after scan without invalidating approval | Fixed and verified |
| F-04 | Medium | Pending autofill approval survived a vault lock/unlock | Fixed and verified |
| F-05 | Medium | Standard-form country/city/state classification failed when label/name/id repeated | Fixed and verified |
| F-06 | Medium | Standard radio/checkbox fill could select an option without matching the approved value (including Male/Female substring collision) | Fixed and verified in browser groups |
| F-07 | Low | Dev-only Vite/fdir/picomatch advisories | Partially resolved: Vite 6.4.6; picomatch has no patch |
| F-08 | Low | Backup passphrase accepts only 8 characters and has no strength check | Fixed for new backups; old archives still restore |
| F-09 | Low | Unlock delay counter resets with service-worker restart | Fixed with persistent throttling |
| F-10 | Low | Legacy server has a default development auth secret and in-memory rate limits | Hardened; still development-only |
| F-11 | Low | Model main-revision aliases are not independently rehashed at load | Fixed; aliases rebuilt from verified bytes |
| F-12 | Low | No live internet model-download test, CI configuration, or public-release packaging | Partially resolved; full live download still not run |
| F-13 | Informational | No independent security audit or formal cryptographic verification | Accepted limitation |
| F-14 | Medium | Scan-level sensitive classification could be downgraded by stored vault metadata | Fixed and browser-verified |
| F-15 | Medium (functional/process) | Onboarding, search/filter, iframe/Shadow DOM, accessibility, and CI/release gaps | Implemented/verified; public release and full accessibility audit remain |
| F-16 | Informational | WebGPU/Q4F16 inference is not enabled | Deliberately scoped to verified WASM; fallback tested |

---

## F-01 — Personal documents in Git history and remote branches

**Severity:** Critical (repository privacy/data exposure)  
**Affected component:** Git repository, legacy `server/storage/documents`  
**CWE:** CWE-538 (Insertion of Sensitive Information into Externally-Accessible File or Directory) is applicable as a descriptive classification; no formal scoring is claimed.

### Description

Three legacy uploaded PDFs (one small degree-style PDF and two identical identity-document blobs) were tracked in an early backend checkpoint. They were removed from the current index in `fc09d3c`, but the blobs remain reachable in:

- local branch `main` (`9f9632f`)
- `origin/migration/local-first` (the GitHub default branch)
- `security/phase-3.1.2`, `backup/pre-model-cache-cleanup`, and old feature history
- any clone/fetch of those refs

The GitHub repository is **public** (`private: false`). During this audit, a raw GitHub URL for the identity PDF on `migration/local-first` returned HTTP 200 with `content-length: 2654171`. That confirms public retrieval. Local OCR classified the PDF as a government identity document; its contents were not printed or copied into this report.

The files still exist in the local working tree under `server/storage/documents/`; `server/storage/` is ignored, so they are no longer tracked by the current branch tip. Ignoring them does not remove history or remote copies.

### Attack scenario / impact

Anyone with repository access or a clone can recover the personal PDFs from history. This can disclose identity information, a degree document, and filenames. It is not an extension-runtime vulnerability, but it is a real privacy and repository-security incident.

### Reproduction

`git log --all -- server/storage/documents` shows the historical commits; `git ls-tree -r main --name-only` / `origin/migration/local-first` lists the paths. Verify the current branch tip with `git ls-files server/storage` (empty).

### Remediation

- Current-tree remediation applied: `git rm --cached -r server/storage/documents`, existing `.gitignore` entry for `server/storage/`.
- Required external remediation: make the repository private/delete it while assessing exposure; mirror-clone; rewrite with `git filter-repo`; force-push all refs/tags after coordination; invalidate clones/forks; ask GitHub Support to purge cached views; rotate/replace the exposed identity document.
- A guarded manual script is provided at `scripts/security/purge-history.sh`. It refuses to run without `FORMFLOW_CONFIRM_HISTORY_REWRITE=YES` and does not push. This audit did not rewrite history or force-push.

### Retest / status

Current tracked tree: no personal PDFs. Public remote exposure remains. **Unresolved critical repository finding; owner action required immediately.**

---

## F-02 — Autofill approval was not bound to the scanned tab/page/document

**Severity:** High (unsafe cross-tab/cross-site autofill)  
**Affected component:** `extension/src/background.ts`, `extension/src/content.ts`, popup  
**CWE:** CWE-346 (Origin Validation Error) as a descriptive classification.

### Description

Before remediation, `GET_FORM_SUGGESTIONS` returned matches without an approval capability. `FILL_ACTIVE_TAB` re-queried the active tab and sent approved values there. If the user navigated or switched tabs after reviewing suggestions, approved values could be sent to a different page/tab. The content script accepted only fills, not a scan-instance token.

### Reproduction / evidence

The new `scripts/dev/audit-autofill-binding.mjs` test verifies:

- scan returns a tab-bound approval token and content scan token;
- fill without approval is rejected;
- forged content token is rejected;
- navigation to a different URL invalidates approval and leaves the new page empty;
- rescan + fill works only on the scanned page;
- token is single-use;
- reused token cannot overwrite the page.

The Google Forms and standard-form audit scripts both pass after the fix.

### Remediation implemented

- Background issues a random approval token bound to `tabId`, exact URL, scan token, and a 10-minute expiry.
- `FILL_ACTIVE_TAB` requires the token, consumes it once, checks the current active tab ID and exact URL, and sends the bound scan token to the content script.
- Content script generates a scan token per scan; fill requires the exact token.
- Content script stores a form fingerprint (control tag/type/name/id/aria/placeholder/form count) and rejects fill if the form changed.
- Locking the vault clears all pending scan approvals.
- Popup stores the approval token from the scan response and never fills without it.

### Residual risk

A same-origin page with identical URL and identical form fingerprint could be indistinguishable after navigation; the content scan token is lost on reload, so a fill after reload is rejected. Highly dynamic pages require a rescan. Trusted extension pages remain a trust boundary.

### Retest

`audit-autofill-binding.mjs`: PASS.  
`audit-standard-form.mjs`: PASS, including lock invalidation, mutation rejection, cross-tab rejection, read-back, no-submit, approved-only radio/checkbox selection, same-origin iframe, open Shadow DOM, and sensitive-field flags.

---

## F-03 — Form mutation after scan was not detected

**Severity:** Medium  
**Affected component:** content script/form adapters  
**CWE:** No precise CWE claimed; a stale authorization/state validation issue.

### Description

The content script could scan a page, then the page could replace or relabel controls before the user approved. Field indices could point to different controls.

### Remediation implemented

Added `formFingerprint()` in `extension/src/content.ts`; a fill is rejected if the control set or identifying attributes changed after scan. The standard audit mutates a field `name` after scanning and confirms the fill is rejected and the page is unchanged.

### Retest

`audit-standard-form.mjs`: form mutation rejected; no fill occurred.

---

## F-04 — Pending approval survived vault lock

**Severity:** Medium  
**Affected component:** background approval state  
**CWE:** No precise CWE claimed.

### Description

An approval issued before a vault lock could remain in memory and be usable after unlocking, which conflicts with the expected lock boundary for a pending autofill operation.

### Remediation implemented

`operationCoordinator.onChange` clears `scanApprovals` when the vault transitions to locked.

### Retest

`audit-standard-form.mjs` scans, locks, unlocks, and attempts the old token: rejected; rescan required.

---

## F-05 — Standard form classifier lost country/city/state when label/name/id repeated

**Severity:** Medium (functional matching error)  
**Affected component:** `extension/src/lib/classifier.ts`, `StandardFormAdapter`  
**CWE:** Not a security classification.

### Description

The classifier joined label/name/id/placeholder into one string, then used anchored patterns such as `/^country$/`. A normal control with label `Country`, name `country`, id `country` produced `Country country country`, so the anchored rule failed and the field was `unknown`. The standard-form audit also found select placeholder options (`Choose`) were included and the country suggestion was empty.

### Remediation implemented

- Moved country/city/state rules to unanchored word-boundary patterns.
- Added an exact-label `Name` shortcut for full-name classification.
- Filtered `Choose`/`Select` placeholder options in the standard adapter.

### Retest

`classifier.test.ts` includes repeated-token cases. `audit-standard-form.mjs` now matches and fills Country, reports 3 filled + 1 rejected phone, and preserves no-submit behavior.

---

## F-06 — Standard radio/checkbox fill did not require value-option matching

**Severity:** Medium (potential wrong option selection)  
**Affected component:** `extension/src/adapters/StandardFormAdapter.ts`  
**CWE:** No precise CWE claimed.

### Description

The standard adapter clicked a radio/checkbox without verifying that the approved value matched the option's accessible label. A misclassified group could select an unrelated option.

### Remediation implemented

`setNativeValue` now derives the option label and only clicks when the approved value matches it; it returns the actual checked state. Matching now uses normalized whole-option equality/acronym compaction, not substring inclusion, so `Male` cannot match `Female`. The standard audit now includes a real radio group and checkbox group and verifies only the approved option is selected.

### Retest

Typecheck/extension tests pass. `audit-standard-form.mjs` verifies a real radio group and checkbox group: only `Male` and `TypeScript` are selected; the wrong `Female`/`Python` options are not.

---

## F-07 — Development-only Vite/fdir/picomatch advisories

**Severity:** Low for the shipped extension, residual supply-chain risk for development  
**Affected component:** npm dev dependencies

Vite was updated to 6.4.6, which removes the Vite dev-server path-traversal advisories. `npm audit --omit=dev` reports **0 vulnerabilities**. Full `npm audit` still reports 4 high advisories through `picomatch <= 4.0.7` and its fdir/tinyglobby dependents. The advisory has **no patched npm version** (“Patched versions: None”). These packages are build-time only and are not in `extension/dist` or the dashboard runtime.

**Residual:** accepted dev-only ReDoS until picomatch publishes a fix. Verify production output remains free of dev dependencies.

---

## F-08 — Backup passphrase strength

**Severity:** Low  
**Affected component:** `VaultMigrationPage`, backup export

New backup exports now require at least 12 Unicode code points through a central `validateBackupPassphrase` policy. Import/restore does not apply the new minimum, so archives created with the old 8-character policy remain restorable. PBKDF2 at 600,000 iterations remains the primary offline-guessing cost. Tests cover empty/short/long/Unicode/wrong-passphrase and compatibility.

---

## F-09 — Unlock attempt delay resets after service-worker restart

**Severity:** Low  
**Affected component:** `core/vault/vault-manager.ts`

Fixed. Failed attempts and the lockout deadline are persisted in the `securityState` IndexedDB store, attempts are serialized, and the delay doubles from 1 s to a 60 s cap after the third failure. Success/passphrase change clears it; corrupt metadata fails open. Tests cover restart, concurrency, corruption, and clock-deadline behaviour. A local attacker who can edit browser storage can still bypass this; PBKDF2 remains the primary offline cost.

---

## F-10 — Legacy server defaults and rate limits

**Severity:** Low/Medium only if exposed publicly  
**Affected component:** `server/index.mjs`, `server/security.mjs`

Hardened. The server binds to `127.0.0.1` by default, sets CORS only for the exact configured origin, rejects other browser origins, adds security headers, limits uploads to 20/min, and requires a unique 32+ character `AUTH_SECRET` in production. It remains a development/migration surface; durable rate limiting and public deployment are not provided. Do not expose it publicly.

---

## F-11 — Model main-revision aliases are not independently rehashed at load

**Severity:** Low (trusted extension-origin cache)  
**Affected component:** `extension/src/model/model-worker.ts`, `ai/runtime/model-loader.ts`

Fixed. The loader and model worker rebuild the `config.json`/`tokenizer_config.json` main-revision aliases from the pinned revision bytes on every install/verify/load, and the worker re-hashes those bytes against the registry before pipeline discovery. A tampered alias is replaced; a tampered revision file fails closed as `corrupt`. Failed/cancelled installs also clear partial chunks.

---

## F-12 — Verification/publication gaps

**Severity:** Low/informational  
**Affected component:** release process

- CI (`.github/workflows/ci.yml`) and a reproducible package script were added. Store signing/submission is still absent.
- Live Hugging Face redirects, range responses, invalid-range handling, and small-file SHA-256 values were verified. A full 734 MiB live download/resume was **not run**.
- WebGPU/Q4F16 inference remains deliberately disabled; WASM fallback is verified.
- Model repository upgrades are still not implemented.
- Microsoft Word reference pagination is still unavailable.
- A public-store package/signing/privacy-policy/update channel is still not configured.

These are readiness gaps, not evidence of a runtime vulnerability.

---

## F-13 — No independent security audit

**Severity:** Informational  
**Affected component:** whole application

This audit is source-based plus targeted execution. It cannot prove absence of vulnerabilities. No formal crypto review, penetration test, fuzzing campaign, or third-party assessment was performed.

---

## F-14 — Sensitive match could be downgraded by stored metadata

**Severity:** Medium  
**Affected component:** `extension/src/lib/matcher.ts`

`buildSuggestions` used `item?.sensitive ?? field.sensitive`. A stored vault field with `sensitive: false` could override a scanned form field that the classifier marked sensitive (for example email or phone). The matcher now uses `item?.sensitive || field.sensitive`, so either source can require the extra-review confirmation. Email, phone, address, birth date, registration number, and identification number are classified sensitive. A real-browser audit verifies all five flags and the popup confirmation path. Regression test: `tests/unit/ai-matcher.test.ts`.

## F-15 — Functional/process gaps

**Severity:** Medium (functional/process, not a runtime vulnerability)  
**Affected component:** onboarding, search/filter, iframe/Shadow DOM, accessibility, CI/release

- Multi-step onboarding was missing; a resumable local wizard is now implemented and browser-tested.
- Document type filters and profile search/verification filters were incomplete; both are implemented and browser-tested.
- Same-origin iframes and open Shadow DOM are now scanned/filled safely; cross-origin and closed roots remain explicitly unsupported.
- Modal focus entry/trap/restore, Escape, live alerts, responsive overflow, and keyboard focus were improved and browser-tested. Full WCAG/screen-reader certification was not performed.
- CI and a reproducible package script were added. Store signing/submission, privacy/legal review, and an independent security review remain missing.

## F-16 — WebGPU/Q4F16 not enabled

**Severity:** Informational  
**Affected component:** local model runtime

WebGPU capability is detected for diagnostics, but inference uses the verified Q8 WASM artifact. Enabling Q4F16 would require a separate model download, quantization/runtime validation, numerical comparison, device-loss handling, and fallback testing. A WebGPU-disabled run confirms truthful capability reporting and WASM fallback. Continuing with WASM is deliberate and documented in `docs/FORMFLOW_MODEL_RELIABILITY.md`.

## Security controls confirmed by review/tests

- AES-256-GCM with per-record AAD; PBKDF2-SHA256 at 600,000 iterations; random salts/nonces; DEK never persisted in extension-readable storage.
- Evidence ciphertext is authenticated by vault integrity checks.
- Parser/offscreen/model boundaries contain no vault keys or IndexedDB access.
- Offscreen port and model/parser protocols are allowlisted and schema-validated.
- Content script cannot be used as a general vault API; model has no vault access or tools.
- Model files pinned by revision, size, and SHA-256; corrupt files cannot be marked ready.
- Autofill approvals are tab/URL/document/fingerprint-bound, one-time, and cleared on lock.
- No auto-submit; read-back rejection reporting.
- Backup v3 is authenticated/encrypted; restore refuses non-empty targets and is journaled.
- Production client has no Drive/external-AI/telemetry path; core dependency audit is clean.

## Residual risks / next priorities

1. **Repository history rewrite and remote purge for personal PDFs** — highest priority; the repo is public.
2. Run a full live 734 MiB model download/resume in a controlled network environment.
3. Complete store signing/submission and a privacy/legal review before public distribution.
4. Obtain an independent security/cryptographic review.
5. Decide and validate WebGPU/Q4F16 or keep WASM-only.
6. Extend accessibility testing (screen reader/WCAG) and physical disk-full/long-run memory tests.
