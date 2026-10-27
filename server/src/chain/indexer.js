// The flipfee index: the Config and every Coin account (getProgramAccounts at start and every INDEX_POLL_MS, then
// `programSubscribe` for changes), the program's events (`logsSubscribe` mentioning the program, plus a signature
// backfill that also catches what a dropped socket missed), and what they add up to: live and queued windows, the
// window history (the Coin account prunes ended, paid windows), hours sold, payouts, today's totals, a wallet's hours
// and coins. Stream events: `register` (a new Coin), `window` (windows or terms changed), `buy` (HoursBought),
// `paid` (Paid), `fee` (FeesSynced). Read-only: the keeper (program/keeper) sends the transactions.
import { Db } from '../db.js';
import { amount } from '../metrics.js';
import { log, logError } from '../log.js';
import { WsClient } from '../ingest/ws.js';
import bs58 from 'bs58';

const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex'); // Anchor emit_cpi! instruction prefix
const S = 1000;

/** A window as the API sends it (times in ms; lamports as strings plus SOL). */
export function winOut(w, extra = {}) {
  const out = { holder: w.holder, start: w.start * S, end: w.end * S, earned: amount(w.earned), owed: amount(w.owed ?? 0), paid: amount(Math.max(0, (w.earned ?? 0) - (w.owed ?? 0))) };
  if (w.cost) out.cost = amount(w.cost);
  if (w.sig) out.sig = w.sig;
  return { ...out, ...extra };
}

export class Indexer {
  constructor({ adapter, rpc, wsUrl, WebSocketImpl = globalThis.WebSocket, db, bus, pollMs = 30_000, now = () => Date.now() }) {
    Object.assign(this, { adapter, rpc, db, bus, pollMs, now });
    this.wsUrl = wsUrl;
    this.WebSocketImpl = WebSocketImpl;
    this.config = null;
    this.coins = new Map(); // mint → normCoin (+ registeredAt)
    this.byAddress = new Map(); // Coin PDA → mint
    this.loaded = false;
    this.counts = { accounts: 0, updates: 0, events: 0, backfilled: 0, txFetched: 0, errors: 0 };
    this.timers = [];
    this.ws = null;
    this.polls = 0;
    this.doneSigs = new Set(); // signatures already read (live logs or backfill), the last 5,000
    this.doneList = [];
    this.rowFn = null; // (mint) → the store's row, for `register` events
  }

  get programId() {
    return this.adapter.programId;
  }

  async start() {
    if (!this.adapter.ready) return;
    await this.loadAll().catch((e) => logError('index.load.fail', e));
    await this.backfill().catch((e) => logError('index.backfill.fail', e));
    if (this.wsUrl) {
      this.ws = new WsClient({ name: 'index', url: this.wsUrl, WebSocketImpl: this.WebSocketImpl, stallMs: 120_000, sendPerSec: 5, onOpen: () => this.subscribe(), onMessage: (d) => this.message(d) });
      this.ws.start();
      const hb = setInterval(() => this.ws.open && this.ws.send({ jsonrpc: '2.0', id: 0, method: 'getHealth' }), 30_000);
      hb.unref?.();
      this.timers.push(hb);
    }
    const t = setInterval(() => void this.poll(), this.pollMs);
    t.unref?.();
    this.timers.push(t);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.ws?.stop();
  }

  async poll() {
    try {
      // accounts come over programSubscribe; a full read every 4th round reconciles what a dropped socket missed
      if (!this.loaded || ++this.polls % 4 === 0) await this.loadAll();
      await this.backfill();
    } catch (e) {
      this.counts.errors++;
      logError('index.poll.fail', e);
    }
  }

  subscribe() {
    const pid = this.programId;
    this.ws.send({ jsonrpc: '2.0', id: 1, method: 'programSubscribe', params: [pid, { encoding: 'base64', commitment: 'confirmed' }] });
    this.ws.send({ jsonrpc: '2.0', id: 2, method: 'logsSubscribe', params: [{ mentions: [pid] }, { commitment: 'confirmed' }] });
  }

  message(d) {
    if (d?.method === 'programNotification') {
      const v = d.params?.result?.value;
      if (!v?.pubkey || !v.account?.data) return;
      this.counts.updates++;
      this.applyAccount(v.pubkey, Buffer.from(v.account.data[0], 'base64'));
      return;
    }
    if (d?.method === 'logsNotification') {
      const v = d.params?.result?.value;
      if (!v || v.err) return;
      const evs = this.adapter.eventsFromLogs(v.logs);
      if (evs.length) this.onEvents(v.signature, d.params?.result?.context?.slot ?? null, this.now(), evs);
      else if (v.logs?.some((l) => l.startsWith(`Program ${this.programId} invoke`))) void this.fetchTx(v.signature);
    }
  }

