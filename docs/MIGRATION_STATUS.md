# FormFlow Migration Status

FormFlow is now an **extension-owned, locally encrypted vault** for the production workflow. The extension dashboard and popup share one canonical IndexedDB vault under the extension origin. The localhost dashboard remains a development and migration surface.

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
- The raw data key is held in `chrome.storage.session` for the active browser session only. It is not written to IndexedDB or `chrome.storage.local`.
- Locking clears the session key.
- Browser restart clears `chrome.storage.session` and requires unlock.
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
- Document text extraction, OCR, and AI processing are still future phases.
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

- Real PDF processing.
- Real DOCX processing.
- Real image and scanned-PDF OCR.
- Document ingestion workflow and processing statuses.
- Source attribution.

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
- No document text extraction, OCR, or AI-based extraction runs in the dashboard yet.
- Document processing is intentionally limited to local storage and metadata in this phase.
- No OCR or PDF assets are packaged in the extension.
- `extension/src/workers/ocr.worker.ts` is not built because it is not yet referenced by the extension.
- No encrypted backup/restore exists.
- IndexedDB data is not encrypted in this phase.
- Existing user data remains in the old backend storage until a user runs the migration wizard.
