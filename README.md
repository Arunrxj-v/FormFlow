# FormFlow

FormFlow is a local-first document intelligence and review-before-fill form assistant. It runs as a Chrome Manifest V3 extension with a React dashboard, an extension popup, a background service worker, an isolated offscreen document, request-scoped parser workers, and a local Qwen3-0.6B ONNX model.

Documents, extracted text, the personal profile, conflicts, collections, history, and model metadata stay on the device. The vault is encrypted with AES-256-GCM using a PBKDF2-SHA256-wrapped data key. The service worker remains the only vault-key authority.

No user document or profile value is sent to an external AI, cloud OCR, or document-storage service. The only network request made by the local AI feature is the explicitly configured public model-asset download from Hugging Face.

## Status

Implemented end to end:

- Encrypted local vault, atomic lock/unlock, passphrase rotation, integrity checks, and encrypted v3 backup/restore.
- Local PDF, DOCX, and TXT ingestion, page-aware extraction, local OCR, and structured document layout.
- First-run local model download with progress, SHA-256 verification, cancellation, retry, repair, removal, and self-test.
- Local-only inference in an isolated offscreen-hosted worker, with WASM execution, bounded context/tokens/timeouts, idle unload, and cancellation.
- Deterministic profile extraction plus grounded local-AI candidates with encrypted provenance.
- Profile review, source evidence, verification state, conflict detection, and structured education/employment/address/skill records.
- Extension field detection, deterministic matching, optional local-AI matching for ambiguous labels, review UI, explicit approval, safe autofill, and no auto-submit.
- Resumable first-run onboarding, document/profile search and filters, same-origin iframe and open Shadow DOM form support, and accessible dialog focus handling.
- Reproducible extension packaging and a CI workflow (typecheck, tests, production builds, audits, browser smoke).

See the consolidated completion report: [`docs/FORMFLOW_FEATURE_COMPLETION_REPORT.md`](docs/FORMFLOW_FEATURE_COMPLETION_REPORT.md), the remediation report: [`docs/FORMFLOW_REMAINING_ISSUES_REMEDIATION_REPORT.md`](docs/FORMFLOW_REMAINING_ISSUES_REMEDIATION_REPORT.md), privacy: [`docs/PRIVACY.md`](docs/PRIVACY.md), and release process: [`docs/FORMFLOW_RELEASE_PROCESS.md`](docs/FORMFLOW_RELEASE_PROCESS.md).

**Security notice:** the public GitHub history still contains personal identity PDFs. See [`docs/FORMFLOW_SECURITY_HARDENING.md`](docs/FORMFLOW_SECURITY_HARDENING.md) before sharing or cloning this repository.

## Quick start

```bash
npm install
npm run build:extension
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `extension/dist` in Chrome 113 or newer. Open the extension dashboard at `chrome-extension://<extension-id>/dashboard.html`, create an encrypted vault, and follow the resumable first-run guide. The guide can be skipped and reopened from Settings.

The local AI model is offered on first run. By default it starts downloading after the first successful document upload; it can also be started manually from **Settings → Local AI**. The verified INT8 model is about 734 MiB and is not bundled in the extension ZIP.

For UI development, `npm run dev` serves the dashboard at `http://localhost:5173`. The localhost dashboard can migrate/import encrypted archives but uses a direct development vault client; model download and inference require the installed extension build.

## Build

```bash
npm run build             # TypeScript check + dashboard production build
npm run build:extension   # Chrome extension build in extension/dist
npm run build:all         # both
npm run package:extension # build + verify + ZIP/SHA-256 in release/
```

The extension build packages the dashboard, popup, background worker, content script, offscreen parser, parser worker, model worker, Transformers.js, ONNX Runtime Web WASM assets, OCR assets, and DOCX layout fonts. Build-time checks verify required files, SHA-256 hashes for bundled runtime assets, manifest references, CSP, and parser/vault isolation.

## Local AI

| Item | Value |
|---|---|
| Model | `onnx-community/Qwen3-0.6B-Instruct-ONNX` |
| Revision | `54250909aca286a05b9d013c8af7a21859ee6ead` |
| Artifact | INT8 `onnx/model_quantized.onnx` |
| Runtime | ONNX Runtime Web / WASM (WebGPU detected but not used for the verified Q8 build) |
| Total download | 769,882,900 bytes (~734 MiB) |
| Storage | Extension-origin Cache Storage (`formflow-model-cache-v1`) |
| Metadata | IndexedDB `modelMetadata` |
| License | Apache-2.0 |

The model worker loads only from the verified local cache. It does not fall back to a remote provider or a remote model file. Model files are hashed during download and verified before loading; corrupt or incomplete assets are marked `corrupt`/`not_installed` and cannot be reported as ready.

The offscreen document owns the model worker because an MV3 service worker cannot create Web Workers. Only validated prompts and non-secret work requests cross the narrow offscreen port. The offscreen document has no vault key, passphrase, AAD, or IndexedDB access.

Details: [`docs/LOCAL_MODEL.md`](docs/LOCAL_MODEL.md).

## End-to-end workflow

1. Create and unlock a local vault.
2. Enter or import personal information.
3. Upload PDF, DOCX, or TXT documents.
4. Documents are parsed locally in the isolated offscreen environment.
5. Deterministic extraction immediately links profile values with source page/block/evidence.
6. The local model installs on first run (or from Settings).
7. On demand, the model adds grounded candidates; deterministic values cannot be overridden.
8. Review extracted values, source evidence, verification state, and conflicts.
9. Open a supported form in Chrome.
10. The popup detects fields and runs deterministic matching first.
11. Ambiguous fields can be sent to the local model for matching; every AI suggestion requires review.
12. Approve individual or multiple fields, then fill.
13. FormFlow verifies that the page accepted each value and never clicks submit.

