// GET /api/stream (Server-Sent Events, forked from peek-sol). Flushes at once and stays unbuffered through proxies:
// no compression, `cache-control: no-cache, no-transform`, `x-accel-buffering: no`, Nagle off, a 2 KB comment first
// (some proxies hold small first chunks). Then one named event per bus event (`event: trade` … `event: want`, with
// `id:` = the event's ULID, so a reconnect sends Last-Event-ID and gets the gap replayed), `event: stats` every 5 s and `event: ping`
// every 15 s. Filters per client: `types` (event names) and `mints` (coins). The board's stream thins trades of coins
// off flipfee to SSE_TRADES_PER_SEC (they only draw dots); every trade of a flipfee coin goes out.

export function frame(event, data, id) {
  let out = '';
  if (id) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  for (const l of text.split('\n')) out += `data: ${l}\n`;
  return `${out}\n`;
}

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
};

const wanted = (c, ev) => (!c.types || c.types.has(ev.type)) && (!c.mints || !ev.mint || c.mints.has(ev.mint));

export class SseHub {
  /**
   * `tradesPerSec`: a client that asked for no coins (the board) gets at most this many trades per second of coins
   * that are not on flipfee (a token bucket, burst 2×); trades of flipfee coins always go out (their "this hour"
   * counts every fee). `priority()`: the mints that are never dropped.
   */
  constructor({ bus, statsFn, maxClients = 5_000, maxPerIp = 12, statsMs = 5_000, pingMs = 15_000, maxBuffered = 1_000_000, tradesPerSec = 25, priority = () => null }) {
    this.bus = bus;
    this.statsFn = statsFn;
    this.tradesPerSec = tradesPerSec;
    this.priority = priority;
    this.thinned = 0;
    this.maxClients = maxClients;
    this.maxPerIp = maxPerIp;
    this.maxBuffered = maxBuffered;
    this.clients = new Set();
    this.perIp = new Map();
    this.sent = 0;
    this.dropped = 0;
    this.unsub = bus.subscribe((ev) => this.broadcast(ev));
    this.statsTimer = setInterval(() => this.sendStats(), statsMs);
    this.pingTimer = setInterval(() => this.ping(), pingMs);
    this.statsTimer.unref?.();
    this.pingTimer.unref?.();
  }

  close() {
    this.unsub();
    clearInterval(this.statsTimer);
    clearInterval(this.pingTimer);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }

  /** Opens a stream. `headers`: extra response headers (CORS). Returns false when a limit says no. */
  open(req, res, { ip, headers = {}, after = null, types = null, mints = null } = {}) {
    const n = this.perIp.get(ip) ?? 0;
    if (this.clients.size >= this.maxClients || n >= this.maxPerIp) return false;
    this.perIp.set(ip, n + 1);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 30_000);
    req.socket.setTimeout(0);
    res.writeHead(200, { ...SSE_HEADERS, ...headers });
    res.flushHeaders?.();
    const client = { res, ip, types, mints, at: Date.now(), tokens: this.tradesPerSec * 2, refill: Date.now() };
    this.clients.add(client);
    res.write(`: ok${' '.repeat(2048)}\n\nretry: 3000\n\n`);
    if (after) for (const ev of this.bus.after(after, 500)) if (wanted(client, ev)) this.write(client, frame(ev.type, ev, ev.eid));
    const s = this.statsFn?.();
    if (s && (!types || types.has('stats'))) this.write(client, frame('stats', s));
    const done = () => {
      if (!this.clients.delete(client)) return;
      const k = (this.perIp.get(ip) ?? 1) - 1;
      if (k <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, k);
    };
    req.on('close', done);
    res.on('close', done);
    res.on('error', done);
    return true;
  }

  write(client, text) {
    const { res } = client;
    if (res.writableEnded || res.destroyed) return;
    if (res.writableLength > this.maxBuffered) {
      // a client that stopped reading: let it reconnect and replay instead of holding memory
      this.dropped++;
      res.destroy();
      return;
    }
    res.write(text);
    this.sent++;
  }

  /** Whether a board client takes this trade now (its bucket for trades of coins off flipfee). */
  take(c, ev, prio) {
    if (ev.type !== 'trade' || c.mints || !this.tradesPerSec || prio?.has(ev.mint)) return true;
    const t = Date.now();
    c.tokens = Math.min(this.tradesPerSec * 2, c.tokens + ((t - c.refill) / 1000) * this.tradesPerSec);
    c.refill = t;
    if (c.tokens < 1) {
      this.thinned++;
      return false;
    }
    c.tokens -= 1;
    return true;
  }

  broadcast(ev) {
    if (!this.clients.size) return;
    const text = frame(ev.type, ev, ev.eid);
    const prio = ev.type === 'trade' ? this.priority() : null;
    for (const c of this.clients) if (wanted(c, ev) && this.take(c, ev, prio)) this.write(c, text);
  }

  sendStats() {
    if (!this.clients.size) return;
    const s = this.statsFn?.();
    if (!s) return;
    const text = frame('stats', s);
    for (const c of this.clients) if (!c.types || c.types.has('stats')) this.write(c, text);
  }

  ping() {
    const text = frame('ping', { t: Date.now() });
    for (const c of this.clients) this.write(c, text);
  }

  status() {
    return { clients: this.clients.size, ips: this.perIp.size, sent: this.sent, dropped: this.dropped, thinnedTrades: this.thinned, tradesPerSec: this.tradesPerSec };
  }
}
