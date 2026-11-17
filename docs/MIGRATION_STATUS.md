# FormFlow Migration Status

FormFlow is now an **extension-owned, locally encrypted vault** for the production workflow. The extension dashboard and popup share one canonical IndexedDB vault under the extension origin. The localhost dashboard remains a development and migration surface.

## Phase 4.1.4.2 — Rendering discrepancies and complete image extraction (complete)

Phase 4.1.4.2 resolves the two remaining pagination discrepancies and extends structured image extraction to table cells and headers/footers. The architecture is unchanged: Manifest V3, background-only vault cryptography, offscreen/parser-worker isolation, encrypted `extractionEnc`, additive schema v1, and local-only processing.

### Root causes

- **Nested tables (+1 page):** the renderer treats an automatic table width as content-fit. The corpus fixture's outer table had no `w:tblGrid` and an `auto` width, so the renderer collapsed the outer columns to their content minimum. The nested table then inherited a very narrow parent cell, wrapped every inner cell, and inflated each outer row from ~46 pt to ~70.5 pt. LibreOffice used the authored/available table width. The correction is a general layout-time table-width normalization, not a fixture page override.
- **Mixed fonts (−1 page):** the packaged Carlito face had the same total line height as LibreOffice's Carlito but a different vertical split: its `hhea` ascent/descent/line-gap came from the win metrics, while LibreOffice used the typo split. The renderer adds line gap above the baseline per face and takes the maximum ascent plus maximum descent; LibreOffice takes maximum ascent plus maximum descent+leading. Single-face line heights matched; only mixed faces diverged (15.09 pt vs 16.8 pt), so FormFlow fit 40 paragraphs on one page instead of 38+2. The correction normalizes packaged font vertical metrics so leading sits below the baseline, preserving each single-face line height.

### Layout corrections

- Added bounded, layout-only DOCX table normalization. Tables with `tblW=auto`/missing width and an authored grid use the grid as a fixed width; tables without a grid synthesize equal columns from the available section/column width; nested grids are constrained to the parent cell width. `w:tblLayout` is set to `fixed`. Explicit, percentage, and floating tables are left authored and reported.
- Added build-time font vertical-metric normalization for the packaged Carlito/Liberation faces. The runtime now builds a local, hash-verified font configuration from `fonts/font-metrics.json` and patched assets instead of the package manifest. Glyph outlines and advance widths are unchanged; only `hhea` ascent/descent/line-gap are moved to the typo split. A fallback to the packaged configuration is retained and warned.
- Table normalization is bounded to 1,000 tables, 10,000 zip entries, and 100 MB uncompressed input. It runs only when the parsed structure contains tables. Warnings: `DOCX_TABLE_WIDTHS_NORMALIZED`, `DOCX_TABLE_LAYOUT_SKIPPED`, `DOCX_TABLE_NORMALIZATION_LIMIT`, `DOCX_FONT_VERTICAL_METRICS_NORMALIZED`.

### Structured images

- Images in normal table cells, nested table cells, and multiple cell paragraphs become stable child `image` blocks. Each carries `parentTableBlockId`, `parentRowBlockId`, `parentCellBlockId`, `tableId`, `rowIndex`, `columnIndex`, `nestedTableDepth`, `sourceParagraphBlockId`, `sourceParagraphIndex`, `placementIndex`, caption text, exact page association, bounding box, provenance, confidence, and warnings.
- Header/footer images in default, first-page, and even-page variants become one source placement per source part. `headerFooter` records kind, variant, part name, defining section, and inherited sections. `appearances` records every physical page where that source placement paints; inherited headers/footers do not create duplicate source blocks.
- Table/body image boxes use `renderer_page_content_points`; header/footer image boxes use `renderer_page_points`. Both are exact renderer boxes. External/linked images are never fetched. Image bytes never enter `DocumentStructure`; only metadata is encrypted inside `extractionEnc`.

### Schema additions (additive, schema v1)

- `DocumentStructureBlock.type: 'image'` continues, with new optional image fields: `placementId`, `parentTableBlockId`, `parentRowBlockId`, `parentCellBlockId`, `tableId`, `rowIndex`, `columnIndex`, `nestedTableDepth`, `sourceParagraphIndex`, `placementIndex`, `headerFooter`, `appearances`.
- `DocumentImageAppearance`: page, optional exact box, confidence.
- `DocumentStructureImageHeaderFooter`: kind, variant, part name, defining section, inherited section indexes.
- `DocumentCoordinateSpace`/geometry boxes accept `renderer_page_points` for page-furniture appearances.
- Validation now enforces image placement-ID uniqueness, bounded image count/appearances, MIME shape, parent table/row/cell consistency, nested depth, header/footer source/inheritance references, page-appearance bounds, and no parent/header-footer mixing. Existing fields and backups remain valid.

### UI

- The structure inspector shows image count, dimensions, alt text, caption, page association, table row/column, nested depth, and header/footer kind/variant/defining section/inheritance/appearance count.
- Table cells render compact image summaries instead of hiding cell images. Inherited header/footer images appear once in the outline with their appearance range, not once per page.

### Reference corpus

Expanded from 20 to **22 fixtures** and re-rendered with LibreOffice 26.8.3.1:

- **22/22 exact page counts**; total reference pages **58**, FormFlow pages **58**.
- **1,108/1,117 comparable top-level block ranges exact (99.2%)**. The only mismatches are 9 body-paragraph boundaries in `header-footer-images`, where the large header/footer images shift body flow relative to LibreOffice; page count still matches.
- Previous failures resolved: `nested-tables` now **2/2** with 3/3 exact block ranges; `multi-font-paragraph` now **2/2** with 40/40 exact.
- `table-images`: 1/1 page, 3/3 exact, 3 table-cell placements (including one nested table), caption linked, 3 exact page appearances.
- `header-footer-images`: 3/3 pages, 1 header + 1 footer source placement, 6 physical-page appearances across 3 pages.
- All 21 non-header-footer fixtures retain 100% exact block mapping.

### Verification

| Suite | Result |
|---|---|
| `npm test` | **188/188 pass** (local 164, extension 12, server 12) |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass; 106 files, 23.53 MB |
| `validate:docx-pagination` | 22 fixtures, 22 exact page counts, 1,108/1,117 block ranges |
| `validate:docx-degraded` | Pass |
| `validate:docx-fidelity` | **16/16 pass** |
| `validate:router-navigation` | **13/13 pass** |
| `benchmark:docx-pagination` | Pass; cancellation `CANCELLED` |
| Phase 4 ingestion E2E | **43/43 pass** |
| Phase 4.1.2 OCR E2E | **54/54 pass** |
| Offscreen parser E2E | **33/33 pass** |
| Phase 3 E2E | **98/98 pass** |
| Interruption E2E | **11/11 pass** |
| Migration crash E2E | **23/23 pass** |
| Extension reload E2E | **21/21 pass** |
| Content isolation E2E | **16/16 pass** |
| Recovery crash E2E | **8/8 pass** |

### Performance

- Extension **106 files, 23.53 MB**; parser worker **4.57 MB**; offscreen **1.68 MB**; background **0.23 MB**; fonts/WASM **6.13 MB**.
- 5,000 mixed-font paragraphs: **1,350 ms** total pagination, 132 pages, 5,000 mappings.
- 500-row nested table: **626 ms**, 18 pages, 1,501 mapped blocks, 629 KB pagination.
- 200 body images: **183 ms**, 40 pages, 200 exact appearances, 138.3 KB image metadata.
- 500 paragraphs with inherited header/footer images: **221 ms**, 15 pages, 2 source blocks with 30 appearances, 5.6 KB image metadata.
- 5,000 plain paragraphs: **1,150 ms**; cancellation **5 ms** after layout start.
- Browser process-tree RSS peak ~0.98–1.19 GB including Chromium/GPU overhead; deltas are noisy.

### Word status

Microsoft Word is still unavailable. The `WORD_REFERENCE_DIR` harness now also reports Word-vs-LibreOffice-vs-FormFlow page counts, Word/FormFlow image paint/appearance counts, and focused nested-table/mixed-font/table-image/header-footer boundary lines. It remains plumbing-tested only with a LibreOffice PDF and does **not** claim Word compatibility. No output is marked `verified_physical`.

### Remaining limitations

- Microsoft Word compatibility remains unverified.
- `header-footer-images` body-flow boundaries differ from LibreOffice by 9 of 80 block ranges while page count matches.
- Nested tables remain flattened into the parent cell in the structure model; images and depth are preserved, but nested-table row/cell blocks are not separate top-level blocks.
- Header/footer images in table cells are supported as header/footer placements without table parent blocks because header/footer table blocks are not separately structured.
- External images are never fetched; only placement metadata is retained.
- Explicit/percentage/floating table widths are not normalized, by design.
- Font substitution remains metric-compatible, not exact proprietary font fidelity. Vertical-metric normalization applies to the packaged substitute assets; document-embedded faces are used as authored and are not rewritten.
- No Phase 4.1.5 or Phase 4.2 work was started.

