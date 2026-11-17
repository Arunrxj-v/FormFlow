import type { ReactNode } from 'react';
import { FileText, List, Table2 } from 'lucide-react';
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
              cells.push(
                <td key={cell.blockId} rowSpan={cell.rowSpan} colSpan={cell.columnSpan}>
                  <div className="ff-body-sm" style={{ whiteSpace: 'pre-wrap' }}>{cell.text || '—'}</div>
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
    const meta = (
      <div className="ff-row ff-gap-4" style={{ flexWrap: 'wrap', marginTop: 3 }}>
        <span className="ff-code ff-muted" style={{ fontSize: 9 }}>{pageLabel(page, block.pageNumber)}</span>
        {provenanceBadge(block)}
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
  return (
    <div className="ff-scroll" style={{ maxHeight: 430, paddingRight: 2 }}>
      <div className="ff-note" style={{ marginBottom: 8 }}>
        Deterministic local layout: {structure.pages.length} {structure.pageSemantics === 'logical' ? 'logical' : 'physical'} page{structure.pages.length === 1 ? '' : 's'},
        {' '}{structure.sections.length} section{structure.sections.length === 1 ? '' : 's'},
        {' '}{structure.tables.length} table{structure.tables.length === 1 ? '' : 's'}.
        {structure.metadata.truncated ? ' The structured view was bounded to the local size limit.' : ''}
      </div>
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
