/**
 * API client.
 *
 * Four things this file takes seriously, because getting them wrong is what
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
 *  4. A request that fails with 401 is refreshed and retried exactly once,
 *     transparently, and only then reported. See the auth bridge below.
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
  /** Opt out of the 401-refresh-retry path (used by the refresh call itself). */
  skipRefresh?: boolean;
}

/**
 * Auth bridge.
 *
 * The client cannot import the auth provider -- the provider imports the
 * client -- so the provider registers two callbacks here at mount and the
 * request path consults them. That keeps session renewal a property of *doing
 * anything*, rather than the responsibility of whichever screen remembered to
 * call refresh first.
 *
 * The alternative, which is what this replaced, is that the access token simply
 * expired. It lasts twelve hours, so in practice it expired in the middle of a
 * shift: a dispatcher would submit an incident and get "Not authenticated",
 * with no way to recover except signing out and back in, losing whatever was
 * half-entered. The refresh token was already being issued and stored and was
 * used in exactly one place -- during boot.
 */
interface AuthBridge {
  /** The current access token, read at request time rather than captured. */
  token: () => string | null;
  /** Exchange the refresh token for a new pair. Resolves to the new access token. */
  refresh: () => Promise<string | null>;
  /** Called when renewal has failed and the session is genuinely over. */
  onExpired: () => void;
}

let bridge: AuthBridge | null = null;

export function bindAuth(next: AuthBridge | null) {
  bridge = next;
}

/** Clear a session that could not be renewed. Screens route off this. */
export const SESSION_EXPIRED = 'medmesh.sessionExpired';

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const explicit = options.token;
  const first = await send<T>(path, options, explicit ?? bridge?.token() ?? null);

  // Only the auth endpoints themselves are exempt from renewal. Everything
  // else -- including reads -- gets one silent retry, because a stale token on a
  // GET is otherwise just as fatal to the screen as one on a write.
  if (!(first instanceof ApiError) || first.status !== 401 || options.skipRefresh || !bridge) {
    if (first instanceof ApiError) throw first;
    return first;
  }

  const renewed = await bridge.refresh();
  if (!renewed) {
    bridge.onExpired();
    throw first;
  }

  const second = await send<T>(path, options, renewed);
  if (second instanceof ApiError) throw second;
  return second;
}

/** One attempt. Errors come back as values so the caller can decide to retry. */
async function send<T>(
  path: string,
  options: RequestOptions,
  token: string | null,
): Promise<T | ApiError> {
  const { method = 'GET', body, signal, timeoutMs = REQUEST_TIMEOUT_MS, raw } = options;

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
    return new ApiError(
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
    const message = explain(response.status, detail);
    return new ApiError(response.status, detail, message);
  }

  return payload as T;
}

/**
 * Turn a server error body into a sentence an operator can act on.
 *
 * The lifecycle's 409 is the case worth naming: it carries `allowed_labels`,
 * the moves that *are* legal from where the trip currently is. Rendering
 * "Invalid status" would leave a driver with no idea what to press; rendering
 * the alternatives turns a refusal into the next action.
 */
function explain(status: number, detail: any): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const parts = detail.slice(0, 3).map((d) => {
      const loc = Array.isArray(d?.loc) ? d.loc.slice(1).join('.') : '';
      return loc ? `${loc}: ${d?.msg ?? 'invalid'}` : String(d?.msg ?? 'invalid value');
    });
    return parts.join('; ') || 'The request was rejected — check the highlighted fields';
  }
  if (detail && typeof detail === 'object') {
    if (detail.message) {
      const extra = Array.isArray(detail.allowed_labels) && detail.allowed_labels.length
        ? ` Allowed from here: ${detail.allowed_labels.join(', ')}.`
        : '';
      const blockers = Array.isArray(detail.blockers) && detail.blockers.length
        ? ` ${detail.blockers.join('; ')}`
        : '';
      return `${detail.message}${blockers}${extra}`;
    }
    if (detail.detail) return String(detail.detail);
  }
  if (status === 401) return 'Your session has ended — sign in again';
  if (status === 403) return 'Your account does not have access to this';
  return `Request failed (${status})`;
}

/**
 * A response the caller wants as raw text plus its headers.
 *
 * Exists for the CSV exports, which need the `Content-Disposition` filename the
 * server chose — that name carries the district and the time window, and
 * reconstructing it on the client would drift the moment either changes.
 */
async function getRaw(
  path: string,
  opts: Omit<RequestOptions, 'method' | 'body'> = {},
): Promise<{ body: string; contentDisposition: string | null; status: number }> {
  const perform = async (token: string | null) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  };

  let response = await perform(opts.token ?? bridge?.token() ?? null);

  if (response.status === 401 && bridge) {
    const renewed = await bridge.refresh();
    if (renewed) {
      response = await perform(renewed);
    } else {
      bridge.onExpired();
    }
  }

  const body = await response.text();
  if (!response.ok) {
    let detail: unknown = body;
    try {
      detail = JSON.parse(body)?.detail ?? body;
    } catch {
      /* the body was not JSON; the text is the best explanation available */
    }
    throw new ApiError(response.status, detail, explain(response.status, detail));
  }

  return {
    body,
    contentDisposition: response.headers.get('content-disposition'),
    status: response.status,
  };
}

export const api = {
  getRaw,
  get: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'PATCH', body }),
  del: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'DELETE' }),
};
