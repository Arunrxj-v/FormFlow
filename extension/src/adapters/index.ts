import { GoogleFormsAdapter } from './GoogleFormsAdapter.ts';
import { StandardFormAdapter } from './StandardFormAdapter.ts';
import type { FormAdapter, ScanResult, FillRequestItem, FillResult } from './types.ts';

export * from './types.ts';
export { GoogleFormsAdapter } from './GoogleFormsAdapter.ts';
export { StandardFormAdapter } from './StandardFormAdapter.ts';

export class FormAdapterRegistry {
  private adapters: FormAdapter[] = [];

  constructor() {
    // Prioritized order: specialized adapters first, then general fallback
    this.register(new GoogleFormsAdapter());
    this.register(new StandardFormAdapter());
  }

  register(adapter: FormAdapter): void {
    this.adapters.push(adapter);
  }

  getAdapter(doc: Document, url: string): FormAdapter {
    for (const adapter of this.adapters) {
      if (adapter.isApplicable(doc, url)) {
        return adapter;
      }
    }
    // Fallback to standard
    return this.adapters[this.adapters.length - 1];
  }

  scan(doc: Document): ScanResult {
    const url = doc.location.href;

    // Check if any adapter detects an unsupported editor page first
    for (const adapter of this.adapters) {
      if (adapter.detectEditor) {
        const editorInfo = adapter.detectEditor(doc, url);
        if (editorInfo?.isEditor) {
          return {
            url,
            title: doc.title,
            adapter: adapter.name,
            isGoogleForms: adapter.name === 'Google Forms',
            isEditor: true,
            editorMessage: editorInfo.message,
            fields: [],
            uploadFields: [],
            forms: 1,
            summary: { total: 0, matched: 0, needsReview: 0, unsupported: 0 },
          };
        }
      }
    }

    const adapter = this.getAdapter(doc, url);
    return adapter.scan(doc);
  }

  async fill(fills: FillRequestItem[], doc: Document): Promise<FillResult> {
    const url = doc.location.href;
    const adapter = this.getAdapter(doc, url);
    return adapter.fill(fills, doc);
  }
}

export const defaultAdapterRegistry = new FormAdapterRegistry();
