# FormFlow Migration Status

FormFlow is now an **extension-owned, locally encrypted vault** for the production workflow. The extension dashboard and popup share one canonical IndexedDB vault under the extension origin. The localhost dashboard remains a development and migration surface.

## Phase 4.1.2 — Local OCR for scanned PDFs (complete)

Phase 4.1.2 adds genuine local OCR for scanned and image-only PDF pages without moving document content outside the browser.

### Engine evaluation and selection

The candidate set was limited to browser-local engines compatible with the existing offscreen architecture: Tesseract.js, OCRAD, and a future WASM Tesseract wrapper. OCRAD was rejected because it has no maintained worker/WASM packaging, weak language coverage, and no confidence or bounding-box model comparable to Tesseract. A custom WASM build would add a large build and maintenance surface without improving the initial English requirement. **Tesseract.js 7.0.0 with tesseract.js-core 7.0.0** was selected because it:

- runs in a classic Web Worker with a SIMD LSTM WASM core;
- supports explicit local `workerPath`, `corePath`, and `langPath` values, avoiding CDN defaults;
- exposes page, line, and word confidence plus bounding boxes;
- is Apache-2.0 licensed, with MIT-licensed language data;
- was verified in the real extension offscreen document under the production CSP on Chrome 156.

The local feasibility probe, and later the full extension suite, recognized `FORMFLOW OCR TEST`, `42 Example Street, Bengaluru`, and `Account number: 9988776655` from a rendered image-only PDF.

### Supported language set

Only **English (`eng`)** is bundled and claimed. The asset is `@tesseract.js-data/eng@1.0.0` `4.0.0_best_int/eng.traineddata.gz`. Additional languages are not supported until their trained data is added to `OCR_LANGUAGE_ASSETS`, copied into the build, and SHA-256 verified. The background refuses preferences outside the bundled set, and the offscreen protocol rejects unbundled language identifiers.

### Runtime architecture

- The background validates the file, computes the SHA-256 digest, encrypts the original, and sends only PDF bytes plus non-secret parser fields to the offscreen document.
- The offscreen parser first extracts native PDF text and identifies pages with little or no text. Only those pages are rendered with PDF.js at 200 DPI, capped at 12 MP per page and scale 3.
- The rendered canvas alone is passed to a request-scoped Tesseract worker. The OCR worker receives no vault key, AAD, passphrase, IndexedDB handle, or vault repository.
- Pages are processed incrementally, one canvas at a time. Each canvas and PDF page is released after use. A request-scoped OCR worker is terminated at the end of the parse, on cancellation, or when the offscreen document shuts down.
- OCR is bounded to 100 pages per attempt, 30 seconds per page, and a 300-second total ingestion timeout.
- Native text is retained on text pages. OCR text replaces only empty/very short native text or substantially longer OCR output; overlapping OCR output is not appended twice.
- The background validates OCR structure again, confirms status/page invariants, and persists recognized text and OCR details only inside the existing encrypted `documentText` record (`extractionEnc` with the `extraction` AAD field).

### CSP and local assets

The extension packages `tesseract/worker.min.js`, `tesseract/tesseract-core-simd-lstm.wasm`, `tesseract/tesseract-core-simd-lstm.wasm.js`, and `tessdata/eng.traineddata.gz` locally. The build verifies each SHA-256 before writing the production extension and fails on a mismatch. The offscreen page allows only `'wasm-unsafe-eval'` for the local WASM core, `connect-src 'self'` for local extension resource fetches, and `worker-src 'self'`. No remote OCR API, CDN, or document upload is used.

### OCR output model

Each OCR page records its original PDF page number, language, confidence, lines, words, bounding boxes, and warnings. The extraction record records engine, engine version, processed timestamp, pages attempted/completed/failed, average confidence, warnings, and status (`not_required`, `completed`, `partial`, or `failed`). Bounding boxes are pixel coordinates in the rendered page image, not PDF points. Confidence values are Tesseract's actual values; no confidence is fabricated when unavailable.

### Verification results

| Command / suite | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass; 78 files; local OCR assets copied and SHA-256 verified; bundle isolation verified |
| `npm run test:local` | 125/125 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `scripts/dev/e2e-phase412-ocr.mjs` | 46/46 pass (test-hooks build) |