  /** All program accounts → config + coins (diffed against what we hold). */
  async loadAll() {
    const list = await this.rpc.call('getProgramAccounts', [this.programId, { encoding: 'base64', commitment: 'confirmed' }]);
    this.counts.accounts = list?.length ?? 0;
    const seen = new Set();
    for (const a of list ?? []) {
      const c = this.applyAccount(a.pubkey, Buffer.from(a.account.data[0], 'base64'), { quiet: !this.loaded });
      if (c?.kind === 'coin') seen.add(c.mint);
    }
    // a Coin account that is gone (closed): drop it
    for (const mint of [...this.coins.keys()]) if (!seen.has(mint)) this.coins.delete(mint);
    this.loaded = true;
  }

  /** One account's new data. Emits `register` for a new coin and `window` when windows or terms change. */
  applyAccount(address, buf, { quiet = false } = {}) {
    const acc = this.adapter.decodeAccount(address, buf);
    if (!acc) return null;
    if (acc.kind === 'config') {
      this.config = acc;
      return acc;
    }
    if (!acc.mint) return null;
    const prev = this.coins.get(acc.mint);
    acc.registeredAt = prev?.registeredAt ?? this.registeredAt(acc.mint);
    this.coins.set(acc.mint, acc);
    this.byAddress.set(address, acc.mint);
    this.saveWindows(acc);
    if (quiet) return acc;
    if (!prev) {
      this.bus?.push('register', { mint: acc.mint, owner: acc.owner, price: amount(acc.price), maxAhead: acc.maxAhead, coin: this.rowFn?.(acc.mint) ?? null });
      return acc;
    }
    const sameWins = JSON.stringify(prev.windows) === JSON.stringify(acc.windows);
    const sameTerms = prev.price === acc.price && prev.maxAhead === acc.maxAhead && prev.paused === acc.paused && prev.owner === acc.owner;
    if (!sameWins || !sameTerms || prev.hoursSold !== acc.hoursSold || prev.paidOut !== acc.paidOut) this.bus?.push('window', this.windowEvent(acc));
    return acc;
  }

  /** When the coin registered (its Registered event), or null while the backfill has not read it. */
  registeredAt(mint) {
    const r = this.db?.get("SELECT MIN(t) AS t FROM chain_events WHERE mint = ? AND type = 'register'", mint);
    return r?.t ?? null;
  }

  saveWindows(acc) {
    if (!this.db) return;
    const t = this.now();
    try {
      this.db.tx(() => {
        for (const w of acc.windows) {
          this.db.run(
            'INSERT INTO windows (mint, holder, start, end, earned, owed, seen) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mint, start) DO UPDATE SET holder = excluded.holder, end = excluded.end, earned = MAX(windows.earned, excluded.earned), owed = excluded.owed, seen = excluded.seen',
            acc.mint,
            w.holder,
            w.start,
            w.end,
            w.earned,
            w.owed,
            t,
          );
        }
        // windows the account pruned were paid in full: nothing is owed on them any more
        const starts = acc.windows.map((w) => w.start);
        this.db.run(`UPDATE windows SET owed = 0 WHERE mint = ? AND end <= ? ${starts.length ? `AND start NOT IN (${starts.map(() => '?').join(',')})` : ''}`, acc.mint, Math.floor(t / S), ...starts);
      });
    } catch (e) {
      logError('index.windows.fail', e);
    }
  }

  /** New signatures of the program since the last one we read (oldest first), their events. */
  async backfill() {
    if (!this.db) return;
    const last = this.db.getMeta(`index:lastSig:${this.programId}`);
    const sigs = [];
    let before;
    for (let page = 0; page < 20; page++) {
      const opts = { limit: 1000, commitment: 'confirmed' };
      if (last) opts.until = last;
      if (before) opts.before = before;
      const r = await this.rpc.call('getSignaturesForAddress', [this.programId, opts]);
      if (!r?.length) break;
      sigs.push(...r);
      if (r.length < 1000) break;
      before = r[r.length - 1].signature;
    }
    if (!sigs.length) return;
    for (const s of sigs.reverse()) {
      if (s.err || this.doneSigs.has(s.signature)) continue;
      const known = this.db.get('SELECT 1 AS x FROM chain_events WHERE sig = ? LIMIT 1', s.signature);
      if (known) continue;
      await this.fetchTx(s.signature, { backfill: true });
    }
    this.db.setMeta(`index:lastSig:${this.programId}`, sigs[sigs.length - 1].signature);
  }

