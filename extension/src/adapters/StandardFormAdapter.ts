import { classifyField, optionMatches } from '../lib/classifier.ts';
import type {
  DetectedField,
  DetectedUploadField,
  FillRequestItem,
  FillResult,
  FormAdapter,
  QuestionType,
  ScanResult,
} from './types.ts';

function createEvent(type: string, options: any = { bubbles: true }): any {
  if (type.startsWith('key') && typeof KeyboardEvent !== 'undefined') {
    return new KeyboardEvent(type, options);
  }
  if ((type.startsWith('mouse') || type === 'click') && typeof MouseEvent !== 'undefined') {
    return new MouseEvent(type, options);
  }
  if (typeof Event !== 'undefined') {
    return new Event(type, options);
  }
  return { type, bubbles: Boolean(options?.bubbles) };
}

export class StandardFormAdapter implements FormAdapter {
  readonly name = 'Standard Web Form';

  isApplicable(_doc: Document, _url: string): boolean {
    return true; // Default fallback adapter
  }

  scan(doc: Document): ScanResult {
    const candidates = Array.from(doc.querySelectorAll<HTMLElement>('input, textarea, select, [role="textbox"]'));
    const fields: DetectedField[] = [];
    const uploadFields: DetectedUploadField[] = [];
    let index = 0;
    let uploadIndex = 0;

    for (const element of candidates) {
      const isRoleTextbox = element.getAttribute('role') === 'textbox';
      const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const type = isRoleTextbox ? 'text' : (input.getAttribute('type') ?? input.tagName.toLowerCase()).toLowerCase();

      // Detect file upload elements
      if (type === 'file') {
        if ((input as HTMLInputElement).disabled || (input as HTMLInputElement).readOnly) continue;
        if (!this.isVisible(input)) continue;
        const label = this.labelFor(input, doc) || input.getAttribute('name') || `Upload field ${uploadIndex + 1}`;
        uploadFields.push({
          index: uploadIndex,
          label,
          name: input.getAttribute('name') ?? '',
          id: input.getAttribute('id') ?? '',
          accept: input.getAttribute('accept') ?? '',
          required: input.required || input.getAttribute('aria-required') === 'true',
          selector: `input[type="file"][name="${CSS.escape(input.getAttribute('name') ?? '')}"]`,
        });
        uploadIndex += 1;
        continue;
      }

      // Ignore buttons, hidden, password, search, reset
      if (['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search'].includes(type)) continue;
      if (!isRoleTextbox && ((input as HTMLInputElement).disabled || (input as HTMLInputElement).readOnly)) continue;
      if (!this.isVisible(element)) continue;

      const label = this.labelFor(element, doc);
      const classified = classifyField({
        label,
        name: element.getAttribute('name') ?? '',
        id: element.getAttribute('id') ?? '',
        placeholder: element.getAttribute('placeholder') ?? '',
        ariaLabel: element.getAttribute('aria-label') ?? '',
        autocomplete: element.getAttribute('autocomplete') ?? '',
        type,
        tag: element.tagName.toLowerCase(),
      });

      if (classified.kind === 'unknown' && !label && !element.getAttribute('name')) continue;

      const selector = `[data-formflow-id="${index}"]`;
      element.setAttribute('data-formflow-id', String(index));

      let qType: QuestionType = 'text';
      if (element.tagName.toLowerCase() === 'textarea' || element.getAttribute('aria-multiline') === 'true') {
        qType = 'paragraph';
      } else if (element.tagName.toLowerCase() === 'select') {
        qType = 'dropdown';
      } else if (type === 'checkbox') {
        qType = 'checkbox';
      } else if (type === 'radio') {
        qType = 'radio';
      } else if (type === 'date') {
        qType = 'date';
      } else if (type === 'email') {
        qType = 'email';
      } else if (type === 'number') {
        qType = 'number';
      }

      fields.push({
        index,
        label: label || element.getAttribute('name') || `Field ${index + 1}`,
        kind: classified.kind,
        confidence: classified.confidence,
        sensitive: classified.sensitive,
        tag: element.tagName.toLowerCase(),
        type,
        questionType: qType,
        required: Boolean(
          (!isRoleTextbox && (input as HTMLInputElement).required) ||
          element.getAttribute('aria-required') === 'true'
        ),
        currentValue: isRoleTextbox ? (element.textContent ?? '') : (input.value ?? ''),
        options: element.tagName.toLowerCase() === 'select'
          ? Array.from(element.querySelectorAll('option'))
            .map((option) => option.textContent?.trim() ?? '')
            .filter((option) => option && !/^(choose|select)$/i.test(option))
          : undefined,
        selector,
      });

      index += 1;
    }

    return {
      url: doc.location.href,
      title: doc.title,
      adapter: this.name,
      isGoogleForms: false,
      fields,
      uploadFields,
      forms: doc.querySelectorAll('form').length,
    };
  }

