# FormFlow Model Upgrade and Rollback Architecture

Date: 2026-11-18  
Status: **IMPLEMENTED BUT NOT FULLY VERIFIED** (state machine and validation unit-verified; no second trusted release exists, so no real upgrade was executed)

## Trust model

The manifest is the trust root for every model download. Rules enforced in `ai/runtime/model-manifest.ts`:

- **Immutable revision only.** `revision` must be a 40-character lowercase hex commit. Mutable aliases (`main`, `master`, `latest`, `head`, `stable`, `dev`, `develop`) are rejected. Aliases are never a security boundary.
- **Closed file set.** Every file path must belong to a known-good variant, all non-model files must be present, and exactly one `onnx/` model file must be listed. Unknown, unexpected, missing and duplicate files are rejected.
- **Trusted digests.** Every file requires a 64-hex SHA-256 and a positive integer size. `validateManifest(..., { requireTrusted: true })` additionally requires the catalog flag.
- **Validated metadata.** Schema version, release id, semantic version, model id, quantization, runtime, backend list, context window, minimum storage, compatibility (app version and model schema), and presence of the chat template/model file are all checked. An app-version requirement higher than the running app is rejected.
- **Catalog-only.** `TRUSTED_MODEL_MANIFESTS` currently contains exactly one release: the verified Q8/INT8 baseline (`qwen3-0.6b-int8-2026-11`, revision `54250909…`). No unverified model is introduced to demonstrate upgrades. `checkForUpgrade()` therefore honestly reports `available: false` in production.

## Components

| File | Role |
|---|---|
| `shared/model-storage.ts` | Centralised storage estimate (`2 × model + 128 MiB`) and quota preflight. |
| `ai/runtime/model-manifest.ts` | Manifest schema, strict validation, trusted catalog, compatibility gate, upgrade detection. |
| `ai/runtime/model-lifecycle.ts` | Journaled state machine: upgrade, rollback, startup recovery, rollback status. |
| `ai/runtime/model-loader.ts` | Staging cache, stage/verify/promote/discard file operations; reuses the single existing downloader. |
| `extension/src/model/model-manager.ts` | Production wiring, progress/status, `upgrade()`, `rollback()`, `prunePrevious()`. |
| `core/database/{schema,database}.ts` | `modelLifecycle` object store (DB v4). |
| `shared/{messages,types,errors}.ts` | Message operations, lifecycle/status types, `MODEL_UPGRADE_UNSUPPORTED`. |

## Upgrade lifecycle

1. **Detect** the installed record and derive its release id (legacy records without a release id are treated as the baseline).
2. **Read trusted metadata** from the catalog via `checkForUpgrade()`; no upgrade is advertised unless it is trusted, validated and compatible.
3. **Compatibility gate**: same model id, higher version, immutable revision, WASM backend, supported app/schema version.
4. **Storage preflight**: known positive quota must cover `2 × model + 128 MiB`; unknown quota does not block but is reported.
5. **Stage**: `modelLoader.stageInstall()` downloads into a separate `formflow-model-cache-staging-v1` Cache Storage namespace with its own metadata key. Active files/record are untouched.
6. **Verify**: `verifyStaged()` re-hashes every staged file against the manifest and rebuilds/verifies aliases.
7. **Self-test**: a real inference self-test must pass before promotion.
8. **Atomic switch**: a single journal write sets `activeReleaseId`; `promoteStaged()` copies only verified bytes into the active cache and re-writes the active record. The previous release id is retained.
9. **Retain**: the previous verified release remains available until health is confirmed and `prunePrevious()` is explicitly called.
10. **Cleanup**: staged files and their metadata are discarded on both success and failure.

Any failure before promotion keeps the previous model active. A failure during or after promotion triggers `runRollback()`.

## Rollback coverage

`runRollback()` restores `activeReleaseId` to the retained previous release, records `rolled_back` status and a reason, optionally verifies the previous release, and cleans up staging. It is used for:

- Staged verification failure, self-test failure and staging exceptions.
- Worker crash/activation failure during promotion (`promote` throws after flipping the active pointer).
- Browser restart during activation: `recoverLifecycle()` re-verifies the active release; healthy → finalize, unhealthy → rollback.
- Interrupted installation: a pre-promotion `in_progress` journal is discarded as `failed` with staging cleanup; the active model is never touched.
- Manual rollback from the model management UI.

If no previous release exists, rollback fails safely with an explicit message rather than deleting the active model.

## Journal

`modelLifecycle` holds one record (`id: active`) with: active and previous release ids, operation, phase (`checking → downloading → verifying → self_testing → switching → completed | failed | rolled_back`), status, target release/version/revision, manifest version, failure reason, timestamps and last rollback time. The journal is written before each irreversible step so restart recovery is deterministic.

## UI

`ModelSettingsCard` shows installed version, release id, manifest version, verification status, active release, rollback availability, honest upgrade availability (and its reason), upgrade progress/phase, and failure details. Buttons: download/retry, cancel, self-test, verify & repair, remove, check for upgrade, cancel upgrade, roll back to previous. No upgrade is offered when the catalog has none.

## Test evidence

`tests/unit/model-manifest.test.ts` (9 tests) and `tests/unit/model-upgrade.test.ts` (11 tests) cover: manifest rejection cases, compatibility ordering, honest no-upgrade reporting, healthy promotion, install/verify/self-test failures, cancellation, insufficient storage, untrusted/incompatible targets, promotion failure with rollback, startup recovery before/during promotion, and rollback status. `tests/unit/model-storage.test.ts` covers staging cleanup and preflight.

## Limitations

- There is only one trusted release, so a real newer model has never been downloaded, promoted or rolled back end to end.
- Self-test during upgrade runs the active worker against the pinned, byte-identical artifact. A future distinct revision requires a staged worker load path before activation.
- `promoteStaged()` rejects any revision other than the pinned commit; supporting a new revision requires a build update with a new trusted manifest (deliberate: no unverified model substitution).
- The stage→promote file copy is not a single filesystem atomic rename; the journal plus retained previous release provides recoverability rather than true filesystem atomicity.
