// What the API sends (DESIGN §1.6, §2.2): the ticker stats, the board snapshot (live flipfee coins and Hot coins),
// the coin page (coin + timeline + last 100 trades), a dev's coins (with eligibility, wants, metrics, a suggested
// price) and a wallet's hours and coins. Every amount is { lamports: "…", sol } (exact lamports, SOL for display);
// every time is ms. Numbers that cover only the tracked coins say so (`scope: 'top coins'`).
import { httpError } from './errors.js';
import { logError } from './log.js';
import { amount, HOUR, LAMPORTS, suggestedLamports, sumTrades } from './metrics.js';
import { withDeadline } from './net.js';
import { chainCoinsOf, eligibilityFromChain, readMintMeta } from './chain/pumpchain.js';
import { winOut } from './chain/indexer.js';

const short = (w) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : null);

export class Views {
  constructor({ cfg, store, tracker, hot = null, indexer = null, wants, pump = null, rpc, adapter = null, now = () => Date.now() }) {
    Object.assign(this, { cfg, store, tracker, hot, indexer, wants, pump, rpc, adapter, now });
    this.boardCache = null;
    this.statsCache = null;
    this.eligCache = new Map(); // `${mint}|${wallet}` → { at, v }
    this.chainCoins = new Map(); // wallet → { at, v }
    this.devRuns = new Map(); // wallet → the dev page being built
    this.boardV = 0;
    this.lastBoardKey = '';
  }

  // ───────────── ticker ─────────────

  stats() {
    const t = this.now();
    if (this.statsCache && t - this.statsCache.at < 1_000) return this.statsCache.v;
    let fee = 0;
    let coins = 0;
    for (const c of this.store.coins.values()) {
      if (!c.trades.length || this.store.hidden(c)) continue;
      const s = sumTrades(c.trades, HOUR, t);
      if (!s.trades) continue;
      fee += s.fee;
      coins++;
    }
    const today = this.indexer?.today() ?? { hoursSold: 0, buyers: 0, devFees: 0, devSales: 0, buys: 0, sales: 0 };
    const v = {
      t,
      // creator fees of the last hour, summed over the coins we followed (exact per trade; "top coins")
      feesHour: amount(fee),
      feesHourCoins: coins,
      scope: 'top coins',
      trackedCoins: this.tracker.current.size,
      liveCoins: this.liveMints().length,
      hoursSoldToday: today.hoursSold,
      buysToday: today.buys,
      paidBuyersToday: amount(today.buyers),
      // the dev's part of hour sales (95%) plus fees paid to devs outside sold hours, today (UTC)
      paidDevsToday: amount(today.devSales + today.devFees),
      devSalesToday: amount(today.devSales),
      devFeesToday: amount(today.devFees),
      solUsd: this.store.solUsd ? Math.round(this.store.solUsd * 100) / 100 : null,
      boardV: this.boardV,
    };
    this.statsCache = { at: t, v };
    return v;
  }

  /** The stream's `stats` frame. */
  statsFrame() {
    return { stats: this.stats() };
  }

  // ───────────── rows ─────────────

  liveMints() {
    if (!this.indexer) return [];
    return [...this.indexer.coins.keys()].filter((m) => !this.store.hidden(this.store.get(m)));
  }

  /** "This hour" of a live coin: who its fees go to now and how much its trades paid since the hour started. */
  thisHour(mint) {
    const h = this.indexer?.holderNow(mint);
    if (!h) return null;
    const c = this.store.get(mint);
    const fee = c ? this.store.feesBetween(c, h.since, this.now()) : 0;
    // `cover` < 1: we did not follow every trade since `since` (a restart, a late subscription): the sum is partial
    return { ...amount(fee), since: h.since, until: h.until ?? null, to: h.to, kind: h.kind, cover: c ? this.store.cover(c, h.since, this.now()) : 0 };
  }

