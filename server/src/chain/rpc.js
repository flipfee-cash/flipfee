// Solana JSON-RPC over HTTP for everything the server reads from chain: one paced queue (public endpoints answer 429
// to bursts), 429 back-off, and counters per method (the RPC load in /health: requests per minute by method). A
// web3.js Connection that goes through the same queue is available for libraries (the flipfee client).
import { Connection } from '@solana/web3.js';
import { Gate } from '../net.js';
import { redact, redactText } from '../log.js';

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export class Rpc {
  constructor({ url, wsUrl = undefined, minIntervalMs = 120, fetchFn = globalThis.fetch, timeoutMs = 20_000, now = () => Date.now() }) {
    this.url = url;
    this.wsUrl = wsUrl;
    this.gate = new Gate(minIntervalMs, 2_000);
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.nextId = 1;
    this.stats = { requests: 0, errors: 0, limited: 0, lastError: null, lastOkAt: 0 };
    this.byMethod = new Map(); // method → count
    this.times = []; // [t, method] of the last 10 minutes
    this.conn = null;
  }

  count(method) {
    this.stats.requests++;
    this.byMethod.set(method, (this.byMethod.get(method) ?? 0) + 1);
    const t = this.now();
    this.times.push([t, method]);
    if (this.times.length > 20_000 || this.times[0][0] < t - 600_000) {
      const cut = t - 600_000;
      let i = 0;
      while (i < this.times.length && this.times[i][0] < cut) i++;
      this.times.splice(0, i);
    }
  }

  /** One HTTP POST through the queue (429 → hold the queue, then retry up to `retries` times). */
  async send(body, { front = false, retries = 3, timeoutMs = this.timeoutMs } = {}) {
    for (let attempt = 0; ; attempt++) {
      const r = await this.gate.run(async () => {
        const res = await this.fetchFn(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 429) {
          const ra = Number(res.headers.get('retry-after'));
          this.gate.hold(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 2_000 * (attempt + 1));
          this.stats.limited++;
          await res.body?.cancel?.().catch(() => {});
          return { limited: true };
        }
        if (!res.ok) {
          await res.body?.cancel?.().catch(() => {});
          if (res.status >= 500) this.gate.hold(1_000);
          throw new RpcError(res.status, `rpc HTTP ${res.status}`);
        }
        return { json: await res.json() };
      }, { front });
      if (!r.limited) return r.json;
      if (attempt >= retries) throw new RpcError(429, 'rpc rate limited');
    }
  }

  /** `method(params)` → result; throws RpcError on a JSON-RPC error. */
  async call(method, params = [], opts = {}) {
    this.count(method);
    try {
      const j = await this.send({ jsonrpc: '2.0', id: this.nextId++, method, params }, opts);
      if (j?.error) throw new RpcError(j.error.code, j.error.message, j.error.data);
      this.stats.lastOkAt = this.now();
      return j?.result;
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = redactText(`${method}: ${e?.message ?? e}`).slice(0, 200);
      throw e;
    }
  }

  /** A web3.js Connection whose HTTP requests go through this queue and its counters. */
  connection() {
    if (this.conn) return this.conn;
    const fetchThrough = async (input, init) => {
      let methods = ['?'];
      try {
        const b = JSON.parse(init?.body ?? '{}');
        methods = (Array.isArray(b) ? b : [b]).map((x) => x?.method ?? '?');
      } catch {
        // keep '?'
      }
      for (const m of methods) this.count(m);
      return this.gate.run(() => this.fetchFn(input, init));
    };
    this.conn = new Connection(this.url, { commitment: 'confirmed', fetch: fetchThrough, disableRetryOnRateLimit: false, ...(this.wsUrl ? { wsEndpoint: this.wsUrl } : {}) });
    return this.conn;
  }

  /** Requests per minute over the last `ms`, by method. */
  load(ms = 60_000) {
    const cut = this.now() - ms;
    const by = {};
    let n = 0;
    for (let i = this.times.length - 1; i >= 0 && this.times[i][0] >= cut; i--) {
      by[this.times[i][1]] = (by[this.times[i][1]] ?? 0) + 1;
      n++;
    }
    const k = 60_000 / ms;
    return { perMin: Math.round(n * k * 10) / 10, byMethod: Object.fromEntries(Object.entries(by).map(([m, v]) => [m, Math.round(v * k * 10) / 10])) };
  }

  status() {
    return {
      url: redact(this.url),
      requests: this.stats.requests,
      errors: this.stats.errors,
      rateLimited: this.stats.limited,
      queued: this.gate.queued,
      lastOkAt: this.stats.lastOkAt || null,
      lastError: this.stats.lastError,
      last1m: this.load(60_000),
      last10m: this.load(600_000),
      total: Object.fromEntries(this.byMethod),
    };
  }
}