The Phase 4.1.2 Chromium suite verified with genuine recognition, not mocks:

- image-only PDF recognized with page/line/word confidence and boxes;
- multi-page scanned PDF with preserved page boundaries;
- mixed native-text and image PDF, OCR applied only to the image page;
- rotated page recognized;
- unreadable/low-quality page stored and marked failed with real warnings;
- partial OCR success (one page completed, one failed);
- OCR language initialization and confidence;
- missing language asset preserving the original document and returning a retryable failure;
- cancellation during OCR with no partial record;
- OCR page timeout with a retryable failed status;
- offscreen crash during OCR, recovery, and successful retry;
- extension restart during OCR with no partial record and successful reimport;
- duplicate import not re-running OCR;
- encrypted OCR output at rest and AAD tamper rejection;
- encrypted backup export/import round-trip preserving OCR text, status, language, confidence, and bounding boxes;
- no vault key material in offscreen request/result diagnostics;
- bounded offscreen heap usage and no residual OCR jobs;
- no external network requests during OCR.

Measured on Google Chrome for Testing 156.0.8078.4 on macOS: a 1600×900 image-only page completed end-to-end import and OCR in **762 ms** with **95% average confidence** in the final test-hooks suite run; a separate final production-build check completed in **711 ms** with **94% confidence** and the expected text. The first OCR page pays engine and language initialization; earlier probe runs took about 1.2 s. Peak offscreen JS heap during the single-page suite run was **15.7 MB**; a two-page scanned PDF peaked at **18.4 MB**. These figures exclude WASM linear memory and are indicative, not a benchmark across devices. The bundled assets total about **9.6 MB** (worker 109 KB, SIMD LSTM core 6.4 MB including WASM, English data 2.8 MB). A single rendered 12 MP RGBA page is about 48 MB, and the implementation holds only one rendered page at a time.

### Limitations

- Only English is bundled.
- OCR accuracy varies with scan quality, skew, rotation, handwriting, tables, and multi-column layout.
- OCR text is not a visual reconstruction; the encrypted original remains authoritative.
- Bounding boxes refer to the rendered OCR image.
- The first OCR page pays engine and language initialization cost.
- Documents with more than 100 OCR-required pages require a later retry for the remaining pages; the UI and warnings report that limit.
- Tesseract.js 7.0.0's `Lang[]` preloaded-data initialization path was not used because its worker initialization path is broken; the implementation uses the documented local `langPath` fetch and still verifies the asset hash before engine startup.
- No external OCR, cloud OCR, or remote model download is implemented.

## Phase 4.1.1 — Isolated offscreen document parsing (complete)

Phase 4.1.1 moves untrusted PDF, DOCX, and TXT parsing out of the privileged MV3 service worker into a hidden Chrome offscreen document and request-scoped parser workers.

Implemented:

- Added the `offscreen` permission and raised `minimum_chrome_version` to **109**, the Chrome Offscreen API minimum.
- Created `offscreen-parser.html` / `offscreen-parser.js` with a hidden extension page that has no user-facing UI or navigation controls. It is created with the narrow `WORKERS` reason and spawns one parser Web Worker per document.
- Added `document-parser.worker.js`, which contains PDF.js, Mammoth, fflate, and the existing parser modules. The service-worker bundle no longer contains any parser runtime.
- Added a strict dedicated-port protocol: `PARSE_DOCUMENT`, `CANCEL_PARSE`, `PARSE_PROGRESS`, `PARSE_RESULT`, `PARSE_ERROR` with unique request IDs, parser version, exact-key validation, bounded progress, result-size checks, and coded errors.
- The background accepts the parser port only from the exact offscreen document URL and sender ID. The offscreen document is explicitly excluded from the general runtime operation router, so it cannot invoke `LIST_DOCUMENTS` or any vault operation.
- Added a non-configurable runtime `indexedDB` guard in the offscreen document and parser worker. Neither bundle imports vault, database, encryption, storage, application, or vault-client modules.
- Added a single managed offscreen lifecycle with a creation mutex, stale-document replacement, 15-second idle shutdown, maximum 2 concurrent parses, and per-request worker cancellation.
- Parser failure, cancellation, timeout, vault lock, service-worker termination, extension reload, or offscreen-document failure cannot produce partial records. The existing single IndexedDB commit remains the only success boundary.
- Added build-time bundle isolation checks using esbuild metafiles. The build fails if the service worker contains parser runtime, or if the offscreen page/worker contains vault, database, encryption, storage, or application modules.
- Added a strict CSP `worker-src 'self'`; no inline/remote scripts, `unsafe-eval`, remote parser libraries, or dynamic code execution were added.
- Kept backup v3, AAD, migrations, duplicate detection, encrypted text storage, and the dashboard UI unchanged at the data layer.