  /** Reads a transaction and records its flipfee events ("Program data:" logs, or emit_cpi! inner instructions). */
  async fetchTx(sig, { backfill = false } = {}) {
    try {
      this.counts.txFetched++;
      const tx = await this.rpc.call('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
      this.done(sig);
      if (!tx?.meta || tx.meta.err) return;
      let evs = this.adapter.eventsFromLogs(tx.meta.logMessages ?? []);
      if (!evs.length) evs = this.cpiEvents(tx);
      if (!evs.length) return;
      if (backfill) this.counts.backfilled += evs.length;
      this.onEvents(sig, tx.slot ?? null, tx.blockTime ? tx.blockTime * S : this.now(), evs, { replay: backfill });
    } catch (e) {
      this.counts.errors++;
      logError('index.tx.fail', e, { sig: sig.slice(0, 12) });
    }
  }

  /** Events emitted with emit_cpi!: inner instructions to the program whose data starts with the event tag. */
  cpiEvents(tx) {
    const keys = [...(tx.transaction?.message?.accountKeys ?? []), ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])].map((k) => (typeof k === 'string' ? k : k.pubkey));
    const out = [];
    for (const inner of tx.meta?.innerInstructions ?? []) {
      for (const ix of inner.instructions ?? []) {
        if (keys[ix.programIdIndex] !== this.programId) continue;
        let data;
        try {
          data = Buffer.from(bs58.decode(ix.data));
        } catch {
          continue;
        }
        if (data.length < 16 || !data.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
        const logs = [`Program ${this.programId} invoke [1]`, `Program data: ${data.subarray(8).toString('base64')}`, `Program ${this.programId} success`];
        out.push(...this.adapter.eventsFromLogs(logs));
      }
    }
    return out;
  }

  mintOf(ev) {
    if (ev.mint && this.coins.has(ev.mint)) return ev.mint;
    if (ev.coin && this.byAddress.has(ev.coin)) return this.byAddress.get(ev.coin);
    if (ev.coin && this.coins.has(ev.coin)) return ev.coin;
    return ev.mint ?? null;
  }

  done(sig) {
    if (this.doneSigs.has(sig)) return;
    this.doneSigs.add(sig);
    this.doneList.push(sig);
    if (this.doneList.length > 5_000) this.doneSigs.delete(this.doneList.shift());
  }