## Phase 4.1.4.1 — Pagination fidelity, geometry, and dependency hardening (complete)

Phase 4.1.4.1 resolves the follow-up limitations without changing the Phase 4.1.4 fallback semantics.

### Issue-by-issue result

| Issue | Before | After |
|---|---|---|
| Microsoft Word validation | LibreOffice-only comparison; no harness for Word output. | The corpus harness accepts `WORD_REFERENCE_DIR` containing Word-exported PDFs and reports Word page counts/mapping. Word is not installed here, so **no Word compatibility is claimed**. The manual procedure is documented in [`PHASE_4_1_4_1_WORD_REFERENCE.md`](PHASE_4_1_4_1_WORD_REFERENCE.md). |
| Font fidelity | Only packaged metric-compatible faces were reported indirectly. | The renderer’s embedded-font origin is used automatically. `docxLayout.fonts` records requested/resolved family, source, exact/substituted/embedded flags, coverage, face identity, and warnings. Theme fonts and `fontTable.xml` declarations are parsed. Malformed/oversized embedded faces are bounded and reported. |
| Structured images | Images affected layout but were not blocks. | Inline/floating images become stable `image` blocks with relationship/source/media part, MIME, intrinsic pixels, display points, positioning, wrap, alt/title text, caption linkage, warnings, and exact renderer page boxes where the resource resolves. |
| Line/cell geometry | Block-level only. | Paragraphs carry exact renderer line boxes per page/fragment. Table rows and cells carry exact boxes, indices, spans, continuation/header-repeat flags, and page/fragment mappings. Geometry confidence is explicit. |
| Multi-column geometry | Page count only. | Sections carry column count/equal-width/gap/separator/explicit widths. Pages expose column boxes, widths/heights, section indices, and derived block/line column indices with approximation labels. |
| React Router advisories | `react-router-dom` 6.30.6 / `react-router` 6.30.6 had two moderate advisories; no patched 6.x release. | Upgraded to **react-router-dom 7.18.5 / react-router 7.18.5** after checking all used APIs. `npm audit` and `npm audit --omit=dev` are clean. |

### Schema additions

All additions are optional and additive under `DocumentStructure` schema version 1:

- `DocumentStructureBlock.type: 'image'` with `image` metadata.
- `DocumentStructureBlock.columnBreakAfter`.
- `DocumentStructureDocxLayout.fonts`, `embeddedFonts`, `themeFonts`.
- `DocumentStructureDocxSection.columns` and `columnBreakCount`.
- `DocumentPaginationInfo.geometry` summary.
- `DocumentPaginationPage.sectionIndex`, `sectionIndexApproximate`, `columnCount`, `columns`.
- `DocumentPaginationBlockPage.geometryConfidence`, `boundingBox`, `lines`, `tableRows`, `rowIndex`, `columnIndex`, `rowSpan`, `columnSpan`.
- `DocumentCoordinateSpace: 'renderer_page_content_points'`.

Old backups and structures without these fields remain valid.

### Font behavior and limits

- Embedded faces are used from the DOCX when the renderer admits them; the renderer deobfuscates in memory and never executes font content.
- Packaged Carlito/Liberation faces remain the substitute set. Exact/local direct faces are reported as `exact_local`; embedded direct faces as `embedded`; packaged substitutes as `metric_substitute`; no-face resolution as `generic_fallback`/`unavailable`.
- The embedded-font origin is bounded by the renderer (16 MiB per face, malformed/over-limit faces dropped). FormFlow reports `DOCX_EMBEDDED_FONT_DROPPED`, `DOCX_EMBEDDED_FONT_UNAVAILABLE`, and font-origin failures.
- No proprietary fonts are packaged and no remote font is fetched.

### Image behavior and limits

- Media is read only from the DOCX package; external/linked images are recorded but **never fetched**.
- Image count is capped at 200, per-image bytes at 12 MiB, total image bytes at 64 MiB, dimensions at 12,000 px, and pixels at 40 million.
- Signature/MIME mismatch, invalid signature, oversized dimensions, missing relationship, missing media, external link, missing alt text, and dimension-unavailable cases produce explicit warnings.
- Image bytes are never placed in `DocumentStructure`; only metadata is emitted. The original bytes remain in the existing encrypted document storage.
- Image-only DOCX files may have an empty text body when the validated structure contains image blocks; they remain importable and encrypted.

### Geometry and column behavior

- Line and cell boxes use renderer page-content points and are labeled `exact`.
- Section/page/column assignment is derived from renderer section breaks and authored column definitions; derived assignments/used-area heights are labeled `renderer_approximate` or `source_approximate`.
- Single-fragment blocks omit redundant `fragmentPages`; cross-page blocks retain them. Page mappings remain in `startPageNumber`/`endPageNumber`.
- Geometry is bounded by 60,000 entries, 2,000 lines per block, 16 columns per page, and a 300,000-character geometry budget. A 5,000-paragraph fixture imports with all 5,000 mappings, truncates line geometry to 1,538 lines, and stays under the existing 2.5 MB structure response limit.
- Nested tables expose outer row/cell geometry; FormFlow’s existing flattened structure keeps nested table content in the parent cell.

### Reference comparison

Expanded from 14 to 20 LibreOffice-rendered fixtures. Results:

- **18/20 exact page counts**; total reference and FormFlow pages are both 54.
- **1,030/1,034 comparable top-level block ranges exactly matched** (99.6%).
- **54/54 page orientations matched**.
- Known discrepancies:
  - `nested-tables`: LibreOffice 2 pages, FormFlow 3. This is a genuine nested-table layout difference; row/cell geometry is still emitted.
  - `multi-font-paragraph`: LibreOffice 2 pages, FormFlow 1. This is a mixed-font line-metric difference.
- Embedded-font and font-substitution fixtures both produced 1 page and exact mapping; the embedded fixture reported an embedded direct face.
- Corrupt embedded font produced fallback plus `DOCX_EMBEDDED_FONT_UNAVAILABLE`.
- Images-captions produced 6 image blocks with 6 exact page mappings.
- Columns-complex produced 1-, 2-, and 3-column page geometry with 120pt/240pt unequal widths and an explicit column break.

Full report: [`PHASE_4_1_4_PAGINATION_VALIDATION.md`](PHASE_4_1_4_PAGINATION_VALIDATION.md).

### Word reference status

Microsoft Word is not installed in this environment. The harness was plumbing-tested by supplying a LibreOffice-generated PDF in `WORD_REFERENCE_DIR`; that is **not** a Word validation and is not reported as one. No output is marked `verified_physical`.

### Dependency remediation evidence

- `react-router-dom` 6.30.6 → **7.18.5**, `react-router` 7.18.5.
- Advisories removed: `GHSA-wrjc-x8rr-h8h6` (open redirect via backslash) and `GHSA-337j-9hxr-rhxg` (SSR hydration constructor injection). Both vulnerable ranges ended at 7.17.x.
- `esbuild` 0.24.2 → **0.25.12**, removing `GHSA-67mh-4wv8-2f99`.
- `npm audit` and `npm audit --omit=dev`: **0 vulnerabilities**.
- Route regression: 13/13 checks covering HashRouter navigation, query-string routing, back/forward, unknown-route redirect, and no page errors.
- FormFlow is a client-only HashRouter application; it does not use SSR hydration/`deserializeErrors`. The upgrade is still applied and tested.

### Performance and cost

- Production extension: **105 files, 23.49 MB**; parser worker **4.54 MB**; offscreen **1.68 MB**; background **0.22 MB**.
- HarfBuzz WASM **434 KB**; TTF faces **5.63 MB**; font/WASM directory **6.13 MB**.
- Worker startup **64–111 ms**.
- 1,000 paragraphs: **296–314 ms** total pagination.
- 5,000 paragraphs: **1,003–1,103 ms** total (font resolution ~0.3 s, renderer ~0.6 s, mapping ~0.1 s); 105 pages; all 5,000 block mappings retained; geometry explicitly truncated.
- 500-row table: **396–398 ms** total.
- Cancellation 5 ms after layout start returns `CANCELLED`.
- Browser process-tree RSS peak ~0.92–1.03 GB in the benchmark runs; deltas are directional and noisy (0–87 MB).

Full report: [`PHASE_4_1_4_PERFORMANCE.md`](PHASE_4_1_4_PERFORMANCE.md).

### Verification