### Verification results

| Command / suite | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass; 73 files; bundle isolation verified |
| `npm run test:local` | 125/125 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | 149/149 pass |
| `scripts/dev/e2e-phase3.mjs` | 98/98 pass |
| `scripts/dev/e2e-phase4-ingestion.mjs` | 30/30 pass |
| `scripts/dev/e2e-phase4-offscreen.mjs` | 33/33 pass (test-hooks build) |
| `scripts/dev/e2e-phase4-interruption.mjs` | 11/11 pass |
| `scripts/dev/e2e-migration-crash.mjs` | 23/23 pass (test-hooks build) |
| `scripts/dev/e2e-extension-reload.mjs` | 21/21 pass |
| `scripts/dev/e2e-content-isolation.mjs` | 16/16 pass |
| `scripts/dev/e2e-recovery-crash.mjs` | 8/8 pass |

Browser: Google Chrome for Testing 156.0.8078.4 on macOS.

The Phase 4.1.1 offscreen suite verified in real Chromium:

- PDF, DOCX, and TXT parsing through the offscreen document.
- Production ingestion created the offscreen parser context.
- Offscreen `indexedDB` access was blocked.
- Actual offscreen request/result key allowlists contained no DEK, KEK, passphrase, AAD, or key-like fields.
- The offscreen document could not invoke arbitrary background vault operations (`UNAUTHORIZED`).
- Malformed parser requests, malformed parser responses, and oversized parser results were rejected.
- A bounded parser timeout left no record.
- An offscreen-document failure rejected the import and left no partial record; a later import recreated the offscreen document successfully.
- Two concurrent requests were handled safely.
- One cancellation did not terminate the other active parse.
- Vault lock drained the offscreen parse and the import committed atomically.
- Duplicate detection and encrypted v2 text persistence still worked.
- Extension disable/re-enable during an active offscreen parse left zero partial records and recovered successfully.

Known limitations:

- Offscreen documents and parser workers share the extension origin. They have no vault authority, no vault/DB/crypto imports, and a runtime IndexedDB guard, but they are not a separate sandboxed origin.
- The offscreen document is created with the `WORKERS` reason and uses Chrome 109+ APIs.
- Local OCR was added in Phase 4.1.2; image-only PDFs no longer remain permanently `ocrRequired`.
- Malformed request/response and timeout tests use test-only bots/offscreen hooks in a test build; the production build was rebuilt and verified to contain no hook strings.
- Parser workers receive only document bytes and non-secret protocol fields; the DEK never leaves the service worker.

## Phase 4.1 — Local document ingestion (complete)

Phase 4.1 adds a local ingestion pipeline for PDF, DOCX, and TXT without adding cloud processing, OCR, model downloads, ONNX, or AI extraction.

Implemented:

- Signature/content validation for PDF (`%PDF-`), DOCX (ZIP container plus `word/document.xml`), and strict UTF-8 TXT. File extensions and browser MIME types are treated as hints, not authority.
- SHA-256 content digests with duplicate detection before a new record is created. The existing record is returned by name; no file is overwritten.
- PDF.js extraction of text, page count, per-page text, page numbers, and best-effort PDF metadata. Image-only, scanned, mixed text/image, empty, password-protected, corrupted, and oversized PDFs are classified. Phase 4.1.2 adds local OCR for image-only pages.
- DOCX extraction with Mammoth validation plus a WordprocessingML structure pass for paragraphs, headings, tables, line breaks, and document order. Table cells are preserved as tab-separated rows.
- Strict UTF-8 TXT handling with BOM detection, CRLF/CR/LF normalization, invalid-encoding rejection, binary-control rejection, and paragraph preservation.
- Atomic encrypted persistence: the document row, encrypted original bytes, encrypted extracted text, and encrypted extraction details are written in one strict IndexedDB transaction. A quota error, lock, parser failure, cancellation, or service-worker termination cannot leave a successful document without its text or file.
- Parser module receives document bytes only. It has no vault session, DEK, KEK, AAD, database handle, or network access. Phase 4.1.1 moved parsing to the hidden offscreen document and request-scoped workers; see the Phase 4.1.1 section.
- Extraction details (warnings, PDF/DOCX metadata, pages requiring OCR) are encrypted under the existing `documentText` record with the distinct AAD field `extraction`. No extracted text or sensitive metadata is stored in plaintext.
- Typed protocol operations for document text retrieval, extraction retry, cancellation, and progress. Progress travels over an extension-origin-only port and contains only stage, page, file index, and percentage — no filename, text, key, or metadata.
- Dashboard upload dialog shows real validation/extraction/encryption/storage stages, page count, duplicate name, OCR-required state, warnings, retry, cancellation, and clear errors.
- Inspector shows decrypted text preview per page, page navigation, extraction status/timestamp, warnings, and OCR-required state without storing plaintext in the list payload.
- Optional document fields (`extractionVersion`, `extractedAt`, `ocrRequired`) and optional `documentText.extractionEnc` preserve compatibility with existing documents, migrations, and v1/v2/v3 backups. Backup v3 now carries extraction details; older backups without them still import.

Verification results:

| Command / test | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass; 73 files |
| `npm run test:local` | 125/125 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| `scripts/dev/e2e-phase3.mjs` | 98/98 pass |
| `scripts/dev/e2e-phase4-ingestion.mjs` | 30/30 pass |
| `scripts/dev/e2e-phase4-offscreen.mjs` | 33/33 pass (test-hooks build) |
| `scripts/dev/e2e-phase4-interruption.mjs` | 11/11 pass |
| `scripts/dev/e2e-migration-crash.mjs` | 23/23 pass |
| `scripts/dev/e2e-extension-reload.mjs` | 21/21 pass |
| `scripts/dev/e2e-content-isolation.mjs` | 16/16 pass |
| `scripts/dev/e2e-recovery-crash.mjs` | 8/8 pass |

Browser: Google Chrome for Testing 156.0.8078.4, Playwright persistent profiles, production extension build. The ingestion E2E imports a real Chromium-generated multi-page PDF, a DOCX with headings/tables, a BOM/CRLF TXT, an image-only PDF, a corrupted PDF, and a password-protected PDF; it verifies encrypted-at-rest text, v2 AAD, duplicates, OCR state, retry, cancellation, real progress, and the dashboard upload dialog. The interruption E2E reaches the offscreen parser during a 1,000-page PDF import, disables the extension, re-enables it, unlocks, and verifies that no partial document/file/text triple exists.

Known Phase 4.1 limitations:

- **OCR is implemented in Phase 4.1.2 for English scanned PDF pages.** Image-only pages are rendered locally and recognized with bundled assets; unsupported languages and failed OCR remain explicitly reported.
- DOCX page boundaries are not reliable in the format; DOCX is stored as one logical page with a warning.
- Complex PDF layout and DOCX table/heading structure are normalized to text; visual layout is not reproduced.
- PDF metadata extraction is best-effort and may be absent.
- Password-protected PDFs are rejected rather than decrypted.
- Parsing runs in the hidden offscreen document and request-scoped workers, outside the service-worker key boundary.
- Local OCR/field extraction is partially implemented: English scanned-PDF OCR is available; ONNX, model downloads, Qwen inference, intelligent extraction, and autofill are out of scope for this phase.

## Phase 3.1.2.1 — Final runtime security verification (complete)

The three Phase 3.1.2 verification gaps were closed with actual Chromium automation:

- **Migration crash:** a test-only extension build created a realistic v1 vault (275 documents, document blobs, values, a collection, an education record, and form history), committed the first `documents` migration batch, then the Chromium process was SIGKILLed. After restart and unlock, the migration resumed, the journal reached `complete`, all 275 documents/files and other records survived without duplicates, the integrity checker passed, and no plaintext values or v1 envelopes remained. The production extension was rebuilt without the test hooks.
- **Extension reload:** a second test-only management extension disabled and re-enabled FormFlow in place, preserving extension ID and storage while restarting the worker. The dashboard and popup reopened locked, no DEK was present, and unlock restored documents and profile data. A 20 MB import was interrupted by the same lifecycle and left no partial document/file pair.
- **Content-script isolation:** actual local HTTP and HTTPS pages were visited; the content script did not run and the page could not access extension APIs, session storage, the vault IndexedDB, or a page-world bridge. A Google Forms-origin page served through route interception was injected, scanned through the background router, and remained unable to access extension APIs.

