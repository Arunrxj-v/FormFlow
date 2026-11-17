type ParseDocx = typeof import('../../core/documents/parsers/docx').parseDocx;
type PaginateDocx = typeof import('../../extension/src/offscreen/docx-layout').paginateDocxWithLocalRenderer;

interface BenchmarkRequest {
  id: string;
  bytes: ArrayBuffer;
  cancelAfterMs?: number;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<BenchmarkRequest>) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;
const heapUsed = async (): Promise<number | null> => {
  const performanceWithMemory = performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  };
  return performanceWithMemory.memory?.usedJSHeapSize ?? null;
};
let parseDocx: ParseDocx | null = null;
let paginateDocxWithLocalRenderer: PaginateDocx | null = null;
const ready = (async () => {
  try {
    const parser = await import('../../core/documents/parsers/docx');
    const layout = await import('../../extension/src/offscreen/docx-layout');
    parseDocx = parser.parseDocx;
    paginateDocxWithLocalRenderer = layout.paginateDocxWithLocalRenderer;
    scope.postMessage({ type: 'ready', heapUsed: await heapUsed() });
  } catch (error) {
    const failure = error as { message?: string; stack?: string };
    scope.postMessage({ type: 'fatal', message: failure.message ?? String(error), stack: failure.stack });
    throw error;
  }
})();

scope.onmessage = (event: MessageEvent<BenchmarkRequest>) => {
  const request = event.data;
  void (async () => {
    let controller: AbortController | null = null;
    let cancelTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      await ready;
      if (!parseDocx || !paginateDocxWithLocalRenderer) throw new Error('Benchmark layout module failed to load.');
      (globalThis as { gc?: () => void }).gc?.();
      const baselineHeap = await heapUsed();
      const parseStarted = performance.now();
      const parsed = await parseDocx({
        format: 'docx',
        bytes: request.bytes,
        fileName: 'benchmark.docx',
      });
      const parseMs = performance.now() - parseStarted;
      if (!parsed.structure) throw new Error('Benchmark DOCX produced no structure.');
      const afterParseHeap = await heapUsed();

      controller = new AbortController();
      if (request.cancelAfterMs !== undefined) {
        cancelTimer = setTimeout(() => controller?.abort(), request.cancelAfterMs);
      }
      const layoutStarted = performance.now();
      const rendered = await paginateDocxWithLocalRenderer(request.bytes, parsed.structure, controller.signal);
      const layoutMs = performance.now() - layoutStarted;
      const afterLayoutHeap = await heapUsed();
      scope.postMessage({
        id: request.id,
        ok: true,
        parseMs,
        layoutMs,
        fontResolutionMs: rendered?.timings?.fontResolutionMs,
        rendererLayoutMs: rendered?.timings?.layoutMs,
        mappingMs: rendered?.timings?.mappingMs,
        baselineHeap,
        afterParseHeap,
        afterLayoutHeap,
        pageCount: rendered?.pagination.pageCount ?? 0,
        blockPageCount: rendered?.pagination.blockPages.length ?? 0,
        fragmentPageCount: rendered?.pagination.blockPages.reduce((count, entry) => count + (entry.fragmentPages?.length ?? 0), 0) ?? 0,
        warningCodes: rendered?.pagination.warnings.map((warning) => warning.code) ?? [],
        serializedChars: rendered ? JSON.stringify(rendered.pagination).length : 0,
        structureChars: JSON.stringify(parsed.structure).length,
        imageBlocks: parsed.structure.blocks.filter((block) => block.type === 'image').length,
        imageAppearances: parsed.structure.blocks.reduce((count, block) => count + (block.image?.appearances?.length ?? 0), 0),
        imageMetadataChars: JSON.stringify(parsed.structure.blocks.filter((block) => block.type === 'image')).length,
      });
    } catch (error) {
      const formFlowError = error as { code?: string; message?: string };
      scope.postMessage({
        id: request.id,
        ok: false,
        cancelled: formFlowError.code === 'CANCELLED',
        code: formFlowError.code ?? 'ERROR',
        message: formFlowError.message ?? String(error),
        elapsedMs: cancelTimer !== null ? request.cancelAfterMs : undefined,
        baselineHeap: await heapUsed(),
      });
    } finally {
      if (cancelTimer !== null) clearTimeout(cancelTimer);
    }
  })();
};