| Command / suite | Result |
|---|---|
| `npm test` | **178/178 pass** |
| `npm run test:local` | **154/154 pass** |
| `npm run test:extension` | **12/12 pass** |
| `npm run test:server` | **12/12 pass** |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass; 105 files, 23.49 MB |
| `validate:docx-pagination` | 20 fixtures, 18 exact page counts, 1,030/1,034 block ranges |
| `validate:docx-degraded` | 9/9 pass |
| `validate:router-navigation` | 13/13 pass |
| `benchmark:docx-pagination` | Pass; cancellation `CANCELLED` |
| `e2e-phase4-ingestion` | 43/43 pass |
| `e2e-phase412-ocr` | 54/54 pass |
| `e2e-phase4-offscreen` | 33/33 pass |
| `e2e-phase3` | 98/98 pass |
| `e2e-phase4-interruption` | 11/11 pass |
| `e2e-migration-crash` | 23/23 pass |
| `e2e-extension-reload` | 21/21 pass |
| `e2e-content-isolation` | 16/16 pass |
| `e2e-recovery-crash` | 8/8 pass |

### Remaining limitations

- No Microsoft Word reference is available; Word compatibility is not claimed.
- Nested-table and mixed-font paragraph reference differences remain.
- Embedded fonts are used only when the renderer admits them; unsupported/corrupt/oversized faces fall back with warnings.
- Geometry is renderer-derived. Line/cell boxes are exact from the renderer; column/page/section assignments and used-column heights can be approximate and are labeled.
- Large documents can truncate line/cell geometry while retaining all top-level page mappings.
- External images are never fetched; image blocks preserve only linked placement metadata.
- No Phase 4.1.5 or Phase 4.2 work was started.

## Phase 4.1.4 — Genuine automatic DOCX pagination (complete)

Phase 4.1.4 adds local automatic physical DOCX pagination without replacing the existing WordprocessingML parser or exposing a backend/document-conversion service. The pre-existing explicit-break, Word-reported-break, and logical fallbacks remain intact.

### Renderer evaluation and selection

| Candidate | Evaluation | Decision |
|---|---|---|
| `docx-preview` 0.4.1 (Apache-2.0, local ~75 KB minified) | Locally bundled DOM renderer; supports manual `w:br type="page"`, optional `w:lastRenderedPageBreak`, headers/footers, tables and page size. Its documentation explicitly states realtime automatic page breaking is **not implemented**. | Rejected as a physical pagination engine. |
| `@docx-editor.dev/core` 2.38.0 + fonts 2.38.0 (Apache-2.0/OFL) | DOM-free OOXML layout engine with automatic page records, font-backed HarfBuzz shaping, paragraph/table fragments, section layout, headers/footers, merged cells, images, keep-with-next/keep-lines, widow/orphan controls and multi-column layout. The browser entry bundles to ~4.5 MB minified in the existing parser worker; packaged HarfBuzz WASM is 434 KB and the selected metric-compatible TTF faces are 5.63 MB. | **Selected.** It produces real automatic page records in a browser module worker and the cost is measured below. |
| Mammoth HTML | Produces HTML text, not physical page layout. | Rejected for pagination. |
| LibreOffice headless / remote conversion | Provides strong reference rendering, but is not a browser-local runtime and would violate the no-backend/no-remote-conversion constraint. | Used only as a test-time reference renderer, never at runtime. |

### Implementation

- The engine runs in the existing request-scoped parser Web Worker, not in the offscreen document or service worker. It receives DOCX bytes only and has no vault, DEK, KEK, passphrase, AAD, vault session, IndexedDB, or repository access.
- HarfBuzz and the Carlito/Liberation Sans/Liberation Serif faces are packaged locally under `extension/dist/fonts/`; the build pins and verifies their SHA-256. No CDN, remote font, or network fetch is used.
- The renderer uses compatible-font mapping: Calibri → Carlito, Arial/Helvetica → Liberation Sans, Times New Roman → Liberation Serif.
- Page records provide dimensions, orientation, margins and fragment-level mappings. For each existing FormFlow block, `blockPages` now includes `fragmentPages` with the page number and renderer fragment index, plus `endPageNumber` when a paragraph/table spans pages. Cells are mapped through their table row’s physical page.
- If renderer output does not complete or exceeds the 1,000-page limit, the existing explicit-break/reported-break/logical fallback is preserved with an explicit `DOCX_PAGINATION_RENDERER_UNAVAILABLE` warning.
- Renderer output is marked `renderer_derived_physical` / `local_renderer`. It is **never** marked `verified_physical`.

### Pagination semantics

- `logical_fallback`: no automatic or explicit page-boundary evidence; the existing logical page remains authoritative. Produced when the renderer is unavailable.
- `explicit_breaks`: page segments derived only from explicit page breaks/section breaks. Used only when automatic rendering is unavailable.
- `renderer_reported_breaks`: segments derived from Word `w:lastRenderedPageBreak` markers. Used only when automatic rendering is unavailable.
- `renderer_derived_physical`: automatic pages produced by the local font-backed renderer.
- `verified_physical`: reserved for independently validated output; not emitted.

### Section, header/footer and source metadata

DOCX structure now additively includes `docxLayout`:

- `sections[]` with section index, break type, page size, orientation, margins, column count, title-page flag, page-number start/format and header/footer references.
- Header/footer references record `kind`, `variant` (`default`/`first`/`even`), relationship ID, resolved part name, defining section, inheritance status, and the existing block IDs for that source part.
- Inherited headers/footers point to the defining section’s existing blocks; they are not duplicated as independent source content.
- Header/footer blocks keep stable FormFlow block IDs and now carry part-specific source references such as `docx:header:header2.xml`.
- `evenAndOddHeaders` is read from `word/settings.xml`; first-page and even variants are tracked even when the current section does not display them.
- DOCX `pages` remains one logical page for compatibility. Physical pages live only in `pagination`, and `docxLayout` carries section metadata.

### Reference-rendered validation

A reproducible corpus is implemented in `scripts/dev/validate-docx-pagination.mjs`. It writes 14 DOCX fixtures, converts each with locally installed LibreOffice 26.8.3, imports the same bytes through the production extension in Chromium, extracts PDF page text with `pdfjs-dist`, and compares page counts and block start/end pages.

- 14/14 fixtures had identical reference and FormFlow page counts.
- 760/760 comparable top-level blocks had matching start/end page ranges using the documented text-segment method.
- Orientation matched on every rendered page (42/42).
- Fixtures cover automatic overflow, explicit breaks, section breaks, portrait/landscape, Letter/A4 and margin changes, long tables, repeating table headers, merged cells, keep-with-next/keep-lines, widow/orphan controls, first/even/inherited headers and footers, page numbering, inline images with captions, mixed fonts/sizes, and two-column sections.

Full results and per-fixture notes: [`docs/PHASE_4_1_4_PAGINATION_VALIDATION.md`](PHASE_4_1_4_PAGINATION_VALIDATION.md).

**Honest discrepancy:** a minimal 120-paragraph DOCX with no explicit styles produced 5 pages in the renderer and 3 in LibreOffice because the two implementations resolve default paragraph spacing differently. With explicit Calibri 11 / single-spacing styles, both produced 3 pages. The corpus therefore uses explicit styles and records LibreOffice as the reference, not Microsoft Word.

### Performance

Measured by `scripts/dev/benchmark-docx-pagination.mjs` in a dedicated Chromium module worker:

- Production extension: **105 files, 23.42 MB**, up from the pre-Phase-4.1.4 78 files/15.08 MB.
- Parser worker: **4.51 MB**; offscreen document remains **1.67 MB**; background remains **0.21 MB**.
- HarfBuzz WASM: **434 KB**; selected TTF faces: **5.63 MB**; font/WASM directory: **6.13 MB**.
- Worker startup: **64–109 ms** across runs after module caching.
- Layout across repeated runs: **114–119 ms** for 120 paragraphs, **191–193 ms** for 500, **317–321 ms** for 1,200, **375–394 ms** for a 500-row table, **197–198 ms** for 500 mixed-font paragraphs; warm 120-paragraph layout was **45–46 ms**.
- Browser process-tree RSS peaks were ~**0.92–1.03 GB** including Chromium, GPU, renderer and extension overhead; incremental deltas were noisy but measured at roughly **5–51 MB**. These are whole-process directional measurements, not isolated heap profiles.
- Cancellation 5 ms after layout started on the 1,200-paragraph document returned `CANCELLED` without a pagination result.

Full measurements: [`docs/PHASE_4_1_4_PERFORMANCE.md`](PHASE_4_1_4_PERFORMANCE.md).

### Verification results