Details: [`docs/USER_WORKFLOW.md`](docs/USER_WORKFLOW.md).

## Security boundaries

- AES-256-GCM with per-record authenticated AAD; PBKDF2-SHA256 at 600,000 iterations; random wrapped DEK.
- The DEK exists only in service-worker memory and is cleared on lock, service-worker termination, or browser restart.
- The offscreen document and parser/model workers never receive the DEK, KEK, passphrase, AAD, vault session, or direct vault authority.
- Parser workers cannot create child workers and have a runtime IndexedDB guard.
- Extension messages require a protocol version, request ID, known operation, validated payload, and trusted extension sender.
- Autofill sends only the approved values for the active operation. It never submits forms, bypasses authentication/CAPTCHA, or scans unrelated page content.
- Sensitive fields require explicit review. The page cannot read the vault.
- Google Drive document storage and external AI provider calls were removed. Legacy OAuth sign-in code in the development server requests identity scopes only.

See [`docs/SECURITY_ARCHITECTURE.md`](docs/SECURITY_ARCHITECTURE.md).

## Tests

```bash
npm test                  # typecheck + local/unit + extension + server tests
npm run typecheck
npm run test:local
npm run test:extension
npm run test:server
```

Browser verification (use a Chrome/Chromium binary that supports MV3 extensions):

```bash
CHROME_PATH="/path/to/Google Chrome for Testing" node scripts/dev/e2e-phase3.mjs
CHROME_PATH="/path/to/Google Chrome for Testing" node scripts/dev/e2e-phase4-ingestion.mjs
CHROME_PATH="/path/to/Google Chrome for Testing" node scripts/dev/e2e-phase4-interruption.mjs
CHROME_PATH="/path/to/Google Chrome for Testing" node scripts/dev/e2e-recovery-crash.mjs
CHROME_PATH="/path/to/Google Chrome for Testing" node scripts/dev/e2e-content-isolation.mjs
CHROME_PATH="/path/to/Google Chrome for Testing" node scripts/dev/e2e-router-navigation.mjs
CHROME_PATH="/path/to/Google Chrome for Testing" node scripts/dev/e2e-phase42-model.mjs
CHROME_PATH="/path/to/Google Chrome for Testing" node scripts/dev/e2e-onboarding.mjs
CHROME_PATH="/path/to/Google Chrome for Testing" node scripts/dev/audit-standard-form.mjs
CHROME_PATH="/path/to/Google Chrome for Testing" node scripts/dev/audit-autofill-binding.mjs
CHROME_PATH="/path/to/Google Chrome for Testing" node scripts/dev/audit-ui-accessibility.mjs
CHROME_PATH="/path/to/Google Chrome for Testing" node scripts/dev/audit-webgpu-fallback.mjs
```

Parser fault-injection tests require a test-hooks build:

```bash
FORMFLOW_TEST_HOOKS=1 npm run build:extension
CHROME_PATH="/path/to/Google Chrome for Testing" node scripts/dev/e2e-phase4-offscreen.mjs
npm run build:extension   # restore the production build
```

The model E2E seeds the real Hugging Face model files into extension Cache Storage through a local fixture server, then exercises the real installer, SHA-256 verification, offscreen transport, WASM inference, offline inference, AI extraction, provenance, and AI field matching. It does not mock inference. It does not measure a live internet download.

## Legacy development server

`npm run server` starts an optional local Node/SQLite API used only for legacy archive migration and development. The production extension vault does not depend on it. External AI providers and Google Drive endpoints were removed. Configure the legacy server with `.env.example`.

## Documentation

- [`docs/MIGRATION_STATUS.md`](docs/MIGRATION_STATUS.md) — phase history and migration state.
- [`docs/SECURITY_ARCHITECTURE.md`](docs/SECURITY_ARCHITECTURE.md) — encryption, isolation, and AI boundaries.
- [`docs/LOCAL_MODEL.md`](docs/LOCAL_MODEL.md) — model lifecycle, storage, integrity, and performance.
- [`docs/USER_WORKFLOW.md`](docs/USER_WORKFLOW.md) — complete product workflow.
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — model, ingestion, and autofill recovery.
- [`docs/FORMFLOW_FEATURE_COMPLETION_REPORT.md`](docs/FORMFLOW_FEATURE_COMPLETION_REPORT.md) — feature completion report and remaining defects.
- [`docs/FORMFLOW_FINAL_STABILIZATION_REPORT.md`](docs/FORMFLOW_FINAL_STABILIZATION_REPORT.md) — stabilization, security review, regression results, and commit status.

## Known limitations

- The verified model is a 0.6B INT8 model. It can miss fields, especially on weak or unusual documents. Only source-grounded values are accepted, and every AI candidate requires review.
- WASM inference on the target 8 GB Apple Silicon machine is usable for small focused extractions but slower than native CPU: approximately 27–67 seconds for the verified resume extraction in browser runs, depending on host load. Input context is bounded to 120,000 characters for profile extraction and 4,000 characters for AI context; output is capped at 160 new tokens.
- WebGPU is detected and recorded, but the verified Q8 artifact runs on WASM. Q4F16 WebGPU remains an opt-in experiment and is not exposed as the default.
- Automatic Word/Microsoft 365 compatibility remains unverified because genuine Word reference outputs are unavailable. `verified_physical` pagination is not claimed.
- OCR supports bundled English (`eng`) assets only.
- Model upgrade/migration across different model repositories is not implemented; the current model can be verified, repaired, reinstalled, or removed.
- Legacy Google sign-in in the development server is not part of the extension product and does not grant document-storage access.
