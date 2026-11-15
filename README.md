# FormFlow

> **Migration status:** Phase 3 is complete. The Chrome extension owns the canonical encrypted vault. The extension dashboard and popup share one IndexedDB vault under the extension origin, with AES-256-GCM encryption at rest, passphrase unlock, auto-lock, and encrypted backup/import. The localhost dashboard remains a development and migration surface. Remote AI, document extraction, and OCR are still future phases. See [`docs/MIGRATION_STATUS.md`](docs/MIGRATION_STATUS.md) for verified status and remaining phases.

FormFlow is a personal document intelligence and form-filling platform. This repository contains:

- A React + TypeScript dashboard built from the supplied `Design FIles` references.
- A shared design system and responsive application shell.
- A local IndexedDB document vault, personal information vault, collections, activity history, and settings.
- A real Manifest V3 Chrome extension with on-demand form detection, field classification, review, and autofill.
- A Node.js + SQLite API that is retained for legacy data migration and development, but is no longer required by the migrated dashboard features.

## Quick start

```bash
npm install
npm run build:extension
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `extension/dist`. Open the extension dashboard at `chrome-extension://<extension-id>/dashboard.html`, create an encrypted vault, and upload documents from your device.

For development of the React UI, `npm run dev` serves the same app at `http://localhost:5173`. The localhost origin is for development and encrypted-archive migration; production vault data belongs to the extension origin.

### Production build

```bash
npm run build
npm run build:extension
# or both
npm run build:all
```

### API server

```bash
npm run server
```

The API listens on `http://localhost:8787` by default and creates `server/formflow.db` using Node's built-in SQLite driver. Copy `.env.example` to `.env` for configuration. Set `AUTH_SECRET` in production.

### Tests

```bash
npm test
```

This runs the local vault/crypto/backup/migration tests, the extension classifier and form-adapter tests, and the legacy API integration tests.

Browser-level verification of the final build:

```bash
CHROME_PATH="/path/to/Chrome for Testing" node scripts/dev/e2e-phase3.mjs
```

The Chromium E2E creates an encrypted vault, uploads a PDF, inspects IndexedDB for ciphertext, exercises the typed vault protocol, exports and re-imports an encrypted archive, checks popup/dashboard locking, and verifies persistence across a browser restart.

## Chrome extension

1. Build the extension:

```bash
npm run build:extension
```

2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `extension/dist`.
3. Start the dashboard with `npm run dev`, sign in, and open **Extension → Open demo form** (`http://localhost:5173/demo-form`).
4. Click the FormFlow toolbar icon. The popup scans only the active tab, classifies fields, matches them against the selected demo collection, and shows a review list.
5. Approve fields and fill. The extension never clicks submit.

The extension requests only `activeTab`, `scripting`, and `storage`. It has no broad host permissions and does not inject a persistent content script.

## Implemented product areas

### Dashboard

- Sign up, login, forgot password, demo login, session handling.
- Seven-step onboarding: welcome, Drive demo authorization, document selection, simulated processing, extracted-value review, extension setup, completion.
- Overview with vault status, recent documents, recent activity, Drive/extension cards, and quick actions.
- Document vault with search, category/status filters, list/grid views, upload, Drive picker, preview, rename, remove, retry, unlink, and metadata.
- Personal information vault: personal profile, addresses, education, employment, skills/certifications.
- Manual value creation, editing, deletion, source attribution, conflict resolution, and sensitive-field labeling.
- Collections with document membership, notes, shared references, and retrieval preview.
- Autofill history with filters, detail view, CSV export, and clear-history controls.
- Settings for profile, connections, autofill safeguards, local data export/reset, and account deletion.
- Demo application form with a working extension-style review panel, grounded long-answer drafting, autofill highlighting, and explicit submit.

### Chrome extension

- Popup UI with connected/disconnected, scanning, no-form, detected, review, complete, error, history, and settings states.
- Deterministic field classification from labels, names, IDs, placeholders, ARIA labels, autocomplete, and input types.
- Collection-scoped matching against the bundled demo vault.
- Confidence bands, sensitive-field review, conflicting-value selection, inline editing, and skip/accept controls.
- Native value setters and input/change/keyup events for React-controlled and dynamic fields.
- Select option matching and graceful failure reporting.
- Local extension history and settings.
- No auto-submit.

### API and database

The API uses `node:http` and `node:sqlite` with no runtime framework dependencies.

Entities:

- `users`
- `documents`
- `fields`
- `field_conflicts`
- `collections`
- `collection_documents`
- `activity`
- `preferences`
- `form_sessions`
- `ai_usage`

