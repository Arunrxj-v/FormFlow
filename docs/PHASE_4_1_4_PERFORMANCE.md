# Phase 4.1.4.2 DOCX pagination fidelity and image performance

Generated: 2026-11-17T14:57:44.187Z

Environment: Apple Silicon macOS, Chromium launched by Playwright, dedicated module worker, packaged Carlito/Liberation fonts and HarfBuzz WASM served locally.

## Bundle and asset size

| Asset | Size |
| --- | ---: |
| Extension dist (106 files) | 23.53 MB |
| Parser worker bundle | 4.57 MB |
| Offscreen document bundle | 1.68 MB |
| Background service worker bundle | 0.23 MB |
| HarfBuzz WASM | 434 KB |
| Packaged TTF faces | 5.63 MB |
| Font/WASM directory total | 6.13 MB |

## Layout runtime

| Case | Worker startup | Cold parse | Font resolution | Renderer layout | Geometry/image mapping | Total pagination | Warm total | Pages | Mapped blocks | Fragment entries | Browser RSS baseline | Browser RSS peak | RSS delta | Serialized pagination |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| paragraphs-120 | 99 ms | 50 ms | 78 ms | 65 ms | 3 ms | 146 ms | 46 ms | 3 | 120 | 0 | 951.6 MB | 1002.9 MB | 51.3 MB | 35 KB |
| paragraphs-500 | 74 ms | 65 ms | 92 ms | 116 ms | 6 ms | 215 ms | — | 11 | 500 | 0 | 1017.6 MB | 1019.0 MB | 1.4 MB | 144 KB |
| paragraphs-1000 | 64 ms | 85 ms | 124 ms | 184 ms | 13 ms | 322 ms | — | 21 | 1000 | 0 | 1014.0 MB | 1018.0 MB | 4.0 MB | 288 KB |
| paragraphs-1200 | 65 ms | 95 ms | 123 ms | 205 ms | 18 ms | 347 ms | — | 25 | 1200 | 0 | 983.9 MB | 985.5 MB | 1.5 MB | 346 KB |
| paragraphs-5000 | 64 ms | 328 ms | 319 ms | 625 ms | 204 ms | 1150 ms | — | 105 | 5000 | 0 | 978.9 MB | 1123.4 MB | 144.5 MB | 765 KB |
| table-500-rows | 64 ms | 101 ms | 156 ms | 225 ms | 20 ms | 402 ms | — | 10 | 2002 | 10 | 1108.1 MB | 1128.5 MB | 20.4 MB | 734 KB |
| mixed-fonts-500 | 68 ms | 62 ms | 84 ms | 116 ms | 6 ms | 206 ms | — | 11 | 500 | 0 | 1119.1 MB | 1124.6 MB | 5.5 MB | 146 KB |
| mixed-fonts-5000 | 65 ms | 457 ms | 485 ms | 648 ms | 216 ms | 1350 ms | — | 132 | 5000 | 0 | 1121.3 MB | 1156.3 MB | 35.0 MB | 773 KB |
| nested-table-500-rows | 66 ms | 124 ms | 295 ms | 317 ms | 12 ms | 626 ms | — | 18 | 1501 | 18 | 1134.4 MB | 1193.9 MB | 59.5 MB | 629 KB |
| images-200 | 66 ms | 108 ms | 77 ms | 101 ms | 3 ms | 183 ms | — | 40 | 200 | 0 | 1136.8 MB | 1143.8 MB | 7.0 MB | 61 KB |
| header-footer-inherited-500 | 64 ms | 107 ms | 81 ms | 133 ms | 6 ms | 221 ms | — | 15 | 503 | 0 | 1141.8 MB | 1145.8 MB | 4.0 MB | 149 KB |
| cancel-paragraphs-1200 | 66 ms | — | — | — | — | — | — | — | — | — | 1143.1 MB | 1144.8 MB | 1.8 MB | — |

## Image placement metadata

| Case | Image blocks | Physical-page appearances | Image metadata | Total structure |
| --- | ---: | ---: | ---: | ---: |
| images-200 | 200 | 200 | 138.3 KB | 148 KB |
| header-footer-inherited-500 | 2 | 30 | 5.6 KB | 112 KB |

Inherited header/footer images remain one source block per part; only their `appearances` array grows with the page count. Image bytes are never included in `DocumentStructure`.

## Cancellation

- Cancellation was issued 5 ms after layout started on the 1,200-paragraph document.
- Result: CANCELLED.
- No pagination result was returned for the cancelled run.

## Notes

- Times include only parsing and pagination in the worker, not encryption or IndexedDB storage.
- “Font resolution” includes packaged/embedded font admission and the local hash-verified normalized-metric configuration. “Renderer layout” is the renderer page pass. “Geometry/image mapping” includes line/cell/column/image/font-report mapping.
- Table normalization runs before the renderer when the parsed structure contains tables. It is layout-only, bounded, and not persisted; timings include its unzip/patch/zip cost inside the pagination total.
- Image metadata includes table-cell parents, nested depth, captions, header/footer source/inheritance, and physical-page appearances. Image bytes are never included.
- RSS is the sum of the Chromium browser process tree sampled every 25 ms; baseline is measured after the worker is ready and before the document is sent. It includes worker, renderer, GPU, and browser overhead, so the delta is a directional whole-process cost, not an isolated heap number.
- Detailed line/cell geometry is bounded by a 300,000-character budget. The 5,000-paragraph case retains all 5,000 top-level page mappings but truncates detailed line geometry.
- The warm run reuses the worker and the engine’s process-wide shaping caches.
- The parser worker bundle contains the full DOCX parser, Mammoth, PDF.js and OCR imports already present before this phase; the font-backed layout engine adds the renderer and HarfBuzz code.

