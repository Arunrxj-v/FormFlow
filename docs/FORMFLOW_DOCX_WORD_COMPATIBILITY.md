# FormFlow DOCX Word Reference Validation

Date: 2026-11-18  
Status: **IMPLEMENTED BUT NOT FULLY VERIFIED** (harness ready for Word references; **Word validation NOT executed** — Microsoft Word is unavailable on this host). `verified_physical` remains disabled.

## What changed

The existing fidelity harness (`scripts/dev/validate-docx-pagination.mjs`) already accepted Microsoft Word PDFs via `WORD_REFERENCE_DIR`. This pass completed the reference-mode contract:

1. **Explicit reference mode**: `REFERENCE_APP=libreoffice` (default) or `REFERENCE_APP=word`. `REFERENCE_APP=word` requires `WORD_REFERENCE_DIR`; npm script: `npm run validate:docx-word`. Setting `WORD_REFERENCE_DIR` still auto-enables Word comparison for backward compatibility.
2. **Reference application and version are recorded**: the report now writes `Reference application` and `version` (override with `WORD_VERSION` / `REFERENCE_APP_VERSION`), and `readPdfReference()` captures PDF `Producer`, `Creator` and `CreationDate` metadata.
3. **Dedicated discrepancy report**: when Word PDFs are supplied the harness writes `docs/DOCX_WORD_DISCREPANCY_REPORT.md` with per-fixture page counts (Word / LibreOffice / FormFlow), paragraph placement, table fragmentation, image paints vs appearances, header/footer image blocks, orientation match and exact block ranges. Missing Word PDFs are listed explicitly.
4. **Explicit status line**: every generated report states `reference mode`, `verified_physical: false` and `renderer_derived_physical` only.
5. LibreOffice comparison remains the default and unchanged in behaviour.

## Comparison dimensions

- Page counts (Word, LibreOffice, FormFlow).
- Paragraph placement: exact start/end block ranges and match rates.
- Table fragmentation: row/cell geometry and blocks spanning multiple pages.
- Images: reference paint operators vs FormFlow image appearances, including table-cell and header/footer placement.
- Headers and footers: references, inherited furniture, even/odd variants, image blocks.
- Page geometry: orientation, page size/margins, section mapping, column boxes.
- Block ranges: per-block start/end page and mismatch list.
- A human-readable discrepancy report is generated in Word mode.

## Representative fixtures

Simple overflow, explicit page breaks, section breaks, portrait/landscape, page-size and margin changes, long and repeating-header tables, merged cells, nested tables, images/captions, table images, header/footer images, columns (incl. complex), headers/footers, widow/orphan, keep-with-next, mixed fonts, multi-font paragraphs, font substitution, embedded fonts (valid and corrupt).

## How to run with Word

1. Generate one PDF per fixture from Microsoft Word (see `docs/PHASE_4_1_4_1_WORD_REFERENCE.md`) into a directory, named `<fixture>.pdf`.
2. `WORD_REFERENCE_DIR=/path/to/pdf WORD_VERSION="Microsoft Word 16.xx" npm run validate:docx-word`.
3. Review `docs/PHASE_4_1_4_1_WORD_REFERENCE.md`-generated report and `docs/DOCX_WORD_DISCREPANCY_REPORT.md`.

## Actual validation status

- Microsoft Word is **not installed** on this host. No Word-exported PDFs were supplied.
- Therefore **Word validation was not executed** and the discrepancy report was not generated in this pass.
- LibreOffice comparison remains available and was exercised previously (`docs/PHASE_4_1_4_PAGINATION_VALIDATION.md`). LibreOffice results must **not** be presented as Word compatibility.
- No fixture is marked `verified_physical`; the application does not claim Word-verified physical pagination anywhere in its UI.

## Remaining limitations

- The harness compares text-derived block mapping, not pixel-perfect rendering; equal page counts alone are not sufficient evidence.
- Word font, style and OOXML feature differences can legitimately produce discrepancies that require manual interpretation.
- A screen-independent, automated pass/fail threshold for Word mode has not been defined; the report is intentionally descriptive.
