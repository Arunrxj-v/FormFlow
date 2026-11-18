# FormFlow Troubleshooting

## Model does not appear

- Confirm you are using the installed extension build, not the localhost dashboard. Model lifecycle is extension-only.
- Open **Settings → Local AI** and refresh the page.
- Verify `transformers.min.js` and `ort/ort-wasm-simd-threaded.asyncify.wasm` exist in `extension/dist`.
- Check that the extension was rebuilt after changing model files or the manifest.

## Model download fails

- The only permitted model host is Hugging Face (`huggingface.co` and its `*.hf.co` CDN). Check browser network policy and the extension host permissions.
- Partial bytes are kept in verified 8 MB chunks after a network interruption. Retry resumes with an HTTP Range request and validates `Content-Range`; if the server ignores Range, that file restarts cleanly. Cancel or a hash mismatch clears the chunks.
- If the error mentions insufficient storage, free at least the reported requirement (model plus headroom).
- If a previous download was interrupted, the install record becomes `failed`; use **Retry download**.
- If a file was tampered with or truncated, the model becomes `corrupt`; use **Verify & repair** or remove and reinstall.

## Model says installed but inference fails

- Run **Run local self-test**. It verifies the cache, loads the worker, and performs a real local generation.
- A self-test failure returns the actual model/runtime error. Common causes:
  - Corrupt cache: remove and reinstall.
  - Offscreen document creation blocked: Chrome 113+ is required.
  - WASM loading blocked: the extension CSP must contain `'wasm-unsafe-eval'` and `worker-src 'self'`.
  - Out of memory: remove the model, close other tabs, and retry. The worker is unloaded after 120 seconds idle.
- AI extraction errors do not block deterministic extraction; deterministic values remain available.

## AI extraction returns few or no values

- The model is a compact 0.6B model. It may miss semantic fields.
- Only values that appear literally in the document are accepted; invented values are rejected and reported as warnings.
- Try a cleaner document with extractable text. Scanned pages should be OCR-verified first.
- Run the model self-test to confirm inference is working.
- The activity log and extraction warnings record whether the model output was invalid, ungrounded, or unavailable.

## Model extraction times out

- The inference timeout is 180 seconds.
- The extraction context is bounded to 120,000 document characters and 4,000 AI context characters.
- Large or unusual documents should be split or reviewed in smaller parts.
- Cancel the active inference from the document facts tab or **Settings → Local AI**, then retry.

## Document import fails

- Supported formats are PDF, DOCX, and TXT; maximum file size is 20 MB.
- Password-protected PDFs are rejected by design.
- A corrupted file or invalid signature is rejected before storage.
- A duplicate checksum is not imported again.
- If extraction times out, the document is not committed. Retry from the original file.
- Scanned PDFs may be marked **OCR required**; use **Run local OCR** in the inspector.

## OCR is partial or failed

- FormFlow bundles English (`eng`) OCR assets only.
- Low-resolution, rotated, or heavily compressed scans may fail page-level OCR.
- Pages that still require OCR remain marked for review. The original file is preserved.
- Retry local OCR after checking the source quality.

## Backup import fails

- The target vault must be empty (no documents, values, or collections) and must have the default profile.
- The backup passphrase is separate from the vault passphrase.
- Tampered headers, wrong passphrases, malformed payloads, and unexpected properties are rejected.
- Interrupted restores are journaled; reopen the vault and retry. Partial activation is not reported as success.
- Evidence and source metadata are preserved in encrypted v3 backups. Older v1/v2 archives remain importable.

## Autofill does not fill a field

- The page may have re-rendered or removed the field after the scan. Rescan.
- The field may be disabled/read-only or have an unsupported widget.
- A value may not match any available option. Choose an option in the review UI.
- For React-controlled inputs, FormFlow uses the native setter and events, but a page can still reject or overwrite the value. FormFlow reports that as a failure rather than claiming success.
- Sensitive fields require explicit approval.
- FormFlow never auto-submits; submit the website form yourself.

## Vault is locked after a browser restart or extension reload

This is expected. The data key is memory-only. Enter the passphrase on the dashboard or popup unlock screen. Documents and profile values persist in the encrypted vault.

## Extension update or rebuild

After changing extension code/assets:

```bash
npm run build:extension
```

Reload the unpacked extension in `chrome://extensions`. The vault data is tied to the extension origin and persists across normal reloads.

## Diagnostics and reporting

The integrated verification report is at [`FORMFLOW_FEATURE_COMPLETION_REPORT.md`](FORMFLOW_FEATURE_COMPLETION_REPORT.md). Include the exact failing step, browser version, model status, and whether inference or deterministic extraction failed. Do not include vault passphrases, decrypted personal values, or document contents in issue reports.
