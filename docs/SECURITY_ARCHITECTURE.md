# FormFlow Security Architecture

Status: Phase 4.1.2 local OCR for scanned PDFs. This document describes the implemented security design, what has been tested, and what remains a residual risk. FormFlow has **not** undergone a professional penetration test or third-party security audit.

## 1. Threat model

### Assets

- Original document bytes.
- Extracted document text.
- Personal profile values, labels, education/employment/address records.
- Collections, notes, activity descriptions, and form history.
- The vault passphrase, key-encryption key (KEK), and data-encryption key (DEK).

### Adversaries considered

- A malicious webpage or content script.
- A different extension or an arbitrary extension page.
- A user or process that can read the IndexedDB files but does not know the passphrase.
- A hand-crafted or corrupted encrypted backup.
- Accidental corruption, interrupted transactions, or storage-quota failures.
- A stale UI or in-flight request that races with a lock.

### Out of scope

- A compromised browser binary or extension process.
- A malicious operating-system administrator, memory forensics, or cold-boot attacks.
- Physical access to an unlocked device.
- A compromised dashboard/service-worker context or a malicious extension with the same extension origin.
- Coercion, keyloggers, or malware running with the user's privileges.
- Guaranteed JavaScript memory erasure.

## 2. Trust boundaries

```text
Untrusted web page
  └── content script (no key, no vault DB, narrow scan/fill messages)
        │  user-triggered tab messages
Trusted extension origin  chrome-extension://<id>
  ├── popup      ── validated operation protocol ──► service worker
  ├── dashboard  ── validated operation protocol ──► service worker
  ├── service worker ── sole DEK owner + privileged vault operations
  │      │ narrow parser port
  │      └──► offscreen parser document (no vault/DB/crypto imports)
  │              └──► request-scoped parser Web Worker (bytes only)
  │
Local browser storage
  ├── IndexedDB formflow-local (ciphertext + structural metadata)
  └── chrome.storage.session (non-secret lock/state marker only)

Separate origin
  └── localhost dashboard (development/migration only; no extension messaging)
```

| Context | Vault DB | DEK | Notes |
|---|---|---|---|
| Service worker | Yes | Yes | Exclusive cryptographic authority; owns all vault operations |
| Extension dashboard | No direct vault access | No | Typed operation client; receives only the minimum response data |
| Popup | No direct DB | No | Typed operation client through the service worker |
| Content script | No | No | Receives only approved fill values and page scan data |
| Offscreen parser | No | No | Extension-origin hidden document; narrow parser port only; IndexedDB runtime-blocked; no vault/DB/crypto imports |
| Parser worker | No | No | One worker per parse; receives base64-decoded bytes and no key/AAD/session |
| Localhost page | Separate dev DB | Dev-only | Development alias; excluded from the extension build |

The dashboard cannot retrieve the DEK, export key material, or send arbitrary encryption/decryption/AAD parameters. It calls explicit operations. The popup and content script receive no key material. `chrome.storage.session` contains only a non-secret `{state, generation, updatedAt}` marker.

### Why the vault locks on service-worker termination

A DEK persisted in `chrome.storage.session` would be readable by extension pages, including the dashboard. To keep the dashboard outside the key boundary, the DEK is memory-only inside the service worker. Manifest V3 can terminate the worker after idle periods; when that happens the DEK is lost and the vault locks. The dashboard and popup use the non-secret state marker to clear sensitive UI and require a fresh unlock. The dashboard and popup hold a validated extension-page keepalive port while open, reducing idle termination during active use. If the worker is still terminated, the vault locks and the security invariant takes precedence over session continuity.

### Extension-origin hardening

- CSP: `script-src 'self'; object-src 'none'; worker-src 'self'`.
- Dashboard/popup HTML adds `base-uri 'none'; object-src 'none'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:`.
- No `unsafe-eval`, remote scripts, inline scripts, dynamic code evaluation, or remote executable JavaScript.
- The content-script page-world ping/pong bridge was removed; the host page has no extension bridge.
- React renders user-controlled values as text. A repository sweep found no `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or `new Function` in the application.
- XSS Chromium tests store malicious collection names, descriptions, and profile values and verify no image/handler execution.
- The message router remains the only privileged authority; sender, protocol, request ID, operation, payload, session, and lease checks remain in force.

## 3. Key hierarchy

```text
User passphrase
  │  PBKDF2-SHA256, 600,000 iterations, random 16-byte salt
  ▼
Key-encryption key (KEK, AES-256-GCM, non-extractable in use)
  │  AES-256-GCM wrap
  ▼
Random 256-bit data-encryption key (DEK)
  │  AES-256-GCM, fresh 12-byte nonce per operation
  ▼
