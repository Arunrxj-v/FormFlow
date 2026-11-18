# FormFlow Security Hardening Report

Date: 2026-11-18  
Branch: `feature/phase-4-document-ingestion`  
Baseline commit: `fc09d3c` (audit remediation is uncommitted unless the owner commits it)

This report covers the remediation pass after the original audit. It distinguishes verified controls from planned or externally blocked work.

## 1. F-01 — personal documents in Git history (CONFIRMED, NOT REMEDIATED)

### Finding

Three PDFs under the legacy `server/storage/documents/` path are present in reachable Git history and on the public remote:

- one small degree-style PDF (726 bytes, 1 page);
- one 2.65 MB PDF whose local OCR text layer/metadata is consistent with an Indian government identity document (Aadhaar), plus a duplicate blob under a second document ID.

The identity PDF is a two-page image-only scan. Local OCR detected “Government of India” and gender markers. The file was **not printed, copied into a report, or uploaded anywhere by this audit**.

### Exposure scope

- GitHub repository `Arunrxj-v/FormFlow` is **public** (`private: false`, `visibility: public`, default branch `migration/local-first`).
- `refs/heads/main`, `refs/heads/migration/local-first`, `refs/heads/security/phase-3.1.2`, `refs/heads/backup/pre-model-cache-cleanup`, and `origin/migration/local-first` contain the PDF paths.
- `raw.githubusercontent.com/.../migration/local-first/.../ArunrajV_aadhar.pdf` returned HTTP 200 with `content-length: 2654171` during this audit. That confirms public retrieval, not merely local Git history.
- The local feature branch tip `fc09d3c` no longer tracks these files, and `server/storage/` is ignored. That does **not** remove history or remote copies.

### Classification

This is a **confirmed critical privacy exposure**, not a false positive or template-only finding. The owner’s statement that no personal documents were uploaded to GitHub is contradicted by the remote tree and raw-file response.

### Required owner action

History rewrite and remote cleanup were **not performed** by this task. `scripts/security/purge-history.sh` is provided as a guarded, manual procedure. It refuses to run unless `FORMFLOW_CONFIRM_HISTORY_REWRITE=YES` is set and the tree is clean. It creates a mirror backup and uses `git filter-repo`; it does not push.

Recommended immediate mitigation order:

1. Make the GitHub repository private or delete it while the exposure is assessed.
2. Rotate/replace the exposed identity document through the issuing authority if it is genuine.
3. Mirror-clone the repository.
4. Run the purge script, verify `git log --all -- server/storage/documents` is empty, then force-push all refs/tags.
5. Ask GitHub Support to purge cached views/forks; invalidate clones and CI caches.
6. Treat any credentials ever committed to the same history as compromised.

## 2. Backup passphrase policy

**Before:** new backups accepted 8 characters; import also required at least 8 via the background validator.

**After:**

- New exports require **12 Unicode code points** and reject empty/whitespace-only values.
- The policy is enforced in the service layer (`validateBackupPassphrase`) and again by the background request validator.
- Import/restore deliberately does **not** apply the new minimum, so old archives remain restorable with their original passphrase.
- The UI disables export below 12 characters and uses code-point counting.
- Tests cover empty, short, long, Unicode, wrong-passphrase, export, and restore compatibility.

This is a length-based policy, not arbitrary character-class rules. It does not claim to measure entropy.

## 3. Persistent unlock throttling

**Before:** failed attempts lived in a module variable and reset when the MV3 service worker restarted.

**After:**

- Failed attempts and the lockout deadline are stored in IndexedDB in a new `securityState` store (database version 3).
- Attempts are serialized through an in-process queue, so concurrent unlock calls cannot race the counter.
- The first two mistakes are not delayed; the third triggers a 1 s lockout, then 2/4/8/16/32/60 s, capped at 60 s.
- A restarted service worker/new manager instance reads the persisted state and still blocks the correct passphrase until the deadline.
- Successful unlock or passphrase change clears the record.
- Corrupt metadata fails open to one normal attempt rather than permanently locking the user out.
- No passphrase, key, or derived key is stored in the throttling record.
- Tests cover progressive delay, restart persistence, concurrent attempts, corrupted metadata, and a future deadline.

**Limitation:** a local attacker who can freely edit browser profile storage can bypass this control. PBKDF2-SHA256 (600,000 iterations) remains the primary offline-guessing cost. The UI reports the remaining lockout time.

## 4. Legacy server hardening

