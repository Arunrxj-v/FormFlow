# FormFlow Privacy Notice

Last updated: 2026-11-18  
Applies to: the FormFlow Chrome extension, dashboard, popup, local workers, and the legacy development server.

FormFlow is a local-first application. This notice describes the actual network and storage behaviour of the code in this repository. It is not a legal privacy policy for a public store listing; a store-specific policy and legal review are still required before public distribution.

## 1. Where data is stored

- Documents, extracted text, OCR data, document structure, profile values, evidence, conflicts, collections, history, activity, settings, and model metadata are stored in the browser's IndexedDB database for the extension origin (`formflow-local`).
- Sensitive records are encrypted before persistence with AES-256-GCM. Each record uses associated data binding it to its vault and record identity.
- The vault data-encryption key is stored only in the background service worker's memory while the vault is unlocked. The key-encryption key is derived from your passphrase with PBKDF2-SHA256 and is never persisted.
- The local AI model is stored in the extension's Cache Storage. Model files contain no user data.
- `.model-cache/` in this repository is a developer test cache and is ignored by Git. It is not part of the extension or a user vault.

## 2. Encryption and passphrases

- Vault data is encrypted with AES-256-GCM and authenticated associated data.
- The vault passphrase is never stored. Losing it means the vault cannot be recovered.
- Repeated failed unlock attempts are recorded locally with a progressive delay. No passphrase or key is stored in that record.
- Backup archives are separately encrypted with the backup passphrase. New backups require at least 12 characters. Older archives remain restorable with their original passphrase.

## 3. Document processing

- PDF, DOCX, and TXT files are read locally in the extension.
- Text extraction, DOCX structure/pagination, OCR, deterministic profile extraction, and local model inference run on your device.
- Scanned pages use bundled Tesseract.js assets. OCR does not call a CDN or external OCR service.
- Malicious or malformed documents are treated as untrusted input and processed in request-scoped workers with size/page/zip/XML/image limits.

## 4. Local AI

- The app uses a pinned Qwen3-0.6B INT8 ONNX model revision.
- Model files are downloaded from Hugging Face over HTTPS, verified against pinned sizes and SHA-256 digests, and cached locally.
- The model runs in an isolated extension worker with no vault keys, no IndexedDB access, no tools, and no network access during inference.
- Model output is untrusted data. It is validated, grounded against source text, and shown for user review; it cannot write profile values or fill forms directly.
- WebGPU capability may be detected for diagnostics, but inference in this build uses the verified WASM backend. No Q4F16 WebGPU model is downloaded or used.

## 5. External network requests

FormFlow does not use telemetry, analytics, advertising, cloud sync, or an external AI provider. The normal runtime makes these network requests:

1. **Model installation/repair:** HTTPS requests to `huggingface.co` and its CDN for the pinned public model files. No document or profile data is included.
2. **Pages you visit:** when you navigate to a website, that website's own requests are made by the browser. FormFlow does not proxy them.
3. **Extension updates:** only through Chrome's normal extension update mechanism if the extension is distributed through a store or managed policy. No update server is configured in this repository.
4. **Legacy development server:** only when you intentionally run it on localhost. It is not used by the production extension.

The content script only runs on `https://docs.google.com/forms/*` automatically. On other sites it is injected on demand through the `activeTab`/`scripting` permissions after you open the popup. It does not run on every page at startup.

## 6. Browser permissions

- `activeTab`: inspect the tab you explicitly act on.
- `scripting`: inject the FormFlow content script on demand.
- `storage`: store non-secret vault state markers and settings.
- `alarms`: auto-lock scheduling.
- `offscreen`: host parser and model workers outside the service worker.
- Host permissions: `docs.google.com/forms`, plus `huggingface.co`/`hf.co` for model downloads.

The extension has no `<all_urls>` host permission and no web-accessible internal resources.

## 7. Autofill

- Scanning reads form labels and attributes from the active page.
- Values are sent to a page only after you select fields and approve filling.
- Approval is bound to the tab, exact URL, content-script scan instance, and form fingerprint; it is single-use and cleared when the vault locks.
- FormFlow never clicks submit. Rejected or transformed values are reported instead of being counted as successful.
- Same-origin iframes and open Shadow DOM are supported. Closed Shadow DOM and cross-origin frames are not traversed.

## 8. Retention and deletion

- Data remains until you delete it, delete the vault, or clear extension data.
- Deleting the vault removes the extension's IndexedDB database and the model cache.
- Deleting a document removes its original file, text, and dependent extracted values; collections and profile records are retained according to the app's documented behaviour.
- Backups are ordinary files you create; FormFlow cannot delete copies you saved elsewhere.

## 9. Backups

- Backup archives are encrypted and authenticated. They contain the vault's portable data, including documents and evidence.
- Restore validates the archive, checks document checksums and references, and refuses to overwrite a non-empty vault.
- Restore uses a journal so an interrupted restore does not partially activate.
- Store backups securely; anyone with the file and passphrase can read the vault.

## 10. Limitations

- JavaScript memory and browser/OS swap cannot be perfectly zeroized.
- A compromised browser profile, malicious extension, or compromised operating system can access data while the vault is unlocked.
- No independent privacy or cryptographic audit has been performed.
- The repository's historical Git objects are a separate issue; see `docs/FORMFLOW_SECURITY_HARDENING.md`.
