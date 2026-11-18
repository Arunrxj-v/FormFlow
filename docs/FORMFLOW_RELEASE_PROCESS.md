# FormFlow Release Process

Date: 2026-11-18

This document describes a reproducible local release build and the remaining steps required for public distribution. FormFlow is **not** declared publicly releasable by this document.

## 1. Preconditions

- Clean working tree with reviewed changes.
- `npm ci` from the committed lockfile.
- Node 22+ (tested with Node 26.12.0).
- Chrome/Chromium 113+ for smoke tests.
- Production dependency audit clean.
- `.model-cache/` must remain ignored and must not be packaged.

## 2. Build and verify

```bash
npm ci
npm run typecheck
npm run test:local
npm run test:extension
npm run test:server
npm run build
npm run build:extension
npm audit --omit=dev
npm run package:extension
```

`package:extension` runs the extension build and then `scripts/package-extension.mjs`.

The packager:

- requires Manifest V3 and a semver version;
- verifies required files exist;
- rejects `.onnx`, model caches, source maps, TypeScript sources, tests, and `src/**`;
- rejects production test hooks;
- scans text assets for common secret patterns;
- writes `release/formflow-extension-<version>.zip`;
- writes a SHA-256 sidecar and `release/release-manifest.json` with sizes/counts.

`release/` is ignored by Git. Do not commit the ZIP or signing material.

## 3. Inspect the package

Before distribution:

1. Load `extension/dist` as an unpacked extension in a clean Chrome profile.
2. Run `scripts/dev/e2e-onboarding.mjs`, `audit-standard-form.mjs`, `audit-autofill-binding.mjs`, and `audit-ui-accessibility.mjs`.
3. Confirm `manifest.json` permissions are unchanged unless justified.
4. Confirm no remote code, inline script, or `unsafe-eval` beyond the documented WASM allowance.
5. Confirm the build has no test hooks:
   ```bash
   grep -c "__FORMFLOW_TEST_HOOKS__\|__TEST_INJECT_\|__TEST_DELAY_" extension/dist/background.js extension/dist/offscreen-parser.js extension/dist/content.js
   ```
6. Confirm no model binaries or personal documents are present.

## 4. Signing and store submission

The project does not contain signing credentials and does not automate store submission.

For a Chrome Web Store release:

1. Create or use the owner's Chrome Web Store developer account and pay the registration fee.
2. Generate/retain the extension signing key outside the repository. Never commit `.pem`, `.crx`, passwords, or store credentials.
3. Upload the ZIP through the Chrome Web Store dashboard or use the Chrome Web Store API with owner-managed OAuth credentials.
4. Complete the listing: name, description, screenshots, category, support URL, privacy policy URL.
5. Complete the data-use disclosure. State the truth: local vault, optional Hugging Face model download, no analytics, no external AI, no cloud document storage.
6. Justify permissions: `activeTab`, `scripting`, `storage`, `alarms`, `offscreen`, and the `docs.google.com/forms` + Hugging Face host permissions.
7. Submit for review. Do not claim review approval until it is granted.

Enterprise/self-hosted distribution can use Chrome enterprise policies or a managed CRX; that process also requires an owner-controlled signing key and update URL.

## 5. Updates

- Extension updates should use Chrome's supported store/managed update mechanism. Do not add a custom remote-code updater.
- Model updates are separate: a new model revision must have pinned sizes/SHA-256, a compatibility review, and real-model validation before it can replace the known-good revision.
- Never silently replace a verified model with an unpinned “main” revision.
- Keep the old verified model working if an update fails.

## 6. Versioning

- Bump `package.json`, `extension/manifest.json`, and any displayed app version together.
- Keep `MODEL_REVISION` and file hashes pinned.
- Update `docs/FORMFLOW_MODEL_RELIABILITY.md`, `docs/FORMFLOW_BROWSER_COMPATIBILITY.md`, and `docs/PRIVACY.md` when behaviour changes.

## 7. Public-release gates

Before claiming public-release readiness:

- [ ] F-01 Git history/remote exposure remediated and verified.
- [ ] Independent security review / penetration test.
- [ ] Privacy/legal review for the store listing and data-use disclosure.
- [ ] Store account, signing key, and submission process owned and documented.
- [ ] Reproducible CI on the release commit.
- [ ] Accessibility review beyond the current keyboard/dialog checks.
- [ ] Full live model download/resume validation.
- [ ] Decision recorded on WebGPU/Q4F16 and model upgrade policy.
- [ ] Support, incident response, and update process defined.
- [ ] No unresolved critical/high application vulnerabilities.

## 8. Current status

The local package build is reproducible and verified. Public distribution is **not ready** because the repository-history exposure, independent review, signing/store process, and several validation gates above remain open.
