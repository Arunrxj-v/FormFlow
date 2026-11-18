# Phase 4.1.4.2 DOCX pagination fidelity and image validation

Generated: 2026-11-18T08:41:32.261Z

Method: each fixture is converted to PDF by a locally installed LibreOffice (`soffice --headless --convert-to pdf`). The same DOCX is imported through the production extension in Chromium, and the renderer-derived pagination, font evidence, image blocks, line/cell boxes, and column geometry are read back from encrypted extraction. Reference page text is extracted with `pdfjs-dist`, and each top-level block is matched by normalized first/last text segments to estimate start/end page mapping. When `WORD_REFERENCE_DIR` is supplied, Word-exported PDFs are read through the same comparison path; no Word reference was supplied for this generated report unless the section below says otherwise.

Reference application: LibreOffice; version: detected via soffice --version.
Reference renderer: LibreOffice 26.8.3.1 861effc5289d539f15c4c18d1ba8579ffd78728b
FormFlow renderer: @docx-editor.dev/core 2.38.0 with packaged Carlito/Liberation fonts and HarfBuzz.
Reference mode: libreoffice; verified_physical: false (renderer_derived_physical only).

| Fixture | Features | Reference pages | FormFlow pages | Diff | Compared blocks | Exact mapping | Start page | End page | Orientation match |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| normal-overflow | automatic paragraph overflow; Calibri 11; Letter 1in margins | 3 | 3 | 0 | 120 | 100% (120/120) | 100% | 100% | 3/3 |
| explicit-breaks | explicit page breaks; pageBreakBefore | 3 | 3 | 0 | 23 | 100% (23/23) | 100% | 100% | 3/3 |
| section-breaks | three next-page sections; section page setup | 3 | 3 | 0 | 30 | 100% (30/30) | 100% | 100% | 3/3 |
| portrait-landscape | portrait and landscape sections; page orientation transitions | 3 | 3 | 0 | 36 | 100% (36/36) | 100% | 100% | 3/3 |
| page-size-margins | Letter and A4 page sizes; different margins | 5 | 5 | 0 | 120 | 100% (120/120) | 100% | 100% | 5/5 |
| long-table | table spanning pages; table row pagination | 2 | 2 | 0 | 3 | 100% (3/3) | 100% | 100% | 2/2 |
| table-header-repeat | repeating table header rows; table pagination | 3 | 3 | 0 | 2 | 100% (2/2) | 100% | 100% | 3/3 |
| merged-cells | merged cells; gridSpan; vertical merge; table pagination | 2 | 2 | 0 | 2 | 100% (2/2) | 100% | 100% | 2/2 |
| keep-with-next | keep-with-next; keep-lines-together | 3 | 3 | 0 | 108 | 100% (108/108) | 100% | 100% | 3/3 |
| widow-orphan | widow/orphan controls; long paragraphs | 4 | 4 | 0 | 40 | 100% (40/40) | 100% | 100% | 4/4 |
| headers-footers | first-page header/footer; even/odd headers; linked-to-previous inheritance; page numbering | 3 | 3 | 0 | 110 | 100% (110/110) | 100% | 100% | 3/3 |
| images-captions | inline images; captions; image pagination | 2 | 2 | 0 | 6 | 100% (6/6) | 100% | 100% | 2/2 |
| mixed-fonts | Calibri, Arial, Times New Roman; mixed font sizes | 3 | 3 | 0 | 60 | 100% (60/60) | 100% | 100% | 3/3 |
| columns | two-column layout; section columns | 3 | 3 | 0 | 100 | 100% (100/100) | 100% | 100% | 3/3 |
| columns-complex | unequal columns; three columns; explicit column break; section column transitions | 5 | 5 | 0 | 111 | 100% (111/111) | 100% | 100% | 5/5 |
| nested-tables | nested tables; table pagination | 2 | 2 | 0 | 3 | 100% (3/3) | 100% | 100% | 2/2 |
| embedded-fonts | embedded regular font; theme font declarations; exact embedded face | 1 | 1 | 0 | 40 | 100% (40/40) | 100% | 100% | 1/1 |
| font-substitution | missing exact font; deterministic fallback; theme declarations | 1 | 1 | 0 | 40 | 100% (40/40) | 100% | 100% | 1/1 |
| corrupt-embedded-font | malformed embedded font; bounded font rejection; fallback | 1 | 1 | 0 | 40 | 100% (40/40) | 100% | 100% | 1/1 |
| multi-font-paragraph | multiple font families inside one paragraph; mixed sizes | 2 | 2 | 0 | 40 | 100% (40/40) | 100% | 100% | 2/2 |
| table-images | images in table cells; image in nested table; table-cell captions | 1 | 1 | 0 | 3 | 100% (3/3) | 100% | 100% | 1/1 |
| header-footer-images | header image; footer image; inherited header/footer across pages | 3 | 3 | 0 | 80 | 89% (71/80) | 89% | 89% | 3/3 |

