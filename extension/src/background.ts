interface ExtensionSettings {
  confirmBeforeAutofill: boolean;
  requireSensitiveReview: boolean;
  allowLongAnswers: boolean;
}

interface FormFlowState {
  connection: { connected: boolean; accountEmail: string; version: string; lastSync: string };
  settings: ExtensionSettings;
  history: Array<{ id: string; website: string; url: string; timestamp: string; detected: number; filled: number; skipped: number; status: string }>;
}

const defaults: FormFlowState = {
  connection: { connected: false, accountEmail: '', version: '1.4.0', lastSync: 'Not connected' },
  settings: { confirmBeforeAutofill: true, requireSensitiveReview: true, allowLongAnswers: true },
  history: [],
};

async function getState(): Promise<FormFlowState> {
  const stored = await chrome.storage.local.get('formflow.state');
  const state = stored['formflow.state'] as FormFlowState | undefined;
  if (!state) {
    await chrome.storage.local.set({ 'formflow.state': defaults });
    return structuredClone(defaults);
  }
  return { ...defaults, ...state, connection: { ...defaults.connection, ...state.connection }, settings: { ...defaults.settings, ...state.settings } };
}

async function setState(state: FormFlowState): Promise<void> {
  await chrome.storage.local.set({ 'formflow.state': state });
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab is available.');
  return tab;
}

function isSupported(url?: string): boolean {
  return Boolean(url && /^https?:\/\//i.test(url));
}

function isGoogleFormsEditorUrl(url?: string): boolean {
  if (!url) return false;
  return /docs\.google\.com\/forms\//i.test(url) && (/\/edit(\?|\/|$)/i.test(url) || /\/builder(\?|\/|$)/i.test(url));
}

async function pingTab(tabId: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve(false);
      }
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, { type: 'FORMFLOW_PING' }, (res) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError || !res?.ok) resolve(false);
        else resolve(true);
      }
    });
  });
}

async function sendTabMessage<T>(tabId: number, message: unknown, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error('The page did not respond to the form scanner (timeout).'));
      }
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'Communication with tab failed.'));
        } else {
          resolve(response as T);
        }
      }
    });
  });
}

