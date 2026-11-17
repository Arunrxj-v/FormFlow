import type {
  DocumentStructureBlock,
  DocumentStructureBoundingBox,
  DocumentStructurePage,
  ExtractionWarning,
  OcrBoundingBox,
  OcrLine,
  OcrPageDetails,
} from '@shared/types';
import { structureBlock, structureBlockId, structurePage } from './structure';
import { sanitizeWarnings } from './text-utils';

const LIST_MARKER = /^([-*•▪◦]|\(?\d{1,3}[.)]|[A-Za-z][.)])\s+(.+)$/;

function union(boxes: OcrBoundingBox[]): OcrBoundingBox {
  return boxes.reduce<OcrBoundingBox>((box, item) => ({
    x0: Math.min(box.x0, item.x0),
    y0: Math.min(box.y0, item.y0),
    x1: Math.max(box.x1, item.x1),
    y1: Math.max(box.y1, item.y1),
  }), { x0: Number.POSITIVE_INFINITY, y0: Number.POSITIVE_INFINITY, x1: 0, y1: 0 });
}

function median(values: number[]): number {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function ocrBox(box: OcrBoundingBox, renderWidth: number, renderHeight: number): DocumentStructureBoundingBox {
  return {
    x0: box.x0,
    y0: box.y0,
    x1: box.x1,
    y1: box.y1,
    coordinateSpace: 'ocr_render_pixels',
    pageWidth: renderWidth,
    pageHeight: renderHeight,
  };
}

function splitOcrColumns(lines: OcrLine[], renderWidth: number): { columns: OcrLine[][]; uncertain: boolean } {
  const narrow = lines.filter((line) => line.bbox.x1 - line.bbox.x0 <= renderWidth * 0.72);
  if (narrow.length < 6) return { columns: [lines], uncertain: false };
  const intervals = narrow.map((line) => [line.bbox.x0, line.bbox.x1] as const).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (!last || interval[0] > last[1]) merged.push([interval[0], interval[1]]);
    else last[1] = Math.max(last[1], interval[1]);
  }
  const contentLeft = Math.min(...narrow.map((line) => line.bbox.x0));
  const contentRight = Math.max(...narrow.map((line) => line.bbox.x1));
  let best: { start: number; end: number; left: OcrLine[]; right: OcrLine[] } | null = null;
  for (let index = 0; index < merged.length - 1; index += 1) {
    const start = merged[index]![1];
    const end = merged[index + 1]![0];
    if (end - start < Math.max(10, renderWidth * 0.045) || start <= contentLeft || end >= contentRight) continue;
    const left = narrow.filter((line) => line.bbox.x1 <= start);
    const right = narrow.filter((line) => line.bbox.x0 >= end);
    if (left.length < 3 || right.length < 3) continue;
    if (!best || end - start > best.end - best.start) best = { start, end, left, right };
  }
  if (!best) return { columns: [lines], uncertain: false };
  const left = lines.filter((line) => line.bbox.x1 <= best.start);
  const right = lines.filter((line) => line.bbox.x0 >= best.end);
  const crossing = lines.filter((line) => !left.includes(line) && !right.includes(line));
  const columns = [left, right, crossing].filter((column) => column.length > 0);
  return { columns, uncertain: crossing.length > 0 || columns.length > 3 };
}

function orderedOcrLines(details: OcrPageDetails, renderWidth: number): { lines: OcrLine[]; uncertain: boolean } {
  const lines = [...(details.lines ?? [])].sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
  const { columns, uncertain } = splitOcrColumns(lines, renderWidth);
  if (columns.length <= 1) return { lines, uncertain };
  const full = columns.find((column) => column.some((line) => line.bbox.x1 - line.bbox.x0 > renderWidth * 0.55)) ?? [];
  const widthColumns = columns.filter((column) => column !== full);
  const ordered: OcrLine[] = [
    ...full.sort((a, b) => a.bbox.y0 - b.bbox.y0),
    ...widthColumns.flatMap((column) => [...column].sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0))),
  ];
  return { lines: ordered, uncertain };
}

