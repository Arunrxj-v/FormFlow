import { classifyField, type FieldKind } from '../lib/classifier.ts';
import type {
  DetectedField,
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

export class GoogleFormsAdapter implements FormAdapter {
  readonly name = 'Google Forms';

  isApplicable(doc: Document, url: string): boolean {
    const isGoogleFormsUrl = /docs\.google\.com\/forms\//i.test(url) || /forms\.gle\//i.test(url);
    if (isGoogleFormsUrl) return true;

    // Check DOM signatures if embedded in iframe or hosted under custom domain
    if (doc.querySelector('form[action*="docs.google.com/forms"], form[action*="formResponse"]')) return true;
    if (doc.querySelector('div[role="list"][aria-label*="questions" i]')) return true;
    if (doc.querySelector('div[role="listitem"] [role="radiogroup"]')) return true;
    if (doc.querySelector('.freebirdFormviewerViewNumberedItemContainer, .exportFormCard')) return true;

    return false;
  }

  detectEditor(_doc: Document, url: string): { isEditor: boolean; message: string } | null {
    const isFormsUrl = /docs\.google\.com\/forms\//i.test(url);
    const isEditorUrl = isFormsUrl && (/\/edit(\?|\/|$)/i.test(url) || /\/builder(\?|\/|$)/i.test(url));

    if (isEditorUrl) {
      return {
        isEditor: true,
        message: 'Google Forms editor detected. Open Preview or the responder link to fill the form.',
      };
    }

    return null;
  }

  scan(doc: Document): ScanResult {
    const url = doc.location.href;
    const title = (doc.title || 'Google Form').replace(/\s*-\s*Google Forms$/i, '').trim();

    // Check if editor URL
    const editorCheck = this.detectEditor(doc, url);
    if (editorCheck?.isEditor) {
      return {
        url,
        title,
        adapter: this.name,
        isGoogleForms: true,
        isEditor: true,
        editorMessage: editorCheck.message,
        fields: [],
        uploadFields: [],
        forms: 1,
        summary: { total: 0, matched: 0, needsReview: 0, unsupported: 0 },
      };
    }

    // Identify question containers
    let questionNodes = Array.from(doc.querySelectorAll<HTMLElement>('div[role="listitem"]'));
    if (questionNodes.length === 0) {
      // Fallback selectors for various Google Forms variants
      questionNodes = Array.from(doc.querySelectorAll<HTMLElement>('.freebirdFormviewerViewNumberedItemContainer, .exportFormCard, div[data-item-id]'));
    }
    if (questionNodes.length === 0) {
      // Secondary fallback: any container enclosing a heading and an interactive role
      const headings = Array.from(doc.querySelectorAll<HTMLElement>('div[role="heading"], span[role="heading"]'));
      questionNodes = headings
        .map((h) => h.closest<HTMLElement>('div[role="list"] > div, form > div, div[jsmodel]'))
        .filter((el): el is HTMLElement => Boolean(el && !['BUTTON', 'HEADER'].includes(el.tagName)));
      questionNodes = Array.from(new Set(questionNodes));
    }

    const fields: DetectedField[] = [];
    let fieldIndex = 0;

    for (const container of questionNodes) {
      // Ignore decorative cards, section headers, or image/video items
      if (this.isNonQuestionContainer(container)) continue;

      const questionInfo = this.extractQuestionInfo(container, fieldIndex, doc);
      if (!questionInfo) continue;

      fields.push(questionInfo);
      fieldIndex += 1;
    }

    return {
      url,
      title,
      adapter: this.name,
      isGoogleForms: true,
      isEditor: false,
      fields,
      uploadFields: [],
      forms: doc.querySelectorAll('form').length || 1,
    };
  }

  private isNonQuestionContainer(container: HTMLElement): boolean {
    // If it has no interactive controls inside (no textbox, radio, checkbox, listbox, inputs)
    const hasControls = Boolean(
      container.querySelector('input, textarea, select, [role="textbox"], [role="radio"], [role="checkbox"], [role="listbox"]')
    );
    if (!hasControls) return true;

    // Check if it's the title banner or submit footer
    if (container.querySelector('[role="heading"][aria-level="1"]')) return true;
    if (container.querySelector('button[type="submit"]') && !container.querySelector('[role="heading"]')) return true;

    return false;
  }

  private extractQuestionInfo(container: HTMLElement, index: number, doc: Document): DetectedField | null {
    // 1. Extract Question Title
    let label = '';
    const headingElem = container.querySelector<HTMLElement>('div[role="heading"], span[role="heading"], [aria-level="3"], [aria-level="2"], .M7eMe, legend');
    if (headingElem) {
      label = this.cleanText(headingElem.textContent || '');
    }

    // Fallback: aria-label on radiogroup/group or container
    if (!label) {
      const group = container.querySelector('[role="radiogroup"], [role="group"]');
      if (group) {
        const labelledBy = group.getAttribute('aria-labelledby');
        if (labelledBy) {
          const referenced = doc.getElementById(labelledBy);
          if (referenced) label = this.cleanText(referenced.textContent || '');
        }
        if (!label) label = group.getAttribute('aria-label') || '';
      }
    }

    // Required status detection
    const isRequired = Boolean(
      container.querySelector('[aria-required="true"], [aria-label*="required" i], [aria-label*="Required" i]') ||
      container.textContent?.includes('*') ||
      label.endsWith('*')
    );

    // Strip trailing asterisk
    label = label.replace(/\s*\*+\s*$/, '').trim();

    // 2. Identify Control & Question Type
    // Multiple Choice (Radio)
    const radioGroup = container.querySelector<HTMLElement>('[role="radiogroup"]');
    const radios = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'));
    if (radioGroup || radios.length > 0) {
      const options: string[] = [];
      const optionSelectors: Record<string, string> = {};

      radios.forEach((radio, rIdx) => {
        const optText = this.getOptionText(radio);
        if (optText) {
          options.push(optText);
          const optId = `ff-gform-r-${index}-${rIdx}`;
          radio.setAttribute('data-formflow-target', optId);
          optionSelectors[optText] = `[data-formflow-target="${optId}"]`;
        }
      });

      const checkedRadio = radios.find((r) => r.getAttribute('aria-checked') === 'true');
      const currentValue = checkedRadio ? this.getOptionText(checkedRadio) : '';
      const selector = `[data-formflow-id="${index}"]`;
      container.setAttribute('data-formflow-id', String(index));

      const classified = classifyField({ label, type: 'radio' });

      return {
        index,
        label: label || `Question ${index + 1}`,
        kind: classified.kind,
        confidence: classified.confidence,
        sensitive: classified.sensitive,
        tag: 'div',
        type: 'radio',
        questionType: 'radio',
        required: isRequired,
        currentValue,
        options,
        selector,
        metadata: { optionSelectors },
      };
    }

    // Checkboxes
    const checkboxes = Array.from(container.querySelectorAll<HTMLElement>('[role="checkbox"]'));
    if (checkboxes.length > 0) {
      const options: string[] = [];
      const optionSelectors: Record<string, string> = {};

      checkboxes.forEach((cb, cIdx) => {
        const optText = this.getOptionText(cb);
        if (optText) {
          options.push(optText);
          const optId = `ff-gform-c-${index}-${cIdx}`;
          cb.setAttribute('data-formflow-target', optId);
          optionSelectors[optText] = `[data-formflow-target="${optId}"]`;
        }
      });

      const checkedBoxes = checkboxes.filter((cb) => cb.getAttribute('aria-checked') === 'true');
      const currentValue = checkedBoxes.map((cb) => this.getOptionText(cb)).join(', ');
      const selector = `[data-formflow-id="${index}"]`;
      container.setAttribute('data-formflow-id', String(index));

      const classified = classifyField({ label, type: 'checkbox' });

      return {
        index,
        label: label || `Question ${index + 1}`,
        kind: classified.kind,
        confidence: classified.confidence,
        sensitive: classified.sensitive,
        tag: 'div',
        type: 'checkbox',
        questionType: 'checkbox',
        required: isRequired,
        currentValue,
        options,
        selector,
        metadata: { optionSelectors },
      };
    }

    // Dropdown (Listbox or Select)
    const listbox = container.querySelector<HTMLElement>('[role="listbox"]');
    const select = container.querySelector<HTMLSelectElement>('select');
    if (listbox || select) {
      let options: string[] = [];
      let currentValue = '';

      if (select) {
        options = Array.from(select.options).map((o) => o.text.trim()).filter((t) => t && !/^(choose|select)$/i.test(t));
        currentValue = select.options[select.selectedIndex]?.text?.trim() || '';
        select.setAttribute('data-formflow-id', String(index));
      } else if (listbox) {
        const optionEls = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
        options = optionEls
          .map((el) => el.getAttribute('data-value') || el.textContent?.trim() || '')
          .filter((t) => t && !/^(choose|select)$/i.test(t));

        const selectedOpt = optionEls.find((el) => el.getAttribute('aria-selected') === 'true');
        currentValue = selectedOpt ? (selectedOpt.getAttribute('data-value') || selectedOpt.textContent?.trim() || '') : '';
        listbox.setAttribute('data-formflow-id', String(index));
      }

      container.setAttribute('data-formflow-id', String(index));
      const classified = classifyField({ label, type: 'select' });

      return {
        index,
        label: label || `Question ${index + 1}`,
        kind: classified.kind,
        confidence: classified.confidence,
        sensitive: classified.sensitive,
        tag: select ? 'select' : 'div',
        type: 'select',
        questionType: 'dropdown',
        required: isRequired,
        currentValue,
        options,
        selector: `[data-formflow-id="${index}"]`,
      };
    }

    // Date Input
    const dateInput = container.querySelector<HTMLInputElement>('input[type="date"]');
    if (dateInput) {
      dateInput.setAttribute('data-formflow-id', String(index));
      container.setAttribute('data-formflow-id', String(index));
      const classified = classifyField({ label, type: 'date' });
      return {
        index,
        label: label || `Question ${index + 1}`,
        kind: 'dateOfBirth',
        confidence: 96,
        sensitive: true,
        tag: 'input',
        type: 'date',
        questionType: 'date',
        required: isRequired,
        currentValue: dateInput.value || '',
        selector: `[data-formflow-id="${index}"]`,
      };
    }

    // Textarea / Paragraph
    const textarea = container.querySelector<HTMLElement>('textarea, [role="textbox"][aria-multiline="true"]');
    if (textarea) {
      textarea.setAttribute('data-formflow-id', String(index));
      container.setAttribute('data-formflow-id', String(index));
      const classified = classifyField({ label, type: 'textarea', tag: 'textarea' });
      const currentValue = textarea.tagName === 'TEXTAREA' ? (textarea as HTMLTextAreaElement).value : textarea.textContent || '';
      return {
        index,
        label: label || `Question ${index + 1}`,
        kind: classified.kind === 'unknown' ? 'longAnswer' : classified.kind,
        confidence: classified.kind === 'unknown' ? 70 : classified.confidence,
        sensitive: classified.sensitive,
        tag: 'textarea',
        type: 'textarea',
        questionType: 'paragraph',
        required: isRequired,
        currentValue,
        selector: `[data-formflow-id="${index}"]`,
      };
    }

    // Short Answer / Text Input
    const textInput = container.querySelector<HTMLElement>('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input:not([type]), [role="textbox"]');
    if (textInput) {
      textInput.setAttribute('data-formflow-id', String(index));
      container.setAttribute('data-formflow-id', String(index));

      const isInputElement = textInput.tagName === 'INPUT';
      const inputType = isInputElement ? ((textInput as HTMLInputElement).type || textInput.getAttribute('type') || 'text') : 'text';
      let qType: QuestionType = 'text';
      if (inputType === 'email' || /email/i.test(label)) qType = 'email';
      else if (inputType === 'number' || /year|percentage|cgpa|marks/i.test(label)) qType = 'number';

      const classified = classifyField({
        label,
        type: inputType,
        placeholder: isInputElement ? (textInput as HTMLInputElement).placeholder || textInput.getAttribute('placeholder') || '' : '',
        ariaLabel: textInput.getAttribute('aria-label') || '',
      });

      const currentValue = isInputElement ? ((textInput as HTMLInputElement).value ?? textInput.getAttribute('value') ?? '') : textInput.textContent || '';

      return {
        index,
        label: label || `Question ${index + 1}`,
        kind: classified.kind,
        confidence: classified.confidence,
        sensitive: classified.sensitive,
        tag: textInput.tagName.toLowerCase(),
        type: inputType,
        questionType: qType,
        required: isRequired,
        currentValue,
        selector: `[data-formflow-id="${index}"]`,
      };
    }

    return null;
  }

  private cleanText(str: string): string {
    return str.replace(/\s+/g, ' ').trim();
  }

  private getOptionText(element: HTMLElement): string {
    const dataVal = element.getAttribute('data-value');
    if (dataVal) return dataVal.trim();

    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    // Look for sibling or enclosing label/span
    const parentContainer = element.closest('.SGIOEc, .Y6FdBh, [role="presentation"]') || element.parentElement;
    if (parentContainer) {
      const textSpan = parentContainer.querySelector('.aDTYNe, span[dir="auto"], label');
      if (textSpan && textSpan.textContent) {
        return this.cleanText(textSpan.textContent);
      }
    }

    return this.cleanText(element.textContent || '');
  }

  async fill(fills: FillRequestItem[], doc: Document): Promise<FillResult> {
    let filled = 0;
    let failed = 0;
    const skipped: Array<{ index: number; reason: string }> = [];

    for (const item of fills) {
      const container = doc.querySelector<HTMLElement>(`[data-formflow-id="${item.index}"]`);
      if (!container) {
        failed += 1;
        skipped.push({ index: item.index, reason: 'Google Forms question container not found.' });
        continue;
      }

      try {
        const success = await this.fillQuestion(container, item.value, doc);
        if (success) {
          filled += 1;
          this.highlightFilled(container);
        } else {
          failed += 1;
          skipped.push({ index: item.index, reason: `Could not populate field with value "${item.value}".` });
        }
      } catch (err) {
        failed += 1;
        skipped.push({ index: item.index, reason: err instanceof Error ? err.message : 'Autofill execution error.' });
      }
    }

    return { filled, failed, skipped };
  }

  private async fillQuestion(container: HTMLElement, value: string, doc: Document): Promise<boolean> {
    // 1. Radio Button Group
    const radios = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'));
    if (radios.length > 0) {
      const targetOpt = radios.find((r) => {
        const optText = this.getOptionText(r).toLowerCase();
        const v = value.toLowerCase().trim();
        return optText === v || optText.includes(v) || v.includes(optText);
      });

      if (!targetOpt) return false;

      targetOpt.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      this.dispatchUserClick(targetOpt);
      targetOpt.setAttribute('aria-checked', 'true');
      return true;
    }

    // 2. Checkboxes
    const checkboxes = Array.from(container.querySelectorAll<HTMLElement>('[role="checkbox"]'));
    if (checkboxes.length > 0) {
      const targetValues = value.split(',').map((v) => v.trim().toLowerCase());
      let anyMatched = false;

      for (const cb of checkboxes) {
        const optText = this.getOptionText(cb).toLowerCase();
        const shouldCheck = targetValues.some((tv) => optText === tv || optText.includes(tv) || tv.includes(optText));
        const isChecked = cb.getAttribute('aria-checked') === 'true';

        if (shouldCheck && !isChecked) {
          this.dispatchUserClick(cb);
          cb.setAttribute('aria-checked', 'true');
          anyMatched = true;
        } else if (shouldCheck && isChecked) {
          anyMatched = true;
        }
      }

      return anyMatched;
    }

    // 3. Dropdown (Listbox or Select)
    const select = container.querySelector<HTMLSelectElement>('select');
    if (select) {
      const option = Array.from(select.options).find(
        (o) => o.text.trim().toLowerCase() === value.toLowerCase() || o.value === value
      );
      if (!option) return false;
      select.value = option.value;
      select.dispatchEvent(createEvent('input', { bubbles: true }));
      select.dispatchEvent(createEvent('change', { bubbles: true }));
      return true;
    }

    const listbox = container.querySelector<HTMLElement>('[role="listbox"]');
    if (listbox) {
      // Click listbox to open options if necessary
      this.dispatchUserClick(listbox);

      // Search for options inside container or open popup in document
      let options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
      if (options.length === 0) {
        options = Array.from(doc.querySelectorAll<HTMLElement>('[role="option"]'));
      }

      const matchOpt = options.find((opt) => {
        const text = (opt.getAttribute('data-value') || opt.textContent || '').trim().toLowerCase();
        const v = value.toLowerCase().trim();
        return text === v || text.includes(v) || v.includes(text);
      });

      if (matchOpt) {
        this.dispatchUserClick(matchOpt);
        return true;
      }
      return false;
    }

    // 4. Standard Text Input / Textarea
    const input = container.querySelector<HTMLElement>('input, textarea, [role="textbox"]');
    if (input) {
      if (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA') {
        input.focus();
        const proto = input.tagName === 'TEXTAREA'
          ? (typeof HTMLTextAreaElement !== 'undefined' ? HTMLTextAreaElement.prototype : null)
          : (typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null);
        const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
        if (descriptor?.set) {
          descriptor.set.call(input, value);
        } else {
          (input as any).value = value;
          input.setAttribute('value', value);
        }
        input.dispatchEvent(createEvent('focus', { bubbles: true }));
        input.dispatchEvent(createEvent('input', { bubbles: true }));
        input.dispatchEvent(createEvent('change', { bubbles: true }));
        input.dispatchEvent(createEvent('keyup', { bubbles: true, key: 'Unidentified' }));
        input.dispatchEvent(createEvent('blur', { bubbles: true }));
        return true;
      } else {
        // [role="textbox"]
        input.focus();
        input.textContent = value;
        input.dispatchEvent(createEvent('input', { bubbles: true }));
        input.dispatchEvent(createEvent('change', { bubbles: true }));
        input.dispatchEvent(createEvent('blur', { bubbles: true }));
        return true;
      }
    }

    return false;
  }

  private dispatchUserClick(element: HTMLElement): void {
    element.dispatchEvent(createEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(createEvent('mouseup', { bubbles: true, cancelable: true }));
    element.click();
    element.dispatchEvent(createEvent('change', { bubbles: true }));
  }

  private highlightFilled(element: HTMLElement): void {
    const origTransition = element.style.transition;
    const origBg = element.style.backgroundColor;
    element.style.transition = 'background-color 400ms ease';
    element.style.backgroundColor = 'rgba(79, 70, 229, 0.12)';
    setTimeout(() => {
      element.style.backgroundColor = origBg;
      element.style.transition = origTransition;
    }, 1500);
  }
}