| Command / suite | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm test` | 170/170 pass |
| `npm run test:local` | 146/146 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass; 105 files, 23.42 MB |
| `scripts/dev/validate-docx-pagination.mjs` | 14/14 fixtures, 0 page-count differences |
| `scripts/dev/e2e-docx-degraded.mjs` | 9/9 pass; missing fonts warn, missing HarfBuzz falls back |
| `scripts/dev/benchmark-docx-pagination.mjs` | Pass; cancellation returned `CANCELLED` |
| `scripts/dev/e2e-phase4-ingestion.mjs` | 38/38 pass |
| `scripts/dev/e2e-phase412-ocr.mjs` | 54/54 pass |
| `scripts/dev/e2e-phase4-offscreen.mjs` | 33/33 pass |
| `scripts/dev/e2e-phase3.mjs` | 98/98 pass |
| `scripts/dev/e2e-phase4-interruption.mjs` | 11/11 pass |
| `scripts/dev/e2e-migration-crash.mjs` | 23/23 pass |
| `scripts/dev/e2e-extension-reload.mjs` | 21/21 pass |
| `scripts/dev/e2e-content-isolation.mjs` | 16/16 pass |
| `scripts/dev/e2e-recovery-crash.mjs` | 8/8 pass |

Real Chromium coverage now includes cross-page paragraphs with multiple fragment entries, tables spanning pages with row mappings, automatic pages without explicit break evidence, renderer-derived UI labels, cancellation during layout, and section/header/footer metadata.

### Supported and unsupported layout

Validated supported behavior includes automatic paragraph wrapping and overflow, metric-compatible font shaping, paragraph spacing, page dimensions/margins, explicit and section breaks, keep-with-next/keep-lines, widow/orphan controls, table row pagination, repeating table headers, merged cells, portrait/landscape sections, first/even/inherited headers and footers, page numbering metadata, inline images with captions, mixed fonts/sizes, and two-column sections.

Remaining limitations:

- Reference validation uses LibreOffice, not Microsoft Word. This is not Word-exact proof.
- No output is `verified_physical`; renderer-derived pages are explicitly labeled.
- Fonts are metric-compatible substitutes, not the document’s original faces. Missing or unsupported fonts can change wrapping and page boundaries; a warning is emitted.
- Renderer-specific support for every OOXML feature is not claimed. Unsupported content is preserved in text/structure where possible and reported by renderer/content warnings.
- Phase 4.1.4.1 adds structured image blocks, exact line/cell boxes, multi-column geometry, and font-resolution evidence; see the newer section above.
- Block-to-renderer mapping is text/order based. Unmatched blocks are omitted from `blockPages` or marked `approximate`; the mapping is not line-level.
- Renderer output above 1,000 pages or 20,000 mapped blocks is bounded and falls back or truncates mapping honestly.
- Layout runs with a 20-second internal limit in addition to the existing ingestion timeout.
- No backend conversion, remote rendering, AI/ONNX, or Phase 4.1.5/4.2/4.3 work was added.

## Phase 4.1.3 — Structured document extraction (complete)

Phase 4.1.3 upgrades local ingestion from flat text to a versioned, deterministic `DocumentStructure` while preserving all plain-text interfaces and the existing vault/offscreen security boundary.

### Schema

`DocumentStructure` v1 is stored inside the existing encrypted `extractionEnc` field with the `documentText` / `extraction` AAD. It is optional, so old records and v1/v2/v3 backups remain readable; new backups carry it.

The schema contains:

- `schemaVersion`, `extractionVersion`, `documentFormat`, `pageSemantics` (`physical` for PDF, `logical` for DOCX/TXT).
- Pages with stable `pageId`, page number, page kind/type, extraction method, block IDs, optional page bounds, and optional OCR-to-PDF coordinate conversion.
- Blocks with stable IDs, type (`heading`, `paragraph`, `list`, `list_item`, `table`, `table_row`, `table_cell`, `header`, `footer`, `caption`, `unknown`), text, page reference, order, parent/children, optional bounding box, optional OCR confidence, provenance, optional heading level/list marker/style/table indices, source reference, and warnings.
- Sections derived from heading hierarchy.
- Tables with row/cell block references and column/row counts.
- Deterministic reading order.
- Document and page warnings, including explicit layout-uncertainty warnings.
- Metadata counts and a `truncated` flag. Document title/author/PDF properties remain in the existing extraction metadata envelope; the structure itself contains deterministic IDs and layout metadata.
- Block IDs are deterministic (`p<page>_b<order>`, table/list child IDs derived from parent order), so identical input and parser versions produce the same structure.

### PDF layout behavior

- PDF text items are transformed into page-point coordinates with the PDF.js viewport, preserving page dimensions, text direction, font size, bold/italic hints, and original item order before grouping.
- Line grouping uses baseline proximity; large horizontal gaps split columns/table cells without destroying line order.
- Paragraphs use vertical spacing, font continuity, indentation, and column boundaries.
- Headings require relative font size and/or bold evidence plus stable short/large-line conditions; large text is not automatically a heading.
- Lists use explicit bullet/number markers and indentation levels.
- Tables require at least two consecutive aligned rows with consistent cell starts and bounded cell widths; otherwise ordered text is preserved and `TABLE_RECONSTRUCTION_UNCERTAIN` is emitted.
- Reading order detects one-to-three-column regions from vertical whitespace, preserves full-width headings/headers/footers, and emits `READING_ORDER_UNCERTAIN` when column bands cross or cannot be resolved confidently.
- Repeated top/bottom margin text across pages is classified as header/footer.
- OCR-only pages are replaced with OCR structure blocks after recognition; native text pages retain native structure. Mixed PDFs therefore keep per-page provenance.

### DOCX structure behavior

- WordprocessingML is the structural authority; Mammoth remains a compatibility fallback for raw text.
- Heading styles/outline levels, paragraph boundaries, alignment, hyperlink text, numbered/bulleted lists, nested list levels, tables, rows, cells, horizontal spans, vertical merges, and header/footer parts are preserved.
- DOCX remains one explicitly **logical** page. No physical pagination is claimed.
- Table cell boundaries are retained in the structure; the existing tab-separated plain text remains a backward-compatible derivative.
- Header/footer parts are deduplicated and section relationships, variants, and inheritance are recorded in `docxLayout`. A document whose header/footer files are not referenced from any section keeps the older `DOCX_HEADERS_FOOTERS_APPROXIMATE` warning.

### OCR structure behavior

- Existing Tesseract line/word boxes and confidence are reused; OCR is not rerun for structure.
- OCR lines are grouped into paragraphs and likely headings using geometry only. Headings are heuristic and carry `OCR_HEADING_HEURISTIC`.
- OCR bounding boxes retain `coordinateSpace: 'ocr_render_pixels'` and the rendered page dimensions. When a PDF page is available, the page records explicit `scaleX`/`scaleY` conversion metadata to PDF page points.
- OCR confidence remains OCR confidence, not semantic confidence.
- Native PDF text/structure is retained when OCR overlaps it; successful non-overlapping OCR pages get OCR blocks.

### Limits and compatibility

- Maximum 20,000 structured blocks, 2,000 sections, 1,000 tables, 5,000 table rows, 20,000 table cells, 32 hierarchy depth, 2,000,000 structure text characters, 20,000 bounding boxes, and 100 warnings.
- Plain `text`, `pageTexts`, search, previews, duplicate detection, and the existing `extractionEnc` model remain unchanged.
- Structure is encrypted at rest, validated by the strict offscreen protocol and backup importer, and preserved through export/import.
- No ONNX, Qwen, LLM inference, AI model download, semantic entity extraction, Phase 4.2/4.3, or autofill was added.

### Verification results

| Command / suite | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass; 78 files; bundle isolation verified |
| `npm run test:local` | 137/137 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | 161/161 pass |
| `scripts/dev/e2e-phase412-ocr.mjs` | 54/54 pass (test-hooks build) |
| `scripts/dev/e2e-phase4-ingestion.mjs` | 32/32 pass |
| `scripts/dev/e2e-phase4-offscreen.mjs` | 33/33 pass |
| `scripts/dev/e2e-phase3.mjs` | 98/98 pass |
| `scripts/dev/e2e-phase4-interruption.mjs` | 11/11 pass |
| `scripts/dev/e2e-migration-crash.mjs` | 23/23 pass |
| `scripts/dev/e2e-extension-reload.mjs` | 21/21 pass |
| `scripts/dev/e2e-content-isolation.mjs` | 16/16 pass |
| `scripts/dev/e2e-recovery-crash.mjs` | 8/8 pass |

Measured on Google Chrome for Testing 156.0.8078.4 on macOS:

- Structured extraction of a synthetic 40-page PDF with 480 blocks: **20 ms** parser time in the local unit suite; heap delta approximately **1.18 MB**.
- Phase 4.1.2 OCR production check remained **711 ms** at 94% confidence for a 1600×900 scanned page; the final structured OCR suite measured **984 ms** in its test build (run-to-run range approximately 0.8–1.0 s).
- OCR heap peak remained approximately **15.6 MB** for one page; two-page OCR peaked at approximately **18.8 MB** with structure included.

These are representative measurements, not universal benchmarks.

### Known limitations

- Layout inference is deterministic but heuristic; perfect reading order, table reconstruction, and column detection are not claimed.
- PDF text extraction can only use the geometry and font metadata exposed by PDF.js. Scanned pages have no native font-size/weight evidence.
- DOCX page boundaries remain logical; header/footer section placement is approximate.
- OCR heading/list inference is geometric and is explicitly warned.
- Bounding boxes for OCR are rendered-image pixels with explicit conversion metadata; they are not silently treated as PDF points.
- Structures may be truncated at the explicit limits while plain text remains complete.
- No semantic understanding, field extraction, or AI processing is performed in this phase.

## Phase 4.1.2 — Local OCR for scanned PDFs (complete)

Phase 4.1.2 adds genuine local OCR for scanned and image-only PDF pages without moving document content outside the browser.

### Engine evaluation and selection

The candidate set was limited to browser-local engines compatible with the existing offscreen architecture: Tesseract.js, OCRAD, and a future WASM Tesseract wrapper. OCRAD was rejected because it has no maintained worker/WASM packaging, weak language coverage, and no confidence or bounding-box model comparable to Tesseract. A custom WASM build would add a large build and maintenance surface without improving the initial English requirement. **Tesseract.js 7.0.0 with tesseract.js-core 7.0.0** was selected because it:

- runs in a classic Web Worker with a SIMD LSTM WASM core;
- supports explicit local `workerPath`, `corePath`, and `langPath` values, avoiding CDN defaults;
- exposes page, line, and word confidence plus bounding boxes;
- is Apache-2.0 licensed, with MIT-licensed language data;
- was verified in the real extension offscreen document under the production CSP on Chrome 156.

The local feasibility probe, and later the full extension suite, recognized `FORMFLOW OCR TEST`, `42 Example Street, Bengaluru`, and `Account number: 9988776655` from a rendered image-only PDF.

### Supported language set

Only **English (`eng`)** is bundled and claimed. The asset is `@tesseract.js-data/eng@1.0.0` `4.0.0_best_int/eng.traineddata.gz`. Additional languages are not supported until their trained data is added to `OCR_LANGUAGE_ASSETS`, copied into the build, and SHA-256 verified. The background refuses preferences outside the bundled set, and the offscreen protocol rejects unbundled language identifiers.

### Runtime architecture

- The background validates the file, computes the SHA-256 digest, encrypts the original, and sends only PDF bytes plus non-secret parser fields to the offscreen document.
- The offscreen parser first extracts native PDF text and identifies pages with little or no text. Only those pages are rendered with PDF.js at 200 DPI, capped at 12 MP per page and scale 3.
- The rendered canvas alone is passed to a request-scoped Tesseract worker. The OCR worker receives no vault key, AAD, passphrase, IndexedDB handle, or vault repository.
- Pages are processed incrementally, one canvas at a time. Each canvas and PDF page is released after use. A request-scoped OCR worker is terminated at the end of the parse, on cancellation, or when the offscreen document shuts down.
- OCR is bounded to 100 pages per attempt, 30 seconds per page, and a 300-second total ingestion timeout.
- Native text is retained on text pages. OCR text replaces only empty/very short native text or substantially longer OCR output; overlapping OCR output is not appended twice.
- The background validates OCR structure again, confirms status/page invariants, and persists recognized text and OCR details only inside the existing encrypted `documentText` record (`extractionEnc` with the `extraction` AAD field).

### CSP and local assets

The extension packages `tesseract/worker.min.js`, `tesseract/tesseract-core-simd-lstm.wasm`, `tesseract/tesseract-core-simd-lstm.wasm.js`, and `tessdata/eng.traineddata.gz` locally. The build verifies each SHA-256 before writing the production extension and fails on a mismatch. The offscreen page allows only `'wasm-unsafe-eval'` for the local WASM core, `connect-src 'self'` for local extension resource fetches, and `worker-src 'self'`. No remote OCR API, CDN, or document upload is used.

### OCR output model

Each OCR page records its original PDF page number, language, confidence, lines, words, bounding boxes, and warnings. The extraction record records engine, engine version, processed timestamp, pages attempted/completed/failed, average confidence, warnings, and status (`not_required`, `completed`, `partial`, or `failed`). Bounding boxes are pixel coordinates in the rendered page image, not PDF points. Confidence values are Tesseract's actual values; no confidence is fabricated when unavailable.

### Verification results

| Command / suite | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass; 78 files; local OCR assets copied and SHA-256 verified; bundle isolation verified |
| `npm run test:local` | 125/125 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `scripts/dev/e2e-phase412-ocr.mjs` | 54/54 pass (test-hooks build; extended in Phase 4.1.3 with structure assertions) |

The Phase 4.1.2 Chromium suite verified with genuine recognition, not mocks:

- image-only PDF recognized with page/line/word confidence and boxes;
- multi-page scanned PDF with preserved page boundaries;
- mixed native-text and image PDF, OCR applied only to the image page;
- rotated page recognized;
- unreadable/low-quality page stored and marked failed with real warnings;
- partial OCR success (one page completed, one failed);
- OCR language initialization and confidence;
- missing language asset preserving the original document and returning a retryable failure;
- cancellation during OCR with no partial record;
- OCR page timeout with a retryable failed status;
- offscreen crash during OCR, recovery, and successful retry;
- extension restart during OCR with no partial record and successful reimport;
- duplicate import not re-running OCR;
- encrypted OCR output at rest and AAD tamper rejection;
- encrypted backup export/import round-trip preserving OCR text, status, language, confidence, and bounding boxes;
- no vault key material in offscreen request/result diagnostics;
- bounded offscreen heap usage and no residual OCR jobs;
- no external network requests during OCR.

Measured on Google Chrome for Testing 156.0.8078.4 on macOS: a 1600×900 image-only page completed end-to-end import and OCR in **762 ms** with **95% average confidence** in the final test-hooks suite run; a separate final production-build check completed in **711 ms** with **94% confidence** and the expected text. The first OCR page pays engine and language initialization; earlier probe runs took about 1.2 s. Peak offscreen JS heap during the single-page suite run was **15.7 MB**; a two-page scanned PDF peaked at **18.4 MB**. These figures exclude WASM linear memory and are indicative, not a benchmark across devices. The bundled assets total about **9.6 MB** (worker 109 KB, SIMD LSTM core 6.4 MB including WASM, English data 2.8 MB). A single rendered 12 MP RGBA page is about 48 MB, and the implementation holds only one rendered page at a time.

### Limitations

- Only English is bundled.
- OCR accuracy varies with scan quality, skew, rotation, handwriting, tables, and multi-column layout.
- OCR text is not a visual reconstruction; the encrypted original remains authoritative.
- Bounding boxes refer to the rendered OCR image.
- The first OCR page pays engine and language initialization cost.
- Documents with more than 100 OCR-required pages require a later retry for the remaining pages; the UI and warnings report that limit.
- Tesseract.js 7.0.0's `Lang[]` preloaded-data initialization path was not used because its worker initialization path is broken; the implementation uses the documented local `langPath` fetch and still verifies the asset hash before engine startup.
- No external OCR, cloud OCR, or remote model download is implemented.

## Phase 4.1.1 — Isolated offscreen document parsing (complete)

Phase 4.1.1 moves untrusted PDF, DOCX, and TXT parsing out of the privileged MV3 service worker into a hidden Chrome offscreen document and request-scoped parser workers.

Implemented:

- Added the `offscreen` permission and raised `minimum_chrome_version` to **109**, the Chrome Offscreen API minimum.
- Created `offscreen-parser.html` / `offscreen-parser.js` with a hidden extension page that has no user-facing UI or navigation controls. It is created with the narrow `WORKERS` reason and spawns one parser Web Worker per document.
- Added `document-parser.worker.js`, which contains PDF.js, Mammoth, fflate, and the existing parser modules. The service-worker bundle no longer contains any parser runtime.
- Added a strict dedicated-port protocol: `PARSE_DOCUMENT`, `CANCEL_PARSE`, `PARSE_PROGRESS`, `PARSE_RESULT`, `PARSE_ERROR` with unique request IDs, parser version, exact-key validation, bounded progress, result-size checks, and coded errors.
- The background accepts the parser port only from the exact offscreen document URL and sender ID. The offscreen document is explicitly excluded from the general runtime operation router, so it cannot invoke `LIST_DOCUMENTS` or any vault operation.
- Added a non-configurable runtime `indexedDB` guard in the offscreen document and parser worker. Neither bundle imports vault, database, encryption, storage, application, or vault-client modules.
- Added a single managed offscreen lifecycle with a creation mutex, stale-document replacement, 15-second idle shutdown, maximum 2 concurrent parses, and per-request worker cancellation.
- Parser failure, cancellation, timeout, vault lock, service-worker termination, extension reload, or offscreen-document failure cannot produce partial records. The existing single IndexedDB commit remains the only success boundary.
- Added build-time bundle isolation checks using esbuild metafiles. The build fails if the service worker contains parser runtime, or if the offscreen page/worker contains vault, database, encryption, storage, or application modules.
- Added a strict CSP `worker-src 'self'`; no inline/remote scripts, `unsafe-eval`, remote parser libraries, or dynamic code execution were added.
- Kept backup v3, AAD, migrations, duplicate detection, encrypted text storage, and the dashboard UI unchanged at the data layer.

### Verification results

| Command / suite | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass; 73 files; bundle isolation verified |
| `npm run test:local` | 125/125 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | 149/149 pass |
| `scripts/dev/e2e-phase3.mjs` | 98/98 pass |
| `scripts/dev/e2e-phase4-ingestion.mjs` | 30/30 pass |
| `scripts/dev/e2e-phase4-offscreen.mjs` | 33/33 pass (test-hooks build) |
| `scripts/dev/e2e-phase4-interruption.mjs` | 11/11 pass |
| `scripts/dev/e2e-migration-crash.mjs` | 23/23 pass (test-hooks build) |
| `scripts/dev/e2e-extension-reload.mjs` | 21/21 pass |
| `scripts/dev/e2e-content-isolation.mjs` | 16/16 pass |
| `scripts/dev/e2e-recovery-crash.mjs` | 8/8 pass |

Browser: Google Chrome for Testing 156.0.8078.4 on macOS.

The Phase 4.1.1 offscreen suite verified in real Chromium:

- PDF, DOCX, and TXT parsing through the offscreen document.
- Production ingestion created the offscreen parser context.
- Offscreen `indexedDB` access was blocked.
- Actual offscreen request/result key allowlists contained no DEK, KEK, passphrase, AAD, or key-like fields.
- The offscreen document could not invoke arbitrary background vault operations (`UNAUTHORIZED`).
- Malformed parser requests, malformed parser responses, and oversized parser results were rejected.
- A bounded parser timeout left no record.
- An offscreen-document failure rejected the import and left no partial record; a later import recreated the offscreen document successfully.
- Two concurrent requests were handled safely.
- One cancellation did not terminate the other active parse.
- Vault lock drained the offscreen parse and the import committed atomically.
- Duplicate detection and encrypted v2 text persistence still worked.
- Extension disable/re-enable during an active offscreen parse left zero partial records and recovered successfully.

Known limitations:

- Offscreen documents and parser workers share the extension origin. They have no vault authority, no vault/DB/crypto imports, and a runtime IndexedDB guard, but they are not a separate sandboxed origin.
- The offscreen document is created with the `WORKERS` reason and uses Chrome 109+ APIs.
- Local OCR was added in Phase 4.1.2; image-only PDFs no longer remain permanently `ocrRequired`.
- Malformed request/response and timeout tests use test-only bots/offscreen hooks in a test build; the production build was rebuilt and verified to contain no hook strings.
- Parser workers receive only document bytes and non-secret protocol fields; the DEK never leaves the service worker.

## Phase 4.1 — Local document ingestion (complete)

Phase 4.1 adds a local ingestion pipeline for PDF, DOCX, and TXT without adding cloud processing, OCR, model downloads, ONNX, or AI extraction.

Implemented:

- Signature/content validation for PDF (`%PDF-`), DOCX (ZIP container plus `word/document.xml`), and strict UTF-8 TXT. File extensions and browser MIME types are treated as hints, not authority.
- SHA-256 content digests with duplicate detection before a new record is created. The existing record is returned by name; no file is overwritten.
- PDF.js extraction of text, page count, per-page text, page numbers, and best-effort PDF metadata. Image-only, scanned, mixed text/image, empty, password-protected, corrupted, and oversized PDFs are classified. Phase 4.1.2 adds local OCR for image-only pages.
- DOCX extraction with Mammoth validation plus a WordprocessingML structure pass for paragraphs, headings, tables, line breaks, and document order. Table cells are preserved as tab-separated rows.
- Strict UTF-8 TXT handling with BOM detection, CRLF/CR/LF normalization, invalid-encoding rejection, binary-control rejection, and paragraph preservation.
- Atomic encrypted persistence: the document row, encrypted original bytes, encrypted extracted text, and encrypted extraction details are written in one strict IndexedDB transaction. A quota error, lock, parser failure, cancellation, or service-worker termination cannot leave a successful document without its text or file.
- Parser module receives document bytes only. It has no vault session, DEK, KEK, AAD, database handle, or network access. Phase 4.1.1 moved parsing to the hidden offscreen document and request-scoped workers; see the Phase 4.1.1 section.
- Extraction details (warnings, PDF/DOCX metadata, pages requiring OCR) are encrypted under the existing `documentText` record with the distinct AAD field `extraction`. No extracted text or sensitive metadata is stored in plaintext.
- Typed protocol operations for document text retrieval, extraction retry, cancellation, and progress. Progress travels over an extension-origin-only port and contains only stage, page, file index, and percentage — no filename, text, key, or metadata.
- Dashboard upload dialog shows real validation/extraction/encryption/storage stages, page count, duplicate name, OCR-required state, warnings, retry, cancellation, and clear errors.
- Inspector shows decrypted text preview per page, page navigation, extraction status/timestamp, warnings, and OCR-required state without storing plaintext in the list payload.
- Optional document fields (`extractionVersion`, `extractedAt`, `ocrRequired`) and optional `documentText.extractionEnc` preserve compatibility with existing documents, migrations, and v1/v2/v3 backups. Backup v3 now carries extraction details; older backups without them still import.

Verification results:

| Command / test | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass; 73 files |
| `npm run test:local` | 125/125 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| `scripts/dev/e2e-phase3.mjs` | 98/98 pass |
| `scripts/dev/e2e-phase4-ingestion.mjs` | 30/30 pass |
| `scripts/dev/e2e-phase4-offscreen.mjs` | 33/33 pass (test-hooks build) |
| `scripts/dev/e2e-phase4-interruption.mjs` | 11/11 pass |
| `scripts/dev/e2e-migration-crash.mjs` | 23/23 pass |
| `scripts/dev/e2e-extension-reload.mjs` | 21/21 pass |
| `scripts/dev/e2e-content-isolation.mjs` | 16/16 pass |
| `scripts/dev/e2e-recovery-crash.mjs` | 8/8 pass |

Browser: Google Chrome for Testing 156.0.8078.4, Playwright persistent profiles, production extension build. The ingestion E2E imports a real Chromium-generated multi-page PDF, a DOCX with headings/tables, a BOM/CRLF TXT, an image-only PDF, a corrupted PDF, and a password-protected PDF; it verifies encrypted-at-rest text, v2 AAD, duplicates, OCR state, retry, cancellation, real progress, and the dashboard upload dialog. The interruption E2E reaches the offscreen parser during a 1,000-page PDF import, disables the extension, re-enables it, unlocks, and verifies that no partial document/file/text triple exists.

Known Phase 4.1 limitations:

- **OCR is implemented in Phase 4.1.2 for English scanned PDF pages.** Image-only pages are rendered locally and recognized with bundled assets; unsupported languages and failed OCR remain explicitly reported.
- DOCX page boundaries are not reliable in the format; DOCX is stored as one logical page with a warning.
- Complex PDF layout and DOCX table/heading structure are normalized to text; visual layout is not reproduced.
- PDF metadata extraction is best-effort and may be absent.
- Password-protected PDFs are rejected rather than decrypted.
- Parsing runs in the hidden offscreen document and request-scoped workers, outside the service-worker key boundary.
- Local OCR/field extraction is partially implemented: English scanned-PDF OCR is available; ONNX, model downloads, Qwen inference, intelligent extraction, and autofill are out of scope for this phase.

## Phase 3.1.2.1 — Final runtime security verification (complete)

The three Phase 3.1.2 verification gaps were closed with actual Chromium automation:

- **Migration crash:** a test-only extension build created a realistic v1 vault (275 documents, document blobs, values, a collection, an education record, and form history), committed the first `documents` migration batch, then the Chromium process was SIGKILLed. After restart and unlock, the migration resumed, the journal reached `complete`, all 275 documents/files and other records survived without duplicates, the integrity checker passed, and no plaintext values or v1 envelopes remained. The production extension was rebuilt without the test hooks.
- **Extension reload:** a second test-only management extension disabled and re-enabled FormFlow in place, preserving extension ID and storage while restarting the worker. The dashboard and popup reopened locked, no DEK was present, and unlock restored documents and profile data. A 20 MB import was interrupted by the same lifecycle and left no partial document/file pair.
- **Content-script isolation:** actual local HTTP and HTTPS pages were visited; the content script did not run and the page could not access extension APIs, session storage, the vault IndexedDB, or a page-world bridge. A Google Forms-origin page served through route interception was injected, scanned through the background router, and remained unable to access extension APIs.

### Verification results

| Command / test | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:local` | 81/81 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| `scripts/dev/e2e-phase3.mjs` | 98/98 pass |
| `scripts/dev/e2e-migration-crash.mjs` | 22/22 pass |
| `scripts/dev/e2e-extension-reload.mjs` | 21/21 pass |
| `scripts/dev/e2e-content-isolation.mjs` | 16/16 pass |
| `scripts/dev/e2e-recovery-crash.mjs` | 8/8 pass |