  /** Records a transaction's events once (sig, index) and publishes the new ones. */
  onEvents(sig, slot, txTime, evs, { replay = false } = {}) {
    this.done(sig);
    evs.forEach((ev, ix) => {
      if (ev.type === 'other') return;
      const t = ev.at ? ev.at * S : txTime; // the chain clock of the event when it says
      if (ev.type === 'config') {
        if (this.config) Object.assign(this.config, { admin: ev.admin, treasury: ev.treasury, feeBps: ev.feeBps, paused: ev.paused });
        return;
      }
      const mint = this.mintOf(ev);
      const wallet = ev.type === 'buy' ? ev.buyer : ev.type === 'paid' ? ev.to : ev.type === 'register' ? ev.owner : null;
      const lamports = ev.type === 'buy' ? ev.paid : ev.type === 'paid' || ev.type === 'sync' ? ev.amount : 0;
      const feeBps = this.config?.feeBps ?? 500;
      const ownerPart = ev.type === 'buy' ? ev.toOwner || Math.floor((ev.paid * (10_000 - feeBps)) / 10_000) : 0;
      let fresh = true;
      if (this.db) {
        try {
          const r = this.db.run(
            'INSERT OR IGNORE INTO chain_events (sig, ix, slot, t, type, kind, mint, wallet, lamports, hours, owner_lamports, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            sig,
            ix,
            slot,
            t,
            ev.type,
            ev.type === 'paid' ? ev.kind : null,
            mint,
            wallet,
            lamports,
            ev.type === 'buy' ? ev.hours : 0,
            ownerPart,
            JSON.stringify(ev),
          );
          fresh = r.changes > 0;
        } catch (e) {
          logError('index.event.save.fail', e);
        }
      }
      if (!fresh) return;
      this.counts.events++;
      if (ev.type === 'register' && mint && this.coins.has(mint)) this.coins.get(mint).registeredAt = t;
      if (ev.type === 'owner' && mint && this.coins.has(mint)) this.coins.get(mint).owner = ev.owner;
      if (ev.type === 'windowDone' && this.db && mint) {
        try {
          this.db.run(
            'INSERT INTO windows (mint, holder, start, end, earned, owed, seen) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(mint, start) DO UPDATE SET earned = MAX(windows.earned, excluded.earned), owed = 0',
            mint,
            ev.holder,
            ev.start,
            ev.end,
            ev.earned,
            t,
          );
        } catch (e) {
          logError('index.window.done.fail', e);
        }
      }
      if (ev.type === 'buy' && this.db && mint) {
        try {
          this.db.run(
            'INSERT INTO windows (mint, holder, start, end, cost, sig, seen) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mint, start) DO UPDATE SET cost = excluded.cost, sig = excluded.sig',
            mint,
            ev.buyer,
            ev.start,
            ev.end,
            ev.paid,
            sig,
            t,
          );
        } catch (e) {
          logError('index.window.cost.fail', e);
        }
      }
      if (replay && this.now() - t > 10 * 60_000) return; // old history: stored, not streamed
      if (!this.bus || !mint) return;
      if (ev.type === 'buy') this.bus.push('buy', { mint, buyer: ev.buyer, hours: ev.hours, start: ev.start * S, end: ev.end * S, paid: amount(ev.paid), price: amount(ev.price), toOwner: amount(ownerPart), sig });
      else if (ev.type === 'paid') this.bus.push('paid', { mint, to: ev.to, amount: amount(ev.amount), kind: ev.kind, sig });
      else if (ev.type === 'sync') this.bus.push('fee', { mint, amount: amount(ev.amount), from: ev.from * S, to: ev.to * S, sig });
      else if (ev.type === 'register' && !this.coins.has(mint)) this.bus.push('register', { mint, owner: ev.owner, price: amount(ev.price), maxAhead: ev.maxAhead, coin: this.rowFn?.(mint) ?? null, sig });
    });
  }

  // ───────────── reads ─────────────

  /** The stream's `window` event body for a coin. */
  windowEvent(acc) {
    const f = this.ff(acc.mint);
    return { mint: acc.mint, windows: f.windows, owner: f.owner, price: f.price, maxAhead: f.maxAhead, paused: f.paused, hoursSold: f.hoursSold, sales: f.sales, feesIn: f.feesIn, ownerPaid: f.ownerPaid, holderPaid: f.holderPaid };
  }

  /** Sums of a coin's payouts from the event log, by kind. */
  paidByKind(mint) {
    const out = { holder: 0, owner: 0 };
    if (!this.db) return out;
    for (const r of this.db.all("SELECT kind, SUM(lamports) AS l FROM chain_events WHERE mint = ? AND type = 'paid' GROUP BY kind", mint)) out[r.kind === 'owner' ? 'owner' : 'holder'] += r.l ?? 0;
    return out;
  }

  /** The flipfee part of a coin (the app's `FF`), or null when the coin is not registered. */
  ff(mint) {
    const c = this.coins.get(mint);
    if (!c) return null;
    const now = Math.floor(this.now() / S);
    const costs = new Map();
    const past = [];
    if (this.db) {
      for (const r of this.db.all('SELECT holder, start, end, earned, owed, cost, sig FROM windows WHERE mint = ? ORDER BY start DESC LIMIT 60', mint)) {
        costs.set(r.start, r);
        if (r.end <= now && !c.windows.some((w) => w.start === r.start)) past.push(winOut(r));
      }
    }
    const windows = c.windows.map((w) => winOut({ ...w, cost: costs.get(w.start)?.cost ?? null, sig: costs.get(w.start)?.sig ?? null }, { live: w.start <= now && now < w.end }));
    const paid = this.paidByKind(mint);
    const lastEnd = c.windows.reduce((m, w) => Math.max(m, w.end), 0);
    const nextStart = Math.max(now, lastEnd);
    const live = c.windows.find((w) => w.start <= now && now < w.end) ?? null;
    return {
      owner: c.owner,
      address: c.address,
      vault: this.adapter.vaultPda(mint),
      price: amount(c.price),
      maxAhead: c.maxAhead,
      paused: c.paused,
      registeredAt: c.registeredAt ?? (c.registeredAt = this.registeredAt(mint)),
      windows,
      past: past.slice(0, 24),
      live: live ? winOut(live) : null,
      nextStart: nextStart * S,
      openUntil: (now + c.maxAhead) * S,
      hoursOpen: Math.max(0, Math.min(12, Math.floor((now + c.maxAhead - nextStart) / 3600))),
      hoursSold: c.hoursSold,
      sales: amount(c.sales),
      feesIn: amount(c.feesIn),
      paidOut: amount(c.paidOut),
      ownerOwed: amount(c.ownerOwed),
      ownerPaid: amount(paid.owner),
      holderPaid: amount(paid.holder),
      lastSync: c.lastSync * S,
    };
  }

