// Trades of the tracked coins with their exact creator fees (forked from peek-sol): one RPC WebSocket (mainnet; the
// local validator in a localnet test), `logsSubscribe` with `mentions: [address]` per tracked coin: its bonding curve
// while on pump.fun (TradeEvent), its PumpSwap pool once graduated (BuyEvent / SellEvent). Every successful
// transaction's logs are decoded (pumpevents.js). Subscriptions are paced, kept in step with the tracker's target set,
// and sent again after every reconnect. A confirmed subscription starts the coin's coverage (its fee windows can be
// exact from then on); an unsubscribe or a dropped socket ends it. After a dropped socket, the caller may read the
// gap's transactions from chain (`onGap`: the newest signature seen before the drop bounds them). A curve that logs its
// migration reports the pool.
import { log } from '../log.js';
import { migrationsFromLogs, swapsFromLogs, swapTrade, tradesFromLogs } from './pumpevents.js';
import { WsClient } from './ws.js';

export class CurveLogs {
  constructor({ url, WebSocketImpl, onTrade, onCover, onMigrate, onGap, sendPerSec = 5, heartbeatMs = 30_000, stallMs = 90_000, now = () => Date.now() }) {
    this.onTrade = onTrade;
    this.onCover = onCover;
    this.onMigrate = onMigrate;
    this.onGap = onGap;
    this.lastSig = new Map(); // address → the newest signature notified (the lower bound of a gap's backfill)
    this.perAddr = new Map(); // address → { mint, since, msgs, trades }: the load each subscription brings
    this.gapFrom = new Map(); // address → when a dropped socket ended its coverage
    this.now = now;
    this.targets = new Map(); // address → { mint, kind: 'curve' | 'pool', quoteMint }
    this.subs = new Map(); // address → { mint, subId?, reqId, at, cancel? }
    this.bySub = new Map(); // subId → address
    this.reqs = new Map(); // reqId → { kind, address }
    this.failed = new Map(); // address → retry-after ms
    this.seen = new Set(); // sig:index, for transactions that touch two tracked addresses
    this.seenList = [];
    this.nextId = 1;
    this.counts = { notifications: 0, failedTx: 0, trades: 0, subErrors: 0, migrations: 0, bytes: 0 };
    this.tradeTimes = [];
    this.heartbeatMs = heartbeatMs;
    this.ws = new WsClient({
      name: 'trades',
      url,
      WebSocketImpl,
      stallMs,
      sendPerSec,
      onOpen: () => this.opened(),
      onMessage: (d) => this.message(d),
      onClose: () => this.closed(),
    });
  }

  start() {
    this.ws.start();
    this.hb = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.hb.unref?.();
  }

  stop() {
    clearInterval(this.hb);
    this.closed();
    this.ws.stop();
  }

  opened() {
    this.subs.clear();
    this.bySub.clear();
    this.reqs.clear();
    this.sync();
  }

  /** The socket dropped: every coin's coverage ends now (the gap is remembered for a backfill after the reconnect). */
  closed() {
    const t = this.now();
    for (const [address, s] of this.subs) {
      if (s.subId === undefined) continue;
      this.onCover?.(s.mint, false, t);
      if (!this.gapFrom.has(address)) this.gapFrom.set(address, t);
    }
    this.subs.clear();
    this.bySub.clear();
  }

  /** Map mint → { key: curve or pool address, kind: 'curve' | 'pool', quoteMint? }. */
  setTargets(byMint) {
    const next = new Map();
    for (const [mint, v] of byMint) {
      if (!v?.key) continue;
      next.set(v.key, { mint, kind: v.kind === 'pool' ? 'pool' : 'curve', quoteMint: v.quoteMint ?? null });
    }
    this.targets = next;
    this.targetMints = new Set([...next.values()].map((x) => x.mint));
    this.sync();
  }