Browser: Google Chrome for Testing 156.0.8078.4, Playwright persistent profiles, production extension build. Migration fixtures were built with a test-only `background.test.ts` entry; the production build was rebuilt afterwards and verified to contain no test-hook strings.

## Phase 3.1.2 — Advanced hardening and recovery (implemented; see limitations)

Completed in this phase:

- Added atomic backup restore: every record, file, checksum, and relationship is validated and encrypted/decrypted round-tripped before activation.
- Added a persistent restore journal (`validating`, `ready`, `complete`, `failed`) and an activation marker committed atomically with the imported records.
- Added restore recovery that inspects actual record counts and the activation marker rather than trusting journal status alone.
- Added concurrent-restore rejection and in-transaction target modification checks.
- Added encrypted vault display names with a separate `nameFormat` marker and migration for existing format-v2 vaults.
- Hardened extension CSP to `script-src 'self'; object-src 'none'` plus HTML `base-uri`, object, image, font, and media restrictions.
- Removed the content-script page-world ping/pong bridge.
- Added stored-XSS payload tests and confirmed React renders data as text.
- Preserved genuine v1/v2 import compatibility, added downgrade-relabel tests, and verified successful legacy imports re-export as v3.
- Added a real Chromium **process kill during backup restore**, restart recovery, journal inspection, and successful retry.