### Verification results

| Command / test | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:local` | 81/81 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| `scripts/dev/e2e-phase3.mjs` | 98/98 pass |
| `scripts/dev/e2e-migration-crash.mjs` | 22/22 pass |
| `scripts/dev/e2e-extension-reload.mjs` | 21/21 pass |
| `scripts/dev/e2e-content-isolation.mjs` | 16/16 pass |
| `scripts/dev/e2e-recovery-crash.mjs` | 8/8 pass |

Browser: Google Chrome for Testing 156.0.8078.4, Playwright persistent profiles, production extension build. Migration fixtures were built with a test-only `background.test.ts` entry; the production build was rebuilt afterwards and verified to contain no test-hook strings.

## Phase 3.1.2 — Advanced hardening and recovery (implemented; see limitations)

Completed in this phase:

- Added atomic backup restore: every record, file, checksum, and relationship is validated and encrypted/decrypted round-tripped before activation.
- Added a persistent restore journal (`validating`, `ready`, `complete`, `failed`) and an activation marker committed atomically with the imported records.
- Added restore recovery that inspects actual record counts and the activation marker rather than trusting journal status alone.
- Added concurrent-restore rejection and in-transaction target modification checks.
- Added encrypted vault display names with a separate `nameFormat` marker and migration for existing format-v2 vaults.
- Hardened extension CSP to `script-src 'self'; object-src 'none'` plus HTML `base-uri`, object, image, font, and media restrictions.
- Removed the content-script page-world ping/pong bridge.
- Added stored-XSS payload tests and confirmed React renders data as text.
- Preserved genuine v1/v2 import compatibility, added downgrade-relabel tests, and verified successful legacy imports re-export as v3.
- Added a real Chromium **process kill during backup restore**, restart recovery, journal inspection, and successful retry.

### Verification results

| Command / test | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:local` | 81/81 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| Chromium extension E2E | 98/98 checks pass |
| Chromium restore process-kill recovery | 8/8 checks pass |

A real Chromium migration process-kill test was not performed. Migration crash behavior is covered by deterministic transaction/journal fault injection; the real process-kill test covers atomic backup restore.

## Phase 3.1.1 — Final security hardening (complete)

Completed in this phase:

- Made the background service worker the exclusive owner of the DEK. The dashboard and popup now use typed operation clients and receive no key material.
- Removed the DEK from `chrome.storage.session`; that area now holds only a non-secret lock/state marker. A service-worker termination therefore locks the vault.
- Added `VaultOperationCoordinator` leases for every data-bearing background operation.
- Lock now sets `locking` synchronously, rejects new operations, drains in-flight reads/mutations, clears the key only after the drain, and only then publishes `locked`.
- Added an operation timeout that fails closed without falsely reporting locked.
- Added validated dashboard/popup keepalive ports so active UI does not lose the session to MV3 idle termination; forced termination still locks.
- Serialized create/unlock/lock transitions and rejected unsafe interleavings.
- Added backup format v3 with a canonical, length-prefixed authenticated header covering algorithms, KDF parameters, salt, nonce, encryption/schema/manifest versions, all record counts, total bytes, payload bytes, and creation time.
- Retained genuine v1/v2 backup imports.
- Added deterministic migration fault points for pre-batch, pre-write, during-transaction, post-commit, journal, verification, and marker boundaries.
- Added quota-exhaustion fault injection for document upload, backup import, migration batches, journal writes, and marker writes.
- Added exact 200 MiB (209,715,200 byte) backup boundary tests.
- Extended Chromium E2E for DEK absence, generic-operation rejection, upload/lock draining, v3 header tampering, and genuine legacy v1/v2 imports.

### Verification results

