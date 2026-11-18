# FormFlow Security Audit Report

Audit date: 2026-11-18  
Scope: source review, encrypted-vault review, worker/message boundaries, model lifecycle, autofill, legacy server, dependency/Git history review, adversarial tests, and selected Chromium execution.

No claim of being vulnerability-free is made. This is a targeted source and runtime assessment, not a formal cryptographic audit or penetration test.

## Findings summary

| ID | Severity | Title | Status |
|---|---|---|---|
| F-01 | Critical | Personal documents remain in reachable Git history and remote branch | **Unresolved historical exposure**; current index cleaned |
| F-02 | High | Autofill approval was not bound to the scanned tab/page/document | Fixed and verified |
| F-03 | Medium | Form could be mutated after scan without invalidating approval | Fixed and verified |
| F-04 | Medium | Pending autofill approval survived a vault lock/unlock | Fixed and verified |
| F-05 | Medium | Standard-form country/city/state classification failed when label/name/id repeated | Fixed and verified |
| F-06 | Medium | Standard radio/checkbox fill could select an option without matching the approved value (including Male/Female substring collision) | Fixed and verified in browser groups |
| F-07 | Low | Dev-only Vite/fdir/picomatch advisories | Unresolved; not in production output |
| F-08 | Low | Backup passphrase accepts only 8 characters and has no strength check | Unresolved |
| F-09 | Low | Unlock delay counter resets with service-worker restart | Unresolved; PBKDF2 is the primary cost |
| F-10 | Low | Legacy server has a default development auth secret and in-memory rate limits | Unresolved; must not be exposed publicly |
| F-11 | Low | Model main-revision aliases are not independently rehashed at load | Residual, trusted-extension boundary |
| F-12 | Low | No live internet model-download test, CI configuration, or public-release packaging | Unverified / missing |
| F-13 | Informational | No independent security audit or formal cryptographic verification | Accepted limitation |

---

## F-01 — Personal documents in Git history and remote branches

**Severity:** Critical (repository privacy/data exposure)  
**Affected component:** Git repository, legacy `server/storage/documents`  
**CWE:** CWE-538 (Insertion of Sensitive Information into Externally-Accessible File or Directory) is applicable as a descriptive classification; no formal scoring is claimed.

### Description

Three legacy uploaded PDFs (one degree document and two identity documents) were tracked in an early backend checkpoint. They were removed from the current index in `fc09d3c`, but the blobs remain reachable in:

- local branch `main` (`9f9632f`)
- `origin/migration/local-first`
- old commits reachable from the current feature branch history
- any clone/fetch of those refs

The files exist in the working tree under `server/storage/documents/`; `server/storage/` is ignored, so they are no longer tracked by the current branch tip. Their contents were not printed or copied into this report.

### Attack scenario / impact

Anyone with repository access or a clone can recover the personal PDFs from history. This can disclose identity information, a degree document, and filenames. It is not an extension-runtime vulnerability, but it is a real privacy and repository-security incident.

### Reproduction

`git log --all -- server/storage/documents` shows the historical commits; `git ls-tree -r main --name-only` / `origin/migration/local-first` lists the paths. Verify the current branch tip with `git ls-files server/storage` (empty).

### Remediation

- Current-tree remediation applied: `git rm --cached -r server/storage/documents`, existing `.gitignore` entry for `server/storage/`.
- Required external remediation: rewrite history with `git filter-repo` or BFG, force-push all affected refs after coordination, invalidate clones, and verify remote object removal. This audit did not rewrite history or force-push.

### Retest / status

Current tracked tree: no personal PDFs. Historical remote exposure remains. **Unresolved critical repository finding.**

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
`audit-standard-form.mjs`: PASS, including lock invalidation, mutation rejection, cross-tab rejection, read-back, no-submit, and approved-only radio/checkbox selection.

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