  sync() {
    if (!this.ws.open) return;
    const t = this.now();
    for (const [address, tg] of this.targets) {
      if (this.subs.has(address)) continue;
      if ((this.failed.get(address) ?? 0) > t) continue;
      const id = this.nextId++;
      this.subs.set(address, { mint: tg.mint, reqId: id, at: t });
      this.reqs.set(id, { kind: 'sub', address });
      this.ws.send({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [address] }, { commitment: 'confirmed' }] });
    }
    for (const address of [...this.gapFrom.keys()]) if (!this.targets.has(address)) this.gapFrom.delete(address);
    for (const address of [...this.perAddr.keys()]) if (!this.targets.has(address)) this.perAddr.delete(address);
    for (const [address, s] of this.subs) {
      if (this.targets.has(address)) continue;
      this.subs.delete(address);
      if (s.subId !== undefined) {
        this.onCover?.(s.mint, false, t);
        this.unsubscribe(s.subId);
      } else s.cancel = true;
    }
  }

  unsubscribe(subId) {
    this.bySub.delete(subId);
    const id = this.nextId++;
    this.reqs.set(id, { kind: 'unsub' });
    this.ws.send({ jsonrpc: '2.0', id, method: 'logsUnsubscribe', params: [subId] });
  }

  heartbeat() {
    // any answer proves the socket is alive (the pubsub endpoint answers unknown methods with an error)
    if (!this.ws.open) return;
    const id = this.nextId++;
    this.reqs.set(id, { kind: 'ping' });
    this.ws.send({ jsonrpc: '2.0', id, method: 'getHealth' });
  }

  /** Decodes one notification's logs into trades for the tracked coins. */
  handleLogs(address, v) {
    const tg = this.targets.get(address);
    const trades = tradesFromLogs(v.logs);
    for (const sw of swapsFromLogs(v.logs)) {
      const pool = this.targets.get(sw.pool);
      if (pool?.kind === 'pool') trades.push(swapTrade(sw, pool.mint, pool.quoteMint));
    }
    if (tg?.kind === 'curve') {
      for (const mg of migrationsFromLogs(v.logs)) {
        if (mg.mint !== tg.mint) continue;
        this.counts.migrations++;
        this.onMigrate?.({ mint: mg.mint, pool: mg.pool, quoteMint: mg.quoteMint, sig: v.signature });
      }
    }
    const now = this.now();
    trades.forEach((tr, i) => {
      const key = `${v.signature}:${i}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.seenList.push(key);
      if (this.seenList.length > 20_000) this.seen.delete(this.seenList.shift());
      // a transaction can trade several coins: each event names its own mint
      if (!this.isTarget(tr.mint)) return;
      this.counts.trades++;
      const pa = this.perAddr.get(address);
      if (pa && pa.mint === tr.mint) pa.trades++;
      this.tradeTimes.push(now);
      this.onTrade?.({ ...tr, sig: v.signature, ix: i, t: tr.ts ? Math.min(now, tr.ts * 1000) : now });
    });
    if (this.tradeTimes.length > 50_000) this.tradeTimes.splice(0, 25_000);
  }

  isTarget(mint) {
    return !!this.targetMints?.has(mint);
  }

  message(d) {
    if (d?.method === 'logsNotification') {
      this.counts.notifications++;
      const v = d.params?.result?.value;
      const address = this.bySub.get(d.params?.subscription);
      if (!v || !address) return;
      if (v.signature) this.lastSig.set(address, v.signature);
      const pa = this.perAddr.get(address);
      if (pa) pa.msgs++;
      if (v.err) {
        this.counts.failedTx++;
        return;
      }
      this.handleLogs(address, v);
      return;
    }
    if (d?.id === undefined) return;
    const req = this.reqs.get(d.id);
    this.reqs.delete(d.id);
    if (!req || req.kind !== 'sub') return;
    const s = this.subs.get(req.address);
    if (d.error || d.result === undefined) {
      this.counts.subErrors++;
      if (s && s.reqId === d.id) this.subs.delete(req.address);
      this.failed.set(req.address, this.now() + 60_000);
      if (this.counts.subErrors <= 5 || this.counts.subErrors % 50 === 0) log('trades.sub.fail', { error: String(d.error?.message ?? 'no result').slice(0, 120), n: this.counts.subErrors });
      return;
    }
    if (!s || s.reqId !== d.id || s.cancel) {
      // the coin left the target set while the request was in flight
      this.unsubscribe(d.result);
      return;
    }
    s.subId = d.result;
    this.bySub.set(d.result, req.address);
    const t = this.now();
    if (!this.perAddr.has(req.address)) this.perAddr.set(req.address, { mint: s.mint, since: t, msgs: 0, trades: 0 });
    this.onCover?.(s.mint, true, t);
    // back after a dropped socket: the trades of the gap can be read from chain (the caller decides for which coins)
    const from = this.gapFrom.get(req.address);
    this.gapFrom.delete(req.address);
    if (from !== undefined) this.onGap?.({ mint: s.mint, address: req.address, untilSig: this.lastSig.get(req.address) ?? null, from, to: t });
  }

  /** Map mint → { msgPerSec, tradesPerSec } of each subscription followed for at least `minMs`. */
  loadByMint(minMs = 60_000) {
    const t = this.now();
    const out = new Map();
    for (const pa of this.perAddr.values()) {
      const sec = (t - pa.since) / 1000;
      if (sec * 1000 < minMs) continue;
      out.set(pa.mint, { msgPerSec: pa.msgs / sec, tradesPerSec: pa.trades / sec });
    }
    return out;
  }

  tradesPerMin(ms = 60_000) {
    const cut = this.now() - ms;
    let n = 0;
    for (let i = this.tradeTimes.length - 1; i >= 0 && this.tradeTimes[i] >= cut; i--) n++;
    return Math.round((n / ms) * 60_000);
  }

  status() {
    let active = 0;
    for (const s of this.subs.values()) if (s.subId !== undefined) active++;
    const ws = this.ws.status();
    return { ...ws, targets: this.targets.size, subscribed: active, pending: this.subs.size - active, ...this.counts, tradesPerMin: this.tradesPerMin() };
  }
}

/**
 * Several trade sockets side by side (TRADES_CONNS; 2 on the public endpoint): each address always lands on the same
 * socket (a hash of the address), so a dropped socket costs only its share of the coins and each socket carries less.
 * Same interface as one CurveLogs.
 */
export class TradeFeeds {
  constructor(n, make) {
    this.feeds = Array.from({ length: Math.max(1, n) }, (_, i) => make(i));
  }

  feedOf(address) {
    let h = 0;
    for (let i = 0; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
    return this.feeds[h % this.feeds.length];
  }

  start() {
    for (const f of this.feeds) f.start();
  }

  stop() {
    for (const f of this.feeds) f.stop();
  }

  setTargets(byMint) {
    const parts = this.feeds.map(() => new Map());
    for (const [mint, v] of byMint) if (v?.key) parts[this.feeds.indexOf(this.feedOf(v.key))].set(mint, v);
    this.feeds.forEach((f, i) => f.setTargets(parts[i]));
  }

  handleLogs(address, v) {
    this.feedOf(address).handleLogs(address, v);
  }

  loadByMint(minMs) {
    const out = new Map();
    for (const f of this.feeds) for (const [m, v] of f.loadByMint(minMs)) out.set(m, v);
    return out;
  }

  status() {
    const all = this.feeds.map((f) => f.status());
    const sum = (k) => all.reduce((s, x) => s + (Number(x[k]) || 0), 0);
    const out = { connected: all.every((x) => x.connected), sockets: all.length, url: all[0]?.url };
    for (const k of ['targets', 'subscribed', 'pending', 'notifications', 'failedTx', 'trades', 'subErrors', 'migrations', 'messages', 'bytes', 'connects', 'reconnects', 'tradesPerMin']) out[k] = sum(k);
    out.last1m = { msgPerSec: Math.round(all.reduce((s, x) => s + x.last1m.msgPerSec, 0) * 10) / 10, kbPerSec: Math.round(all.reduce((s, x) => s + x.last1m.kbPerSec, 0) * 10) / 10 };
    out.perSocket = all.map((x) => ({ connected: x.connected, subscribed: x.subscribed, ...x.last1m, reconnects: x.reconnects, lastError: x.lastError }));
    return out;
  }
}
