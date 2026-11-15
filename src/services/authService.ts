import { apiRequest, clearAuthStorage, getStoredToken, getStoredUser, setStoredToken, setStoredUser } from './apiClient';
import type { User } from './types';

interface AuthResponse {
  token: string;
  user: User;
}

export const authService = {
  isDemo: false,

  getSession(): User | null {
    const token = getStoredToken();
    if (!token) {
      clearAuthStorage();
      return null;
    }
    return getStoredUser<User>();
  },

  async getMe(): Promise<User | null> {
    const token = getStoredToken();
    if (!token) return null;
    try {
      const response = await apiRequest<{ user: User }>('/api/auth/me');
      setStoredUser(response.user);
      return response.user;
    } catch {
      clearAuthStorage();
      return null;
    }
  },

  async login(email: string, password: string): Promise<User> {
    if (!email.includes('@')) throw new Error('Enter a valid email address.');
    if (password.length < 6) throw new Error('Password must be at least 6 characters.');
    const response = await apiRequest<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });
    setStoredToken(response.token);
    setStoredUser(response.user);
    return response.user;
  },

  async signup(name: string, email: string, password: string): Promise<User> {
    if (name.trim().length < 2) throw new Error('Enter your full name.');
    if (!email.includes('@')) throw new Error('Enter a valid email address.');
    if (password.length < 8) throw new Error('Use at least 8 characters for your password.');
    const response = await apiRequest<AuthResponse>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase(), password }),
    });
    setStoredToken(response.token);
    setStoredUser(response.user);
    return response.user;
  },

  async requestPasswordReset(email: string): Promise<void> {
    if (!email.includes('@')) throw new Error('Enter a valid email address.');
  },

  async getGoogleSignInUrl(): Promise<string> {
    const data = await apiRequest<{ url: string }>('/api/auth/google/url?intent=signin');
    return data.url;
  },

  async signInWithGoogle(): Promise<void> {
    const url = await this.getGoogleSignInUrl();
    if (typeof window !== 'undefined' && url) {
      window.location.href = url;
    }
  },

  async handleOAuthToken(token: string): Promise<User> {
    setStoredToken(token);
    const response = await apiRequest<{ user: User }>('/api/auth/me');
    setStoredUser(response.user);
    return response.user;
  },

  async logout(): Promise<void> {
    clearAuthStorage();
    try {
      await apiRequest('/api/auth/logout', { method: 'POST', body: '{}' });
    } catch {
      // Ignore network errors during logout
    }
  },

  updateProfile(user: User): User {
    setStoredUser(user);
    return user;
  },
};