Summary: 22 fixture(s); 22/22 exact page counts; reference pages 58, FormFlow pages 58; 1108/1117 comparable top-level block ranges exact.

## Microsoft Word reference comparison

No Microsoft Word reference PDFs were supplied. The harness accepts `WORD_REFERENCE_DIR` containing one PDF per fixture (`<fixture>.pdf`); see `docs/PHASE_4_1_4_1_WORD_REFERENCE.md` for the manual Word export procedure. No Microsoft Word compatibility is claimed.

## Per-fixture notes
### normal-overflow

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 3, FormFlow 3, difference 0.
- Block mapping: 120/120 exact start/end ranges; start 120/120; end 120/120.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 120 line record(s), 0 cell record(s), 3 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0, 3→0.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### explicit-breaks

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 3, FormFlow 3, difference 0.
- Block mapping: 23/23 exact start/end ranges; start 23/23; end 23/23.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 23 line record(s), 0 cell record(s), 3 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0, 3→0.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### section-breaks

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 3, FormFlow 3, difference 0.
- Block mapping: 30/30 exact start/end ranges; start 30/30; end 30/30.
- DOCX section metadata: 3 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 30 line record(s), 0 cell record(s), 3 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→1, 3→2.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### portrait-landscape

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 3, FormFlow 3, difference 0.
- Block mapping: 36/36 exact start/end ranges; start 36/36; end 36/36.
- DOCX section metadata: 3 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 36 line record(s), 0 cell record(s), 3 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt, 648pt, 451pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→1, 3→2.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### page-size-margins

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 5, FormFlow 5, difference 0.
- Block mapping: 120/120 exact start/end ranges; start 120/120; end 120/120.
- DOCX section metadata: 2 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 180 line record(s), 0 cell record(s), 5 column box(es), truncated false.
- Column geometry: column counts 1; widths 307pt, 540pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0, 3→0, 4→1, 5→1.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### long-table

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 2, FormFlow 2, difference 0.
- Block mapping: 3/3 exact start/end ranges; start 3/3; end 3/3.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 2 line record(s), 180 cell record(s), 2 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_TABLE_WIDTHS_NORMALIZED, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_TABLE_WIDTHS_NORMALIZED, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### table-header-repeat

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 3, FormFlow 3, difference 0.
- Block mapping: 2/2 exact start/end ranges; start 2/2; end 2/2.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 1 line record(s), 279 cell record(s), 3 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0, 3→0.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_TABLE_WIDTHS_NORMALIZED, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_TABLE_WIDTHS_NORMALIZED, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### merged-cells

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 2, FormFlow 2, difference 0.
- Block mapping: 2/2 exact start/end ranges; start 2/2; end 2/2.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 1 line record(s), 157 cell record(s), 2 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_TABLE_WIDTHS_NORMALIZED, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_MERGED_CELLS_RECONSTRUCTED, DOCX_RENDERER_DERIVED_PAGINATION, DOCX_TABLE_WIDTHS_NORMALIZED, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### keep-with-next

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 3, FormFlow 3, difference 0.
- Block mapping: 108/108 exact start/end ranges; start 108/108; end 108/108.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 108 line record(s), 0 cell record(s), 3 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0, 3→0.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### widow-orphan

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 4, FormFlow 4, difference 0.
- Block mapping: 40/40 exact start/end ranges; start 40/40; end 40/40.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 160 line record(s), 0 cell record(s), 4 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0, 3→0, 4→0.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### headers-footers

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 3, FormFlow 3, difference 0.
- Block mapping: 110/110 exact start/end ranges; start 110/110; end 110/110.
- DOCX section metadata: 2 section(s), 6 header reference(s), 2 inherited header reference(s), 3 inherited footer reference(s), even/odd enabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 110 line record(s), 0 cell record(s), 3 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0, 3→1.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_HEADERS_FOOTERS_SECTION_AWARE, DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### images-captions

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 2, FormFlow 2, difference 0.
- Block mapping: 6/6 exact start/end ranges; start 6/6; end 6/6.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 6 block(s), 6 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 6 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 6 line record(s), 0 cell record(s), 2 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_IMAGES_WITH_WARNINGS, DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### mixed-fonts

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 3, FormFlow 3, difference 0.
- Block mapping: 60/60 exact start/end ranges; start 60/60; end 60/60.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute, metric_substitute, metric_substitute.
- Geometry: 90 line record(s), 0 cell record(s), 3 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0, 3→0.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### columns

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 3, FormFlow 3, difference 0.
- Block mapping: 100/100 exact start/end ranges; start 100/100; end 100/100.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 200 line record(s), 0 cell record(s), 6 column box(es), truncated false.
- Column geometry: column counts 2; widths 216pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0, 3→0.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### columns-complex

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 5, FormFlow 5, difference 0.
- Block mapping: 111/111 exact start/end ranges; start 111/111; end 111/111.
- DOCX section metadata: 4 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 275 line record(s), 0 cell record(s), 10 column box(es), truncated false.
- Column geometry: column counts 1, 2, 3; widths 468pt, 120pt, 240pt, 132pt.
- Explicit column breaks recorded: 1.
- Page-to-section mapping: 1→0, 2→1, 3→2, 4→2, 5→3.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### nested-tables

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 2, FormFlow 2, difference 0.
- Block mapping: 3/3 exact start/end ranges; start 3/3; end 3/3.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 2 line record(s), 38 cell record(s), 2 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_TABLE_WIDTHS_NORMALIZED, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_NESTED_TABLES, DOCX_RENDERER_DERIVED_PAGINATION, DOCX_TABLE_WIDTHS_NORMALIZED, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### embedded-fonts

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 1, FormFlow 1, difference 0.
- Block mapping: 40/40 exact start/end ranges; start 40/40; end 40/40.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 1; font sources: embedded, metric_substitute.
- Geometry: 40 line record(s), 0 cell record(s), 1 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0.
- Theme fonts: major Calibri Light, minor FormFlow Embedded Test.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### font-substitution

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 1, FormFlow 1, difference 0.
- Block mapping: 40/40 exact start/end ranges; start 40/40; end 40/40.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: unavailable, metric_substitute.
- Geometry: 40 line record(s), 0 cell record(s), 1 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0.
- Theme fonts: major Calibri Light, minor FormFlow Embedded Test.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### corrupt-embedded-font

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 1, FormFlow 1, difference 0.
- Block mapping: 40/40 exact start/end ranges; start 40/40; end 40/40.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 1; font sources: unavailable, metric_substitute.
- Geometry: 40 line record(s), 0 cell record(s), 1 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0.
- Theme fonts: major Calibri Light, minor FormFlow Embedded Test.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED, DOCX_EMBEDDED_FONT_UNAVAILABLE
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED, DOCX_EMBEDDED_FONT_UNAVAILABLE

