const TOKEN_KEY = 'formflow.auth.token';
const USER_KEY = 'formflow.auth.user';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function getStoredUser<T>(): T | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function setStoredUser<T>(user: T | null): void {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function clearAuthStorage(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    // Also clean up any legacy mock keys
    localStorage.removeItem('formflow.demo.session.v1');
    localStorage.removeItem('formflow.demo.store.v2');
    localStorage.removeItem('formflow.demo.records');
    localStorage.removeItem('formflow.demo.store');
  } catch {
    // Ignore storage errors
  }
}

export async function apiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  headers.set('content-type', 'application/json');
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      ...options,
      headers,
    });
  } catch {
    const error = new Error('Cannot connect to FormFlow backend. Please check that the backend is running.');
    (error as unknown as { status: number }).status = 503;
    throw error;
  }

  if (response.status === 204) {
    return {} as T;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    let errorMsg = data?.error;
    if (!errorMsg) {
      if (response.status === 500) {
        errorMsg = 'FormFlow server error (500). Please check backend logs.';
      } else if (response.status === 502 || response.status === 503 || response.status === 504) {
        errorMsg = 'FormFlow backend is unavailable. Please verify the server is running on port 8787.';
      } else if (response.status === 401) {
        errorMsg = 'Invalid email or password.';
      } else {
        errorMsg = `Server returned error (${response.status})`;
      }
    }
    const error = new Error(errorMsg);
    (error as unknown as { status: number }).status = response.status;
    throw error;
  }

  return data as T;
}
