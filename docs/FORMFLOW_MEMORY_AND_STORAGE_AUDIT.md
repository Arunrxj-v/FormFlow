# FormFlow Memory and Storage Audit

Date: 2026-11-18  
Status: **IMPLEMENTED BUT NOT FULLY VERIFIED** for per-worker heap and physical disk-full; **FIXED AND VERIFIED** for indirect growth measurement and storage preflight/cleanup.

## Instrumentation (supported only)

| Signal | Source | Limitation |
|---|---|---|
| Process-sum RSS | `ps -Ao rss=,command=` filtered to the disposable Chrome profile | Includes browser UI, GPU, renderers, service worker and workers; not a per-worker heap. |
| Renderer JS heap | `performance.memory.usedJSHeapSize` in the dashboard page | Non-standard, renderer-only; explicitly **not** a worker heap. |
| Storage usage/quota | `navigator.storage.estimate()` | Browser-reported; may be approximate. |
| Per-worker heap | none | Unavailable in Chromium extensions. No value is invented. |

Scripts: `scripts/dev/audit-memory.mjs` (phase sampling), `scripts/dev/audit-memory-growth.mjs` (repeated-operation growth), `scripts/dev/audit-ui-accessibility.mjs`, `scripts/dev/e2e-phase42-model.mjs`.

## Repeated-operation growth (8 cycles; each cycle: lock → unlock → small document import → delete → inference-cancel/worker termination → status → backup export → storage status)

Run 2026-11-18T08:34:31Z, Playwright Chromium (full Chrome for Testing binary), fresh profile.

| Measurement | Value |
|---|---|
| Initial process-sum RSS | 758 MB |
| Per-cycle RSS | 707, 569, 475, 473, 460, 506, 524, 529 MB |
| Peak RSS | 754 MB |
| Post-cleanup RSS (2 s settle) | 466 MB |
| RSS linear trend | **−16.56 MB/cycle** |
| Renderer JS heap per cycle | 14, 16, 15, 16, 20, 18, 22, 20 MB |
| Storage status checks passed | 8/8 |

Interpretation: process-sum RSS declined over the run and ended below the initial value; renderer heap fluctuated within 14–22 MB with no monotone growth. **No confirmed leak** from these operations. A longer run (more cycles, repeated model initialization/inference) is still needed to rule out slow growth.

An earlier 8-cycle run before the storage-op correction showed a +1.54 MB/cycle RSS slope with post-cleanup below initial; that run reported zero valid storage checks and is superseded by the run above.

## Earlier phase measurements (from `docs/FORMFLOW_MODEL_RELIABILITY.md`, retained)

Process-sum RSS: browser+extension start ~748 MB; after vault creation ~816 MB; after 4.08 MiB TXT import ~1,060 MB; backup export peak ~1,248 MB; three lock/unlock cycles ~1,100 MB; model self-test peak ~1,711 MB; AI extraction peak ~1,747 MB. No OOM on an 8 GB host. These are not model-only or worker-only values.

## Static leak review

Reviewed retained `ArrayBuffer`s, object URLs, canvases/ImageBitmaps, parser/worker references, duplicate model instances, inference tensors, large React state, message queues, listeners and DB connections:

- Object URLs: `src/services/documentService.ts` tracks and revokes after 60 s; `HistoryPage` and `VaultMigrationPage` revoke immediately — bounded.
- Workers: offscreen parser/OCR/model workers are terminated on completion, cancellation and error (`extension/src/offscreen/main.ts`, `ocr.ts`, `parser-client.ts`, `model-manager.ts`). Model worker has a 120 s idle disposal.
- Abort listeners use `{ once: true }` consistently; React effects remove listeners/intervals on cleanup (`AppContext.tsx`, `Dropdown.tsx`, `Modal.tsx`, `Topbar.tsx`, `AppShell.tsx`).
- No duplicate DB connection: `getDb()` is a single cached promise with `close()` on test reset.
- No stale inference tensors retained: the model worker disposes its generator before reloading and on dispose.

No confirmed leak was found by static review. No speculative resource destruction was added.

## Storage exhaustion and recovery

Physical disk was **not** filled. Tests use controlled fixtures, in-memory quota mocks and failing IndexedDB/Cache operations.

| Scenario | Evidence |
|---|---|
| Insufficient space before install/upgrade | `shared/model-storage.ts` preflight; `extension/src/model/model-manager.ts` uses it; `tests/unit/model-upgrade.test.ts` asserts no staging work starts and the previous release stays active. |
| Insufficient space during download/final assembly | Chunked downloader reuses verified parts; a failed install writes `failed`, clears parts (`tests/unit/model-download.test.ts`); final assembly only occurs after full-size/hash validation. |
| Storage estimate unavailable | `hasSufficientStorage()` treats unknown/zero quota as non-blocking; `quotaManager.estimate()` degrades to zeros (`tests/unit/model-storage.test.ts`). |
| IndexedDB quota failure | `tests/unit/quota-boundary.test.ts`: partial document removed on quota failure; backup import transaction aborts atomically. |
| Corrupted temporary files | `tests/unit/model-storage.test.ts`: `clearStaging()` removes corrupted staged chunks and staging metadata while leaving the active model and record intact. |
| Invalid/partial model never installed | `tests/unit/model-download.test.ts`, `model-integrity.test.ts`: status `corrupt`/`failed`/`not_installed`, never `ready`. |
| Backup size limit | `quota-boundary.test.ts`: exact 200 MB boundary, checked before reading the archive. |
| Restore atomicity | `tests/unit/restore-atomicity.test.ts`: failed restore preserves target and journals failure. |
| Model upgrade storage | Lifecycle preflights `minStorageBytes` and cleans staging on failure; previous model untouched. |

### Atomicity status

- **Document persistence / backup restore / profile updates**: journaled and unit-verified (`restore-atomicity.test.ts`, vault migration tests).
- **Model install/upgrade**: recoverable-but-not-filesystem-atomic. Staging cache + journal + retained previous release provide rollback; promotion copies files then flips a single journal record. Restart recovery handles interruption before and during promotion.
- **Backup creation**: size preflight and write-time checks; no automatic deletion of user documents or backups to free space anywhere in the codebase.

## Remaining limitations

- No physical disk-full test and no OPFS quota test (the application does not use OPFS).
- No browser storage eviction simulation.
- No per-worker heap or long-run (hundreds of cycles / repeated model init) growth measurement.
- Temporary peak during Cache API assembly remains roughly twice the model size; reducing it requires a different storage design.