Encrypted records and document blobs
```

- The passphrase is never stored.
- The KEK is derived on demand and is not persisted.
- The DEK is wrapped by the KEK. It is never written to IndexedDB, `chrome.storage.local`, or `chrome.storage.session`.
- While unlocked, the DEK exists only in the service worker as an in-memory `CryptoKey` (imported non-extractable for operation use). No extension page or popup receives it.
- Locking clears the in-memory `CryptoKey`; service-worker termination or browser restart also clears it.
- The non-secret state marker in `chrome.storage.session` is cleared on browser shutdown and overwritten with `locked` when the worker starts.
- Passphrase changes derive a new KEK with a new random salt and rewrap the same DEK. The new envelope is authenticated before the metadata update is committed.

The wrapped-DEK envelope keeps the legacy `formflow:vault:v1` AAD because it is a single key-wrap record, not a vault record, and changing it would make existing vaults unopenable without a separate recovery migration.

## 4. Encryption format

### Algorithms

| Property | Value |
|---|---|
| Cipher | AES-256-GCM |
| Authentication tag | 128 bits |
| Nonce | 12 random bytes per encryption |
| AAD | Per-record canonical context (format v2) |
| KDF | PBKDF2-SHA256 |
| Iterations | 600,000 |
| Vault salt | 16 random bytes |
| Backup archive KDF | PBKDF2-SHA256, 600,000, 16-byte salt |
| Envelope version | 2 for new records; 1 accepted for migration |

### AAD format (v2)

The AAD is a length-prefixed UTF-8 encoding of:

```text
formflow | record | 2 | schemaVersion | vaultId | recordType | recordId | field
```

Each segment is encoded as `<byteLength>:<value>` and joined with `|`. Length-prefixing prevents delimiter injection or ambiguous field boundaries from attacker-controlled IDs.

Examples of `recordType` / `field`:

| Record | Type | Field |
|---|---|---|
| Profile | `profile` | `profile` |
| Document name | `document` | `name` |
| Original filename | `document` | `originalFilename` |
| Document bytes | `documentFile` | `file` |
| Value | `value` | `value`, `normalizedValue`, `label` |
| Conflict | `conflict` | `existingValue`, `newValue`, `label` |
| Profile record | `profileRecord:<type>` | `data` |
| Collection | `collection` | `name`, `description`, `notes` |
| Activity | `activity` | `title`, `detail` |
| Form history | `formHistory` | `website`, `url`, `documentsUsed` |
| Document text | `documentText` | `text`, `pageTexts`, `extraction` |

Changing a record ID, record type, field, vault ID, or schema version causes authentication failure. Ciphertexts cannot be moved between records, between fields, or between vaults and still decrypt.

### Record envelope

JSON envelope for encrypted JSON fields:

```json
{ "v": 2, "alg": "AES-GCM", "iv": "<base64 12 bytes>", "data": "<base64 ciphertext+tag>" }
```

Document blobs store `iv`, ciphertext bytes, `version: 2`, and `aadVersion: 2`. Legacy blobs without `aadVersion` are read with the v1 AAD only during migration.

### V1 compatibility

Phase 3 records use envelope version 1 and the vault-wide AAD `formflow:vault:v1`. Readers accept v1 records until the v2 migration completes. New writes always use v2. The migration status is stored in `vaultMeta.encryptionFormat` and a journal.

## 5. Metadata encryption

### Encrypted at rest

- Document title and original filename.
- Original document bytes.
- Extracted document text, page text, extraction warnings, and extracted PDF/DOCX metadata.
- Personal field labels and values.
- Profile object and all profile record payloads (education, employment, skills, certifications, projects, addresses).
- Collection names, descriptions, and notes.
- Activity titles and descriptions.
- Form history website, URL, and used-document list.
- Conflict values and labels.
- Vault display name (`vaults.nameEnc`, bound to vault ID, record type, field, schema version, and record AAD).

### Remaining plaintext metadata

- Record IDs and vault ID.
- Field keys / schema identifiers (needed for matching and indexes).
- Categories, statuses, verification states.
- Timestamps.
- File sizes, MIME types, extensions, size labels.
- The document `metadata` object (processing metadata; it can contain a legacy document ID but not field values).
- Document checksums.
- Collection colors and membership IDs.
- Activity type.
- Preferences and onboarding settings.
- Migration journal counts and timestamps.
- `storageKey` values (the actual ciphertext is keyed by record ID).

These fields are needed for indexing, sorting, UI state, or integrity checks. They can reveal document counts, record types, approximate activity times, and file sizes. They do not reveal document contents, field values, labels, filenames, collection text, history URLs, or the vault display name.

### Metadata classification

- **Required operational:** IDs, field keys, categories, statuses, timestamps, MIME/extension, sizes, checksums, collection membership IDs, storage keys. These support indexes, relationships, sorting, and integrity checks.
- **Encrypted:** filenames, titles, labels, values, profile data, collection text, activity/history text, document bytes, document text, extraction warnings/metadata, and the vault display name.
- **Removed/replaced:** no additional removals in this phase; error messages avoid logging personal values, and dashboard responses are limited to operations the UI needs.

Search is performed after decryption in the trusted extension context. There is no remote search and no plaintext search index.

## 6. Session lifecycle and locking

- Unlock: derive KEK, unwrap DEK, import it into service-worker memory, increment the session generation, publish `unlocked`.
- Explicit lock: enter `locking`, reject new operations, drain in-flight leases, clear the in-memory key, increment the generation, publish `locked`.
- Auto-lock: dashboard inactivity timer (pointer, keyboard, touch, scroll) plus a background `chrome.alarms` backstop; both use the coordinated lock path.
- Browser restart: the service worker starts with no key; publish `locked`; the unlock screen is required.
- Service-worker termination: the in-memory key is lost; the new worker publishes `locked`. Chromium verifies that the next request reports locked, the key is absent from session storage, and the user can unlock again.
- Lock coordination: a background `VaultOperationCoordinator` tracks active read/mutation leases. Lock sets state `locking` synchronously, rejects all new leases, and waits for existing leases to settle before clearing the key and acknowledging lock. A timeout returns an error and keeps the vault unlocked; it never reports locked while a mutation can commit.
- Session generation: the router captures the generation and rejects any data-bearing response if it changed. Coordinator leases make the generation stable for the duration of an operation.
- Dashboard/popup: hold a validated extension-origin keepalive port while open; subscribe to the non-secret state marker and clear fetched values, matches, collections, history, document preview URLs, and sensitive actions on `locking`/`locked`.

### Lock coordination details

`core/vault/operation-coordinator.ts` implements:

- `locked → unlocking → unlocked` for create/unlock transitions.
- `unlocked → locking → locked` for lock.
- A lease registry for every data-bearing background operation. Leases are acquired only while `unlocked` and released only after the handler's IndexedDB transaction has completed or failed.
- Synchronous transition to `locking` on lock request, so new reads/mutations are rejected even while older operations drain.
- Lock waits for active leases; the key is cleared only after the drain and only then is `locked` published.
- Multiple lock requests share one transition promise; a lock while already locked is a no-op.
- Unlock during locking is rejected. Lock during an unlock is rejected so the state cannot interleave.
- The lock timeout is 60 seconds. On timeout the coordinator returns an error, restores `unlocked`, and never publishes `locked`; the vault remains usable and the user can retry. There is no false lock-success state.
- The dashboard has no direct vault repository path; all mutations and decrypted reads are leases in the background. This is what closes the "committed after lock" race rather than merely discarding a response.
- Document preview object URLs are revoked on lock and after a timeout.

JavaScript cannot guarantee that copies of a key or decrypted value have been erased from all engine memory.

## 6.1 Local document ingestion (Phase 4.1.1) and local OCR (Phase 4.1.2)

### Trust boundary

```text
Dashboard file picker
  └── base64 import operation (typed background protocol)
        └── service-worker ingestion coordinator
              ├── validates format signature, size, MIME hint, and vault state
              ├── computes SHA-256 and rejects duplicates
              ├── encrypts original bytes with the documentFile AAD
              ├── sends only non-secret parse fields + base64 bytes over a
              │   dedicated port to the hidden offscreen parser document
              │       ├── request-scoped parser Web Worker (native text)
              │       └── request-scoped local OCR path (Phase 4.1.2)
              │             ├── PDF.js renders only OCR-required pages
              │             ├── canvas is passed to a local Tesseract worker
              │             └── decoded, non-executable OCR data is returned
              ├── validates every parser/OCR result again
              ├── encrypts text/pageTexts/extraction details with documentText AAD
              └── one strict IndexedDB transaction for document + file + text