  row(mint, { full = false, recent = 0 } = {}) {
    const c = this.store.ensure(mint);
    const ff = this.indexer?.ff(mint) ?? null;
    const extra = { wants: this.wants.count(mint), flipfee: ff, thisHour: ff ? this.thisHour(mint) : null };
    // the board's rows carry their last trades (the trade dots and "this hour" on first paint)
    if (recent) extra.recent = c.recent.slice(-recent).map((rec) => this.store.tradeOut(c, rec));
    const r = this.store.row(c, extra);
    // a flipfee coin's owner is its dev and its fee-split admin (no API may know the coin yet)
    if (ff) {
      r.dev ??= ff.owner;
      r.admin ??= ff.owner;
    }
    return full ? { ...r, ...this.store.detail(c) } : r;
  }

  /** Sort key of a Hot row: the last hour's fees, exact when covered, else the estimate. */
  hourKey(r) {
    const h = r.fees.h1;
    return Number(h.exact ? h.lamports : h.est?.lamports ?? h.lamports);
  }

  /** A chain event changed the board: the next snapshot is rebuilt (and a registered coin's eligibility re-read). */
  invalidate(mint = null) {
    this.boardCache = null;
    this.statsCache = null;
    if (mint) for (const k of this.eligCache.keys()) if (k.startsWith(`${mint}|`)) this.eligCache.delete(k);
  }

  board() {
    const t = this.now();
    if (this.boardCache && t - this.boardCache.at < 2_000) return this.boardCache.v;
    const live = this.liveMints()
      .map((m) => this.row(m, { recent: 40 }))
      .sort((a, b) => Number(b.fees.h1.lamports) - Number(a.fees.h1.lamports));
    const liveSet = new Set(live.map((r) => r.mint));
    const hot = this.tracker
      .hotMints()
      .filter((m) => !liveSet.has(m) && !this.store.hidden(this.store.get(m)))
      .map((m) => this.row(m, { recent: 12 }))
      // coins that can still join flipfee first (Want makes sense there), then by the last hour's fees
      .sort((a, b) => (a.canJoin === false) - (b.canJoin === false) || this.hourKey(b) - this.hourKey(a))
      .slice(0, this.cfg.hotMax);
    // the busiest live coin for the hero's cash counter
    let hero = null;
    for (const r of live) if (r.thisHour && (!hero || Number(r.thisHour.lamports) > Number(hero.thisHour.lamports))) hero = r;
    const key = [...live.map((r) => r.mint), '|', ...hot.map((r) => r.mint)].join(',');
    if (key !== this.lastBoardKey) {
      this.lastBoardKey = key;
      this.boardV++;
    }
    const v = {
      at: t,
      v: this.boardV,
      stats: this.stats(),
      hero: hero ? { mint: hero.mint, symbol: hero.symbol, image: hero.image, thisHour: hero.thisHour } : null,
      live,
      hot,
    };
    this.boardCache = { at: t, v };
    return v;
  }

  // ───────────── coin page ─────────────

  async coin(mint) {
    let c = this.store.get(mint);
    const registered = !!this.indexer?.coins.has(mint);
    if (this.pump && (!c?.ext.pump || this.now() - c.ext.pump.at > 60_000)) {
      try {
        const p = await withDeadline(this.pump.coin(mint, { front: true }), 2_500, 'pump.fun');
        if (p) c = this.store.onPump(p);
      } catch (e) {
        if (e?.code !== 'TIMEOUT') logError('coin.pump.fail', e);
      }
    }
    if (!c && !registered) throw httpError(404, 'unknownCoin');
    c = this.store.ensure(mint);
    if (!c.tracked && !registered) {
      this.tracker.pin(mint);
      if (this.pump && (!c.ext.act || this.now() - c.ext.act.at > 5 * 60_000)) {
        await withDeadline(this.pump.activity(mint, { front: true }), 2_000, 'activity')
          .then((a) => this.store.onActivity(mint, a))
          .catch(() => {});
      }
    }
    const row = this.row(mint, { full: true });
    const trades = c.recent
      .slice(-100)
      .reverse()
      .map((rec) => this.store.tradeOut(c, rec));
    return { coin: row, trades, timeline: this.timeline(c, row.flipfee) };
  }