  /** Who the coin's fees go to now: the live window's holder, else the dev. */
  holderNow(mint) {
    const c = this.coins.get(mint);
    if (!c) return null;
    const now = Math.floor(this.now() / S);
    const live = c.windows.find((w) => w.start <= now && now < w.end);
    if (live) {
      // "this hour" of a multi-hour window starts on the window's hour marks
      const since = live.start + Math.floor((now - live.start) / 3600) * 3600;
      return { kind: 'holder', to: live.holder, since: since * S, until: Math.min(live.end, since + 3600) * S };
    }
    const lastEnd = c.windows.filter((w) => w.end <= now).reduce((m, w) => Math.max(m, w.end), 0);
    const hourStart = Math.floor(now / 3600) * 3600;
    return { kind: 'dev', to: c.owner, since: Math.max(hourStart, lastEnd, c.registeredAt ? Math.floor(c.registeredAt / S) : 0) * S };
  }

  /** Today's (UTC) totals for the ticker. */
  today() {
    const from = Db.dayStart(this.now());
    const out = { hoursSold: 0, buyers: 0, devFees: 0, devSales: 0, buys: 0, sales: 0 };
    if (!this.db) return out;
    for (const r of this.db.all("SELECT type, kind, COUNT(*) AS n, SUM(lamports) AS l, SUM(hours) AS h, SUM(owner_lamports) AS o FROM chain_events WHERE t >= ? AND type IN ('buy', 'paid') GROUP BY type, kind", from)) {
      if (r.type === 'buy') {
        out.buys += r.n;
        out.hoursSold += r.h ?? 0;
        out.sales += r.l ?? 0;
        out.devSales += r.o ?? 0;
      } else if (r.kind === 'owner') out.devFees += r.l ?? 0;
      else out.buyers += r.l ?? 0;
    }
    return out;
  }

  /** A wallet's hours (as a buyer), its coins (as a dev) and totals. */
  me(wallet) {
    const now = Math.floor(this.now() / S);
    const hours = [];
    if (this.db) {
      for (const r of this.db.all('SELECT mint, holder, start, end, earned, owed, cost, sig FROM windows WHERE holder = ? ORDER BY start DESC LIMIT 200', wallet)) {
        const live = this.coins.get(r.mint)?.windows.find((w) => w.start === r.start);
        const w = live ? { ...r, earned: live.earned, owed: live.owed } : r;
        hours.push(winOut(w, { mint: r.mint, hours: Math.round((r.end - r.start) / 3600), state: r.start <= now && now < r.end ? 'live' : r.start > now ? 'upcoming' : 'past' }));
      }
    }
    const coins = [...this.coins.values()].filter((c) => c.owner === wallet).map((c) => c.mint);
    let spent = 0;
    let received = 0;
    let devFees = 0;
    let devSales = 0;
    if (this.db) {
      spent = this.db.get("SELECT COALESCE(SUM(lamports), 0) AS l FROM chain_events WHERE type = 'buy' AND wallet = ?", wallet).l;
      for (const r of this.db.all("SELECT kind, SUM(lamports) AS l FROM chain_events WHERE type = 'paid' AND wallet = ? GROUP BY kind", wallet)) {
        if (r.kind === 'owner') devFees += r.l ?? 0;
        else received += r.l ?? 0;
      }
      if (coins.length) devSales = this.db.get(`SELECT COALESCE(SUM(owner_lamports), 0) AS l FROM chain_events WHERE type = 'buy' AND mint IN (${coins.map(() => '?').join(',')})`, ...coins).l;
    }
    return { hours, coins, totals: { spent: amount(spent), received: amount(received), devSales: amount(devSales), devFees: amount(devFees) } };
  }

  status() {
    return {
      program: this.programId || null,
      adapter: this.adapter.describe(),
      loaded: this.loaded,
      config: this.config ? { admin: this.config.admin, treasury: this.config.treasury, feeBps: this.config.feeBps, paused: this.config.paused } : null,
      coins: this.coins.size,
      ws: this.ws ? this.ws.status() : null,
      ...this.counts,
    };
  }
}

void log;