```

The offscreen document is created with Chrome's Offscreen API using the narrow **`WORKERS`** reason. It runs a hidden extension page (`offscreen-parser.html`) with no user-facing UI or navigation controls. The page creates one parser Web Worker per request. The worker receives only the selected document bytes (base64 decoded by the offscreen page), format, filename, parser version, OCR language identifier, and a request ID. It has no vault session, DEK, KEK, AAD, database handle, repository import, generic RPC bridge, or network access.

OCR does not pass PDF bytes to the Tesseract worker. Only a rendered canvas, language identifier, request ID, and bounded Tesseract parameters cross that worker boundary. The OCR result is validated as untrusted input before the background persists it.

The background remains the exclusive authority for duplicate detection, encryption/decryption, AAD construction, vault IndexedDB access, atomic persistence, and lock/unlock. Parser output is treated as untrusted and validated by both the offscreen document and the background before persistence.

### Offscreen lifecycle

- A single module-level creation promise prevents conflicting document creation.
- The background waits for the offscreen page to connect over the exact `formflow-offscreen-parser` port and validates `sender.id` plus the exact `chrome-extension://<id>/offscreen-parser.html` URL.
- If an existing document is present without a live port, the background closes it and recreates it. This covers service-worker restarts and stale documents.
- The offscreen document becomes idle and closes after 15 seconds with no active parses. The background recreates it on demand.
- A background port disconnect cancels all active workers and closes the offscreen document. A service-worker restart or extension reload therefore cannot leave an orphan parser.
- Every parse has its own worker. User cancellation terminates only that worker; a second active parse is unaffected.
- The offscreen document enforces a maximum of **2 concurrent parses**. Additional requests receive `PARSER_BUSY`.
- A hard parser timeout is enforced by the ingestion coordinator (300 seconds, including OCR) and the background parser client. Per-OCR-page processing is separately limited to 30 seconds. Cancellation sends `CANCEL_PARSE`; the offscreen terminates the request-scoped parser and OCR workers.

### Parser message protocol

Only these operations exist:

| Operation | Direction | Purpose |
|---|---|---|
| `PARSE_DOCUMENT` | background → offscreen → worker | Strict request with `protocol`, `requestId`, `parserVersion`, `format`, `fileName`, `sizeBytes`, bundled `ocrLanguage`, and base64 bytes |
| `CANCEL_PARSE` | background → offscreen → worker | Request-scoped cancellation |
| `PARSE_PROGRESS` | worker → offscreen → background | Bounded page/progress update with an optional `text` or `ocr` stage |
| `PARSE_RESULT` | worker → offscreen → background | Structured text/page/warning/metadata result plus optional validated OCR details |
| `PARSE_ERROR` | worker → offscreen → background | Coded, bounded error |

Every message uses a unique request ID and strict exact-key validation. Unknown operations, extra fields, invalid request IDs, unsupported formats/parser versions, unbundled OCR languages, size mismatches, malformed progress, oversized results, inconsistent page boundaries, excess warnings, and unexpected metadata are rejected. OCR results receive an additional exact-shape validation: page numbers bounded by the document, line/word caps, confidence in 0–100, non-inverted bounding boxes, status/page-count invariants, and no duplicate OCR page numbers. The protocol is not a generic RPC bridge. The offscreen document cannot call `LIST_DOCUMENTS` or any other vault operation: the background runtime router explicitly rejects the offscreen document URL as an untrusted privileged sender. Its only accepted channel is the dedicated parser port.

### Resource limits

- 20 MB per original document.
- 1,000 PDF pages.
- 10,000,000 extracted characters; the offscreen result cap allows the duplicated `text` + `pageTexts` representation with a fixed headroom.
- 24 MB per DOCX XML part and 96 MB total uncompressed DOCX content.
- 100 extraction warnings per document.
- Maximum 2 concurrent parser workers (and therefore at most 2 concurrent OCR attempts).
- 300-second ingestion timeout; 30-second per-OCR-page timeout; request-scoped cancellation; 15-second offscreen idle shutdown.
- OCR rendering: 200 DPI, maximum 12 megapixels per page, maximum scale 3, maximum 100 OCR pages per attempt.
- OCR output caps: 500 words per page, 5,000 words per result, 200 lines per page, 1,000,000 serialized OCR detail characters.

### Format validation and extraction behavior

- PDF: `%PDF-` signature, PDF.js parse, page limit, password/corruption classification, per-page text, page count, best-effort metadata, image-operator detection, and warnings. Image-only pages are marked OCR-required. Phase 4.1.2 renders only those pages and runs local OCR; successfully recognized pages no longer remain OCR-required.
- DOCX: ZIP signature, required `word/document.xml`, bounded uncompressed XML/media size, Mammoth validation, and structural WordprocessingML parsing without HTML rendering. Tables are tab-separated; headings and line breaks are preserved. DOCX is stored as one logical page with a warning.
- TXT: strict UTF-8 decode, BOM detection, CRLF/CR/LF normalization, NUL/control rejection, and empty-content rejection.
- Browser MIME and extension are cross-checked but are not trusted as the format authority.

### Encrypted persistence and atomicity

- The document row (`documents`), original bytes (`documentFiles`), and extracted text (`documentText`) are encrypted before commit.
- `StoredDocumentText.textEnc` uses AAD `documentText` / `text`; `pageTextsEnc` uses `pageTexts`; the optional `extractionEnc` uses `extraction`.
- The `extractionEnc` payload contains warnings, pages requiring OCR, PDF/DOCX metadata, and (when OCR ran) the OCR engine/version, language, timestamp, page status, average confidence, lines, words, bounding boxes, and warnings. It is never stored in plaintext record metadata or logs. The document list row carries only non-sensitive OCR status, language, confidence, and page-count fields.
- The three records are written in a single IndexedDB transaction with `durability: 'strict'`. Duplicate checksum validation happens before the record is created and again inside the transaction. A quota error, parser failure, lock, cancellation, offscreen failure, or worker termination rolls back the whole transaction. The UI is not told that an import succeeded until after that transaction completes.
- SHA-256 duplicate detection returns the existing document and never silently replaces it. The UI displays the existing document name.
- Extraction retry reads the encrypted original, re-runs the isolated parser, and replaces the text/extraction details in one transaction without creating a second document.
- Dashboard progress travels over a separate extension-origin-only port and contains stage, percentage, file index/count, and page number only — no filename, extracted text, key, AAD, or metadata. Phase 4.1.2 adds a distinct `running_ocr` stage and real per-page OCR progress; no synthetic progress is reported.

### Local OCR security and resource behavior (Phase 4.1.2)