export function buildOcrPageStructure(input: {
  pageNumber: number;
  details: OcrPageDetails;
  text?: string;
  renderWidth: number;
  renderHeight: number;
  pageWidthPoints?: number;
  pageHeightPoints?: number;
}): { page: DocumentStructurePage; blocks: DocumentStructureBlock[]; warnings: ExtractionWarning[] } {
  const { pageNumber, details, renderWidth, renderHeight } = input;
  const warnings: ExtractionWarning[] = [...(details.warnings ?? [])];
  const blocks: DocumentStructureBlock[] = [];
  const pageBlockIds: string[] = [];
  let order = 0;
  const add = (block: DocumentStructureBlock) => blocks.push(block);
  const ordered = orderedOcrLines(details, renderWidth);
  if (ordered.uncertain) {
    warnings.push({
      code: 'READING_ORDER_UNCERTAIN',
      message: 'OCR column regions were detected but reading order could not be established with certainty.',
      page: pageNumber,
    });
  }
  const lines = ordered.lines;
  const lineHeights = lines.map((line) => line.bbox.y1 - line.bbox.y0).filter((value) => value > 0);
  const bodyHeight = median(lineHeights);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const marker = LIST_MARKER.exec(line.text);
    if (marker) {
      const items: OcrLine[] = [];
      let cursor = index;
      while (cursor < lines.length) {
        const candidate = lines[cursor]!;
        if (!LIST_MARKER.test(candidate.text)) break;
        items.push(candidate);
        cursor += 1;
      }
      const listBlockId = structureBlockId(pageNumber, order + 1);
      const itemIds: string[] = [];
      const itemBlocks: DocumentStructureBlock[] = [];
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const itemLine = items[itemIndex]!;
        const itemMarker = LIST_MARKER.exec(itemLine.text);
        const itemId = structureBlockId(pageNumber, order + 1, `li${itemIndex + 1}`);
        itemIds.push(itemId);
        itemBlocks.push(structureBlock({
          blockId: itemId,
          type: 'list_item',
          text: itemMarker?.[2] ?? itemLine.text,
          pageNumber,
          order: order++,
          parentId: listBlockId,
          boundingBox: ocrBox(itemLine.bbox, renderWidth, renderHeight),
          confidence: itemLine.confidence,
          provenance: 'ocr',
          layoutInferred: true,
          level: Math.max(1, Math.min(3, Math.floor(itemLine.bbox.x0 / Math.max(20, renderWidth * 0.08)) + 1)),
          listMarker: itemMarker?.[1] ?? '•',
          sourceRef: `ocr:page${pageNumber}:list${listBlockId}:item${itemIndex + 1}`,
        }));
      }
      pageBlockIds.push(listBlockId);
      blocks.push(structureBlock({
        blockId: listBlockId,
        type: 'list',
        text: items.map((item) => LIST_MARKER.exec(item.text)?.[2] ?? item.text).join('\n'),
        pageNumber,
        order: order++,
        children: itemIds,
        boundingBox: ocrBox(union(items.map((item) => item.bbox)), renderWidth, renderHeight),
        provenance: 'inferred_from_layout',
        layoutInferred: true,
        sourceRef: `ocr:page${pageNumber}:list${listBlockId}`,
      }));
      blocks.push(...itemBlocks);
      index = cursor;
      continue;
    }

    const paragraphLines: OcrLine[] = [line];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const next = lines[cursor]!;
      if (LIST_MARKER.test(next.text)) break;
      const previous = paragraphLines[paragraphLines.length - 1]!;
      if (next.bbox.y0 - previous.bbox.y1 > Math.max(3, bodyHeight * 1.55)) break;
      if (Math.abs(next.bbox.x0 - line.bbox.x0) > renderWidth * 0.16) break;
      paragraphLines.push(next);
      cursor += 1;
    }
    const text = paragraphLines.map((item) => item.text).join('\n');
    const box = union(paragraphLines.map((item) => item.bbox));
    const maxHeight = Math.max(...paragraphLines.map((item) => item.bbox.y1 - item.bbox.y0));
    const likelyHeading = paragraphLines.length <= 2
      && text.length <= 140
      && maxHeight >= bodyHeight * 1.35;
    if (likelyHeading) {
      warnings.push({
        code: 'OCR_HEADING_HEURISTIC',
        message: 'A heading-like OCR block was inferred from line height and position; verify it against the original image.',
        page: pageNumber,
      });
    }
    const confidences = paragraphLines.map((item) => item.confidence).filter((value) => value > 0);
    const confidence = confidences.length
      ? Math.round(confidences.reduce((sum, value) => sum + value, 0) / confidences.length)
      : undefined;
    const blockId = structureBlockId(pageNumber, order + 1);
    pageBlockIds.push(blockId);
    add(structureBlock({
      blockId,
      type: likelyHeading ? 'heading' : 'paragraph',
      text,
      pageNumber,
      order: order++,
      boundingBox: ocrBox(box, renderWidth, renderHeight),
      ...(confidence !== undefined ? { confidence } : {}),
      provenance: likelyHeading ? 'inferred_from_layout' : 'ocr',
      layoutInferred: likelyHeading,
      ...(likelyHeading ? { level: 3 } : {}),
      sourceRef: `ocr:page${pageNumber}:line${index + 1}`,
    }));
    index = cursor;
  }

  if (!lines.length && input.text?.trim()) {
    const blockId = structureBlockId(pageNumber, 1);
    pageBlockIds.push(blockId);
    add(structureBlock({
      blockId,
      type: 'paragraph',
      text: input.text.trim(),
      pageNumber,
      order: 0,
      provenance: 'ocr',
      sourceRef: `ocr:page${pageNumber}:fallback`,
    }));
  }

  const page = structurePage({
    pageNumber,
    pageKind: 'physical',
    pageType: pageBlockIds.length ? 'text' : 'image_only',
    extractionMethod: 'ocr',
    blockIds: pageBlockIds,
    pageBounds: {
      width: renderWidth,
      height: renderHeight,
      coordinateSpace: 'ocr_render_pixels',
    },
    ...(input.pageWidthPoints && input.pageHeightPoints ? {
      conversion: {
        from: 'ocr_render_pixels' as const,
        to: 'pdf_page_points' as const,
        scaleX: input.pageWidthPoints / renderWidth,
        scaleY: input.pageHeightPoints / renderHeight,
        width: input.pageWidthPoints,
        height: input.pageHeightPoints,
      },
    } : {}),
    ...(warnings.length ? { warnings: sanitizeWarnings(warnings) } : {}),
  });
  return { page, blocks, warnings };
}
