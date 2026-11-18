# FormFlow Browser Compatibility

Date: 2026-11-18

## Supported browser

FormFlow is a **Chromium Manifest V3 extension**. The declared minimum is **Google Chrome 113** (`minimum_chrome_version: "113"`).

Why 113:

- The extension uses the `chrome.offscreen` API (available from Chrome 109).
- Chrome 113 is the oldest **Chrome for Testing** build that could be obtained for this audit. Declaring 109 without a runtime test would be an unverified claim, so the declared floor was raised to the oldest tested build.
- The build target is `chrome113`.

## Actual tested versions

| Browser | Version | Result | Scope |
|---|---|---|---|
| Google Chrome for Testing | 113.0.5672.0 (headed) | PASS | Fresh installation, vault setup, onboarding persistence, standard HTML form scan/fill, same-origin iframe, open Shadow DOM, radio/checkbox, mutation/cross-tab/lock approval |
| Google Chrome for Testing | 159.0.8154.6 (headless) | PASS | Full automated suite, vault/backup/encryption, ingestion, OCR, offscreen isolation, reload/interruption/crash/migration, content isolation, router, real model install/self-test/offline inference/extraction, Google Forms and standard-form autofill, onboarding, UI accessibility |
| Chrome/Chromium older than 113 | — | NOT TESTED | Not supported by the declared minimum |
| Microsoft Edge (Chromium) | current | NOT TESTED | Expected to work because it is Chromium MV3, but not verified |
| Brave/Arc/Opera (Chromium) | current | NOT TESTED | Same expectation, not verified |
| Firefox | any | NOT SUPPORTED | Firefox extension APIs and MV3 offscreen behaviour differ; no implementation |
| Safari | any | NOT SUPPORTED | Safari Web Extension architecture differs; no implementation |

Headless Chrome 113 did not expose the extension service worker, so the 113 compatibility run used headed mode. This is a browser/runtime limitation, not an app failure.

## Required platform APIs

- Manifest V3 service worker with ES modules.
- `chrome.offscreen` and offscreen reasons `WORKERS` / `BLOBS`.
- `chrome.scripting.executeScript`.
- `chrome.storage.session`.
- `chrome.alarms`.
- Service worker + `import()` of bundled extension resources.
- WebAssembly SIMD and threads for the verified ONNX path.
- `crypto.subtle` for AES-GCM, PBKDF2, and SHA-256.

## Form-surface support

| Surface | Status | Notes |
|---|---|---|
| Standard HTML forms | Supported | Inputs, textareas, selects, radios, checkboxes, labels, placeholders, ARIA names |
| Google Forms responder pages | Supported | Content script injected on `docs.google.com/forms/*`, including frames |
| Google Forms editor | Detected, not filled | Shows an editor warning instead of risking edits |
| Same-origin iframes | Supported | Traversed from the top document, depth-limited; origin remains the top tab origin for approval binding |
| Cross-origin iframes | Not supported | Browser origin isolation is respected; no bypass |
| Open Shadow DOM | Supported | Open roots only; labels resolved in the owning root |
| Closed Shadow DOM | Not supported | Deliberately not bypassed |
| React-controlled inputs | Supported | Native prototype setters + input/change/keyup events |
| Dynamic forms | Supported with rescan | Form fingerprint rejects fills after post-scan mutation |
| Hidden/disabled/read-only fields | Skipped | Not targeted |
| Password/search/button inputs | Skipped | Not part of autofill |
| File uploads | Detected only | Never auto-uploaded |
| Cross-origin frame messaging | Not used | No unsafe workaround was added |

## Compatibility limitations

- Extension popup layout is designed for the Chrome toolbar popup; very small popup sizes are not separately certified.
- The dashboard is responsive and was checked at 1280×900 and 768×900 without horizontal overflow. It was not tested on mobile browsers.
- Accessibility was checked for semantic dialogs, focus entry/restore, Escape handling, keyboard focus, labels, live regions, visible focus, and reduced motion. No full WCAG audit or screen-reader matrix was performed.
- WebGPU is detected but not used for inference in this build; WASM is the compatibility path.
- Chrome's extension update mechanism is the only supported update path. No side-loaded auto-updater exists.