Every document, field, collection, preference, and history query is scoped by the authenticated user ID. Foreign keys and cascading deletes are enabled.

Key endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/signup` | Create account |
| POST | `/api/auth/login` | Password login |
| POST | `/api/auth/demo` | Demo session |
| GET | `/api/auth/me` | Current user |
| GET/POST | `/api/documents` | List/create documents |
| PATCH/DELETE | `/api/documents/:id` | Rename/remove document |
| POST | `/api/documents/:id/process` | Run extraction pipeline |
| GET | `/api/fields` | List vault values |
| PATCH/DELETE | `/api/fields/:id` | Edit/remove value |
| POST | `/api/fields/:id/resolve` | Resolve conflict |
| GET/POST | `/api/collections` | List/create collections |
| PATCH/DELETE | `/api/collections/:id` | Update/delete collection |
| GET | `/api/activity` | Activity feed |
| GET/POST | `/api/history` | Form sessions |
| GET/PUT | `/api/preferences` | User preferences |
| GET | `/api/extension/bootstrap` | Extension retrieval payload |
| DELETE | `/api/account` | Password-confirmed, cascading account deletion |

### AI pipeline

`server/ai.mjs` implements a single modular extraction pipeline:

1. Document text validation and size limits.
2. Deterministic rule-based extraction by default.
3. Optional OpenAI-compatible provider selected through environment variables.
4. Structured fact normalization and validation.
5. Confidence calculation with explicit caps.
6. Source page/document attribution.
7. Conflict detection that never overwrites user-verified values.
8. Persistence and AI usage recording.

Provider secrets are server-only. Document text is treated as untrusted data and the provider prompt explicitly instructs the model to ignore embedded instructions.

## Real vs. legacy integrations

| Area | Status |
|---|---|
| React dashboard | Real, working at the extension origin and on localhost for development |
| Local vault | Real encrypted IndexedDB under the extension origin |
| Chrome extension | Real MV3 extension, locally built and browser-tested |
| Form detection/classification/autofill | Real browser-side implementation |
| Typed extension protocol | Real request/response router with trusted-sender checks |
| SQLite API | Legacy and development only; not required by the extension vault |
| Legacy password auth | Legacy API only; production access uses the local vault passphrase |
| Google OAuth / Drive API | **Not connected.** Legacy source files remain but the extension vault workflow does not use them. |
| PDF/DOCX/OCR extraction | **Not implemented.** Documents are stored encrypted; extraction is a future phase. |
| AI provider | **Not used in production.** Legacy server-side provider code remains; the extension does not call external AI. |
| Dashboard → API wiring | **Not used.** The dashboard reads and writes the local vault. |
| Extension → API auth | **Not used.** The popup reads the extension vault through controlled background messaging. |

## Security notes

- Vault contents, document blobs, personal values, collections, history, and profile records are encrypted with AES-256-GCM.
- PBKDF2-SHA256 derives a key-encryption key from the vault passphrase; a random data key is wrapped by it.
- The passphrase and plaintext data key are never written to IndexedDB or `chrome.storage.local`.
- The data key is held in `chrome.storage.session` for the active browser session and cleared on lock.
- Locking blocks dashboard access, profile reads, document access, export, and autofill.
- Extension messages require a protocol version, request ID, known operation, and validated payload.
- Only extension-owned pages are accepted as privileged senders; arbitrary webpages and content scripts cannot query the vault.
- Content scripts receive only the specific values the user approved for the current page.
- Autofill requires explicit approval for sensitive fields and never submits forms.
- Google Drive, external AI, cloud storage, and remote synchronization are not part of the production vault workflow.
- Losing the vault passphrase makes the vault unrecoverable; there is no recovery mechanism in this phase.

## Known limitations

- Structural metadata (record IDs, field keys, categories, statuses, sizes, MIME types, checksums, vault name) remains plaintext by design.
- PDF/DOCX text extraction, OCR, and AI processing are future phases. Documents are stored and retrieved as encrypted bytes.
- Encrypted backup import requires a target with no documents, values, or collections and an unmodified default profile; the archive's profile replaces the local profile.
- The backup format is a JSON envelope with base64 document payloads and a 200 MB import limit.
- Auto-lock runs in the dashboard and the extension alarm; perfect memory erasure is not possible in JavaScript.
- The legacy Google Drive, backend auth, and AI source files remain in the repository but are not part of the extension vault workflow.
- The localhost dashboard is a development and migration surface, not a production privileged client.

## Design references

The supplied `Design FIles` directory is treated as the visual source of truth and was not modified. The implementation follows the Precision Vault palette, Inter typography, compact information density, source attribution, and extension review patterns from those references.