### Verification results

| Command / test | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:local` | 81/81 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| Chromium extension E2E | 98/98 checks pass |
| Chromium restore process-kill recovery | 8/8 checks pass |

A real Chromium migration process-kill test was not performed. Migration crash behavior is covered by deterministic transaction/journal fault injection; the real process-kill test covers atomic backup restore.

## Phase 3.1.1 — Final security hardening (complete)

Completed in this phase:

- Made the background service worker the exclusive owner of the DEK. The dashboard and popup now use typed operation clients and receive no key material.
- Removed the DEK from `chrome.storage.session`; that area now holds only a non-secret lock/state marker. A service-worker termination therefore locks the vault.
- Added `VaultOperationCoordinator` leases for every data-bearing background operation.
- Lock now sets `locking` synchronously, rejects new operations, drains in-flight reads/mutations, clears the key only after the drain, and only then publishes `locked`.
- Added an operation timeout that fails closed without falsely reporting locked.
- Added validated dashboard/popup keepalive ports so active UI does not lose the session to MV3 idle termination; forced termination still locks.
- Serialized create/unlock/lock transitions and rejected unsafe interleavings.
- Added backup format v3 with a canonical, length-prefixed authenticated header covering algorithms, KDF parameters, salt, nonce, encryption/schema/manifest versions, all record counts, total bytes, payload bytes, and creation time.
- Retained genuine v1/v2 backup imports.
- Added deterministic migration fault points for pre-batch, pre-write, during-transaction, post-commit, journal, verification, and marker boundaries.
- Added quota-exhaustion fault injection for document upload, backup import, migration batches, journal writes, and marker writes.
- Added exact 200 MiB (209,715,200 byte) backup boundary tests.
- Extended Chromium E2E for DEK absence, generic-operation rejection, upload/lock draining, v3 header tampering, and genuine legacy v1/v2 imports.

### Verification results

| Command / test | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:local` | 70/70 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| Chromium extension E2E | 88/88 checks pass |