| Command / test | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:local` | 70/70 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| Chromium extension E2E | 88/88 checks pass |

The Chromium suite verifies that the dashboard and popup cannot read a raw DEK, generic crypto/database operations are rejected, an 8 MB upload and lock are safely drained, no mutation starts while locked, v3 header tampering fails authentication, v3 imports work, genuine v1/v2 imports work, the service worker locks on termination, browser restart requires unlock, and encrypted documents remain readable.

## Phase 3.1 — Security hardening (complete)

Completed in this phase:

- Replaced the vault-wide AAD with per-record authenticated context bound to vault ID, record type, record ID, field, encryption format, and schema version.
- Added canonical length-prefixed AAD encoding and format-v2 envelopes.
- Added ciphertext identity tests for cross-record, cross-field, cross-type, and cross-vault swapping.
- Added a resumable v1→v2 encryption migration with a persistent journal, controlled batches, compare-and-swap writes, round-trip verification, and a full verification pass before setting the format marker.
- Encrypted personal field labels and conflict labels at rest.
- Added a vault integrity checker that reports invalid ciphertext, missing files, checksum mismatches, broken references, and incomplete migration state without deleting records.
- Hardened backup archives: strict envelope/key validation, exact KDF parameters, nonce/salt/base64 bounds, record-count limits, duplicate-ID checks, relationship checks, checksum recalculation, UTF-8 failure handling, and a v2 archive AAD.
- Kept Phase 3 v1 backups importable.
- Added session generations so data-bearing operations are discarded when a lock occurs in flight.
- Serialized concurrent lock/unlock transitions.
- Cleared popup state on remote lock and revoked document preview URLs on lock.
- Added passphrase-change verification before committing the new wrapped key.
- Documented the threat model and residual risks in `docs/SECURITY_ARCHITECTURE.md`.

### Verification results

| Command / test | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:local` | 47/47 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| Chromium extension E2E | 63/63 checks pass |

The Chromium E2E covers v2 ciphertext inspection, per-record AAD metadata, cross-field ciphertext swapping and recovery, integrity checking, service-worker termination, encrypted export/import, malformed backup rollback, passphrase rotation, browser restart, popup/dashboard locking, and one shared vault.

The v1→v2 migration is verified by unit tests that seed all record types in the Phase 3 format, migrate them, verify decryption and integrity, corrupt a record, confirm the marker stays at v1 with a failed journal, restore the record, and resume successfully.

## Phase 3 — Extension-owned vault and encryption (complete)

Completed in this phase:

- Built the existing React dashboard into `chrome-extension://<extension-id>/dashboard.html`.
- Switched the extension build to package dashboard HTML, JS, CSS, fonts, popup, background worker, content script, and icons.
- Removed the localhost backend host permissions from the production manifest.
- Added a strict versioned extension message protocol with request IDs, payload validation, operation routing, and trusted-extension-sender checks.
- Connected the popup to the extension-owned vault instead of a separate `chrome.storage` vault.
- Removed the old popup vault keys as an active source of truth.
- Added one-time migration of legacy popup vault values into the canonical vault.
- Added encrypted vault creation, unlock, lock, auto-lock, and passphrase change.
- Added AES-256-GCM encryption at rest for documents, document text, profile values, conflicts, profile records, collections, activity, and history.
- Added PBKDF2-SHA256 key derivation at 600,000 iterations with a random per-vault salt and a wrapped random data-encryption key.
- Added encrypted document blobs and authenticated decryption on preview/download.
- Added encrypted backup export and import with checksum validation and non-empty-target rejection.
- Added a Phase 2 plaintext-to-encrypted in-place migration path.
- Added verifiable lock-state enforcement for dashboard access, popup access, and autofill requests.
- Added browser-level E2E verification of encryption at rest, lock/unlock, browser restart, cross-origin import, and auto-lock.