- Default bind changed from all interfaces to `127.0.0.1`. `HOST` can be overridden explicitly.
- CORS now sets `Access-Control-Allow-Origin` only when the request `Origin` exactly matches the configured dashboard origin. A disallowed Origin receives 403 with no allow-origin header.
- `ALLOWED_ORIGIN` must be one explicit HTTP(S) origin; wildcards are rejected at startup.
- Added `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a restrictive CSP to every response.
- Added a 20 requests/minute upload limit in addition to the global and auth limits, with `Retry-After`.
- Production now requires `AUTH_SECRET` to be present, unique, and at least 32 characters; the development default is rejected in production.
- A clear warning is printed when the development secret or a non-loopback development bind is used.
- Server tests cover allowed/disallowed CORS and preflight handling.
- The server remains a **development/migration surface**, not a production service. It was not exposed publicly during testing.

## 5. Model integrity

- The pinned revision remains `54250909aca286a05b9d013c8af7a21859ee6ead` / Q8 INT8.
- Install and repair verify every file's expected size and SHA-256.
- The `config.json`/`tokenizer_config.json` aliases used by transformers.js are now rebuilt from the verified revision bytes rather than trusting an existing alias.
- The model worker independently re-hashes those revision files with Web Crypto before rebuilding the aliases on load, and rejects size/hash mismatches.
- `modelLoader.verify()` also repairs/validates aliases and marks the record `corrupt` if synchronization fails.
- Failed or cancelled installs now clear resumable chunks instead of leaking quota.
- The worker still refuses any non-WASM runtime; Q4F16/WebGPU is not silently selected.
- Real model E2E install, offline self-test, and extraction passed after these changes.

## 6. Sensitive-field matching

The audit found that `buildSuggestions` used `item?.sensitive ?? field.sensitive`. If a vault value existed with `sensitive: false`, a scanned email/phone field marked sensitive by the classifier could be downgraded. It now uses `item?.sensitive || field.sensitive`, so scan-level sensitivity cannot be downgraded by stored metadata.

Email, phone, address, date of birth, registration number, and identification number are classified sensitive. The popup requires the explicit “I reviewed the sensitive values” confirmation when any selected match is sensitive. A real-browser audit verifies the flags for email, phone, address, birth date, and passport number.

## 7. Iframe and Shadow DOM

- Added a shared DOM traversal helper that follows open shadow roots and same-origin iframe documents up to depth 3.
- Cross-origin frames are skipped; the helper catches `contentDocument` access failures and does not bypass origin isolation.
- Closed shadow roots are skipped.
- Standard-form scan keeps an element registry so fill works across iframe/shadow realms; cross-realm `instanceof` checks were replaced with tag/property duck-typing and owner-document prototypes.
- Labels and `aria-labelledby` resolve against the element's own root.
- The content-script form fingerprint now includes shadow/iframe controls and the root count, so a post-scan mutation is rejected.
- Browser audit verifies: same-origin iframe scanned and filled; open Shadow DOM scanned and filled; cross-origin iframe not scanned; mutation after scan rejected; cross-tab and reused approvals rejected; no submit.

## 8. Autofill approvals (reverified)

The previous audit’s high-severity fix remains in place:

- background approval bound to tab ID, exact URL, content scan token, and form fingerprint;
- 10-minute expiry;
- single use;
- cleared on vault lock;
- content script rejects forged/stale scan tokens and changed forms;
- popup refuses to fill without the scan approval token;
- only selected/approved values are sent;
- read-back rejection is reported;
- no automatic submit.

Both Google Forms and standard-form browser audits pass after the new iframe/shadow changes.

## 9. Inference reliability

- Load and generation budgets are separate: 240 s load, 300 s base generation, 1.5 s per requested token, capped at 600 s.
- The previous fixed 180 s generation timeout was the cause of the heavily contended failure. The timeout now scales with output length.
- Concurrent inference/self-test requests are rejected with a clear “another inference is running” message instead of sharing a generator unsafely.
- Cancellation still disposes the worker and rejects pending requests.
- AI failure preserves deterministic extraction; the existing pipeline tests and real model E2E pass.
- Memory measurements are in `docs/FORMFLOW_MODEL_RELIABILITY.md`; they are process-sum RSS, not per-worker heap.

## 10. Dependencies

- Vite was updated to the latest 6.x (`6.4.6`) to remove the Vite dev-server path-traversal advisories.
- `npm audit --omit=dev` is clean.
- Full `npm audit` still reports **4 high** advisories through `picomatch <= 4.0.7` and its `fdir`/`tinyglobby` dependents. The advisory has **no patched version** (“Patched versions: None”). It is a development/build-time ReDoS reachable only when an attacker controls glob patterns processed by the dev toolchain; it is not in the production extension.
- No vulnerable package is shipped in `extension/dist`.
- This remains an accepted, documented dev-only risk until picomatch publishes a fix.

## 11. Residual risks

1. **F-01 public Git history exposure** — unresolved; owner action required immediately.
2. Dev-only picomatch ReDoS — no upstream patch.
3. Full live 734 MiB model download not repeated; small files and byte-range behaviour were verified live.
4. WebGPU/Q4F16 inference not implemented or validated.
5. Microsoft Word reference pagination not available.
6. No independent security/cryptographic audit.
7. Physical disk-full and long-run memory leak testing are incomplete.
8. Browser compatibility is verified on Chrome 113 and 159 only; Firefox/Safari are unsupported.
9. Same-origin iframe/shadow support is scoped; cross-origin and closed shadow roots are unsupported by design.