The Chromium suite verifies that the dashboard and popup cannot read a raw DEK, generic crypto/database operations are rejected, an 8 MB upload and lock are safely drained, no mutation starts while locked, v3 header tampering fails authentication, v3 imports work, genuine v1/v2 imports work, the service worker locks on termination, browser restart requires unlock, and encrypted documents remain readable.

## Phase 3.1 — Security hardening (complete)

Completed in this phase:

- Replaced the vault-wide AAD with per-record authenticated context bound to vault ID, record type, record ID, field, encryption format, and schema version.
- Added canonical length-prefixed AAD encoding and format-v2 envelopes.
- Added ciphertext identity tests for cross-record, cross-field, cross-type, and cross-vault swapping.
- Added a resumable v1→v2 encryption migration with a persistent journal, controlled batches, compare-and-swap writes, round-trip verification, and a full verification pass before setting the format marker.
- Encrypted personal field labels and conflict labels at rest.
- Added a vault integrity checker that reports invalid ciphertext, missing files, checksum mismatches, broken references, and incomplete migration state without deleting records.
- Hardened backup archives: strict envelope/key validation, exact KDF parameters, nonce/salt/base64 bounds, record-count limits, duplicate-ID checks, relationship checks, checksum recalculation, UTF-8 failure handling, and a v2 archive AAD.
- Kept Phase 3 v1 backups importable.
- Added session generations so data-bearing operations are discarded when a lock occurs in flight.
- Serialized concurrent lock/unlock transitions.
- Cleared popup state on remote lock and revoked document preview URLs on lock.
- Added passphrase-change verification before committing the new wrapped key.
- Documented the threat model and residual risks in `docs/SECURITY_ARCHITECTURE.md`.

### Verification results

| Command / test | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:local` | 47/47 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| Chromium extension E2E | 63/63 checks pass |

The Chromium E2E covers v2 ciphertext inspection, per-record AAD metadata, cross-field ciphertext swapping and recovery, integrity checking, service-worker termination, encrypted export/import, malformed backup rollback, passphrase rotation, browser restart, popup/dashboard locking, and one shared vault.

The v1→v2 migration is verified by unit tests that seed all record types in the Phase 3 format, migrate them, verify decryption and integrity, corrupt a record, confirm the marker stays at v1 with a failed journal, restore the record, and resume successfully.

## Phase 3 — Extension-owned vault and encryption (complete)

Completed in this phase:

- Built the existing React dashboard into `chrome-extension://<extension-id>/dashboard.html`.
- Switched the extension build to package dashboard HTML, JS, CSS, fonts, popup, background worker, content script, and icons.
- Removed the localhost backend host permissions from the production manifest.
- Added a strict versioned extension message protocol with request IDs, payload validation, operation routing, and trusted-extension-sender checks.
- Connected the popup to the extension-owned vault instead of a separate `chrome.storage` vault.
- Removed the old popup vault keys as an active source of truth.
- Added one-time migration of legacy popup vault values into the canonical vault.
- Added encrypted vault creation, unlock, lock, auto-lock, and passphrase change.
- Added AES-256-GCM encryption at rest for documents, document text, profile values, conflicts, profile records, collections, activity, and history.
- Added PBKDF2-SHA256 key derivation at 600,000 iterations with a random per-vault salt and a wrapped random data-encryption key.
- Added encrypted document blobs and authenticated decryption on preview/download.
- Added encrypted backup export and import with checksum validation and non-empty-target rejection.
- Added a Phase 2 plaintext-to-encrypted in-place migration path.
- Added verifiable lock-state enforcement for dashboard access, popup access, and autofill requests.
- Added browser-level E2E verification of encryption at rest, lock/unlock, browser restart, cross-origin import, and auto-lock.