### Verification results

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:local` | 21/21 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| Chromium extension vault E2E | 48/48 checks pass: vault creation, real PDF upload, profile value, collection, encrypted-at-rest inspection, typed protocol operations, service-worker termination/restart, encrypted export, import safeguards, popup shared-vault, dashboard→popup lock propagation, popup unlock/lock, wrong/correct passphrase, browser restart, persistence |
| Cross-origin encrypted migration | Localhost encrypted export imported into the extension origin; document and profile value verified |
| Auto-lock and legacy popup migration | Auto-lock triggered after inactivity; legacy popup values imported and old keys removed |

The browser E2E is reproducible with `CHROME_PATH="/path/to/Chrome for Testing" node scripts/dev/e2e-phase3.mjs` against `extension/dist`.

### Security model

- Vault passphrase is never stored.
- PBKDF2-SHA256 derives a key-encryption key.
- A random AES-256-GCM data key is wrapped by the key-encryption key.
- Every encryption uses a fresh 12-byte nonce.
- Encrypted records use authenticated encryption with associated data.
- The raw data key is held only in service-worker memory. It is not written to IndexedDB, `chrome.storage.local`, or `chrome.storage.session`.
- Locking clears the in-memory key and publishes only the non-secret lock state.
- Browser restart and service-worker termination lose the key and require unlock.
- Content scripts never access the vault key or the full vault.
- The popup and dashboard are trusted extension pages and access the vault through the shared security layer and service worker.
- Document blobs are encrypted with the same vault data key.
- Backup archives are encrypted with a separate backup passphrase.
- Backup import recalculates document checksums instead of trusting archive metadata.

### Known Phase 3 limitations

- Vault metadata such as record IDs, field keys, categories, statuses, file sizes, MIME types, checksums, and the vault name remain plaintext structural metadata. Sensitive values and document contents are encrypted.
- The backup format is a JSON envelope with base64 document payloads. The current import limit is 200 MB.
- Encrypted backup import is allowed only when the target has no documents, values, or collections and its profile is still the default created at vault setup. The archive's profile replaces the local profile.
- Automatic lock is implemented in the dashboard and in the extension background alarm. The alarm uses the configured inactivity interval.
- There is no passphrase recovery mechanism. Losing the passphrase makes the vault unrecoverable.
- The legacy Google Drive, backend, and old auth source files remain in the repository but are not used by the extension vault workflow.
- Local text extraction is implemented for PDF, DOCX, and TXT, and Phase 4.1.2 added English scanned-PDF OCR. AI field extraction and AI processing remain future phases.
- The extension dashboard is the production dashboard. The localhost dashboard remains a development and migration surface.

## Phase 1 — Recovery and build foundation (complete)

Completed in this phase:

- Resolved the canonical field definition to `shared/form-fields.ts`.
- Fixed the broken relative import in `extension/src/lib/classifier.ts`.
- Added `core/`, `ai/`, and `extension/test/` to TypeScript checking.
- Restored `npm run typecheck`, `npm run build`, `npm run build:extension`, and `npm test`.
- Made the extension build atomic: it now builds into `extension/.build/`, validates required assets and manifest references, and only then replaces `extension/dist/`.
- Verified the generated extension in Chromium: service worker starts, popup loads, and no page or console errors occur.
- Excluded `.model-cache/` and `server/storage/` from Git and removed them from the Git index without deleting local files.
- Documented the Qwen3 INT8/Q4F16 runtime findings.

### Verification results

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| Chromium extension load | Service worker + popup load; no page/console errors |

Generated extension contents:

```text
extension/dist/
├── BUILD.txt
├── background.js
├── content.js
├── manifest.json
├── popup.css
├── popup.html
├── popup.js
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

## Phase 2 — Local data integration (complete)

Completed in this phase:

- Added a versioned IndexedDB schema with an explicit local `vaults` record.
- Added local repositories for vaults, documents, document files, profile values, addresses, education, employment, skills, certifications, projects, collections, collection-document relationships, activity, form history, settings, and processing jobs.
- Added local application services for vaults, documents, profile records, collections, history, activity, dashboard metrics, and settings.
- Added local document blob storage and SHA-256 checksum-based duplicate detection.
- Connected the dashboard, document vault, personal profile, addresses, education, employment, skills, collections, history, and settings to local data.
- Added a local vault setup page and a vault migration page.
- Added a one-time legacy backend migration path that reads existing SQLite-backed data and imports it into IndexedDB.
- Added an origin-portable local vault export/import mechanism.
- Added local database, document storage, and migration tests.
- Removed backend API calls from migrated dashboard features.

