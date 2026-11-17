import type { ReactNode } from 'react';
import { FileText, Image as ImageIcon, List, Table2 } from 'lucide-react';
import type {
  DocumentExtractionProvenance,
  DocumentStructure,
  DocumentStructureBlock,
  DocumentStructurePage,
  DocumentStructureTable,
} from '@/services/types';

const MAX_DISPLAY_BLOCKS = 240;

const PROVENANCE_LABELS: Record<DocumentExtractionProvenance, string> = {
  pdf_native: 'PDF text',
  docx_xml: 'DOCX XML',
  ocr: 'Local OCR',
  mixed: 'Mixed sources',
  inferred_from_layout: 'Layout inference',
  txt_native: 'Plain text',
};

function pageLabel(page: DocumentStructurePage | undefined, pageNumber: number): string {
  return page?.pageKind === 'logical' ? `Logical page ${pageNumber}` : `Page ${pageNumber}`;
}

function provenanceBadge(block: DocumentStructureBlock) {
  return (
    <span className="ff-tag" style={{ fontSize: 9 }}>
      {PROVENANCE_LABELS[block.provenance]}{block.layoutInferred ? ' · layout' : ''}
    </span>
  );
}

function blockText(block: DocumentStructureBlock) {
  return block.text?.trim() ? block.text : '—';
}

function tableRows(
  tableBlock: DocumentStructureBlock,
  byId: Map<string, DocumentStructureBlock>,
  table: DocumentStructureTable | undefined,
): DocumentStructureBlock[][] {
  const rows = (tableBlock.children ?? [])
    .map((rowId) => byId.get(rowId))
    .filter((row): row is DocumentStructureBlock => Boolean(row && row.type === 'table_row'));
  if (rows.length) return rows.map((row) => (row.children ?? []).map((cellId) => byId.get(cellId)).filter((cell): cell is DocumentStructureBlock => Boolean(cell)));
  return table ? table.rowBlockIds.map((rowId) => {
    const row = byId.get(rowId);
    return (row?.children ?? []).map((cellId) => byId.get(cellId)).filter((cell): cell is DocumentStructureBlock => Boolean(cell));
  }) : [];
}