  fill(fills: FillRequestItem[], doc: Document): FillResult {
    let filled = 0;
    let failed = 0;
    const skipped: Array<{ index: number; reason: string }> = [];

    for (const item of fills) {
      const element = doc.querySelector<HTMLElement>(`[data-formflow-id="${item.index}"]`);
      if (!element) {
        failed += 1;
        skipped.push({ index: item.index, reason: 'Field no longer exists on the page.' });
        continue;
      }
      if ((element as HTMLInputElement).disabled || (element as HTMLInputElement).readOnly) {
        failed += 1;
        skipped.push({ index: item.index, reason: 'Field is disabled or read-only.' });
        continue;
      }

      const ok = this.setNativeValue(element, item.value, doc);
      if (ok) {
        filled += 1;
        this.highlightFilled(element);
      } else {
        failed += 1;
        skipped.push({ index: item.index, reason: 'Unable to set value matching option list.' });
      }
    }

    return { filled, failed, skipped };
  }

  private setNativeValue(element: HTMLElement, value: string, doc: Document): boolean {
    if (element instanceof HTMLSelectElement) {
      const option = Array.from(element.options).find(
        (item) => item.value === value || item.textContent?.trim().toLowerCase() === value.toLowerCase()
      );
      if (!option) return false;
      element.value = option.value;
      element.dispatchEvent(createEvent('input', { bubbles: true }));
      element.dispatchEvent(createEvent('change', { bubbles: true }));
      return element.value === option.value;
    }

    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
      const optionLabel = (this.labelFor(element, doc)
        || element.getAttribute('aria-label')
        || element.value
        || '').trim().toLowerCase();
      const targets = value.split(',').map((entry) => entry.trim()).filter(Boolean);
      const matches = targets.some((target) => optionMatches(optionLabel, target));
      if (!matches) return false;
      if (!element.checked) element.click();
      return element.checked;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(createEvent('input', { bubbles: true }));
      element.dispatchEvent(createEvent('change', { bubbles: true }));
      element.dispatchEvent(createEvent('keyup', { bubbles: true, key: 'Unidentified' }));
      // Verify the page did not reject or overwrite the value synchronously.
      return element.value === value;
    }

    if (element.getAttribute('role') === 'textbox') {
      element.textContent = value;
      element.dispatchEvent(createEvent('input', { bubbles: true }));
      element.dispatchEvent(createEvent('change', { bubbles: true }));
      return (element.textContent ?? '') === value;
    }

    return false;
  }

  private highlightFilled(element: HTMLElement): void {
    const origTransition = element.style.transition;
    const origBg = element.style.backgroundColor;
    element.style.transition = 'background-color 300ms ease, box-shadow 300ms ease';
    element.style.backgroundColor = 'rgba(79, 70, 229, 0.12)';
    setTimeout(() => {
      element.style.backgroundColor = origBg;
      element.style.transition = origTransition;
    }, 1200);
  }

  private labelFor(field: HTMLElement, doc: Document): string {
    const id = field.getAttribute('id');
    if (id) {
      try {
        const explicit = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (explicit) return this.textOf(explicit);
      } catch {
        // Fallback if id is invalid selector
      }
    }
    const wrapping = field.closest('label');
    if (wrapping) return this.textOf(wrapping);

    const labelledBy = field.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map((part) => this.textOf(doc.getElementById(part))).filter(Boolean);
      if (parts.length > 0) return parts.join(' ');
    }

    const aria = field.getAttribute('aria-label');
    if (aria) return aria.trim();

    const placeholder = field.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();

    const name = field.getAttribute('name');
    if (name) return name.replace(/[_\-.\[\]]+/g, ' ').trim();

    return id ? id.replace(/[_\-.]+/g, ' ').trim() : '';
  }

  private textOf(element: Element | null): string {
    return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  private isVisible(element: HTMLElement): boolean {
    if (element.hidden) return false;
    const style = window.getComputedStyle ? window.getComputedStyle(element) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) {
      return false;
    }
    const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
    if (rect && (rect.width === 0 && rect.height === 0)) return false;
    return true;
  }
}