async function scanActiveTab() {
  const tab = await activeTab();
  if (!isSupported(tab.url)) {
    throw new Error('Open a regular http(s) page with a form, then try again. Chrome does not allow scanning browser or extension pages.');
  }

  // Check if active tab is a Google Forms editor page
  if (isGoogleFormsEditorUrl(tab.url)) {
    return {
      tab,
      scan: {
        url: tab.url,
        title: tab.title || 'Google Forms',
        adapter: 'Google Forms',
        isGoogleForms: true,
        isEditor: true,
        editorMessage: 'Google Forms editor detected. Open Preview or the responder link to fill the form.',
        fields: [],
        uploadFields: [],
        forms: 1,
        summary: { total: 0, matched: 0, needsReview: 0, unsupported: 0 },
      },
    };
  }

  // Ping content script; inject if not responding
  const isAlive = await pingTab(tab.id!);
  if (!isAlive) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
      // Brief pause to allow initialization
      await new Promise((r) => setTimeout(r, 60));
    } catch (err) {
      throw new Error(`Unable to inject scanner script: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const requestId = `req_${Date.now()}`;
  const response = await sendTabMessage<{ ok: boolean; data: any; error?: string }>(
    tab.id!,
    { type: 'FORMFLOW_SCAN', requestId },
    4500
  );

  if (!response?.ok) {
    throw new Error(response?.error ?? 'The page did not respond to the form scanner.');
  }

  return { tab, scan: response.data };
}

async function fillActiveTab(fills: Array<{ index: number; value: string }>) {
  const tab = await activeTab();
  if (!isSupported(tab.url)) throw new Error('This page cannot be filled.');

  const isAlive = await pingTab(tab.id!);
  if (!isAlive) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
    await new Promise((r) => setTimeout(r, 60));
  }

  const requestId = `fill_${Date.now()}`;
  const response = await sendTabMessage<{ ok: boolean; data: any; error?: string }>(
    tab.id!,
    { type: 'FORMFLOW_FILL', fills, requestId },
    6000
  );

  if (!response?.ok) {
    throw new Error(response?.error ?? 'The page did not accept the autofill request.');
  }

  return { tab, result: response.data };
}

export async function syncVaultWithBackend() {
  try {
    const res = await fetch('http://localhost:8787/api/extension/bootstrap', {
      credentials: 'include',
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.user && Array.isArray(data?.fields)) {
        await chrome.storage.local.set({
          'formflow.vault': data.fields,
          'formflow.collections': data.collections || [],
          'formflow.user': data.user,
        });
        const state = await getState();
        const next = {
          ...state,
          connection: {
            connected: true,
            accountEmail: data.user.email,
            version: '1.4.0',
            lastSync: 'Just now',
          },
        };
        await setState(next);
        return { ok: true, user: data.user, fields: data.fields, collections: data.collections };
      }
    }
  } catch {
    // Backend offline or not authenticated
  }
  return { ok: false };
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await getState();
  await setState({ ...state, connection: { ...state.connection, lastSync: 'Just now' } });
  await syncVaultWithBackend();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      switch (message?.type) {
        case 'GET_STATE': {
          sendResponse({ ok: true, data: await getState() });
          break;
        }
        case 'SYNC_VAULT': {
          const syncRes = await syncVaultWithBackend();
          const stored = await chrome.storage.local.get(['formflow.vault', 'formflow.collections', 'formflow.user']);
          sendResponse({
            ok: true,
            data: {
              synced: syncRes.ok,
              vault: stored['formflow.vault'] || [],
              collections: stored['formflow.collections'] || [],
              user: stored['formflow.user'] || null,
            },
          });
          break;
        }
        case 'GET_VAULT': {
          const stored = await chrome.storage.local.get(['formflow.vault', 'formflow.collections', 'formflow.user']);
          sendResponse({
            ok: true,
            data: {
              vault: stored['formflow.vault'] || [],
              collections: stored['formflow.collections'] || [],
              user: stored['formflow.user'] || null,
            },
          });
          break;
        }
        case 'CONNECT': {
          const state = await getState();
          const next = {
            ...state,
            connection: {
              ...state.connection,
              connected: true,
              accountEmail: message.email ?? state.connection.accountEmail,
              lastSync: 'Just now',
            },
          };
          await setState(next);
          await syncVaultWithBackend();
          sendResponse({ ok: true, data: next });
          break;
        }
        case 'DISCONNECT': {
          const state = await getState();
          const next = { ...state, connection: { ...state.connection, connected: false, lastSync: 'Disconnected' } };
          await setState(next);
          sendResponse({ ok: true, data: next });
          break;
        }
        case 'UPDATE_SETTINGS': {
          const state = await getState();
          const next = { ...state, settings: { ...state.settings, ...message.settings } };
          await setState(next);
          sendResponse({ ok: true, data: next });
          break;
        }
        case 'SCAN_ACTIVE_TAB': {
          const { tab, scan } = await scanActiveTab();
          sendResponse({ ok: true, data: { tab: { id: tab.id, url: tab.url, title: tab.title }, scan } });
          break;
        }
        case 'FILL_ACTIVE_TAB': {
          const { tab, result } = await fillActiveTab(Array.isArray(message.fills) ? message.fills : []);
          sendResponse({ ok: true, data: { tab: { id: tab.id, url: tab.url, title: tab.title }, result } });
          break;
        }
        case 'RECORD_HISTORY': {
          const state = await getState();
          const entry = {
            id: `hist_${Date.now()}`,
            website: message.website ?? 'Unknown page',
            url: message.url ?? '',
            timestamp: new Date().toISOString(),
            detected: Number(message.detected ?? 0),
            filled: Number(message.filled ?? 0),
            skipped: Number(message.skipped ?? 0),
            status: message.status ?? 'Completed',
          };
          const next = { ...state, history: [entry, ...state.history].slice(0, 25) };
          await setState(next);
          sendResponse({ ok: true, data: next.history });
          break;
        }
        case 'CLEAR_HISTORY': {
          const state = await getState();
          const next = { ...state, history: [] };
          await setState(next);
          sendResponse({ ok: true, data: next.history });
          break;
        }
        case 'OPEN_TAB':
        case 'OPEN_DASHBOARD': {
          await chrome.tabs.create({ url: message.url ?? 'http://localhost:5173/dashboard' });
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown extension request.' });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Extension request failed.' });
    }
  })();
  return true;
});
