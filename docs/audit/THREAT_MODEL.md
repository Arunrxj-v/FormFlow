# FormFlow Threat Model

Audit date: 2026-11-18  
Scope: Chrome extension, dashboard, popup, background service worker, offscreen document, parser workers, OCR runtime, local model worker, IndexedDB vault, backup/restore, legacy development server, build system.

## 1. Assets

| Asset | Sensitivity | Location |
|---|---|---|
| Document bytes | Critical | Encrypted `documentFiles`; plaintext only transiently in offscreen/parser |
| Extracted text | Critical | Encrypted `documentText` |
| OCR text/confidence | High | Encrypted `documentText.extractionEnc` |
| Structured layout/pagination | High | Encrypted `documentText.extractionEnc` |
| Profile values | Critical | Encrypted `extractedValues` |
| Evidence excerpts | High | Encrypted `evidenceEnc` |
| Identification/contact/address data | Critical | Encrypted vault records |
| Conflict records | High | Encrypted `conflicts` |
| Profile records | High | Encrypted `profileRecords` |
| Collections/activity/history | Medium | Encrypted records |
| Vault DEK | Critical | Service-worker memory only |
| Passphrase/KEK | Critical | Memory during derivation; never persisted |
| Backup passphrase/archive | Critical | User-controlled file outside extension; encrypted |
| Model weights | Public | Extension Cache Storage; no user data |
| Model metadata | Low | IndexedDB `modelMetadata` |
| Autofill approval state | High (authorization) | Background service-worker memory |
| Scan token/fingerprint | High (authorization) | Content-script isolated memory/DOM attributes only |
| Legacy server tokens/database | High in dev | Server SQLite/localStorage in localhost dev |
| Build assets/dependencies | Supply chain | `node_modules`, `extension/dist` |

## 2. Trust boundaries

1. **Website/page ↔ content script** — page is untrusted; content script is an isolated extension world.
2. **Content script ↔ background service worker** — extension-only `chrome.tabs`/`runtime` messaging; background treats website labels/values as untrusted.
3. **Dashboard/popup ↔ background** — trusted extension pages use versioned request/response protocol and validated payloads.
4. **Background ↔ offscreen document** — narrow port protocol; offscreen has no vault keys/IndexedDB.
5. **Offscreen ↔ parser/model workers** — request-scoped workers receive only document bytes/prompts and non-secret options.
6. **Background ↔ IndexedDB** — only background has the DEK; repository layer encrypts before persistence.
7. **Model download ↔ Hugging Face** — public assets cross the network; pinned SHA-256 is the trust anchor.
8. **Extension ↔ legacy server** — production client has no cloud/backend dependency; localhost development only.
9. **Repository ↔ Git remote** — source/history is a supply-chain and privacy boundary.

## 3. Threat actors

- Malicious website hosting a form, including scripts that mutate DOM, intercept events, or spoof labels.
- Malicious document content (PDF/DOCX/TXT/image), including parser exploit attempts, ZIP/XML bombs, prompt injection.
- Malicious or substituted model files or CDN responses.
- Malicious model output (hallucinated or instruction-injected).
- Malicious or compromised browser extension, or a compromised dashboard page.
- Local attacker with device/browser-profile access.
- Dependency/build-chain attacker.
- Attacker with repository/remote access looking for personal documents, secrets, or history.
- Unauthenticated network attacker against the legacy development server if exposed.

## 4. Attack surfaces

### Chrome extension surface

- `background.js` message listener and offscreen/parser ports.
- `content.js` scan/fill message handler.
- `popup.html`, dashboard pages, extension setup.
- `chrome.scripting.executeScript` on active tab.
- `chrome.tabs.sendMessage` fill path.
- Model install/inference messages.
- Manifest permissions/host permissions/CSP.
- Cache Storage/IndexedDB/Chrome storage.

### Document surface

- PDF.js parsing, page rendering, embedded images/fonts.
- DOCX ZIP/XML/relationship/font/image parsing and local layout engine.
- OCR canvas/image boundary and Tesseract assets.
- Large text/structure serialization.

### AI surface

