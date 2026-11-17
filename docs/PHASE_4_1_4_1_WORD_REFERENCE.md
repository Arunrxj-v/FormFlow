# Microsoft Word reference procedure (Phase 4.1.4.2)

Microsoft Word is not installed in the current development environment. FormFlow therefore does **not** claim automated Microsoft Word compatibility. The validation harness accepts Word-rendered PDFs without introducing a Word or cloud dependency into the extension runtime.

## Generate references

1. Use a legitimately licensed Microsoft Word desktop installation.
2. Generate the corpus DOCX files by running the validation harness with `CORPUS_KEEP=1`:
   ```bash
   CORPUS_KEEP=1 CHROME_PATH="/path/to/chrome" npm run validate:docx-pagination
   ```
   The harness prints a `WORKDIR` path. It contains one `.docx` per corpus fixture.
3. Open each fixture in Word without editing it.
4. Export or print to PDF with the document’s own page size and orientation preserved.
5. Save each PDF as `<fixture-name>.pdf` in one directory, for example:
   ```text
   word-references/
     normal-overflow.pdf
     explicit-breaks.pdf
     section-breaks.pdf
     portrait-landscape.pdf
     page-size-margins.pdf
     long-table.pdf
     table-header-repeat.pdf
     merged-cells.pdf
     keep-with-next.pdf
     widow-orphan.pdf
     headers-footers.pdf
     images-captions.pdf
     mixed-fonts.pdf
     columns.pdf
     columns-complex.pdf
     nested-tables.pdf
     embedded-fonts.pdf
     font-substitution.pdf
     corrupt-embedded-font.pdf
     multi-font-paragraph.pdf
     table-images.pdf
     header-footer-images.pdf
   ```
6. Do not rename, re-save, or re-export through another renderer. Use the PDF Word produced.

## Compare

```bash
WORD_REFERENCE_DIR=/absolute/path/to/word-references \
  CHROME_PATH="/path/to/chrome" \
  npm run validate:docx-pagination
```

The report then includes, for every supplied Word PDF:

- Word page count, LibreOffice page count, and FormFlow page count.
- FormFlow-to-Word and FormFlow-to-LibreOffice page differences.
- Word-to-FormFlow block start/end mapping.
- Word image paint counts versus FormFlow physical-page image appearances.
- Table-cell, nested-table, and header/footer image placement counts.
- Focused nested-table, mixed-font, table-image, and header/footer boundary lines.

Missing PDFs are listed explicitly. The harness does not substitute LibreOffice output for a missing Word reference and does not mark any output `verified_physical`.

## Acceptance rule

A Word comparison is evidence only for the exact fixtures, Word version, platform, fonts, and export settings used. It is not a general guarantee that every DOCX will paginate identically in Word. FormFlow remains `renderer_derived_physical` unless a separate independent validation process explicitly establishes stronger evidence.