function renderTable(
  block: DocumentStructureBlock,
  byId: Map<string, DocumentStructureBlock>,
  tables: Map<string, DocumentStructureTable>,
) {
  const rows = tableRows(block, byId, block.tableId ? tables.get(block.tableId) : undefined);
  if (!rows.length) return <div className="ff-note">Table cells were not preserved separately in this result.</div>;
  const columnCount = Math.max(...rows.map((row) => row.reduce((sum, cell) => sum + (cell.columnSpan ?? 1), 0)), 1);
  return (
    <div style={{ overflowX: 'auto', marginTop: 4 }}>
      <table className="ff-table" style={{ minWidth: Math.min(680, Math.max(320, columnCount * 120)) }}>
        <tbody>
          {rows.map((row, rowIndex) => {
            let column = 0;
            const cells: ReactNode[] = [];
            for (const cell of row) {
              if (cell.columnIndex !== undefined && cell.columnIndex > column) {
                cells.push(<td key={`gap-${rowIndex}-${column}`} aria-hidden="true" />);
                column = cell.columnIndex;
              }
              const cellImages = (cell.children ?? [])
                .map((childId) => byId.get(childId))
                .filter((child): child is DocumentStructureBlock => Boolean(child && child.type === 'image' && child.image));
              cells.push(
                <td key={cell.blockId} rowSpan={cell.rowSpan} colSpan={cell.columnSpan}>
                  <div className="ff-body-sm" style={{ whiteSpace: 'pre-wrap' }}>{cell.text || (cellImages.length ? '' : '—')}</div>
                  {cellImages.length ? (
                    <div className="ff-code ff-muted" style={{ fontSize: 9 }}>
                      Table cell · row {(cellImages[0]!.image?.rowIndex ?? 0) + 1}, column {(cellImages[0]!.image?.columnIndex ?? 0) + 1}
                    </div>
                  ) : null}
                  {cellImages.map((imageBlock) => (
                    <div key={imageBlock.blockId} className="ff-row ff-gap-4" style={{ alignItems: 'center', marginTop: 3 }} title={imageBlock.image?.alternativeText}>
                      <ImageIcon size={11} className="ff-primary" />
                      <span className="ff-code ff-muted" style={{ fontSize: 9 }}>
                        {Math.round(imageBlock.image?.displayWidthPt ?? 0)}×{Math.round(imageBlock.image?.displayHeightPt ?? 0)} pt
                        {imageBlock.image?.appearances?.length
                          ? ` · page${imageBlock.image.appearances.length === 1 ? '' : 's'} ${imageBlock.image.appearances[0]!.pageNumber}${imageBlock.image.appearances.length > 1 ? `–${imageBlock.image.appearances[imageBlock.image.appearances.length - 1]!.pageNumber}` : ''}`
                          : ''}
                      </span>
                      {imageBlock.image?.alternativeText
                        ? <span className="ff-body-sm ff-muted">{imageBlock.image.alternativeText}</span>
                        : null}
                      {imageBlock.image?.nestedTableDepth
                        ? <span className="ff-tag" style={{ fontSize: 8 }}>nested</span>
                        : null}
                    </div>
                  ))}
                </td>,
              );
              column += cell.columnSpan ?? 1;
            }
            return <tr key={`row-${rowIndex}`}>{cells}</tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}

function renderBlocks(structure: DocumentStructure) {
  const byId = new Map(structure.blocks.map((block) => [block.blockId, block]));
  const tables = new Map(structure.tables.map((table) => [table.tableId, table]));
  const pages = new Map(structure.pages.map((page) => [page.pageId, page]));
  const paginationPages = new Map((structure.pagination?.blockPages ?? []).map((entry) => [entry.blockId, entry]));
  const order = structure.readingOrder.length
    ? structure.readingOrder
    : structure.pages.flatMap((page) => page.blockIds);
  const output: ReactNode[] = [];
  let count = 0;
  for (const blockId of order) {
    if (count >= MAX_DISPLAY_BLOCKS) break;
    const block = byId.get(blockId);
    if (!block) continue;
    count += 1;
    const page = pages.get(block.pageId);
    const paginationPage = paginationPages.get(block.blockId);
    const lineColumns = [...new Set((paginationPage?.lines ?? [])
      .map((line) => line.columnIndex)
      .filter((column): column is number => column !== undefined))];
    const geometryBits = [
      paginationPage?.lines?.length ? `${paginationPage.lines.length} lines` : null,
      paginationPage?.tableRows?.length ? `${paginationPage.tableRows.length} rows · ${paginationPage.tableRows.reduce((count, row) => count + (row.cells?.length ?? 0), 0)} cells` : null,
      lineColumns.length ? `Columns ${lineColumns.join(', ')}` : null,
      paginationPage?.columnIndex !== undefined ? `Column ${paginationPage.columnIndex}` : null,
      paginationPage?.geometryConfidence ? `geometry ${paginationPage.geometryConfidence}` : null,
      block.columnBreakAfter ? 'column break after' : null,
    ].filter(Boolean);
    const physicalPagination = structure.pagination?.status === 'renderer_derived_physical'
      || structure.pagination?.status === 'verified_physical';
    const paginationLabel = paginationPage
      ? physicalPagination
        ? `Physical page${paginationPage.endPageNumber && paginationPage.endPageNumber !== paginationPage.startPageNumber ? `s ${paginationPage.startPageNumber}–${paginationPage.endPageNumber}` : ` ${paginationPage.startPageNumber}`}${paginationPage.approximate ? ' · approximate' : ''}${paginationPage.fragmentPages && paginationPage.fragmentPages.length > 1 ? ` · ${paginationPage.fragmentPages.length} fragments` : ''}`
        : `${structure.pagination?.status === 'renderer_reported_breaks' ? 'Reported page' : 'Break-derived page'} ${paginationPage.startPageNumber}${paginationPage.endPageNumber && paginationPage.endPageNumber !== paginationPage.startPageNumber ? `–${paginationPage.endPageNumber}` : ''}`
      : pageLabel(page, block.pageNumber);
    const meta = (
      <div className="ff-row ff-gap-4" style={{ flexWrap: 'wrap', marginTop: 3 }}>
        <span className="ff-code ff-muted" style={{ fontSize: 9 }}>
          {paginationLabel}
        </span>
        {provenanceBadge(block)}
        {geometryBits.length ? (
          <span className="ff-code ff-muted" style={{ fontSize: 9 }}>{geometryBits.join(' · ')}</span>
        ) : null}
        {typeof block.confidence === 'number' ? (
          <span className="ff-code ff-muted" style={{ fontSize: 9 }}>{Math.round(block.confidence)}% OCR confidence</span>
        ) : null}
        {block.sourceRef ? <span className="ff-code ff-muted" style={{ fontSize: 9 }}>{block.sourceRef}</span> : null}
      </div>
    );

    if (block.type === 'heading') {
      output.push(
        <div key={block.blockId} style={{ marginTop: 10, paddingLeft: Math.max(0, (block.level ?? 1) - 1) * 12 }}>
          <div className="ff-label" style={{ fontSize: block.level === 1 ? 14 : block.level === 2 ? 12.5 : 11.5, fontWeight: 700 }}>
            {block.text || 'Untitled heading'}
          </div>
          {meta}
        </div>,
      );
      continue;
    }

    if (block.type === 'list') {
      const items = (block.children ?? [])
        .map((childId) => byId.get(childId))
        .filter((item): item is DocumentStructureBlock => Boolean(item && item.type === 'list_item'));
      output.push(
        <div key={block.blockId} style={{ marginTop: 8 }}>
          <div className="ff-row ff-gap-6" style={{ alignItems: 'center' }}>
            <List size={13} className="ff-primary" />
            <span className="ff-label">List · {items.length} item{items.length === 1 ? '' : 's'}</span>
          </div>
          <div className="ff-stack ff-gap-2" style={{ marginTop: 3 }}>
            {items.map((item) => (
              <div key={item.blockId} style={{ paddingLeft: Math.max(0, (item.level ?? 1) - 1) * 14 }}>
                <span className="ff-body-sm">
                  <span className="ff-code" style={{ marginRight: 6 }}>{item.listMarker ?? '•'}</span>
                  {item.text}
                </span>
              </div>
            ))}
          </div>
          {meta}
        </div>,
      );
      continue;
    }

    if (block.type === 'table') {
      output.push(
        <div key={block.blockId} style={{ marginTop: 10 }}>
          <div className="ff-row ff-gap-6" style={{ alignItems: 'center' }}>
            <Table2 size={13} className="ff-primary" />
            <span className="ff-label">Table</span>
          </div>
          {renderTable(block, byId, tables)}
          {block.warnings?.map((warning) => (
            <div key={`${warning.code}-${warning.message}`} className="ff-body-sm" style={{ color: 'var(--ff-warning, #92400e)', marginTop: 3 }}>
              {warning.message}
            </div>
          ))}
          {meta}
        </div>,
      );
      continue;
    }

    if (block.type === 'image' && block.image) {
      const image = block.image;
      const details = [
        image.mimeType,
        image.originalWidthPx && image.originalHeightPx ? `${image.originalWidthPx}×${image.originalHeightPx} px` : null,
        `${Math.round(image.displayWidthPt)}×${Math.round(image.displayHeightPt)} pt`,
        image.positioning,
        image.wrap,
        image.mediaPart,
      ].filter(Boolean).join(' · ');
      output.push(
        <div key={block.blockId} style={{ marginTop: 7, padding: '6px 8px', border: '1px solid var(--ff-border)', borderRadius: 6 }}>
          <div className="ff-row ff-gap-6" style={{ alignItems: 'center' }}>
            <ImageIcon size={13} className="ff-primary" />
            <span className="ff-label">Image</span>
          </div>
          <div className="ff-code ff-muted" style={{ fontSize: 9, marginTop: 2 }}>{details}</div>
          {image.headerFooter ? (
            <div className="ff-body-sm ff-muted">
              {image.headerFooter.kind === 'header' ? 'Header' : 'Footer'} · {image.headerFooter.variant} variant · defined by section {image.headerFooter.definingSectionIndex}
              {image.headerFooter.inheritedSectionIndexes?.length
                ? ` · inherited by section${image.headerFooter.inheritedSectionIndexes.length === 1 ? '' : 's'} ${image.headerFooter.inheritedSectionIndexes.join(', ')}`
                : ''}
              {' · '}{image.headerFooter.partName}
            </div>
          ) : null}
          {image.parentCellBlockId ? (
            <div className="ff-body-sm ff-muted">
              Table cell · row {(image.rowIndex ?? 0) + 1}, column {(image.columnIndex ?? 0) + 1}
              {image.nestedTableDepth ? ` · nested table depth ${image.nestedTableDepth}` : ''}
            </div>
          ) : null}
          {image.appearances?.length ? (
            <div className="ff-body-sm ff-muted">
              {image.appearances.length === 1
                ? `Physical page ${image.appearances[0]!.pageNumber}`
                : `Physical pages ${image.appearances[0]!.pageNumber}–${image.appearances[image.appearances.length - 1]!.pageNumber} · ${image.appearances.length} appearances`}
            </div>
          ) : null}
          {image.alternativeText ? <div className="ff-body-sm">Alt: {image.alternativeText}</div> : <div className="ff-body-sm" style={{ color: 'var(--ff-warning, #92400e)' }}>No alternative text.</div>}
          {image.title ? <div className="ff-body-sm ff-muted">Title: {image.title}</div> : null}
          {image.captionText ? <div className="ff-body-sm ff-muted">Caption: {image.captionText}</div> : null}
          {image.external ? <div className="ff-body-sm" style={{ color: 'var(--ff-warning, #92400e)' }}>External link not fetched.</div> : null}
          {image.warnings.map((warning, index) => (
            <div key={`${warning.code}-${index}`} className="ff-body-sm" style={{ color: 'var(--ff-warning, #92400e)' }}>{warning.message}</div>
          ))}
          {meta}
        </div>,
      );
      continue;
    }

    if (block.type === 'header' || block.type === 'footer') {
      output.push(
        <div key={block.blockId} style={{ marginTop: 6, padding: '4px 8px', borderLeft: '2px solid var(--ff-border)', color: 'var(--ff-text-secondary)' }}>
          <span className="ff-uppercase" style={{ fontSize: 9 }}>{block.type}</span>
          <div className="ff-body-sm" style={{ whiteSpace: 'pre-wrap' }}>{blockText(block)}</div>
          {meta}
        </div>,
      );
      continue;
    }

    output.push(
      <div key={block.blockId} style={{ marginTop: 7 }}>
        <div className="ff-row ff-gap-4" style={{ alignItems: 'flex-start' }}>
          <FileText size={12} className="ff-muted" style={{ marginTop: 2, flex: '0 0 auto' }} />
          <div className="ff-body-sm" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{blockText(block)}</div>
        </div>
        {meta}
      </div>,
    );
  }
  if (order.length > MAX_DISPLAY_BLOCKS) {
    output.push(
      <div key="structure-truncated" className="ff-note ff-mt-8">
        Showing the first {MAX_DISPLAY_BLOCKS} blocks. The encrypted extraction still contains the complete bounded structure.
      </div>,
    );
  }
  return output;
}

export function DocumentStructureView({ structure }: { structure: DocumentStructure }) {
  const methods = [...new Set(structure.pages.map((page) => page.extractionMethod))];
  const pagination = structure.pagination;
  const docxLayout = structure.docxLayout;
  const headerReferences = docxLayout?.sections.reduce((count, section) => count + section.headers.length, 0) ?? 0;
  const inheritedHeaderReferences = docxLayout?.sections.reduce((count, section) => count + section.headers.filter((reference) => reference.inherited).length, 0) ?? 0;
  const footerReferences = docxLayout?.sections.reduce((count, section) => count + section.footers.length, 0) ?? 0;
  const inheritedFooterReferences = docxLayout?.sections.reduce((count, section) => count + section.footers.filter((reference) => reference.inherited).length, 0) ?? 0;
  const imageCount = structure.blocks.filter((block) => block.type === 'image').length;
  const fonts = docxLayout?.fonts ?? [];
  const substitutedFamilies = fonts.filter((font) => font.substituted);
  const embeddedFamilies = fonts.filter((font) => font.embedded);
  const geometry = pagination?.geometry;
  const columnPages = pagination?.pages.filter((page) => page.columns?.length).slice(0, 5) ?? [];
  const paginationSummary = pagination
    ? pagination.status === 'verified_physical'
      ? `Verified physical pages: ${pagination.pageCount}.`
      : pagination.status === 'renderer_derived_physical'
        ? `Renderer-derived physical pages: ${pagination.pageCount}${pagination.renderer ? ` via ${pagination.renderer}` : ''}. These come from local font-backed layout and are not verified against Microsoft Word.`
        : pagination.status === 'renderer_reported_breaks'
          ? `DOCX last-rendered break pages: ${pagination.pageCount}. Automatic physical pagination was not performed; these boundaries are not verified.`
          : pagination.status === 'explicit_breaks'
            ? `DOCX break-derived pages: ${pagination.pageCount}. Only explicit page/section breaks were used; automatic page breaks are not claimed.`
            : 'Logical page only. Automatic physical pagination is unavailable; no physical page count is claimed.'
    : null;
  return (
    <div className="ff-scroll" style={{ maxHeight: 430, paddingRight: 2 }}>
      <div className="ff-note" style={{ marginBottom: 8 }}>
        Deterministic local layout: {structure.pages.length} {structure.pageSemantics === 'logical' ? 'logical' : 'physical'} page{structure.pages.length === 1 ? '' : 's'},
        {' '}{structure.sections.length} section{structure.sections.length === 1 ? '' : 's'},
        {' '}{structure.tables.length} table{structure.tables.length === 1 ? '' : 's'},
        {' '}{imageCount} image{imageCount === 1 ? '' : 's'}.
        {structure.metadata.truncated ? ' The structured view was bounded to the local size limit.' : ''}
      </div>
      {docxLayout ? (
        <div className="ff-note" style={{ marginBottom: 8 }}>
          Word sections: {docxLayout.sections.length}
          {docxLayout.sections[0] ? `; first section ${Math.round(docxLayout.sections[0].pageWidthPt)}×${Math.round(docxLayout.sections[0].pageHeightPt)} pt ${docxLayout.sections[0].orientation}` : ''}
          {docxLayout.evenAndOddHeaders ? '; even/odd headers enabled' : ''}
          {' '}Header references: {headerReferences} ({inheritedHeaderReferences} inherited); footer references: {footerReferences} ({inheritedFooterReferences} inherited). Source parts are stored once.
        </div>
      ) : null}
      {fonts.length ? (
        <div className="ff-note" style={{ marginBottom: 8 }}>
          Fonts: {fonts.length} requested famil{fonts.length === 1 ? 'y' : 'ies'}; {substitutedFamilies.length} substituted; {embeddedFamilies.length} resolved from embedded faces. Exact local or embedded fonts are used only when the renderer admitted them.
        </div>
      ) : null}
      {geometry ? (
        <div className="ff-note" style={{ marginBottom: 8 }}>
          Geometry: {geometry.lineCount} line boxes, {geometry.cellCount} cell boxes, {geometry.columnCount} column boxes{geometry.truncated ? '; bounded by the local geometry limit' : ''}.
          {columnPages.length ? ` Columns: ${columnPages.map((page) => `page ${page.pageNumber}: ${page.columnCount ?? page.columns?.length ?? 0}`).join('; ')}.` : ''}
        </div>
      ) : null}
      {paginationSummary ? (
        <div className="ff-note" style={{ marginBottom: 8, borderLeft: '3px solid var(--ff-primary)' }}>
          <strong>Pagination:</strong> {paginationSummary}
          {pagination?.warnings?.length ? (
            <div style={{ marginTop: 3 }}>
              {pagination.warnings.map((warning, index) => (
                <div key={`${warning.code}-${index}`} className="ff-body-sm" style={{ color: 'var(--ff-warning, #92400e)' }}>{warning.message}</div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="ff-row ff-gap-4" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        {methods.map((method) => <span key={method} className="ff-tag">{method === 'ocr' ? 'Local OCR' : method === 'pdf_native' ? 'PDF text' : method === 'docx_xml' ? 'DOCX XML' : method === 'mixed' ? 'Mixed pages' : 'Plain text'}</span>)}
        {structure.pages.some((page) => page.conversion) ? <span className="ff-tag">OCR image coordinates converted explicitly</span> : null}
      </div>
      {structure.sections.length ? (
        <div style={{ marginBottom: 8 }}>
          <span className="ff-uppercase" style={{ fontSize: 9, color: 'var(--ff-text-secondary)' }}>Sections</span>
          <div className="ff-row ff-gap-4" style={{ flexWrap: 'wrap', marginTop: 3 }}>
            {structure.sections.slice(0, 24).map((section) => (
              <span key={section.sectionId} className="ff-tag" title={`Pages ${section.pageStart}–${section.pageEnd}`}>
                {section.title || 'Document'}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {renderBlocks(structure)}
      {structure.warnings.length ? (
        <div style={{ marginTop: 12 }}>
          <span className="ff-uppercase" style={{ fontSize: 9, color: 'var(--ff-text-secondary)' }}>Layout warnings</span>
          <div className="ff-stack ff-gap-4" style={{ marginTop: 4 }}>
            {structure.warnings.map((warning, index) => (
              <div key={`${warning.code}-${warning.page ?? 'doc'}-${index}`} className="ff-body-sm" style={{ color: 'var(--ff-warning, #92400e)' }}>
                {warning.page ? `Page ${warning.page}: ` : ''}{warning.message}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