- **Selected engine:** Tesseract.js 7.0.0 with tesseract.js-core 7.0.0, Apache-2.0; `@tesseract.js-data/eng` 1.0.0 language data, MIT. Only English (`eng`) is bundled and claimed.
- **Local assets only:** `tesseract/worker.min.js`, the SIMD LSTM core JS/WASM, and `tessdata/eng.traineddata.gz` are packaged. The build copies each asset and verifies its SHA-256; a mismatch fails the build. The offscreen page verifies the language data's size and SHA-256 again before starting the engine.
- **No external inference:** explicit `workerPath`, `corePath`, and `langPath` values override Tesseract.js CDN defaults. `workerBlobURL: false` keeps `worker-src 'self'`. The Chromium suite is run with external DNS disabled and records zero external requests.
- **CSP:** the offscreen page uses `default-src 'none'`, `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`, `connect-src 'self'`, `img-src 'self' data: blob:`, and no remote sources. `'wasm-unsafe-eval'` is required by Chrome to instantiate the local Tesseract WASM core; it does not permit JavaScript `eval`.
- **No key material:** the OCR path receives none of the DEK, KEK, passphrase, vault session, AAD, IndexedDB handle, or repository. The Tesseract worker receives a rendered canvas, the language identifier, request ID, and bounded OCR parameters.
- **Untrusted output:** the background re-validates OCR details and status/page invariants. Invalid OCR output is discarded, the already-validated native extraction is preserved, and the OCR attempt is marked retryable instead of failing the whole import.
- **Incremental processing:** only OCR-required pages are rendered, one canvas at a time. Canvas dimensions are capped, page resources are released after processing, and the request-scoped Tesseract worker and PDF renderer are destroyed in `finally` paths. Cancellation aborts the current page and terminates the request-scoped workers.
- **Failure isolation:** language availability, engine initialization, rendering, per-page timeout, worker crash, offscreen shutdown, cancellation, or malformed OCR output never overwrites the encrypted original. A failed OCR attempt is stored as `failed`/`partial` with `pagesNeedingOcr` for retry; the original and any native text remain available.
- **Encrypted persistence:** recognized text and OCR details use the existing `documentText` AAD fields `text`, `pageTexts`, and `extraction`. The AAD includes document ID, so cross-document ciphertext swapping fails.

### Build-time isolation proof

The extension build uses esbuild metafiles and fails if:

- `background.js` contains PDF.js, Mammoth, parser modules, or Tesseract.js.
- `offscreen-parser.js` contains parser runtime or any `core/vault`, `core/database`, `core/encryption`, `core/storage`, `core/application`, or vault-client input.
- `document-parser.worker.js` contains any vault, database, encryption, storage, or application input.
- The offscreen HTML contains inline scripts, remote scripts, or inline event handlers.
- The manifest does not declare `offscreen`, Chrome < 109, or a CSP missing `worker-src 'self'`.
- The dashboard bundle contains parser internals.
- Any packaged OCR asset is missing or does not match its pinned SHA-256.

### Chrome compatibility

The Offscreen API requires Chrome 109 and the `"offscreen"` permission. The manifest now requires Chrome 109 or newer. The tested browser is Google Chrome for Testing 156.0.8078.4. The offscreen document uses the `WORKERS` reason because it must spawn request-scoped parser workers.

## 7. Vault migrations

### Phase 2 plaintext → encrypted

Detected when a vault record exists without `vaultMeta`. The migration snapshots plaintext rows, encrypts v2 records, writes them in one IndexedDB transaction, and sets the format marker. On error it attempts a rollback and locks the session. It is covered by unit tests.

### Phase 3 v1 → v2 per-record AAD

Journal key: `settings.encryptionMigrationV2`.

Journal fields: status (`in_progress`, `failed`, `complete`), started/updated/completed timestamps, per-store migrated counts, last error.

Process:

1. Require an unlocked vault.
2. Acquire a Web Lock (`formflow-vault-encryption-v2`) so dashboard and service worker cannot migrate concurrently.
3. Write the journal as `in_progress`.
4. Process stores in controlled batches (20 records, one document blob at a time):
   - read v1 fields,
   - encrypt with v2 AAD,
   - decrypt the new value and compare before writing,
   - re-read the row inside the write transaction and compare the old ciphertext (compare-and-swap) so concurrent edits are not overwritten.
5. Verify every encrypted field in the vault, every label, every document file, and decrypt all of them.
6. Only then set `vaultMeta.encryptionFormat = 2`, mark the journal complete, and set `storageFormat = 'encrypted-v2'` in one transaction.

Recovery:

- A crash before a batch transaction commits leaves the old records; IndexedDB rolls the batch back.
- A crash after a batch commits leaves a mix of v1 and v2; the next run re-encrypts only v1 envelopes and skips v2.
- A failed or corrupted record sets the journal to `failed`, keeps `encryptionFormat = 1`, and leaves all records in place.
- The marker is never set to 2 while `verifyVault` fails.
- The migration is idempotent and can be retried.
- A partial migration is never treated as complete.

The migration exposes deterministic fault points: `before_migration`, `before_batch`, `before_write`, `during_transaction`, `after_commit`, `before_journal`, `after_journal`, `before_verification`, `before_marker`, and `after_marker`. Tests throw at each critical point, then rerun and verify the vault reaches format 2 with a passing integrity check.

Quota exhaustion is fault-injected at migration batches, journal writes, and the final marker update. Transactions abort, the marker stays at 1, and retry succeeds after storage is available. The tests also cover document import and backup import quota failures, verifying that no partial document or partially imported vault remains.

## 8. Backup format and import defenses

### Format

New archives use envelope **version 3**:

```json
{
  "format": "formflow-encrypted-backup",
  "version": 3,
  "header": {
    "application": "FormFlow",
    "backupFormat": 3,
    "cipher": "AES-GCM",
    "kdf": "PBKDF2-SHA256",
    "iterations": 600000,
    "salt": "<base64 16 bytes>",
    "nonce": "<base64 12 bytes>",
    "encryptionFormat": 2,
    "schemaVersion": 3,
    "manifestVersion": 1,
    "documentCount": 0,
    "valueCount": 0,
    "collectionCount": 0,
    "conflictCount": 0,
    "profileRecordCount": 0,
    "activityCount": 0,
    "historyCount": 0,
    "textCount": 0,
    "totalBytes": 0,
    "payloadBytes": 0,
    "createdAt": "..."
  },
  "payload": "<base64 ciphertext+tag>"
}
```

The complete header is the AES-GCM AAD, encoded as fixed-order length-prefixed segments (`formflow | backup-header | 3 | field-name | value | ...`). Changing any authenticated field causes authentication failure. `payloadBytes` is the decoded ciphertext length and is checked before key derivation. Duplicate JSON keys in the v3 header are rejected before parsing.

Legacy archives remain importable:

- v1: original legacy AAD `formflow:vault:v1`.
- v2: original fixed archive AAD `formflow-backup / backup / archive / payload`.
- v3: canonical authenticated header AAD.

New exports always use v3. The documented size limit is exactly `200 × 1024 × 1024 = 209,715,200` bytes. The check runs before reading, parsing, decoding, or KDF work.

### Validation before writing

- File size: non-empty, ≤ 209,715,200 bytes.
- Envelope shape, required keys, no unexpected keys.
- Format and version 1, 2, or 3; v3 header fields, types, bounds, and duplicate keys.
- KDF name exactly PBKDF2-SHA256 and iterations exactly 600,000 (untrusted KDF parameters rejected; CPU exhaustion prevented).
- Salt exactly 16 bytes; nonce exactly 12 bytes; payload valid base64.
- Cipher name exactly AES-GCM.
- Manifest schema 3, counts and total bytes bounded and matched against the decrypted payload.
- Record-count caps: 5,000 documents/files, 50,000 values, 5,000 collections, 50,000 conflicts/activity/history, 10,000 profile records, 10,000 text records.
- Duplicate document, file, value, conflict, collection, membership, activity, history, text, and file IDs rejected.
- Supported extension, file type, MIME type, statuses, categories, verification states, and activity/history types.
- ISO timestamps and finite non-negative numeric fields.
- UTF-8 decoding with `fatal: true`.
- Document bytes decoded, exact size checked, SHA-256 recalculated, and compared to the archived checksum.
- Collection memberships must reference existing collections and documents.
- Oversized strings, deeply nested metadata, and oversized arrays rejected.
- Target vault must be empty (no documents, values, collections, or customized profile).
- The target is re-checked immediately before the write.

### Import transaction and rollback

All encrypted records are constructed in memory, then written in one IndexedDB transaction across the affected stores. Decryption, authentication, checksum, relationship, and target-state validation happen before the transaction. A malformed archive cannot partially modify the active vault. After the transaction, the import runs the vault integrity checker and raises an error if any imported record, file, or relationship is invalid.

### Atomic restore staging and journal

Restore intentionally targets only an empty vault. The import path does not write any active record until all of the following have succeeded:

1. Archive size, outer envelope, header authentication, KDF, payload shape, manifest, records, relationships, MIME/extension, timestamps, duplicate IDs, and checksums.
2. Every encrypted field is constructed with the target DEK and then decrypted and compared to its staged plaintext.
3. Every document blob is decrypted, size-checked, and SHA-256 checked.
4. A `ready` restore journal is persisted.

The activation is one IndexedDB transaction over all active stores plus the restore journal. Inside the transaction, active document/value/collection counts are checked again to detect concurrent modification. The transaction writes the imported records, a `complete` journal, and an activation marker atomically. If any put fails or quota is exhausted, the transaction aborts and the target remains unchanged.

Journal states: `validating`, `ready`, `complete`, `failed`. `activating` is an in-memory phase; the durable activation marker and complete journal commit in the same transaction, avoiding an ambiguous persisted intermediate.

On startup and after unlock, recovery reads the journal, activation marker, and actual target counts. If an activation marker matches and counts match, the journal is marked complete. If there is no marker and the target is empty, the journal is marked failed and the target remains untouched. If records exist without a matching marker, nothing is deleted; the journal is marked failed for inspection. Duplicate/concurrent restores are rejected by an in-process restore gate.

This uses a **pre-validated in-memory staging representation plus one atomic activation transaction** rather than a separate staging database. It avoids duplicating plaintext or ciphertext in a second database while preserving the required invariant: no active record changes before complete validation, and a failed restore cannot partially replace the target.

## 9. Integrity checker

The dashboard security page exposes **Run integrity check**. It verifies:

- Encryption metadata and per-record AAD.
- Decryption of profile, values, labels, conflicts, profile records, collections, activity, history, and text.
- Presence of a file for every document and no orphan files.
- Decrypted file size and SHA-256 against document metadata.
- Collection membership targets.
- Source-document references for values, conflicts, and profile records.
- Incomplete or failed v1→v2 migration state.

The checker reports issues and never deletes or rewrites corrupted records. The user can still export an encrypted backup.