  /**
   * The hour timeline: the last 12 hours (sold windows with their holder and what they earned, the dev's time per
   * clock hour), now, and the hours ahead (queued windows, then open time at the price until max_ahead).
   */
  timeline(c, ff) {
    const t = this.now();
    const segs = [];
    const from = Math.floor((t - 12 * HOUR) / HOUR) * HOUR;
    const sold = ff ? [...ff.past, ...ff.windows].map((w) => ({ ...w })).sort((a, b) => a.start - b.start) : [];
    // what a stretch paid: exact where we followed the coin (cover 1), partial below, null when we did not follow it
    const fees = (a, b) => {
      const cover = this.store.cover(c, a, b);
      return cover ? { ...amount(this.store.feesBetween(c, a, b)), cover } : null;
    };
    // dev stretches between `a` and `b`, cut at clock hours
    const devStretch = (a, b, state) => {
      for (let x = a; x < b; ) {
        const y = Math.min(b, (Math.floor(x / HOUR) + 1) * HOUR);
        // the stretch that reaches now is the live one (its hour is still running)
        segs.push({ start: x, end: y, kind: 'dev', state: state ?? (y < t ? 'past' : x <= t ? 'live' : 'open'), to: ff?.owner ?? null, fees: x < t ? fees(x, Math.min(y, t)) : null });
        x = y;
      }
    };
    let cur = from;
    for (const w of sold) {
      if (w.end <= from) continue;
      if (w.start > cur) devStretch(cur, Math.min(w.start, Math.max(t, cur)), null);
      const state = w.end <= t ? 'past' : w.start <= t ? 'live' : 'sold';
      segs.push({ start: Math.max(w.start, from), end: w.end, kind: 'holder', state, holder: w.holder, holderShort: short(w.holder), earned: w.earned, fees: w.start < t ? fees(Math.max(w.start, from), Math.min(w.end, t)) : null, cost: w.cost ?? null });
      cur = Math.max(cur, w.end);
    }
    if (cur < t) devStretch(cur, t, null);
    if (ff) {
      const start = Math.max(cur, t);
      const until = ff.openUntil;
      if (until > start) segs.push({ start, end: until, kind: 'open', state: 'open', price: ff.price, hours: Math.floor((until - start) / HOUR) });
    }
    return { now: t, from, segments: segs, price: ff?.price ?? null, nextStart: ff?.nextStart ?? null, hoursOpen: ff?.hoursOpen ?? 0, paused: ff?.paused ?? null };
  }

  // ───────────── dev ─────────────

  async eligibility(mint, wallet) {
    const key = `${mint}|${wallet}`;
    const hit = this.eligCache.get(key);
    if (hit && this.now() - hit.at < 30_000) return hit.v;
    let v = null;
    try {
      if (this.adapter) v = await withDeadline(this.adapter.eligibility(this.rpc.connection(), mint, wallet), 15_000, 'eligibility');
    } catch (e) {
      logError('dev.eligibility.client.fail', e, { mint });
    }
    if (!v) {
      v = await eligibilityFromChain(this.rpc, mint, wallet, { vault: this.adapter?.ready ? this.adapter.vaultPda(mint) : null, hasCoinAccount: !!this.indexer?.coins.has(mint) }).catch((e) => {
        logError('dev.eligibility.chain.fail', e, { mint });
        return null;
      });
      if (v) v.source = 'chain';
    } else v.source = 'client';
    if (v) {
      this.eligCache.set(key, { at: this.now(), v });
      if (this.eligCache.size > 5_000) this.eligCache.delete(this.eligCache.keys().next().value);
    }
    return v;
  }

  async chainCoinsOf(wallet, knownCurves = new Set()) {
    const hit = this.chainCoins.get(wallet);
    if (hit && this.now() - hit.at < 5 * 60_000) return hit.v;
    const v = await chainCoinsOf(this.rpc, wallet, { knownCurves }).catch((e) => {
      logError('dev.chain.fail', e);
      return [];
    });
    this.chainCoins.set(wallet, { at: this.now(), v });
    if (this.chainCoins.size > 2_000) this.chainCoins.delete(this.chainCoins.keys().next().value);
    return v;
  }