### multi-font-paragraph

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 2, FormFlow 2, difference 0.
- Block mapping: 40/40 exact start/end ranges; start 40/40; end 40/40.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 0 block(s), 0 page-mapped; 0 table cell placement(s), 0 header/footer placement(s), 0 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute, metric_substitute, metric_substitute.
- Geometry: 40 line record(s), 0 cell record(s), 2 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### table-images

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 1, FormFlow 1, difference 0.
- Block mapping: 3/3 exact start/end ranges; start 3/3; end 3/3.
- DOCX section metadata: 1 section(s), 0 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 3 block(s), 3 page-mapped; 3 table cell placement(s), 0 header/footer placement(s), 3 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 2 line record(s), 2 cell record(s), 1 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_TABLE_WIDTHS_NORMALIZED, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_NESTED_TABLES, DOCX_RENDERER_DERIVED_PAGINATION, DOCX_TABLE_WIDTHS_NORMALIZED, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

### header-footer-images

- Status: `renderer_derived_physical` / `local_renderer`
- Page count: reference 3, FormFlow 3, difference 0.
- Block mapping: 71/80 exact start/end ranges; start 71/80; end 71/80.
- DOCX section metadata: 1 section(s), 1 header reference(s), 0 inherited header reference(s), 0 inherited footer reference(s), even/odd disabled.
- Structured images: 2 block(s), 2 page-mapped; 0 table cell placement(s), 2 header/footer placement(s), 6 physical-page appearance(s); embedded font declarations: 0; font sources: metric_substitute.
- Geometry: 80 line record(s), 0 cell record(s), 3 column box(es), truncated false.
- Column geometry: column counts 1; widths 468pt.
- Explicit column breaks recorded: 0.
- Page-to-section mapping: 1→0, 2→0, 3→0.
- Mapping mismatches (first 12):
  - `p1_b35` paragraph mapped 2-2, reference 1-1: Header/footer image body paragraph 33 with deterministic text.
  - `p1_b36` paragraph mapped 2-2, reference 1-1: Header/footer image body paragraph 34 with deterministic text.
  - `p1_b37` paragraph mapped 2-2, reference 1-1: Header/footer image body paragraph 35 with deterministic text.
  - `p1_b67` paragraph mapped 3-3, reference 2-2: Header/footer image body paragraph 65 with deterministic text.
  - `p1_b68` paragraph mapped 3-3, reference 2-2: Header/footer image body paragraph 66 with deterministic text.
  - `p1_b69` paragraph mapped 3-3, reference 2-2: Header/footer image body paragraph 67 with deterministic text.
  - `p1_b70` paragraph mapped 3-3, reference 2-2: Header/footer image body paragraph 68 with deterministic text.
  - `p1_b71` paragraph mapped 3-3, reference 2-2: Header/footer image body paragraph 69 with deterministic text.
  - `p1_b72` paragraph mapped 3-3, reference 2-2: Header/footer image body paragraph 70 with deterministic text.
- Pagination warnings: DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED
- Structure warnings: DOCX_IMAGES_WITH_WARNINGS, DOCX_HEADERS_FOOTERS_SECTION_AWARE, DOCX_RENDERER_DERIVED_PAGINATION, DOCX_PAGINATION_FONT_SUBSTITUTION, DOCX_FONT_VERTICAL_METRICS_NORMALIZED

## Interpretation

- These are reference-rendered comparisons, not synthetic expected page counts.
- A zero page-count difference does not by itself prove exact physical pagination; mapping rates and mismatches are reported separately.
- LibreOffice is not Microsoft Word. Fonts, default styles, and unsupported OOXML features can produce legitimate reference differences.
- If Word PDFs are supplied, they are read through the same harness; otherwise Word compatibility remains unvalidated and must not be claimed.
- No fixture is marked `verified_physical`. Renderer-derived output is reported as `renderer_derived_physical`.

