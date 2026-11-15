# FormFlow

FormFlow is a personal document intelligence and form-filling platform. This repository contains:

- A React + TypeScript dashboard built from the supplied `Design FIles` references.
- A shared design system and responsive application shell.
- A document vault, personal information vault, collections, autofill history, and settings.
- A real Manifest V3 Chrome extension with on-demand form detection, field classification, review, and autofill.
- A Node.js + SQLite API with authentication, ownership checks, document processing, conflict detection, collections, history, preferences, and an AI-provider abstraction.

## Quick start

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The demo workspace is pre-filled:

- Email: `arun@example.com`
- Password: `formflow-demo`
- Or use **Continue with demo workspace**.

The dashboard runs against a deterministic local demo service layer (`src/services/*`) backed by `localStorage`, so it works without credentials or a running server. Every simulated integration is labeled as demo in the UI.

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

This runs TypeScript checks, extension classifier/scoping tests, and API integration tests.

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

## Real vs. demo integrations

| Area | Status |
|---|---|
| React dashboard | Real, working |
| Local demo vault | Real local persistence in `localStorage` |
| Chrome extension | Real MV3 extension, locally built |
| Form detection/classification/autofill | Real browser-side implementation |
| SQLite API | Real, tested |
| Password auth and signed sessions | Real local implementation |
| Google OAuth / Drive API | **Not connected.** Demo-only UI and service interface. Requires Google Cloud credentials, consent-screen configuration, and server-side token storage. |
| PDF/DOCX/OCR processing | **Not implemented in this environment.** The API accepts extracted text; production extraction needs PDF/DOCX/OCR workers. |
| AI provider | Interface and optional OpenAI-compatible implementation; local deterministic rules are used without a key. |
| Dashboard → API wiring | **Not enabled by default.** The dashboard uses the demo service layer. The API is implemented and tested for the next integration step. |
| Extension → API auth | **Not enabled.** The extension uses a bundled demo vault so it works without a server. |

## Security notes

- No secrets are committed. `.env` is ignored.
- API authorization is enforced server-side on every owned resource.
- Account deletion requires the current password and cascades through owned data.
- Passwords use `scrypt` with per-user salts.
- Session tokens are HMAC-signed and expire after seven days.
- CORS is restricted to `APP_ORIGIN`.
- Request bodies are size-limited; rate limits apply to auth and general API traffic.
- Extension permissions are minimal; scanning requires user invocation.
- Autofill requires explicit approval for sensitive fields.
- The extension never auto-submits forms.

## Known limitations

- Google Drive, Google login, real file download, real upload storage, OCR, and production email/password reset delivery require external credentials and infrastructure.
- The dashboard currently runs in demo mode; wiring it to the API requires replacing the demo service adapters with an API client and adding a token lifecycle.
- The extension uses bundled demo data and does not yet authenticate against the API.
- PDF/DOCX parsing is not included; the API pipeline expects extracted text.
- The AI provider path is implemented but untested without an API key.
- There is no deployment configuration, object storage, malware scanning, or production observability stack.

## Design references

The supplied `Design FIles` directory is treated as the visual source of truth and was not modified. The implementation follows the Precision Vault palette, Inter typography, compact information density, source attribution, and extension review patterns from those references.