## 10. Implemented, tested, theoretical, untested

### Implemented and tested

- Background-only DEK authority; dashboard/popup operation clients receive no key material.
- Coordinator leases and lock draining; no new operation after locking begins.
- Backup v3 authenticated header and v1/v2 compatibility.
- Migration fault injection at all journal/transaction/marker boundaries.
- Quota injection for document import, backup import, migration batch, journal, and marker writes.
- Exact 200 MB boundary tests.
- AES-256-GCM record encryption and 600,000-iteration PBKDF2-SHA256.
- Per-record AAD binding across ID, type, field, vault, and schema version.
- Fresh nonce per operation.
- Cross-record, cross-field, cross-type, and cross-vault ciphertext rejection.
- Nonce, ciphertext, tag, and envelope tampering rejection.
- V1→v2 migration of all record types, failure and resume, idempotency.
- Phase 2 plaintext migration.
- Label encryption and encrypted vault display names with a name-format marker and migration.
- Passphrase change, old-passphrase rejection, new-passphrase access, document access after change.
- Hostile backup archives: malformed JSON, truncation, versions, algorithms, salt, nonce, base64, KDF parameters, manifests, ciphertext, UTF-8, duplicate IDs, missing files, checksums, negative sizes, relationships, unexpected fields, timestamps, MIME/extension.
- Pre-activation encrypted-field, checksum, and relationship verification before atomic restore activation.
- Restore journal recovery from incomplete staging and activation markers; concurrent target modification detection.
- Failed import leaves the target unchanged.
- Integrity checking of swapped ciphertext, missing files, checksum mismatch, and broken membership.
- Session generation across lock/unlock and concurrent transition serialization.
- Popup/dashboard clearing on remote lock, browser restart locking, service-worker termination locking.
- Chromium E2E with a real PDF, DEK absence in dashboard/popup storage, generic-operation rejection, ciphertext inspection, tamper test, upload-versus-lock draining, passphrase rotation, v3 header tamper, valid v3 import, genuine v1/v2 imports, restore journal recovery, CSP enforcement, and XSS payload rendering.
- A real Chromium process kill during backup restore, followed by restart, journal inspection, and successful retry.
- A real Chromium SIGKILL during v1→v2 migration after a committed `documents` journal batch, followed by restart, resume, integrity verification, record-count comparison, duplicate detection, ciphertext inspection, and document-blob access.
- Real Chromium Phase 4.1 ingestion: a Chromium-generated multi-page PDF, DOCX headings/tables, BOM/CRLF TXT, image-only OCR-required PDF, corrupted PDF, and password-protected PDF; encrypted-at-rest text and v2 AAD verified; duplicate, retry, cancellation, progress, and dashboard states verified.
- Real Chromium interruption during a 1,000-page offscreen ingestion: extension disabled, offscreen/worker terminated, re-enabled, unlocked, and no partial document/file/text triple found; a later import succeeded atomically.
- Atomic ingestion rollback for parser failure, cancellation, vault lock, and quota failure; backup v3 round-trip preserves encrypted extraction details.
- Phase 4.1.1 real Chromium offscreen suite: PDF/DOCX/TXT parsed through the offscreen document; offscreen context presence, IndexedDB blocking, exact request/result field allowlists, denial of arbitrary background vault operations, malformed request/response rejection, oversized result rejection, parser timeout, offscreen failure recovery, concurrency, one-of-two cancellation, vault lock draining, duplicate detection, and encrypted persistence.
- Phase 4.1.2 real Chromium OCR suite with genuine Tesseract recognition (no mocked output): image-only, multi-page scanned, mixed text/image, rotated, and low-quality pages; OCR language initialization and missing-language failure; confidence/line/word/bbox persistence; progress; cancellation; timeout; offscreen crash and recovery; extension restart during OCR; partial success; duplicate OCR prevention; encrypted OCR at rest; AAD tamper rejection; no key material in offscreen diagnostics; and zero external network requests with external DNS disabled.
- Build-time bundle isolation checks prove the service worker contains no parser runtime or OCR dependencies, and the offscreen document/worker contain no vault, database, encryption, storage, or application modules.
- An in-place extension disable/re-enable lifecycle using a test-only management helper: worker restart, no persisted DEK, dashboard/popup locked UI, unlock persistence, and interruption of a 20 MB document mutation without a partial document/file pair.
- Runtime HTTP and HTTPS page isolation: content script absent, no extension APIs/session storage/vault IndexedDB/page-world bridge.
- Runtime Google Forms-origin injection and background scan through the real content script.

The migration fixture is generated by test-only files (`extension/src/background.test.ts`, `extension/src/test-hooks.ts`, `core/vault/downgrade-test.ts`) and a test-only management helper extension. The production `background.js` was rebuilt and verified to contain none of the test-hook strings.

### Simulated or partially tested

