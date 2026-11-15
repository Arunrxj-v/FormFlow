import { defaultAdapterRegistry, type FillRequestItem } from './adapters/index.ts';

declare global {
  interface Window {
    __formflowInjected?: boolean;
    __formflowReady?: boolean;
  }
}

try {
  window.__formflowInjected = true;
  window.__formflowReady = true;
  document.documentElement.setAttribute('data-formflow-extension', 'installed');
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'FORMFLOW_EXTENSION_PING') {
      window.postMessage({ type: 'FORMFLOW_EXTENSION_PONG', version: '2.0.0' }, '*');
    }
  });
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
        sendResponse({ ok: true, data: scanData, requestId });
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
        const fills: FillRequestItem[] = Array.isArray(message.fills) ? message.fills : [];
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
