export interface KeySessionBackend {
  readonly kind: 'web' | 'memory';
  get(): Promise<string | null>;
  set(value: string | null): Promise<void>;
}

export class WebSessionBackend implements KeySessionBackend {
  readonly kind = 'web' as const;

  async get(): Promise<string | null> {
    try {
      return sessionStorage.getItem('formflow.vault.session_key');
    } catch {
      return null;
    }
  }

  async set(value: string | null): Promise<void> {
    try {
      if (value) sessionStorage.setItem('formflow.vault.session_key', value);
      else sessionStorage.removeItem('formflow.vault.session_key');
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
  // In the extension the DEK is memory-only inside the service worker. It is
  // never written to chrome.storage.session, which extension pages can read.
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) return new MemorySessionBackend();
  if (typeof sessionStorage !== 'undefined') return new WebSessionBackend();
  return new MemorySessionBackend();
}