- Migration crash boundaries are also covered by deterministic fault injection, which complements the real migration SIGKILL test.
- Storage quota is simulated by throwing `QuotaExceededError` from IndexedDB `put`; it is not a physical disk-full test.
- The 200 MB boundary uses synthetic `Blob` size/text shims and a small valid archive; it does not allocate a 200 MB fixture.
- The real Chromium timeout test uses a test-only bounded timeout and parse/OCR delay hooks; the production 300-second ingestion and 30-second per-page OCR timeouts are not stalled in full.
- Malformed offscreen request/response and oversized-result tests use a test-only injection hook in the offscreen test build; production offscreen code does not expose those hooks.
- The extension reload test uses `chrome.management.setEnabled(false/true)` with a test-only helper extension, not `chrome.runtime.reload()`, because the Playwright `--load-extension` harness blocks extension navigation after `runtime.reload()`. It preserves extension ID/storage and restarts the worker, exercising the same DEK-loss and lock behavior.
- The Google Forms runtime page is served at the real `https://docs.google.com/forms/...` origin through Playwright route interception, not fetched from Google's production servers.

### Untested

- Firefox and Safari.
- `chrome.runtime.reload()` under the Playwright `--load-extension` harness; the management disable/enable equivalent is tested instead.
- A physical disk-full environment.
- Coverage-guided fuzzing of the archive parser.
- Cross-site scripting inside the extension origin (the escape tests cover stored data rendering, not an XSS vulnerability in extension code).
- Malicious other extensions or a compromised browser profile.
- Professional penetration testing, formal cryptographic review, or a security audit.

## 11. Known residual risks and limitations

1. **Restore only targets an empty vault.** Restoration does not replace a populated vault; doing so would need a separate activation/generation design and an explicit destructive confirmation flow.
2. **Structural metadata remains plaintext** as listed in section 5.
3. **Restore staging is in-memory.** Validation is complete before activation and activation is one transaction, but there is no separate on-disk staging database; a crash before activation simply leaves the journal and target for recovery.
4. **Dashboard compromise while unlocked.** The dashboard cannot read the DEK, but a compromised dashboard can submit authorized vault operations while the vault is unlocked. Operation schemas and leases limit arbitrary access; they do not distinguish a malicious authenticated UI from the real one.
5. **Offline passphrase guessing.** An attacker with the ciphertext can attempt passphrases offline. PBKDF2 at 600,000 iterations raises cost but does not prevent weak passphrases. The UI requires at least 10 characters.
6. **No recovery.** Losing the passphrase or backup passphrase makes the corresponding data unrecoverable.
7. **Backup legacy headers.** V3 headers are fully authenticated. Legacy v1/v2 archives retain their original weaker AAD for compatibility and are imported only after their existing structural and relationship validation.
8. **JavaScript memory.** Decrypted values and keys may remain in engine memory until garbage collection. Lock clears references and session storage, not all possible copies.
9. **Service-worker termination locks the vault.** This is the deliberate consequence of keeping the DEK out of extension-readable storage. Frequent MV3 worker termination can interrupt a long idle session; an active dashboard connection reduces this in practice.
10. **OCR accuracy and language coverage.** Only English is bundled. OCR output depends on scan quality, resolution, skew, rotation, handwriting, tables, and column layout; Tesseract confidence is a heuristic, not a guarantee. Bounding boxes refer to the rendered OCR image. No external OCR service is used. Additional languages require new bundled, SHA-256-pinned assets before they can be claimed.
11. **DOCX page boundaries are approximate.** DOCX is stored as one logical page because the format does not expose reliable page count/layout without a renderer.
12. **Text extraction is not visual reconstruction.** PDF/DOCX layout, columns, and complex table styling are normalized to text; the original file remains available for fidelity.
13. **Offscreen documents share the extension origin.** The offscreen parser has no vault/DB/crypto imports, no privileged runtime sender acceptance, a narrow port protocol, and a non-configurable runtime `indexedDB` guard. It is not a separate browser origin; a compromised offscreen page could still attempt other extension-origin APIs. It cannot decrypt vault records without the DEK, which never leaves the service worker.
14. **Parser workers share the offscreen page origin.** Each worker is request-scoped and receives only bytes/non-secret fields, but it is not a separate sandboxed origin. The worker blocks `indexedDB` and child-worker creation at runtime. The offscreen document is nonetheless outside the service-worker key boundary.
15. **Transitional v1 fallback.** Readers accept legacy v1 envelopes while a vault is being upgraded. The migration verifies that no v1 field remains before setting the v2 marker, after which integrity checks flag any legacy envelope.
16. **Auto-lock precision.** The dashboard timer handles the interactive interval; the background alarm is a backstop with Chrome alarm granularity.
17. **AAD schema source.** The schema version in the AAD comes from the active vault record. If that metadata is corrupted, records fail closed rather than decrypting under a different context.
18. **Dashboard operation client availability.** The localhost development dashboard uses a separate direct client and web session storage. That client is not packaged in the extension build, but development data is less isolated than production.
19. **CSP limitations.** The extension manifest hardens `script-src` (including `'wasm-unsafe-eval'` for the local OCR core), `object-src`, and `worker-src`; the offscreen HTML meta policy adds `base-uri`, `connect-src 'self'`, and image/font/media restrictions. `'wasm-unsafe-eval'` is the narrow WebAssembly permission and does not enable JavaScript `eval`. Network restriction also relies on the absence of network code in the offscreen bundles.
20. **No third-party audit.** The implementation has targeted tests, not a professional security certification.
