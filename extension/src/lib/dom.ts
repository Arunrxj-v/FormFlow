/**
 * DOM traversal for form detection.
 *
 * Only open shadow roots and same-origin iframe documents are accessible to a
 * content script. Closed shadow roots and cross-origin frames are deliberately
 * skipped; there is no attempt to bypass browser origin boundaries.
 */
export type FormRoot = Document | ShadowRoot;

const CONTROL_SELECTOR = 'input, textarea, select, [role="textbox"], [role="radio"], [role="checkbox"], [role="listbox"]';
const MAX_FRAME_DEPTH = 3;

function isElementVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hidden) return false;
  const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(element) : null;
  if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
  return true;
}

export function collectFormRoots(root: FormRoot, depth = 0, output: FormRoot[] = []): FormRoot[] {
  if (depth > MAX_FRAME_DEPTH) return output;
  output.push(root);
  for (const element of Array.from(root.querySelectorAll('*'))) {
    if (element.shadowRoot) collectFormRoots(element.shadowRoot, depth + 1, output);
    if (element instanceof HTMLIFrameElement) {
      try {
        if (!isElementVisible(element)) continue;
        const frameDocument = element.contentDocument;
        if (frameDocument?.documentElement) collectFormRoots(frameDocument, depth + 1, output);
      } catch {
        // Cross-origin frames throw on contentDocument access. Leave them
        // unsupported rather than weakening origin isolation.
      }
    }
  }
  return output;
}

export function collectControlElements(root: FormRoot): HTMLElement[] {
  const controls: HTMLElement[] = [];
  for (const candidateRoot of collectFormRoots(root)) {
    controls.push(...Array.from(candidateRoot.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)));
  }
  return controls;
}

export function rootForElement(element: Element): FormRoot | null {
  const root = element.getRootNode() as Node & Partial<FormRoot>;
  // nodeType avoids cross-realm instanceof failures for same-origin iframe
  // documents, whose constructors come from a different global object.
  if (root.nodeType === Node.DOCUMENT_NODE || root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    if (typeof root.querySelector === 'function' && typeof root.getElementById === 'function') {
      return root as FormRoot;
    }
  }
  return null;
}
