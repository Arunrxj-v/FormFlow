# FormFlow Security Architecture

Status: Phase 3.1.1 final security hardening. This document describes the implemented security design, what has been tested, and what remains a residual risk. FormFlow has **not** undergone a professional penetration test or third-party security audit.

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
  └── service worker ── sole DEK owner + privileged vault operations
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
| Localhost page | Separate dev DB | Dev-only | Development alias; excluded from the extension build |

The dashboard cannot retrieve the DEK, export key material, or send arbitrary encryption/decryption/AAD parameters. It calls explicit operations. The popup and content script receive no key material. `chrome.storage.session` contains only a non-secret `{state, generation, updatedAt}` marker.

### Why the vault locks on service-worker termination

A DEK persisted in `chrome.storage.session` would be readable by extension pages, including the dashboard. To keep the dashboard outside the key boundary, the DEK is memory-only inside the service worker. Manifest V3 can terminate the worker after idle periods; when that happens the DEK is lost and the vault locks. The dashboard and popup use the non-secret state marker to clear sensitive UI and require a fresh unlock. The dashboard and popup hold a validated extension-page keepalive port while open, reducing idle termination during active use. If the worker is still terminated, the vault locks and the security invariant takes precedence over session continuity.

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
| Document text | `documentText` | `text`, `pageTexts` |

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
- Extracted document text and page text.
- Personal field labels and values.
- Profile object and all profile record payloads (education, employment, skills, certifications, projects, addresses).
- Collection names, descriptions, and notes.
- Activity titles and descriptions.
- Form history website, URL, and used-document list.
- Conflict values and labels.

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
- Vault display name.
- Preferences and onboarding settings.
- Migration journal counts and timestamps.
- `storageKey` values (the actual ciphertext is keyed by record ID).

These fields are needed for indexing, sorting, UI state, or integrity checks. They can reveal document counts, record types, approximate activity times, and file sizes. They do not reveal document contents, field values, labels, filenames, collection text, or history URLs.

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
- Label encryption.
- Passphrase change, old-passphrase rejection, new-passphrase access, document access after change.
- Hostile backup archives: malformed JSON, truncation, versions, algorithms, salt, nonce, base64, KDF parameters, manifests, ciphertext, UTF-8, duplicate IDs, missing files, checksums, negative sizes, relationships, unexpected fields, timestamps, MIME/extension.
- Failed import leaves the target unchanged.
- Integrity checking of swapped ciphertext, missing files, checksum mismatch, and broken membership.
- Session generation across lock/unlock and concurrent transition serialization.
- Popup/dashboard clearing on remote lock, browser restart locking, service-worker termination locking.
- Chromium E2E with a real PDF, DEK absence in dashboard/popup storage, generic-operation rejection, ciphertext inspection, tamper test, upload-versus-lock draining, passphrase rotation, v3 header tamper, valid v3 import, genuine v1/v2 imports, and restart.

### Simulated, not a real process kill

- Migration crash points are deterministic fault injection inside the application, including transaction abort paths. A real browser process kill is not performed.
- Storage quota is simulated by throwing `QuotaExceededError` from IndexedDB `put`; it is not a physical disk-full test.
- The 200 MB boundary uses synthetic `Blob` size/text shims and a small valid archive; it does not allocate a 200 MB fixture.

### Untested

- Firefox and Safari.
- Full extension reload behavior under the Playwright `--load-extension` harness.
- A physical disk-full environment and real browser process termination.
- Coverage-guided fuzzing of the archive parser.
- Cross-site scripting inside the extension origin.
- Malicious other extensions or a compromised browser profile.
- Professional penetration testing, formal cryptographic review, or a security audit.

## 11. Known residual risks and limitations

1. **Vault display name is plaintext.** It is used before/around vault UI and was not encrypted in this phase.
2. **Structural metadata remains plaintext** as listed in section 5.
3. **Dashboard compromise while unlocked.** The dashboard cannot read the DEK, but a compromised dashboard can submit authorized vault operations while the vault is unlocked. Operation schemas and leases limit arbitrary access; they do not distinguish a malicious authenticated UI from the real one.
4. **Offline passphrase guessing.** An attacker with the ciphertext can attempt passphrases offline. PBKDF2 at 600,000 iterations raises cost but does not prevent weak passphrases. The UI requires at least 10 characters.
5. **No recovery.** Losing the passphrase or backup passphrase makes the corresponding data unrecoverable.
6. **Backup legacy headers.** V3 headers are fully authenticated. Legacy v1/v2 archives retain their original weaker AAD for compatibility and are imported only after their existing structural and relationship validation.
7. **JavaScript memory.** Decrypted values and keys may remain in engine memory until garbage collection. Lock clears references and session storage, not all possible copies.
8. **Service-worker termination locks the vault.** This is the deliberate consequence of keeping the DEK out of extension-readable storage. Frequent MV3 worker termination can interrupt a long idle session; an active dashboard connection reduces this in practice.
9. **Transitional v1 fallback.** Readers accept legacy v1 envelopes while a vault is being upgraded. The migration verifies that no v1 field remains before setting the v2 marker, after which integrity checks flag any legacy envelope.
10. **Auto-lock precision.** The dashboard timer handles the interactive interval; the background alarm is a backstop with Chrome alarm granularity.
11. **AAD schema source.** The schema version in the AAD comes from the active vault record. If that metadata is corrupted, records fail closed rather than decrypting under a different context.
12. **Dashboard operation client availability.** The localhost development dashboard uses a separate direct client and web session storage. That client is not packaged in the extension build, but development data is less isolated than production.
13. **No third-party audit.** The implementation has targeted tests, not a professional security certification.
