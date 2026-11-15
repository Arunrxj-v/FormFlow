import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleFormsAdapter } from '../src/adapters/GoogleFormsAdapter.ts';
import { FormAdapterRegistry } from '../src/adapters/index.ts';
import { matchOption } from '../src/lib/classifier.ts';

// Lightweight, accurate DOM simulation for Node test environment
class MockElement {
  tagName: string;
  attributes: Record<string, string> = {};
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  textContent: string = '';
  value: string = '';
  checked: boolean = false;
  hidden: boolean = false;
  style: Record<string, string> = {};
  disabled: boolean = false;
  readOnly: boolean = false;
  options: Array<{ value: string; text: string; selected?: boolean }> = [];
  selectedIndex: number = 0;
  eventListeners: Record<string, Function[]> = {};

  constructor(tagName: string, attributes: Record<string, string> = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this.textContent = text;
    if (attributes['value']) this.value = attributes['value'];
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === 'value') this.value = value;
    if (name === 'aria-checked') this.checked = value === 'true';
  }

  appendChild(child: MockElement): MockElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  closest<T extends MockElement>(selector: string): T | null {
    let curr: MockElement | null = this;
    while (curr) {
      if (curr.matches(selector)) return curr as unknown as T;
      curr = curr.parentElement;
    }
    return null;
  }

  matches(selector: string): boolean {
    const parts = selector.split(/\s*,\s*/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // Tag check if specified at beginning
      const tagMatch = trimmed.match(/^([a-zA-Z0-9_\-]+)/);
      if (tagMatch && this.tagName !== tagMatch[1].toUpperCase()) {
        continue;
      }

      // Check all [attr=val] or [attr]
      const attrRegex = /\[([a-zA-Z0-9_\-]+)(?:([*^$]?=)["']?([^"']*)["']?)?\]/g;
      let attrMatch: RegExpExecArray | null;
      let matchedAllAttrs = true;
      let hasAttrCheck = false;

      while ((attrMatch = attrRegex.exec(trimmed)) !== null) {
        hasAttrCheck = true;
        const attrName = attrMatch[1];
        const op = attrMatch[2];
        const expectedVal = attrMatch[3];
        const actualVal = this.getAttribute(attrName);
        if (actualVal === null) {
          matchedAllAttrs = false;
          break;
        }
        if (op === '=') {
          if (actualVal.toLowerCase() !== expectedVal.toLowerCase()) {
            matchedAllAttrs = false;
            break;
          }
        } else if (op === '*=') {
          if (!actualVal.toLowerCase().includes(expectedVal.toLowerCase())) {
            matchedAllAttrs = false;
            break;
          }
        }
      }
      if (!matchedAllAttrs) continue;

      // Class check if specified
      const classMatch = trimmed.match(/\.([a-zA-Z0-9_\-]+)/);
      if (classMatch) {
        const classes = (this.getAttribute('class') || '').split(/\s+/);
        if (!classes.includes(classMatch[1])) continue;
      }

      if (tagMatch || hasAttrCheck || classMatch) {
        return true;
      }
    }
    return false;
  }

  querySelector<T extends MockElement>(selector: string): T | null {
    const all = this.querySelectorAll<T>(selector);
    return all[0] ?? null;
  }

  querySelectorAll<T extends MockElement>(selector: string): T[] {
    const results: T[] = [];
    const walk = (node: MockElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) {
          results.push(child as unknown as T);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  addEventListener(event: string, handler: Function): void {
    this.eventListeners[event] = this.eventListeners[event] || [];
    this.eventListeners[event].push(handler);
  }

  dispatchEvent(event: any): boolean {
    const listeners = this.eventListeners[event.type || event] || [];
    for (const l of listeners) l(event);
    return true;
  }

  click(): void {
    this.dispatchEvent({ type: 'click', bubbles: true });
  }

  focus(): void {
    this.dispatchEvent({ type: 'focus', bubbles: true });
  }

  scrollIntoView(): void {}

  getBoundingClientRect() {
    return { width: 100, height: 40, top: 0, left: 0 };
  }
}

class MockDocument {
  location = { href: 'https://docs.google.com/forms/d/e/1FAIpQLSc.../viewform' };
  title = 'Application Form 2026 - Google Forms';
  body: MockElement = new MockElement('BODY');

  getElementById(id: string): MockElement | null {
    const find = (node: MockElement): MockElement | null => {
      if (node.getAttribute('id') === id) return node;
      for (const child of node.children) {
        const res = find(child);
        if (res) return res;
      }
      return null;
    };
    return find(this.body);
  }

  querySelector<T extends MockElement>(selector: string): T | null {
    if (this.body.matches(selector)) return this.body as unknown as T;
    return this.body.querySelector<T>(selector);
  }

  querySelectorAll<T extends MockElement>(selector: string): T[] {
    const res: T[] = [];
    if (this.body.matches(selector)) res.push(this.body as unknown as T);
    return res.concat(this.body.querySelectorAll<T>(selector));
  }
}

// Build standard 8-question respondent Google Form DOM
function buildSampleGoogleForm(): MockDocument {
  const doc = new MockDocument();
  const form = new MockElement('FORM', { action: 'https://docs.google.com/forms/u/0/d/e/.../formResponse' });
  doc.body.appendChild(form);

  const list = new MockElement('DIV', { role: 'list', 'aria-label': 'Questions' });
  form.appendChild(list);

  // 1. Short Answer: Full Name (Required)
  const q1 = new MockElement('DIV', { role: 'listitem' });
  q1.appendChild(new MockElement('DIV', { role: 'heading', 'aria-level': '3', class: 'M7eMe' }, 'Full Name *'));
  q1.appendChild(new MockElement('SPAN', { 'aria-label': 'Required question' }, '*'));
  const inputContainer1 = new MockElement('DIV', { class: 'Xb9hP' });
  const input1 = new MockElement('INPUT', { type: 'text', class: 'whsOnd', 'aria-labelledby': 'i1' });
  inputContainer1.appendChild(input1);
  q1.appendChild(inputContainer1);
  list.appendChild(q1);

  // 2. Paragraph: Academic Background
  const q2 = new MockElement('DIV', { role: 'listitem' });
  q2.appendChild(new MockElement('DIV', { role: 'heading', 'aria-level': '3' }, 'Describe your academic background'));
  const inputContainer2 = new MockElement('DIV', { class: 'Xb9hP' });
  const textarea2 = new MockElement('TEXTAREA', { class: 'KHxj8b', 'aria-labelledby': 'i2' });
  inputContainer2.appendChild(textarea2);
  q2.appendChild(inputContainer2);
  list.appendChild(q2);

  // 3. Multiple Choice: Branch (CT, CM, EC, EE, EEE)
  const q3 = new MockElement('DIV', { role: 'listitem' });
  q3.appendChild(new MockElement('DIV', { role: 'heading', 'aria-level': '3' }, 'Branch'));
  const radioGroup = new MockElement('DIV', { role: 'radiogroup', 'aria-label': 'Branch' });
  const branches = ['CT', 'CM', 'EC', 'EE', 'EEE'];
  branches.forEach((b) => {
    const row = new MockElement('DIV', { class: 'SGIOEc' });
    const radio = new MockElement('DIV', { role: 'radio', 'aria-checked': 'false', 'data-value': b, 'aria-label': b });
    row.appendChild(radio);
    row.appendChild(new MockElement('SPAN', { class: 'aDTYNe' }, b));
    radioGroup.appendChild(row);
  });
  q3.appendChild(radioGroup);
  list.appendChild(q3);

  // 4. Checkboxes: Technical Skills (Python, TypeScript, SQL, Docker)
  const q4 = new MockElement('DIV', { role: 'listitem' });
  q4.appendChild(new MockElement('DIV', { role: 'heading', 'aria-level': '3' }, 'Select your technical skills'));
  const checkGroup = new MockElement('DIV', { role: 'group' });
  const skills = ['Python', 'TypeScript', 'SQL', 'Docker'];
  skills.forEach((s) => {
    const row = new MockElement('DIV', { class: 'Y6FdBh' });
    const cb = new MockElement('DIV', { role: 'checkbox', 'aria-checked': 'false', 'data-value': s, 'aria-label': s });
    row.appendChild(cb);
    row.appendChild(new MockElement('SPAN', { class: 'aDTYNe' }, s));
    checkGroup.appendChild(row);
  });
  q4.appendChild(checkGroup);
  list.appendChild(q4);

  // 5. Dropdown: Semester (Semester 1 ... Semester 8)
  const q5 = new MockElement('DIV', { role: 'listitem' });
  q5.appendChild(new MockElement('DIV', { role: 'heading', 'aria-level': '3' }, 'Select your semester'));
  const listbox = new MockElement('DIV', { role: 'listbox', 'aria-label': 'Semester' });
  for (let i = 1; i <= 8; i++) {
    listbox.appendChild(new MockElement('DIV', { role: 'option', 'data-value': `Semester ${i}` }, `Semester ${i}`));
  }
  q5.appendChild(listbox);
  list.appendChild(q5);

  // 6. Date: Date of birth
  const q6 = new MockElement('DIV', { role: 'listitem' });
  q6.appendChild(new MockElement('DIV', { role: 'heading', 'aria-level': '3' }, 'Date of birth *'));
  q6.appendChild(new MockElement('INPUT', { type: 'date', 'aria-label': 'Date of birth' }));
  list.appendChild(q6);

  // 7. Email: Email address
  const q7 = new MockElement('DIV', { role: 'listitem' });
  q7.appendChild(new MockElement('DIV', { role: 'heading', 'aria-level': '3' }, 'Email address *'));
  q7.appendChild(new MockElement('INPUT', { type: 'email', 'aria-label': 'Email address' }));
  list.appendChild(q7);

  // 8. Number: Graduation Year
  const q8 = new MockElement('DIV', { role: 'listitem' });
  q8.appendChild(new MockElement('DIV', { role: 'heading', 'aria-level': '3' }, 'Graduation year'));
  q8.appendChild(new MockElement('INPUT', { type: 'number', 'aria-label': 'Graduation year' }));
  list.appendChild(q8);

  // Submit button (to test it is NEVER clicked)
  const submitBtn = new MockElement('BUTTON', { type: 'submit' }, 'Submit');
  submitBtn.addEventListener('click', () => {
    throw new Error('CRITICAL VIOLATION: Submit button was clicked during autofill!');
  });
  form.appendChild(submitBtn);

  return doc;
}

test('detects Google Forms respondent page vs editor page', () => {
  const adapter = new GoogleFormsAdapter();
  const doc = new MockDocument();

  // Responder page
  doc.location.href = 'https://docs.google.com/forms/d/e/1FAIpQLS.../viewform';
  assert.equal(adapter.isApplicable(doc as any, doc.location.href), true);
  assert.equal(adapter.detectEditor(doc as any, doc.location.href), null);

  // Editor page ending in /edit
  const editorUrl = 'https://docs.google.com/forms/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit';
  const editorCheck = adapter.detectEditor(doc as any, editorUrl);
  assert.ok(editorCheck !== null);
  assert.equal(editorCheck.isEditor, true);
  assert.equal(
    editorCheck.message,
    'Google Forms editor detected. Open Preview or the responder link to fill the form.'
  );
});

test('scans all 8 Google Forms question types with accessible structure', () => {
  const doc = buildSampleGoogleForm();
  const adapter = new GoogleFormsAdapter();
  const scanResult = adapter.scan(doc as any);

  assert.equal(scanResult.isGoogleForms, true);
  assert.equal(scanResult.isEditor, false);
  assert.equal(scanResult.fields.length, 8);

  // 1. Short answer: Name
  const f1 = scanResult.fields[0];
  assert.equal(f1.label, 'Full Name');
  assert.equal(f1.kind, 'fullName');
  assert.equal(f1.questionType, 'text');
  assert.equal(f1.required, true);

  // 2. Paragraph: Academic Background
  const f2 = scanResult.fields[1];
  assert.equal(f2.label, 'Describe your academic background');
  assert.equal(f2.kind, 'longAnswer');
  assert.equal(f2.questionType, 'paragraph');

  // 3. Multiple Choice: Branch
  const f3 = scanResult.fields[2];
  assert.equal(f3.label, 'Branch');
  assert.equal(f3.kind, 'branch');
  assert.equal(f3.questionType, 'radio');
  assert.deepEqual(f3.options, ['CT', 'CM', 'EC', 'EE', 'EEE']);

  // 4. Checkboxes: Technical skills
  const f4 = scanResult.fields[3];
  assert.equal(f4.label, 'Select your technical skills');
  assert.equal(f4.kind, 'skills');
  assert.equal(f4.questionType, 'checkbox');
  assert.deepEqual(f4.options, ['Python', 'TypeScript', 'SQL', 'Docker']);

  // 5. Dropdown: Semester
  const f5 = scanResult.fields[4];
  assert.equal(f5.label, 'Select your semester');
  assert.equal(f5.kind, 'semester');
  assert.equal(f5.questionType, 'dropdown');
  assert.equal(f5.options?.length, 8);

  // 6. Date: Date of birth
  const f6 = scanResult.fields[5];
  assert.equal(f6.label, 'Date of birth');
  assert.equal(f6.kind, 'dateOfBirth');
  assert.equal(f6.questionType, 'date');
  assert.equal(f6.required, true);

  // 7. Email: Email address
  const f7 = scanResult.fields[6];
  assert.equal(f7.label, 'Email address');
  assert.equal(f7.kind, 'email');
  assert.equal(f7.questionType, 'email');
  assert.equal(f7.required, true);

  // 8. Number: Graduation Year
  const f8 = scanResult.fields[7];
  assert.equal(f8.label, 'Graduation year');
  assert.equal(f8.kind, 'graduationYear');
  assert.equal(f8.questionType, 'number');
});

test('populates Google Forms fields correctly without submitting the form', async () => {
  const doc = buildSampleGoogleForm();
  const adapter = new GoogleFormsAdapter();
  adapter.scan(doc as any);

  // Stored branch in vault: "Computer Science and Engineering"
  // Should match branch option 'CT' via semantic option matching!
  const branchOption = matchOption('Computer Science and Engineering', ['CT', 'CM', 'EC', 'EE', 'EEE'], 'branch');
  assert.equal(branchOption?.match, 'CT');

  // Fills array
  const fills = [
    { index: 0, value: 'Arunraj V.' },
    { index: 1, value: 'Holds B.Tech in CSE with focus on intelligent software.' },
    { index: 2, value: 'CT' }, // Radio
    { index: 3, value: 'Python, TypeScript' }, // Checkboxes
    { index: 4, value: 'Semester 6' }, // Dropdown
    { index: 5, value: '2001-05-14' }, // Date
    { index: 6, value: 'arun@example.com' }, // Email
    { index: 7, value: '2025' }, // Number
  ];

  const fillResult = await adapter.fill(fills, doc as any);
  assert.equal(fillResult.filled, 8);
  assert.equal(fillResult.failed, 0);
  assert.equal(fillResult.skipped.length, 0);

  // Verify Short Answer populated
  const nameInput = doc.querySelector('input.whsOnd') as any;
  assert.equal(nameInput.value, 'Arunraj V.');

  // Verify Paragraph populated
  const descTextarea = doc.querySelector('textarea.KHxj8b') as any;
  assert.equal(descTextarea.value, 'Holds B.Tech in CSE with focus on intelligent software.');

  // Verify Radio 'CT' selected
  const ctRadio = doc.querySelector('div[role="radio"][data-value="CT"]') as any;
  assert.equal(ctRadio.getAttribute('aria-checked'), 'true');

  // Verify Checkboxes 'Python' & 'TypeScript' checked
  const pyCb = doc.querySelector('div[role="checkbox"][data-value="Python"]') as any;
  const tsCb = doc.querySelector('div[role="checkbox"][data-value="TypeScript"]') as any;
  const sqlCb = doc.querySelector('div[role="checkbox"][data-value="SQL"]') as any;
  assert.equal(pyCb.getAttribute('aria-checked'), 'true');
  assert.equal(tsCb.getAttribute('aria-checked'), 'true');
  assert.equal(sqlCb.getAttribute('aria-checked'), 'false');

  // Verify Email & Date & Year populated
  const emailInput = doc.querySelector('input[type="email"]') as any;
  assert.equal(emailInput.value, 'arun@example.com');
  const dateInput = doc.querySelector('input[type="date"]') as any;
  assert.equal(dateInput.value, '2001-05-14');
  const yearInput = doc.querySelector('input[type="number"]') as any;
  assert.equal(yearInput.value, '2025');
});

test('FormAdapterRegistry selects GoogleFormsAdapter on Google Forms and returns editor warning on /edit', () => {
  const registry = new FormAdapterRegistry();
  const doc = new MockDocument();

  // Test editor detection
  doc.location.href = 'https://docs.google.com/forms/d/e/1FAIpQLSc.../edit';
  const editorScan = registry.scan(doc as any);
  assert.equal(editorScan.isEditor, true);
  assert.equal(editorScan.isGoogleForms, true);
  assert.equal(
    editorScan.editorMessage,
    'Google Forms editor detected. Open Preview or the responder link to fill the form.'
  );

  // Test responder detection
  doc.location.href = 'https://docs.google.com/forms/d/e/1FAIpQLSc.../viewform';
  const adapter = registry.getAdapter(doc as any, doc.location.href);
  assert.equal(adapter.name, 'Google Forms');
});
