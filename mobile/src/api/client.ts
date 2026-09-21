/**
 * API client.
 *
 * Three things this file takes seriously, because getting them wrong is what
 * makes a prototype feel like a prototype:
 *
 *  1. Base URL resolution differs per platform. A physical Android device
 *     reaches the host machine through an Expo LAN IP, an emulator through
 *     10.0.2.2, the web build through the same origin it was served from. All
 *     three are handled, plus an explicit override.
 *  2. Every response error surfaces as a typed ApiError carrying the server's
 *     `detail`, so screens can show "No free ICU to hold at SRMC" instead of
 *     "Something went wrong".
 *  3. Requests time out. A hung fetch on a dispatcher console is worse than a
 *     visible failure, because the operator keeps acting on stale data.
 */

import Constants from 'expo-constants';
import { Platform } from 'react-native';

export const API_PREFIX = '/api/v1';
const DEFAULT_PORT = 8000;
const REQUEST_TIMEOUT_MS = 12_000;

function resolveHost(): string {
  // 1. Explicit override wins — .env, EAS secrets, or `EXPO_PUBLIC_API_URL=...`
  const override = process.env.EXPO_PUBLIC_API_URL;
  if (override) return override.replace(/\/$/, '');

  // 2. Web: same origin the bundle was served from. The Expo dev server proxies
  //    /api and /ws through to the backend, so the browser never needs to
  //    resolve `localhost` itself (which it cannot, in a sandboxed preview).
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }

  // 3. Native: derive the host from the Metro bundler URI, which is the machine
  //    running the backend during development.
  const legacy = (Constants as unknown as { manifest?: { debuggerHost?: string } }).manifest;
  const hostUri = Constants.expoConfig?.hostUri ?? legacy?.debuggerHost ?? '';
  const host = hostUri.split(':')[0];

  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    return `http://${host}:${DEFAULT_PORT}`;
  }

  // 4. Android emulator maps the host loopback to 10.0.2.2.
  if (Platform.OS === 'android') return `http://10.0.2.2:${DEFAULT_PORT}`;
  return `http://localhost:${DEFAULT_PORT}`;
}

export const BASE_URL = resolveHost();
export const API_BASE = `${BASE_URL}${API_PREFIX}`;

export function wsUrl(path: string, token?: string | null): string {
  const base = BASE_URL.replace(/^http/, 'ws');
  const sep = path.includes('?') ? '&' : '?';
  return `${base}${path}${token ? `${sep}token=${encodeURIComponent(token)}` : ''}`;
}

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown, message: string) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.name = 'ApiError';
  }

  /** Server-issued explanation, if the payload carried one. */
  get isAuth() {
    return this.status === 401;
  }

  get fieldErrors(): string[] {
    if (Array.isArray(this.detail)) {
      return this.detail.map((d: any) => {
        const loc = Array.isArray(d?.loc) ? d.loc.slice(1).join('.') : '';
        return loc ? `${loc}: ${d?.msg}` : String(d?.msg ?? 'invalid value');
      });
    }
    if (this.detail && typeof this.detail === 'object' && 'blockers' in (this.detail as any)) {
      const b = (this.detail as any).blockers;
      return Array.isArray(b) ? b : [String(b)];
    }
    return [];
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Set for endpoints that return text (CSV exports). */
  raw?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, signal, timeoutMs = REQUEST_TIMEOUT_MS, raw } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error)?.name === 'AbortError';
    throw new ApiError(
      0,
      null,
      aborted ? 'Request timed out — check the connection' : 'Cannot reach the MedMesh API',
    );
  }
  clearTimeout(timer);

  if (response.status === 204) return undefined as T;

  if (raw) {
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(response.status, text, `Export failed (${response.status})`);
    }
    return (await response.text()) as unknown as T;
  }

  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const detail = payload?.detail ?? payload;
    const message =
      typeof detail === 'string'
        ? detail
        : detail?.message
          ? String(detail.message)
          : Array.isArray(detail)
            ? 'The request was rejected — check the highlighted fields'
            : `Request failed (${response.status})`;
    throw new ApiError(response.status, detail, message);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'PATCH', body }),
  del: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'DELETE' }),
};
