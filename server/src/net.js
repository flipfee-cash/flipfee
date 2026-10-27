// HTTP for the data sources: one paced queue per source (each source's rate limit), timeouts, 429 back-off with
// Retry-After, and a status line per source for /api/health.
import { redactText } from './log.js';

const UA = 'flipfee/0.1 (+https://flipfee.cash)';

/** Runs jobs one after another with at least `minIntervalMs` between starts. */
export class Gate {
  constructor(minIntervalMs, maxQueue = 200) {
    this.min = minIntervalMs;
    this.maxQueue = maxQueue;
    this.next = 0;
    this.q = [];
    this.timer = null;
  }

  run(fn, { front = false } = {}) {
    if (this.q.length >= this.maxQueue) return Promise.reject(Object.assign(new Error('source queue is full'), { code: 'BUSY' }));
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject };
      if (front) this.q.unshift(job);
      else this.q.push(job);
      this.pump();
    });
  }

  pump() {
    if (this.timer || !this.q.length) return;
    const wait = Math.max(0, this.next - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const job = this.q.shift();
      if (job) {
        this.next = Date.now() + this.min;
        Promise.resolve()
          .then(job.fn)
          .then(job.resolve, job.reject);
      }
      this.pump();
    }, wait);
    // no unref: a queued job is a promise someone awaits (the timer only exists while the queue is not empty)
  }

  /** No new request before `ms` from now (429, outage). */
  hold(ms) {
    this.next = Math.max(this.next, Date.now() + ms);
  }

  get queued() {
    return this.q.length;
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** A rate-limited JSON source with a health line. */
export class Source {
  constructor(name, { minIntervalMs = 1000, timeoutMs = 8000, headers = {}, maxQueue = 200, fetchFn = globalThis.fetch } = {}) {
    this.name = name;
    this.gate = new Gate(minIntervalMs, maxQueue);
    this.timeoutMs = timeoutMs;
    this.headers = { 'user-agent': UA, accept: 'application/json', ...headers };
    this.fetchFn = fetchFn;
    this.stats = { requests: 0, ok: 0, errors: 0, limited: 0, lastOkAt: 0, lastErrorAt: 0, lastError: null };
  }

  json(url, { timeoutMs = this.timeoutMs, front = false, allow404 = false } = {}) {
    return this.gate.run(() => this.fetchNow(url, { timeoutMs, allow404 }), { front });
  }

  /** A JSON POST (JSON-RPC) through the same gate. */
  post(url, body, { timeoutMs = this.timeoutMs, front = false } = {}) {
    return this.gate.run(() => this.fetchNow(url, { timeoutMs, body }), { front });
  }

  async fetchNow(url, { timeoutMs = this.timeoutMs, allow404 = false, body } = {}) {
    this.stats.requests++;
    try {
      const init = { headers: this.headers, signal: AbortSignal.timeout(timeoutMs) };
      if (body !== undefined) Object.assign(init, { method: 'POST', body: JSON.stringify(body), headers: { ...this.headers, 'content-type': 'application/json' } });
      const r = await this.fetchFn(url, init);
      if (r.status === 404 && allow404) {
        await r.body?.cancel?.().catch(() => {});
        this.ok();
        return null;
      }
      if (r.status === 429) {
        const ra = Number(r.headers.get('retry-after'));
        this.gate.hold(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 600) * 1000 : 30_000);
        this.stats.limited++;
        await r.body?.cancel?.().catch(() => {});
        throw new HttpError(429, `${this.name}: rate limited`);
      }
      if (!r.ok) {
        if (r.status >= 500) this.gate.hold(3_000);
        await r.body?.cancel?.().catch(() => {});
        throw new HttpError(r.status, `${this.name}: HTTP ${r.status}`);
      }
      const data = await r.json();
      this.ok();
      return data;
    } catch (e) {
      this.stats.errors++;
      this.stats.lastErrorAt = Date.now();
      this.stats.lastError = redactText(e?.name === 'TimeoutError' ? `${this.name}: timeout` : e?.message || String(e)).slice(0, 160);
      throw e;
    }
  }

  ok() {
    this.stats.ok++;
    this.stats.lastOkAt = Date.now();
  }

  status() {
    const s = this.stats;
    return {
      ok: !!s.lastOkAt && (!s.lastErrorAt || s.lastOkAt > s.lastErrorAt),
      lastOkAt: s.lastOkAt || null,
      requests: s.requests,
      errors: s.errors,
      rateLimited: s.limited,
      queued: this.gate.queued,
      lastError: s.lastError,
    };
  }
}

/** Resolves like `p`, or rejects with code TIMEOUT after `ms` (the slow work runs on; its result is dropped). */
export function withDeadline(p, ms, what = 'work') {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what} took longer than ${ms} ms`), { code: 'TIMEOUT' })), Math.max(0, ms));
  });
  Promise.resolve(p).catch(() => undefined);
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
