# FormFlow User Workflow

This is the complete supported product flow, from an empty browser to an approved form fill.

## 1. Create the local vault

1. Build and load `extension/dist` at `chrome://extensions`.
2. Open the FormFlow dashboard.
3. Create a vault with a passphrase of at least 10 characters.
4. The passphrase is never stored. Losing it makes the vault unrecoverable.

The vault lives in IndexedDB under the extension origin. The data-encryption key is held only in service-worker memory.

## 2. Enter personal information

Open **My information → Personal profile** to:

- Add a value manually.
- Edit or delete a vault value.
- Inspect the source document, page, block, evidence excerpt, extraction method, and model version.
- Verify a value with the shield action.
- Review conflicts when two documents disagree.

Values entered manually are marked verified. Extracted values remain `extracted` until the user verifies or edits them.

## 3. Upload documents

Open **Document Vault → Upload document**. Supported formats:

- PDF (text and scanned/image pages)
- DOCX
- TXT

Documents are validated, SHA-256 checksummed, encrypted, parsed locally, and stored atomically. Duplicates are rejected by checksum.

Immediately after storage, deterministic extraction links obvious values such as email, phone, name, degree, institution, graduation year, employer, job title, and identification numbers. Each value keeps its document, page, block, and a short evidence excerpt.

## 4. Review documents and extracted values

Select a document to open the inspector:

- **Preview**: page text and metadata.
- **Structure**: headings, paragraphs, lists, tables, images, and renderer-derived pagination.
- **Facts**: linked vault values, evidence, conflict markers, and the **Extract profile values** action.
- **Audit**: processing history.

The facts tab shows deterministic and AI-assisted values separately through their method and model-version labels.

## 5. Install the local model

The model can be installed in either of these ways:

- **Automatic first run**: after the first successful document upload (default preference).
- **Manual**: **Settings → Local AI → Download model**.

The settings card shows:

- Download size and downloaded bytes
- Current phase and percentage
- Model revision, quantization, runtime, installed/verified timestamps
- Storage usage and quota
- Retry, cancel, verify/repair, self-test, and remove controls

The dashboard remains usable while the model is absent or downloading.

## 6. Run AI-assisted extraction

In **Facts → Extract profile values**, FormFlow runs:

1. Deterministic extraction over the bounded document text.
2. Local model extraction with a compact few-shot prompt.
3. Source grounding: a returned value must appear literally in the document.
4. Deterministic normalization and validation.
5. Merge rules that never overwrite deterministic values or verified values.
6. Encrypted persistence with document/page/block/evidence/model-version provenance.

AI candidates are stored as `extracted` and require review. A conflict creates a review item; it never silently replaces a verified value.

## 7. Review the profile

Open the profile pages:

- **Personal profile**: personal/contact/identification values.
- **Addresses**: address field values and source provenance.
- **Education**, **Employment**, **Skills & certifications**: structured records synthesised from grounded extraction and editable manually.

Each value can be edited, deleted, verified, or resolved when conflicts exist. Deleting a profile value does not alter the source document.

## 8. Open a supported form

Supported production surface:

- Google Forms respondent pages.
- Standard HTML forms on regular `http(s)` pages, after the user opens the popup.

The popup scans only the active tab after user action. It does not collect unrelated website content.

## 9. Review suggestions

The popup shows detected fields with:

- Suggested value
- Matched profile field
- Source document/page
- Verification state
- Confidence
- Reason for the match
- Sensitive/conflict indicators

Deterministic matching runs first. If ambiguous fields remain, the popup offers **Improve ambiguous fields with local AI**. That call:

- Uses only field labels, kinds, and options.
- Runs in the local model.
- Never sends profile values to the model.
- Only fills fields that deterministic matching left empty.
- Marks every AI suggestion `needsReview`.

The user can edit or reject any suggestion, approve individual fields, approve all, approve sensitive fields explicitly, or cancel.

## 10. Fill approved fields

**Fill approved fields** sends only the selected values for the active tab. The page script:

- Uses native value setters and dispatches input/change/keyup events for React-controlled inputs.
- Handles text inputs, textareas, selects, radio buttons, checkboxes, and ARIA textboxes.
- Verifies that the element actually holds the accepted value.
- Reports rejected/overwritten fields as failures rather than false successes.
- Does not click submit, bypass CAPTCHA, or bypass page protections.

The user reviews and submits the website form independently.

## 11. Backup and recovery

Use **Settings → Vault security → Backup & migration** to export an encrypted archive. Import requires an empty target vault and the archive passphrase. Interrupted restore is journaled and can be retried; partial activation is never treated as success.

## 12. Locking

The vault can lock manually, after the configured inactivity period, or when the service worker is terminated. A locked vault blocks dashboard data, document access, profile reads, export, and autofill until the passphrase is entered again.