- Model file download/redirects/cache.
- Prompt construction and document text injection.
- Output parsing/validation.
- Offscreen model worker and ONNX runtime.
- Field-matching prompt using website labels/options.

### Autofill surface

- Website labels/options/ARIA content.
- Scan/fill approval token and content scan token/fingerprint.
- Cross-tab/cross-origin navigation.
- React/dynamic DOM mutation and event semantics.
- Sensitive field detection.

### Data/backup surface

- IndexedDB records and database migrations.
- Encrypted archive import/export.
- Model cache and metadata.
- localStorage/sessionStorage in localhost development.
- Legacy SQLite server and upload storage.

### Repository surface

- Git history and remotes.
- Test fixtures and build artifacts.
- `node_modules` install scripts and dependencies.

## 5. Threat scenarios and controls

| # | Scenario | Preconditions | Control | Residual risk |
|---|---|---|---|---|
| T1 | Website reads vault data directly | Malicious page | No extension APIs in page world; content script isolated; no web-accessible resources; strict message senders | Page can observe values it already displays after fill; expected |
| T2 | Website requests arbitrary vault values | Page calls extension APIs | `chrome.runtime` absent in page; background validates trusted extension sender | Compromised extension page could request vault data (trusted-boundary assumption) |
| T3 | Website spoofs form approval / fills another tab | Malicious page/navigation after scan | Background approval token bound to tab ID/URL/scan token; current active tab and URL rechecked; content scan token + form fingerprint; one-time token; lock clears approvals | Same-document DOM changes after scan are rejected by fingerprint; highly adaptive page could still influence labels before scan |
| T4 | Approval token replayed | Extension page or page | Single-use token; scan token clears after fill; fingerprint/tab URL checks | Token in memory could be used by another trusted extension page through messaging, but not by website |
| T5 | Content script becomes vault API | Malicious page | Content script only receives extension messages; only approved values; no vault access | Compromised extension context could message content script |
| T6 | Sensitive field silently filled | Ambiguous website labels | Sensitive classification; explicit approval; `requireSensitiveReview`; AI suggestions always review | Misclassification of an unlabelled sensitive field remains possible; user review is the final gate |
| T7 | Auto-submission or CAPTCHA bypass | Malicious page | Adapters never click submit; only input value setters/clicks on selected controls | Page-level auto-submit triggered by input events is outside extension control; user must verify |
| T8 | Cross-origin data leakage | User switches tabs/navigates | Tab ID/URL approval binding; active tab check; content token/fingerprint | Same-origin page navigation with identical URL/DOM could be indistinguishable, but user must rescan/approve |
| T9 | Malicious PDF/DOCX parser exploit | Malicious upload | Offscreen/parser worker isolation; validation; page/size/text/ZIP/XML/image limits; no external relationship fetch; parser timeout/cancel | Parser library vulnerabilities remain; no formal fuzzing/audit |
| T10 | ZIP bomb/decompression exhaustion | Malicious DOCX | `unzipSync` filter checks original size before extraction; total uncompressed/image/XML caps; worker timeout | Header-reported size trust assumptions and native library behavior not fuzzed exhaustively |
| T11 | External entity/relationship fetch | Malicious DOCX | Regex-based XML parsing; `TargetMode=External` marked external and not fetched | Future XML parser changes could introduce XXE; current code avoids parser entities |
| T12 | Path traversal in DOCX relationships | Malicious relationships | `normalizeDocxPartTarget` strips/rejects `..` escaping and constrains `word/...` paths | Unknown edge cases not fuzzed |
| T13 | OCR data exfiltration | Malicious image/network | Bundled local Tesseract assets; explicit paths; no CDN; E2E external request count 0 | Tesseract/library vulnerability risk |
| T14 | Model substitution | Compromised CDN/HF | Pinned revision + per-file size/SHA-256; hash on download and before load; corrupt status | No live CDN substitution test; TLS trust remains |
| T15 | Malicious model code execution | Substituted model/runtime | Model artifacts are data; Transformers/ORT bundled and hash-checked at build; model worker CSP/self | ONNX runtime/model parsing vulnerabilities remain |
| T16 | Prompt injection extracts vault | Malicious document | Model has no vault access/tools; document text marked untrusted; output restricted/grounded; user review | Model could output grounded malicious values or miss fields; not a confidentiality breach by itself |
| T17 | Malformed model output writes bad profile | Hallucinating/injected model | JSON parser, catalogue keys, deterministic validation, literal grounding, review; deterministic precedence | Values literally present but semantically wrong can still appear and require user review |
| T18 | Model output causes code execution | Malicious model | Output is string; no eval/HTML injection; React text rendering | None identified in current path |
| T19 | Vault plaintext at rest | Storage bug/migration | Encrypt-before-write; v2 AAD; repository review; phase3/phase4 tests; integrity checks | JS/engine memory and OS swap cannot be fully controlled |
| T20 | Key leakage via logs/errors | Debug logging | No prompt/value logging; bounded error messages; popup/dashboard state clearing | Exceptions could include operational metadata; no full log scrubbing audit |
| T21 | Key leakage via Chrome storage | Session persistence | Extension uses memory-only `MemorySessionBackend`; `chrome.storage.session` only state marker; tests assert no DEK | Web development uses sessionStorage by design |
| T22 | Ciphertext tampering/AAD swapping | Local attacker | Per-record AAD with vault/record/field/schema; v2 envelope; integrity check | No formal cryptographic audit |
| T23 | Backup exfiltration | Stolen archive | Encrypted v3 payload + authenticated header; passphrase separate; no plaintext values | Backup passphrase minimum only 8 chars; offline guessing possible |
| T24 | Malicious backup overwrites data | Hostile archive | Import only into empty target; validate counts/checksums/references; atomic activation/journal | Physical disk-full/crash combinations untested |
| T25 | Model cache tampering | Local attacker/extension page | Hash verification by manager; worker re-hashes verified revision files and rebuilds aliases; no remote fallback | Public cache not encrypted; a trusted extension page could alter files, but hash checks fail closed |
| T26 | Offscreen compromise | Parser exploit | No vault key/IDB, exact port sender, narrow protocol, allowlisted results | Shares extension origin; not a separate sandboxed origin |
| T27 | Background compromise | Memory/JS bug | DEK only memory; operations leases; session generation; sender validation | A compromised service worker can use the unlocked key; inherent |
| T28 | Legacy server account/data access | Exposed dev server | Auth tokens, scoped queries, rate limiting, CORS whitelist, JSON body, production secret assertion | Default dev secret, in-memory rate limits, no CSRF token; do not expose publicly |
| T29 | Repository personal-document disclosure | Git history/remote | Current index cleaned and `server/storage/` ignored; future files untracked | **Confirmed public GitHub repository; `migration/local-first` and other refs serve the identity PDF; raw URL returned 200**; requires immediate owner remediation |
| T30 | Dependency supply chain | npm install/build | Pinned versions; audit; no remote code at runtime; built assets verified | Dev-only Vite/fdir/picomatch advisories; native install scripts; no SBOM/attestation |

## 6. Trust assumptions

- Extension dashboard/popup are trusted; a fully compromised extension page can submit authorized operations while the vault is unlocked.
- Chrome extension origin isolation and MV3 service-worker isolation hold.
- The browser and OS are not compromised.
- Hugging Face serves the pinned public model files; SHA-256 detects content substitution.
- The user reviews autofill values before filling; sensitive fields require explicit approval.
- Localhost development server is not exposed to untrusted networks.
- JavaScript memory cannot be perfectly zeroized.

## 7. Residual risk summary

1. Historical personal PDFs remain in a **public** Git remote/history (confirmed critical repository exposure).
2. Personal-use runtime has no remaining known critical/high finding after the autofill binding fix, but no independent security audit has been performed.
3. Live CDN download behavior, WebGPU/Q4F16, model upgrades, Word pagination, accessibility, iframe/Shadow DOM, and peak memory are not fully verified.
4. Dev-only dependency advisories and legacy server defaults remain low/medium residual risks.
5. Parser/model runtimes are isolated but not formally fuzzed beyond the existing adversarial suites.
