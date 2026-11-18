# Remediation Report

Audit date: 2026-11-18  
No commit was created during this audit. All remediation changes remain in the working tree and must be reviewed/committed by the repository owner.

## 1. Remediation summary

| Finding | Severity | Action | Retest |
|---|---|---|---|
| F-01 personal documents in Git history/remotes | Critical | Removed current index in prior stabilization commit; audited remaining history/remotes; **did not rewrite history** | Current index clean; history/remotes remain exposed |
| F-02 autofill approval not bound to scan/tab/page/document | High | Added background approval token; tab ID/exact URL; content scan token; one-time use; lock invalidation; popup wiring | Google and standard browser audits PASS |
| F-03 post-scan form mutation | Medium | Added content-script form fingerprint and rejection on change | Standard audit mutation test PASS |
| F-04 approval survived lock | Medium | Clear pending approvals on locked state change | Standard audit lock/unlock test PASS |
| F-05 country/city/state classification on repeated tokens | Medium (functional) | Replaced anchored classifier patterns; exact `Name` shortcut; filter select placeholders | Classifier unit test and standard audit PASS |
| F-06 standard radio/checkbox option mismatch | Medium (defensive) | Require approved value to match option label; prevent substring matches such as Male/Female; return actual checked state | Extension tests and standard audit real group PASS |
| Prompt-injection regression test missing | Low | Added grounded/ungrounded adversarial extraction test | 216-test suite PASS |
| Audit browser scripts missing | Low | Added `audit-autofill-binding.mjs` and `audit-standard-form.mjs` | Both audits PASS |
| F-07 dev-only Vite/fdir/picomatch advisories | Low | No upgrade (no safe patched version; unrelated build churn) | Documented; production audit clean |
| F-08 backup passphrase min 8/no strength | Low | No change | Documented |
| F-09 unlock delay resets on SW restart | Low | No persistent counter (avoid lockout DoS) | Documented |
| F-10 legacy server defaults | Low/Medium if exposed | No public deployment; documentation | Documented |
| F-11 model alias rehash | Low | No change | Documented |
| F-12 live CDN/CI/publication gaps | Low | No CI/live network/package added | Documented |
| F-13 independent audit | Informational | Not performed | Documented |

## 2. Fixed code paths

### Approval binding and form freshness

- `shared/messages.ts` — `ScanPayload.scanToken`.
- `extension/src/content.ts` — per-scan UUID token, form fingerprint, fill rejection after token/fingerprint mismatch; token cleared after fill.
- `extension/src/background.ts` — approval map, 10-minute TTL, issue/consume logic, active-tab/exact-URL checks, one-time token, lock clearing, required `approvalToken` on fill, token forwarded to content script.
- `extension/src/popup/Popup.tsx` — stores scan approval token; refuses fill without it; sends it with fills.

### Standard form correctness/safety

- `extension/src/lib/classifier.ts` — unanchored word-boundary country/city/state patterns; exact label `Name` shortcut.
- `extension/src/adapters/StandardFormAdapter.ts` — filter `Choose`/`Select` options; require value-to-option label match for radio/checkbox; verify read-back value.
- `extension/test/classifier.test.ts` — repeated label/name/id regression test.
- `extension/test/google-forms.test.ts` — existing read-back/rejection and fill tests retained.

### Audit tests added

- `tests/unit/extraction-pipeline.test.ts` — prompt-injection test.
- `scripts/dev/audit-autofill-binding.mjs` — Google Forms scan/fill authorization audit.
- `scripts/dev/audit-standard-form.mjs` — standard HTML, read-back, mutation, cross-tab, lock, single-use audit.

### No changes made to

- Encryption primitives, vault key derivation, backup format, parser limits, model registry hashes, model worker inference, OCR assets, or production model binaries.
- Existing test assertions were not weakened or deleted. Test-hook builds were used only for suites that require fault-injection hooks; production was rebuilt afterward.

## 3. Retest results

- `npm test`: **216 tests, 216 pass, 0 fail**.
  - Local/unit 189.
  - Extension 15.
  - Server 12.
- `npm run typecheck`: pass.
- `npm run build`: pass.
- `npm run build:extension`: pass, 111 files, 51,041.0 KB.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `audit-autofill-binding.mjs`: PASS.
- `audit-standard-form.mjs`: PASS.
- `e2e-phase3.mjs`: PASS.
- `e2e-phase4-ingestion.mjs`: PASS.
- `e2e-phase412-ocr.mjs` (test hooks): PASS.
- `e2e-phase4-offscreen.mjs` (test hooks): PASS.
- `e2e-extension-reload.mjs`: PASS.
- `e2e-phase4-interruption.mjs`: PASS.
- `e2e-recovery-crash.mjs`: PASS.
- `e2e-migration-crash.mjs` (test hooks): PASS.
- `e2e-content-isolation.mjs`: PASS.
- `e2e-router-navigation.mjs`: PASS in this audit.
- `e2e-phase42-model.mjs`: PASS (real inference, 15.8 s install, 10.7 s self-test, 34.2 s extraction).

## 4. Unresolved / not safely fixable in audit

1. **Historical Git personal PDFs** — requires history rewrite, force-push, clone invalidation and remote object cleanup. Audit rules forbid history rewriting; owner action required.
2. **Dev-only Vite/fdir/picomatch advisories** — no patched version offered by current audit; production output unaffected.
3. **Live CDN download** — needs controlled external-network validation; local fixture + Range unit tests only.
4. **WebGPU/Q4F16 and model upgrade** — require model/runtime evaluation and validation, not audit-time changes.
5. **Word reference pagination** — requires genuine Word output; cannot be fabricated.
6. **Iframe/Shadow DOM, accessibility, and peak-memory coverage** — remaining gaps; standard radio/checkbox groups are now browser-tested.
7. **Backup passphrase strength, unlock delay persistence** — product policy changes; not made without owner decision.
8. **Legacy server** — development-only; must not be publicly exposed.

## 5. Git status

All audit remediation files are uncommitted. The prior stabilization commit remains `fc09d3c`; no commit was created in this audit. See `FINAL_AUDIT_SUMMARY.md` for the exact final changed-file set.
