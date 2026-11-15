import { VAULT_SESSION_KEY } from '@shared/constants';

export interface KeySessionBackend {
  readonly kind: 'extension' | 'web' | 'memory';
  get(): Promise<string | null>;
  set(value: string | null): Promise<void>;
}

const hasChromeSession = (): boolean =>
  typeof chrome !== 'undefined' && Boolean(chrome.storage?.session?.get);

export class ChromeSessionBackend implements KeySessionBackend {
  readonly kind = 'extension' as const;

  async get(): Promise<string | null> {
    const result = await chrome.storage.session.get(VAULT_SESSION_KEY);
    const value = result[VAULT_SESSION_KEY];
    return typeof value === 'string' ? value : null;
  }

  async set(value: string | null): Promise<void> {
    if (value) await chrome.storage.session.set({ [VAULT_SESSION_KEY]: value });
    else await chrome.storage.session.remove(VAULT_SESSION_KEY);
  }
}

export class WebSessionBackend implements KeySessionBackend {
  readonly kind = 'web' as const;

  async get(): Promise<string | null> {
    try {
      return sessionStorage.getItem(VAULT_SESSION_KEY);
    } catch {
      return null;
    }
  }

  async set(value: string | null): Promise<void> {
    try {
      if (value) sessionStorage.setItem(VAULT_SESSION_KEY, value);
      else sessionStorage.removeItem(VAULT_SESSION_KEY);
    } catch {
      // Ignore unavailable session storage.
    }
  }
}

export class MemorySessionBackend implements KeySessionBackend {
  readonly kind = 'memory' as const;
  private value: string | null = null;

  async get(): Promise<string | null> {
    return this.value;
  }

  async set(value: string | null): Promise<void> {
    this.value = value;
  }
}

export function createDefaultSessionBackend(): KeySessionBackend {
  if (hasChromeSession()) return new ChromeSessionBackend();
  if (typeof sessionStorage !== 'undefined') return new WebSessionBackend();
  return new MemorySessionBackend();
}
