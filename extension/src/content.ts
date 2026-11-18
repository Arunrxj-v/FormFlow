import { defaultAdapterRegistry, type FillRequestItem } from './adapters/index.ts';

declare global {
  interface Window {
    __formflowInjected?: boolean;
    __formflowReady?: boolean;
  }
}

let lastScanToken: string | null = null;
let lastScanFingerprint = '';

function formFingerprint(): string {
  const controls = Array.from(document.querySelectorAll<HTMLElement>('input, textarea, select, [role="textbox"], [role="radio"], [role="checkbox"], [role="listbox"]'));
  return controls.map((element) => [
    element.tagName.toLowerCase(),
    element.getAttribute('type') ?? '',
    element.getAttribute('name') ?? '',
    element.getAttribute('id') ?? '',
    element.getAttribute('aria-label') ?? '',
    element.getAttribute('placeholder') ?? '',
  ].join(':')).join('|') + `|forms:${document.forms.length}`;
}

try {
  window.__formflowInjected = true;
  window.__formflowReady = true;
  document.documentElement.setAttribute('data-formflow-extension', 'installed');
} catch {
  // Ignore context errors
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const requestId = message?.requestId;

  // Scanner Ping / Ready check
  if (message?.type === 'FORMFLOW_PING' || message?.type === 'PING') {
    sendResponse({ ok: true, ready: true, version: '2.0.0', requestId });
    return true;
  }

  // Scan Active Page / Form
  if (message?.type === 'FORMFLOW_SCAN' || message?.type === 'SCAN') {
    (async () => {
      try {
        const scanData = defaultAdapterRegistry.scan(document);
        lastScanToken = crypto.randomUUID();
        lastScanFingerprint = formFingerprint();
        sendResponse({ ok: true, data: { ...scanData, scanToken: lastScanToken }, requestId });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Scanner execution failed.',
          requestId,
        });
      }
    })();
    return true;
  }

  // Fill Active Page / Form
  if (message?.type === 'FORMFLOW_FILL' || message?.type === 'FILL') {
    (async () => {
      try {
        if (typeof message.scanToken !== 'string' || !lastScanToken || message.scanToken !== lastScanToken) {
          sendResponse({ ok: false, error: 'The page changed after scanning. Rescan the form before filling.', requestId });
          return;
        }
        if (formFingerprint() !== lastScanFingerprint) {
          sendResponse({ ok: false, error: 'The form changed after scanning. Rescan the form before filling.', requestId });
          return;
        }
        const fills: FillRequestItem[] = Array.isArray(message.fills) ? message.fills : [];
        lastScanToken = null;
        const result = await defaultAdapterRegistry.fill(fills, document);
        sendResponse({ ok: true, data: result, requestId });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Autofill execution failed.',
          requestId,
        });
      }
    })();
    return true;
  }

  return false;
});