### Verification results

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm run test:local` | 9/9 pass |
| `npm test` | Pass |
| Chromium UI verification | Vault creation, PDF upload, profile value, skills persistence, collection creation, refresh persistence, browser restart, collection deletion, document deletion all pass |
| Backend-offline verification | Dashboard and documents continue working after `server/index.mjs` is stopped |
| Real legacy backend migration | 1 document, 3 values, 1 collection, and 1 history entry imported from a temporary SQLite-backed backend; repeated migration is idempotent |

### Origin strategy

- IndexedDB is origin-scoped. The current dashboard uses the Vite origin; the future extension dashboard will use `chrome-extension://<extension-id>`.
- The local database is accessed through `core/database/*` repositories and `core/application/*` services, not directly from React components.
- `core/storage/vault-export.ts` can export the local vault to a portable JSON file and import it into another origin.
- The extension-owned dashboard is still future work. Local data does **not** automatically transfer between origins.

## Model runtime status

- Repository: `onnx-community/Qwen3-0.6B-Instruct-ONNX`
- Pinned revision: `54250909aca286a05b9d013c8af7a21859ee6ead`
- Licence: Apache-2.0
- Verified CPU candidate: **INT8 / Q8** (`onnx/model_quantized.onnx`, 753,999,618 bytes).
- Q8 Node inference was verified against real ONNX weights: cached load 2.66 s, 675 ms for an 80-token generation, valid JSON output.
- Q4F16 CPU loading fails with a float16 graph type mismatch:

  ```text
  Type (tensor(float16)) of output arg
  (/model/layers.0/input_layernorm/Cast_output_0)
  does not match expected type (tensor(float)).
  ```

- Q4F16 must not be selected for CPU/WASM execution unless a successful compatibility test is added. The current `preferredVariant()` helper can select Q4F16 when WebGPU is available, but it is not wired into the product and has no verified browser/WebGPU test yet.
- Node inference does **not** prove browser or extension inference works. No model worker or offscreen runtime exists yet.
- The repository’s tokenizer config does not contain the chat template. `chat_template.jinja` must be loaded and assigned manually before chat prompting.

## Git cache status

- `.model-cache/` is now ignored and removed from the Git index.
- Local model files were preserved for testing (approximately 1.3 GB).
- `server/storage/` is now ignored and removed from the Git index; local user documents were preserved.
- Checkpoint commit `9f9632f` still contains the model blobs in Git history. Removing history requires a backup and explicit authorization before using a history-rewriting tool such as `git filter-repo`. No history was rewritten.

## Remaining work

### Phase 2 — Local data integration

Completed. IndexedDB repositories and services are wired into the dashboard. Local document storage, profile values, addresses, education, employment, skills, collections, history, activity, and dashboard metrics all use local data.

### Phase 3 — Extension-owned dashboard and AI runtime

- Build the dashboard into the extension.
- Vault setup and unlock UI.
- Local AI runtime and Qwen3 worker.
- Model download, progress, integrity verification, and installation UI.
- WebGPU and WASM execution.
- Offline inference verification.

### Phase 4 — Document ingestion

- Phase 4.1 local PDF, DOCX, and TXT ingestion is complete.
- Phase 4.1.2 local English OCR for scanned/image-only PDF pages is complete; additional languages require new verified language assets.
- Intelligent field extraction and source attribution remain future work.

### Phase 5 — Form intelligence

- Deterministic field matching against the local vault.
- Semantic matching with Qwen3.
- Contextual answer generation.
- Review and approval workflow.

### Phase 6 — Security and cloud removal

- Encrypt the existing vault data through the new crypto layer.
- Backup and restore.
- Remove Google Drive.
- Remove Gemini and OpenAI-compatible providers.
- Remove demo data and mock execution paths.
- Full offline verification and security testing.

## Known limitations after Phase 2

- The dashboard still has non-migrated surfaces that use the backend: authentication, Google Drive connections, and some onboarding/extension screens.
- Google Drive, Gemini, and OpenAI-compatible code remain.
- No extension-owned dashboard exists.
- No local AI inference runs in the extension.
- At that time, no document text extraction, OCR, or AI-based extraction ran in the dashboard.
- Document processing was intentionally limited to local storage and metadata in that phase.
- At that time, no OCR or PDF assets were packaged in the extension; Phase 4.1.2 now packages SHA-256-verified OCR assets.
- `extension/src/workers/ocr.worker.ts` is not built because it is not referenced by the extension; OCR uses the offscreen OCR runtime instead.
- No encrypted backup/restore exists.
- IndexedDB data is not encrypted in this phase.
- Existing user data remains in the old backend storage until a user runs the migration wizard.