  /**
   * The coins a wallet created (pump.fun API and chain) or owns on flipfee, with eligibility, wants and metrics. At most
   * two wallets are read at once (each read is tens of RPC calls); the same wallet asked again shares the read.
   */
  async dev(wallet) {
    const running = this.devRuns.get(wallet);
    if (running) return running;
    if (this.devRuns.size >= 2) throw httpError(503, 'busy');
    const p = this.devNow(wallet).finally(() => this.devRuns.delete(wallet));
    this.devRuns.set(wallet, p);
    return p;
  }

  async devNow(wallet) {
    const mints = [];
    const add = (m) => !mints.includes(m) && mints.push(m);
    for (const m of this.indexer ? [...this.indexer.coins.values()].filter((c) => c.owner === wallet).map((c) => c.mint) : []) add(m);
    // pump.fun's list first (it names the curves), then the chain for what it misses
    let created = [];
    if (this.pump) {
      try {
        created = await this.pump.created(wallet);
      } catch (e) {
        logError('dev.pump.fail', e);
      }
    }
    for (const p of created) {
      this.store.onPump(p);
      add(p.mint);
    }
    for (const m of await this.chainCoinsOf(wallet, new Set(created.map((p) => p.bondingCurve).filter(Boolean)))) add(m);
    const list = mints.slice(0, 30);
    // names from the mints themselves for coins no API named (one read for all of them)
    const unnamed = list.filter((m) => !this.store.get(m)?.symbol);
    if (unnamed.length) {
      try {
        for (const [m, meta] of await readMintMeta(this.rpc, unnamed)) this.store.onChainMeta(m, meta);
      } catch (e) {
        logError('dev.meta.fail', e);
      }
    }
    // pump.fun's activity for estimates of coins we do not follow (the first 10, 2 s budget)
    if (this.pump) {
      const need = list.filter((m) => !this.store.get(m)?.tracked).slice(0, 10);
      await withDeadline(Promise.allSettled(need.map((m) => this.pump.activity(m).then((a) => this.store.onActivity(m, a)))), 2_500, 'activity').catch(() => {});
    }
    const elig = new Map();
    // eligibility, a few at a time (each is 1-3 RPC reads)
    for (let i = 0; i < list.length; i += 4) {
      const part = list.slice(i, i + 4);
      const rs = await Promise.all(part.map((m) => this.eligibility(m, wallet)));
      part.forEach((m, k) => elig.set(m, rs[k]));
    }
    const coins = list.map((m) => {
      const r = this.row(m);
      const h1 = r.fees.h1.exact ? Number(r.fees.h1.lamports) : Number(r.fees.h1.est?.lamports ?? r.fees.h1.lamports);
      const h6 = r.fees.h6.exact ? Number(r.fees.h6.lamports) : Number(r.fees.h6.est?.lamports ?? r.fees.h6.lamports);
      const e = elig.get(m);
      return { ...r, eligibility: e ? { ...e, kind: e.kind } : { kind: 'not-admin', reason: 'unknown' }, suggested: amount(suggestedLamports(h1, h6)) };
    });
    const rank = (x) => (x.flipfee ? 0 : ['almost', 'ready', 'ready-new'].includes(x.eligibility.kind) ? 1 : 2);
    coins.sort((a, b) => rank(a) - rank(b) || Number(b.fees.h24.est?.lamports ?? b.fees.h24.lamports) - Number(a.fees.h24.est?.lamports ?? a.fees.h24.lamports));
    return { wallet, coins };
  }

  // ───────────── me ─────────────

  me(wallet) {
    const m = this.indexer?.me(wallet) ?? { hours: [], coins: [], totals: { spent: amount(0), received: amount(0), devSales: amount(0), devFees: amount(0) } };
    const hours = m.hours.map((h) => {
      const c = this.store.get(h.mint);
      return { ...h, symbol: c?.symbol ?? '', name: c?.name ?? '', image: c ? this.store.image(c) : null, live: h.state === 'live' ? this.thisHour(h.mint) : null };
    });
    return { wallet, hours, coins: m.coins.map((mint) => this.row(mint)), totals: m.totals, wants: this.wants.of(wallet) };
  }
}

export { winOut, LAMPORTS };