`npm audit --omit=dev` reports **0 vulnerabilities**. Full `npm audit` reports 4 high advisories through Vite 6.4.5 → fdir/tinyglobby → picomatch 4.0.7. These packages are build-time only and are not in `extension/dist` or the dashboard runtime. `npm audit fix` proposes removing packages rather than a safe patched version; no upgrade was made.

**Recommendation:** upgrade Vite when a compatible patched release is available; verify production output remains free of dev dependencies.

---

## F-08 — Backup passphrase strength

**Severity:** Low  
**Affected component:** `VaultMigrationPage`, backup export

Vault creation requires at least 10 characters and rejects all-repeat/all-digit passwords. Backup export accepts an 8-character passphrase without a strength check. PBKDF2 at 600,000 iterations remains the primary offline-guessing cost.

**Recommendation:** align backup passphrase validation with vault strength requirements or add a strength meter; no silent weakening was introduced.

---

## F-09 — Unlock attempt delay resets after service-worker restart

**Severity:** Low  
**Affected component:** `core/vault/vault-manager.ts`

`failedAttempts` is in memory. A service-worker restart resets the progressive delay, so offline/local repeated unlock attempts are limited primarily by PBKDF2 and OS controls. No lockout is claimed.

**Recommendation:** if stronger online throttling is required, persist attempt counters in a non-secret location with careful denial-of-service tradeoffs; not implemented to avoid locking users out.

---

## F-10 — Legacy server defaults and rate limits

**Severity:** Low/Medium only if exposed publicly  
**Affected component:** `server/index.mjs`, `server/security.mjs`

The legacy server is a localhost development/migration surface. It has a default `AUTH_SECRET` outside production, in-memory rate limiting, CORS restricted to `ALLOWED_ORIGIN`, JSON-body mutations, and signed OAuth state. Drive/AI routes are removed. It should not be exposed to the internet.

**Recommendation:** require a strong `AUTH_SECRET` in all non-ephemeral deployments, use durable rate limiting if deployed, and keep the server bound to localhost/firewalled. No public deployment is claimed.

---

## F-11 — Model main-revision aliases are not independently rehashed at load

**Severity:** Low (trusted extension-origin cache)  
**Affected component:** `extension/src/model/model-worker.ts`, `ai/runtime/model-loader.ts`

The pinned revision files are SHA-256 verified. Transformers.js 4.3.2 reads `config.json`/`tokenizer_config.json` from a `main` revision during pipeline discovery; FormFlow creates aliases from the verified bytes. The aliases are not separately hashed on every load. A compromised extension page (already within the trusted vault UI boundary) could alter public model config in Cache Storage.

**Recommendation:** compare alias bytes to the revision files before worker load, or use a custom loader that avoids the main-revision quirk. Not required for the current threat model, but worth hardening.

---

## F-12 — Verification/publication gaps

**Severity:** Low/informational  
**Affected component:** release process

- No CI workflow exists.
- Live Hugging Face CDN download/resume was not exercised; controlled Range tests and a fresh real-file local-fixture install were.
- WebGPU/Q4F16 inference is not validated.
- Model repository upgrades are not implemented.
- Microsoft Word reference pagination is unavailable.
- No public-store package/signing/privacy policy/update channel is present.

These are readiness gaps, not evidence of a runtime vulnerability.

---

## F-13 — No independent security audit

**Severity:** Informational  
**Affected component:** whole application

This audit is source-based plus targeted execution. It cannot prove absence of vulnerabilities. No formal crypto review, penetration test, fuzzing campaign, or third-party assessment was performed.

---

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

1. **Repository history rewrite and remote purge for personal PDFs** — highest priority.
2. Add iframe/Shadow DOM and accessibility coverage.
3. Add live CDN/model-download integrity run in a controlled network environment.
4. Add CI and a release/signing/privacy process before public distribution.
5. Consider alias rehashing and backup passphrase strength.
6. Obtain an external security review before public release.
