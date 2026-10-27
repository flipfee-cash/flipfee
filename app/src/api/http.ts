// JSON over /api (DESIGN.md §2.2). A wallet session adds `Authorization: Bearer <token>`.

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let tokenOf: () => string | null = () => null;
let onUnauthorized: () => void = () => undefined;

/** The session module registers how to read the bearer token and what to do on a 401. */
export function setAuth(get: () => string | null, on401: () => void): void {
  tokenOf = get;
  onUnauthorized = on401;
}

export const API_BASE = '/api';

interface Opts {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** 'need': fails without a session. 'try': adds the token when there is one. */
  auth?: 'need' | 'try';
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function api<T>(path: string, o: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const tok = o.auth ? tokenOf() : null;
  if (o.auth === 'need' && !tok) throw new ApiError(401, 'signIn', 'sign in first');
  if (tok) headers.authorization = 'Bearer ' + tok;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), o.timeoutMs ?? 15000);
  const onAbort = () => ac.abort();
  o.signal?.addEventListener('abort', onAbort);
  let r: Response;
  try {
    r = await fetch(API_BASE + path, {
      method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      signal: ac.signal,
    });
  } catch (e) {
    throw new ApiError(0, o.signal?.aborted ? 'aborted' : 'network', e instanceof Error ? e.message : 'network');
  } finally {
    window.clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
  }
  let data: unknown = null;
  const text = await r.text().catch(() => '');
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!r.ok) {
    const d = (data ?? {}) as { error?: unknown; code?: unknown; message?: unknown };
    const code = typeof d.code === 'string' ? d.code : typeof d.error === 'string' ? d.error : String(r.status);
    const msg = typeof d.message === 'string' ? d.message : typeof d.error === 'string' ? d.error : r.statusText;
    if (r.status === 401 && tok) onUnauthorized();
    throw new ApiError(r.status, code, msg);
  }
  return data as T;
}

export const get = <T>(path: string, o: Omit<Opts, 'method' | 'body'> = {}) => api<T>(path, o);
export const post = <T>(path: string, body: unknown, o: Omit<Opts, 'method' | 'body'> = {}) => api<T>(path, { ...o, method: 'POST', body });
export const del = <T>(path: string, o: Omit<Opts, 'method' | 'body'> = {}) => api<T>(path, { ...o, method: 'DELETE' });