### Verification results

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:local` | 21/21 pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| Chromium extension vault E2E | 48/48 checks pass: vault creation, real PDF upload, profile value, collection, encrypted-at-rest inspection, typed protocol operations, service-worker termination/restart, encrypted export, import safeguards, popup shared-vault, dashboard→popup lock propagation, popup unlock/lock, wrong/correct passphrase, browser restart, persistence |
| Cross-origin encrypted migration | Localhost encrypted export imported into the extension origin; document and profile value verified |
| Auto-lock and legacy popup migration | Auto-lock triggered after inactivity; legacy popup values imported and old keys removed |

The browser E2E is reproducible with `CHROME_PATH="/path/to/Chrome for Testing" node scripts/dev/e2e-phase3.mjs` against `extension/dist`.

### Security model

- Vault passphrase is never stored.
- PBKDF2-SHA256 derives a key-encryption key.
- A random AES-256-GCM data key is wrapped by the key-encryption key.
- Every encryption uses a fresh 12-byte nonce.
- Encrypted records use authenticated encryption with associated data.
- The raw data key is held only in service-worker memory. It is not written to IndexedDB, `chrome.storage.local`, or `chrome.storage.session`.
- Locking clears the in-memory key and publishes only the non-secret lock state.
- Browser restart and service-worker termination lose the key and require unlock.
- Content scripts never access the vault key or the full vault.
- The popup and dashboard are trusted extension pages and access the vault through the shared security layer and service worker.
- Document blobs are encrypted with the same vault data key.
- Backup archives are encrypted with a separate backup passphrase.
- Backup import recalculates document checksums instead of trusting archive metadata.

### Known Phase 3 limitations

- Vault metadata such as record IDs, field keys, categories, statuses, file sizes, MIME types, checksums, and the vault name remain plaintext structural metadata. Sensitive values and document contents are encrypted.
- The backup format is a JSON envelope with base64 document payloads. The current import limit is 200 MB.
- Encrypted backup import is allowed only when the target has no documents, values, or collections and its profile is still the default created at vault setup. The archive's profile replaces the local profile.
- Automatic lock is implemented in the dashboard and in the extension background alarm. The alarm uses the configured inactivity interval.
- There is no passphrase recovery mechanism. Losing the passphrase makes the vault unrecoverable.
- The legacy Google Drive, backend, and old auth source files remain in the repository but are not used by the extension vault workflow.
- Local text extraction is implemented for PDF, DOCX, and TXT, and Phase 4.1.2 added English scanned-PDF OCR. AI field extraction and AI processing remain future phases.
- The extension dashboard is the production dashboard. The localhost dashboard remains a development and migration surface.

## Phase 1 — Recovery and build foundation (complete)

Completed in this phase:

- Resolved the canonical field definition to `shared/form-fields.ts`.
- Fixed the broken relative import in `extension/src/lib/classifier.ts`.
- Added `core/`, `ai/`, and `extension/test/` to TypeScript checking.
- Restored `npm run typecheck`, `npm run build`, `npm run build:extension`, and `npm test`.
- Made the extension build atomic: it now builds into `extension/.build/`, validates required assets and manifest references, and only then replaces `extension/dist/`.
- Verified the generated extension in Chromium: service worker starts, popup loads, and no page or console errors occur.
- Excluded `.model-cache/` and `server/storage/` from Git and removed them from the Git index without deleting local files.
- Documented the Qwen3 INT8/Q4F16 runtime findings.

### Verification results

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm test` | Pass |
| Chromium extension load | Service worker + popup load; no page/console errors |

Generated extension contents:

```text
extension/dist/
├── BUILD.txt
├── background.js
├── content.js
├── manifest.json
├── popup.css
├── popup.html
├── popup.js
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

## Phase 2 — Local data integration (complete)

Completed in this phase:

- Added a versioned IndexedDB schema with an explicit local `vaults` record.
- Added local repositories for vaults, documents, document files, profile values, addresses, education, employment, skills, certifications, projects, collections, collection-document relationships, activity, form history, settings, and processing jobs.
- Added local application services for vaults, documents, profile records, collections, history, activity, dashboard metrics, and settings.
- Added local document blob storage and SHA-256 checksum-based duplicate detection.
- Connected the dashboard, document vault, personal profile, addresses, education, employment, skills, collections, history, and settings to local data.
- Added a local vault setup page and a vault migration page.
- Added a one-time legacy backend migration path that reads existing SQLite-backed data and imports it into IndexedDB.
- Added an origin-portable local vault export/import mechanism.
- Added local database, document storage, and migration tests.
- Removed backend API calls from migrated dashboard features.

### Verification results

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run build:extension` | Pass |
| `npm run test:extension` | 12/12 pass |
| `npm run test:server` | 12/12 pass |
| `npm run test:local` | 9/9 pass |
| `npm test` | Pass |
| Chromium UI verification | Vault creation, PDF upload, profile value, skills persistence, collection creation, refresh persistence, browser restart, collection deletion, document deletion all pass |
| Backend-offline verification | Dashboard and documents continue working after `server/index.mjs` is stopped |
| Real legacy backend migration | 1 document, 3 values, 1 collection, and 1 history entry imported from a temporary SQLite-backed backend; repeated migration is idempotent |

### Origin strategy

- IndexedDB is origin-scoped. The current dashboard uses the Vite origin; the future extension dashboard will use `chrome-extension://<extension-id>`.
- The local database is accessed through `core/database/*` repositories and `core/application/*` services, not directly from React components.
- `core/storage/vault-export.ts` can export the local vault to a portable JSON file and import it into another origin.
- The extension-owned dashboard is still future work. Local data does **not** automatically transfer between origins.

## Model runtime status

- Repository: `onnx-community/Qwen3-0.6B-Instruct-ONNX`
- Pinned revision: `54250909aca286a05b9d013c8af7a21859ee6ead`
- Licence: Apache-2.0
- Verified CPU candidate: **INT8 / Q8** (`onnx/model_quantized.onnx`, 753,999,618 bytes).
- Q8 Node inference was verified against real ONNX weights: cached load 2.66 s, 675 ms for an 80-token generation, valid JSON output.
- Q4F16 CPU loading fails with a float16 graph type mismatch:

  ```text
  Type (tensor(float16)) of output arg
  (/model/layers.0/input_layernorm/Cast_output_0)
  does not match expected type (tensor(float)).
  ```

- Q4F16 must not be selected for CPU/WASM execution unless a successful compatibility test is added. The current `preferredVariant()` helper can select Q4F16 when WebGPU is available, but it is not wired into the product and has no verified browser/WebGPU test yet.
- Node inference does **not** prove browser or extension inference works. No model worker or offscreen runtime exists yet.
- The repository’s tokenizer config does not contain the chat template. `chat_template.jinja` must be loaded and assigned manually before chat prompting.

## Git cache status

- `.model-cache/` is now ignored and removed from the Git index.
- Local model files were preserved for testing (approximately 1.3 GB).
- `server/storage/` is now ignored and removed from the Git index; local user documents were preserved.
- Checkpoint commit `9f9632f` still contains the model blobs in Git history. Removing history requires a backup and explicit authorization before using a history-rewriting tool such as `git filter-repo`. No history was rewritten.

## Remaining work

### Phase 2 — Local data integration

Completed. IndexedDB repositories and services are wired into the dashboard. Local document storage, profile values, addresses, education, employment, skills, collections, history, activity, and dashboard metrics all use local data.

### Phase 3 — Extension-owned dashboard and AI runtime

- Build the dashboard into the extension.
- Vault setup and unlock UI.
- Local AI runtime and Qwen3 worker.
- Model download, progress, integrity verification, and installation UI.
- WebGPU and WASM execution.
- Offline inference verification.

### Phase 4 — Document ingestion

- Phase 4.1 local PDF, DOCX, and TXT ingestion is complete.
- Phase 4.1.2 local English OCR for scanned/image-only PDF pages is complete; additional languages require new verified language assets.
- Intelligent field extraction and source attribution remain future work.

### Phase 5 — Form intelligence

- Deterministic field matching against the local vault.
- Semantic matching with Qwen3.
- Contextual answer generation.
- Review and approval workflow.

### Phase 6 — Security and cloud removal

- Encrypt the existing vault data through the new crypto layer.
- Backup and restore.
- Remove Google Drive.
- Remove Gemini and OpenAI-compatible providers.
- Remove demo data and mock execution paths.
- Full offline verification and security testing.

## Known limitations after Phase 2

- The dashboard still has non-migrated surfaces that use the backend: authentication, Google Drive connections, and some onboarding/extension screens.
- Google Drive, Gemini, and OpenAI-compatible code remain.
- No extension-owned dashboard exists.
- No local AI inference runs in the extension.
- At that time, no document text extraction, OCR, or AI-based extraction ran in the dashboard.
- Document processing was intentionally limited to local storage and metadata in that phase.
- At that time, no OCR or PDF assets were packaged in the extension; Phase 4.1.2 now packages SHA-256-verified OCR assets.
- `extension/src/workers/ocr.worker.ts` is not built because it is not referenced by the extension; OCR uses the offscreen OCR runtime instead.
- No encrypted backup/restore exists.
- IndexedDB data is not encrypted in this phase.
- Existing user data remains in the old backend storage until a user runs the migration wizard.
