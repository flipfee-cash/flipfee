// Per-coin state: metadata (pump.fun, DexScreener, Jupiter), the decoded trades of the last hour with their exact
// creator fees, per-minute fee buckets for 24 h (SQLite-backed), tracking coverage (when we followed the coin's trades,
// so a window can say whether it is exact), price and market cap from the last trade, outside volume for estimates,
// and the API rows built from all of it. Names and tickers are untrusted text: control characters are stripped and
// hate slurs masked (moderate.js); such coins are `hidden` (kept off the board and out of the stream).
import { amount, coveredMs, DEFAULT_TIERS, estFee, HOUR, hourly, isExact, LAMPORTS, MIN, sumMinutes, sumTrades, tierBps, WINDOWS } from './metrics.js';
import { badCoin, cleanAbout, maskSlurs } from './moderate.js';
import { imageUrl, quoteOf } from './sources/pumpfun.js';
import { curveOf, isSolQuote, sharingConfigOf } from './ingest/pumpevents.js';
import { logError } from './log.js';

export const PUMP_SUPPLY = 1_000_000_000; // pump.fun coins: 1B tokens, 6 decimals
const KEEP_TRADES_MS = HOUR + 5 * MIN;
const KEEP_MINUTES = 24 * 60 + 5;
const RECENT = 100;

// Token names and tickers are untrusted text: strip control and bidi characters, mask hate slurs, cap the length.
const CTRL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
export const cleanName = (s) => maskSlurs(String(s ?? '').replace(CTRL, '').replace(/\s+/g, ' ').trim()).slice(0, 48);
export const cleanTicker = (s) => maskSlurs(String(s ?? '').replace(CTRL, '').replace(/\s+/g, '').trim()).slice(0, 16);

const earliest = (a, b) => {
  const ok = (v) => Number.isFinite(v) && v > 0;
  if (!ok(b)) return a ?? null;
  return ok(a) ? Math.min(a, b) : b;
};

export function linksOf(mint) {
  return {
    pumpfun: `https://pump.fun/coin/${mint}`,
    dexscreener: `https://dexscreener.com/solana/${mint}`,
    solscan: `https://solscan.io/token/${mint}`,
  };
}

export class CoinStore {
  constructor({ db = null, now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
    this.coins = new Map();
    this.solUsd = null;
    this.tiers = DEFAULT_TIERS;
    this.dirtyMinutes = new Set(); // `${mint}|${m}`
    this.pendingTrades = [];
    this.keep = new Set(); // mints kept regardless of activity (registered, tracked)
  }

  get(mint) {
    return this.coins.get(mint) ?? null;
  }

  ensure(mint) {
    let c = this.coins.get(mint);
    if (!c) {
      c = {
        mint,
        symbol: '',
        name: '',
        image: null,
        description: null,
        socials: {},
        dev: null, // the wallet that created the coin (pump.fun)
        feeTo: null, // bonding_curve.creator (the dev, or the coin's sharing config) from the last curve trade
        coinCreator: null, // pool.coin_creator from the last PumpSwap trade
        shareholders: null,
        sharing: null, // { admin, revoked, shareholders } from chain, when read
        createdAt: null,
        curve: null,
        pool: null,
        graduated: false,
        quote: 'sol',
        supply: PUMP_SUPPLY,
        mayhem: false,
        cashback: false,
        nsfw: false,
        banned: false,
        priceSol: null,
        priceAt: 0,
        mcapUsdExt: null,
        mcapSolExt: null,
        feeBps: { curve: null, amm: null },
        tracked: false,
        trackedSince: 0,
        coverage: [], // [start, end|null]
        trades: [], // the last 65 minutes, every trade, lean: { t, fee, lam, buy }
        recent: [], // the last 100 trades, any age: { t, sig, ix, buy, lam, fee, wallet, venue }
        minutes: new Map(), // unix minute → { fee, vol, trades, buys }
        ext: {}, // pump, dex, jup, act
        seenAt: this.now(),
        lastTradeAt: 0,
      };
      this.coins.set(mint, c);
    }
    return c;
  }

  setSolUsd(v) {
    if (Number.isFinite(v) && v > 0) this.solUsd = v;
  }

  setTiers(t) {
    if (t?.amm?.length) this.tiers = { curve: t.curve ?? this.tiers.curve, amm: t.amm };
  }

  // ───────────── inputs ─────────────

  /** A normalized pump.fun record (sources/pumpfun.js normCoin). */
  onPump(p) {
    if (!p?.mint) return null;
    const c = this.ensure(p.mint);
    c.ext.pump = p;
    c.seenAt = this.now();
    if (p.name) c.name = cleanName(p.name);
    if (p.symbol) c.symbol = cleanTicker(p.symbol);
    if (p.description) c.description = p.description;
    if (p.image) c.image = p.image;
    c.socials = { ...c.socials, ...p.socials };
    if (p.creator) c.dev = p.creator;
    c.createdAt = earliest(c.createdAt, p.createdAt);
    if (p.bondingCurve) c.curve = p.bondingCurve;
    if (p.complete) c.graduated = true;
    if (p.pool) c.pool = p.pool;
    c.quote = p.quote ?? c.quote;
    if (p.supply > 0) c.supply = p.supply;
    c.cashback = !!p.cashback;
    c.nsfw = !!p.nsfw;
    c.banned = !!p.banned;
    if (p.raydium) c.raydium = true;
    if (p.mcapUsd) c.mcapUsdExt = p.mcapUsd;
    if (p.mcapSol) c.mcapSolExt = p.mcapSol;
    return c;
  }

  /** A DexScreener pair (sources/dexscreener.js normPair). */
  onDex(pair) {
    if (!pair?.mint) return;
    const c = this.ensure(pair.mint);
    c.ext.dex = pair;
    if (!c.symbol && pair.symbol) c.symbol = cleanTicker(pair.symbol);
    if (!c.name && pair.name) c.name = cleanName(pair.name);
    if (pair.socials) c.socials = { ...pair.socials, ...c.socials };
    if (!c.image && pair.image) c.image = pair.image;
    if (pair.dexId === 'pumpswap' && pair.pairAddress) {
      c.graduated = true;
      c.pool ??= pair.pairAddress;
    }
    if (!c.ext.pump?.mcapUsd && pair.mcapUsd) c.mcapUsdExt = pair.mcapUsd;
    c.createdAt = earliest(c.createdAt, pair.createdAt);
  }

  /** A Jupiter token record (sources/jupiter.js normToken). */
  onJup(j) {
    if (!j?.mint) return;
    const c = this.ensure(j.mint);
    c.ext.jup = { ...j, at: this.now() };
    if (!c.symbol && j.symbol) c.symbol = cleanTicker(j.symbol);
    if (!c.name && j.name) c.name = cleanName(j.name);
    if (!c.image && j.icon) c.image = j.icon;
    const s = {};
    if (j.twitter) s.twitter = j.twitter;
    if (j.telegram) s.telegram = j.telegram;
    if (j.website) s.website = j.website;
    c.socials = { ...s, ...c.socials };
    c.createdAt = earliest(c.createdAt, j.createdAt);
    if (j.graduatedPool) {
      c.graduated = true;
      c.pool ??= j.graduatedPool;
    }
    if (j.dev && !c.dev) c.dev = j.dev;
    if (!c.ext.pump?.mcapUsd && j.mcapUsd) c.mcapUsdExt = j.mcapUsd;
  }

  /** Name and symbol from the mint's own metadata (Token-2022), for coins no API names. */
  onChainMeta(mint, m) {
    if (!m) return;
    const c = this.ensure(mint);
    if (!c.name && m.name) c.name = cleanName(m.name);
    if (!c.symbol && m.symbol) c.symbol = cleanTicker(m.symbol);
    c.metaUri ??= m.uri ?? null;
  }

  /** pump.fun's market activity (volume per window, USD). */
  onActivity(mint, act) {
    if (!act) return;
    this.ensure(mint).ext.act = act;
  }

  /** The sharing config of a coin as read from chain: { admin, revoked, shareholders, status } (or null: none). */
  onSharing(mint, s) {
    this.ensure(mint).sharing = s ? { ...s, at: this.now() } : { none: true, at: this.now() };
  }

  /**
   * A decoded trade (ingest/pumpevents.js curveTrade/swapTrade + sig, ix, t). Updates price, fee rate and the windows.
   * Returns the stored record, or null for a duplicate or a trade in a non-SOL quote (its fee is no SOL).
   */
  onTrade(tr) {
    const c = this.ensure(tr.mint);
    const t = Math.min(tr.t ?? this.now(), this.now());
    if (!tr.solQuote) {
      c.quote = tr.quoteMint ? quoteOf(tr.quoteMint) : 'other';
      return null;
    }
    if (tr.vSol > 0 && tr.vTokens > 0) {
      c.priceSol = (tr.vSol / LAMPORTS) / (tr.vTokens / 1e6);
      c.priceAt = t;
    }
    if (tr.venue === 'curve') {
      if (tr.feeTo) c.feeTo = tr.feeTo;
      if (tr.shareholders) c.shareholders = tr.shareholders.length ? tr.shareholders : null;
      if (tr.mayhem) c.mayhem = true;
      c.feeBps.curve = tr.feeBps ?? c.feeBps.curve;
      if (tr.realTokens === 0) c.curveDone = true;
    } else {
      c.graduated = true;
      if (tr.pool) c.pool = tr.pool;
      if (tr.feeTo) c.coinCreator = tr.feeTo;
      c.feeBps.amm = tr.feeBps ?? c.feeBps.amm;
    }
    const rec = { t, sig: tr.sig ?? null, ix: tr.ix ?? 0, buy: !!tr.isBuy, lam: Math.max(0, Math.round(Number(tr.lamports) || 0)), fee: Math.max(0, Math.round(tr.fee || 0)), wallet: tr.wallet ?? null, venue: tr.venue };
    // the windows keep a lean copy (busy coins trade thousands of times an hour); trades arrive in order, a late one is
    // placed by time so the windows stay sorted
    const lean = { t, fee: rec.fee, lam: rec.lam, buy: rec.buy };
    const list = c.trades;
    if (!list.length || list[list.length - 1].t <= t) list.push(lean);
    else {
      let i = list.length - 1;
      while (i > 0 && list[i - 1].t > t) i--;
      list.splice(i, 0, lean);
    }
    c.recent.push(rec);
    if (c.recent.length > RECENT * 2) c.recent.splice(0, c.recent.length - RECENT);
    const m = Math.floor(t / MIN);
    let b = c.minutes.get(m);
    if (!b) {
      b = { fee: 0, vol: 0, trades: 0, buys: 0 };
      c.minutes.set(m, b);
    }
    b.fee += rec.fee;
    b.vol += rec.lam;
    b.trades++;
    if (rec.buy) b.buys++;
    this.dirtyMinutes.add(`${c.mint}|${m}`);
    if (this.db) this.pendingTrades.push([rec.sig ?? `x${t}${Math.random()}`, rec.ix, c.mint, t, rec.buy ? 1 : 0, rec.lam, rec.fee, rec.wallet, rec.venue]);
    c.lastTradeAt = Math.max(c.lastTradeAt, t);
    return rec;
  }

  onMigrate(mint, pool) {
    const c = this.ensure(mint);
    c.graduated = true;
    if (pool) c.pool = pool;
  }

  /** We follow the coin's trades from `t` (the subscription is confirmed). */
  coverStart(mint, t = this.now()) {
    const c = this.ensure(mint);
    const open = c.coverage.find(([, e]) => e === null);
    if (open) return;
    c.coverage.push([t, null]);
    if (!c.tracked) c.trackedSince = t;
    c.tracked = true;
    this.db?.run('INSERT OR IGNORE INTO coverage (mint, start, end) VALUES (?, ?, NULL)', mint, t);
  }

  /** The trades of [from, to) were read from chain after the fact (a dropped socket): that stretch is covered too. */
  coverPatch(mint, from, to) {
    if (!(to > from)) return;
    const c = this.ensure(mint);
    c.coverage.push([from, to]);
    this.db?.run('INSERT OR IGNORE INTO coverage (mint, start, end) VALUES (?, ?, ?)', mint, from, to);
  }

  /** We stopped following the coin's trades at `t`. */
  coverEnd(mint, t = this.now()) {
    const c = this.coins.get(mint);
    if (!c) return;
    for (const iv of c.coverage) {
      if (iv[1] !== null) continue;
      iv[1] = Math.max(iv[0], t);
      this.db?.run('UPDATE coverage SET end = ? WHERE mint = ? AND start = ?', iv[1], mint, iv[0]);
    }
    c.tracked = false;
  }

  // ───────────── persistence ─────────────

  /** Loads the last 24 h of buckets, coverage, recent trades and coin records. `aliveAt`: when the last run ended. */
  load(aliveAt = null) {
    if (!this.db) return;
    const t = this.now();
    const fromM = Math.floor((t - 24 * HOUR) / MIN) - 1;
    for (const r of this.db.all('SELECT mint, m, fee, trades, buys, vol FROM buckets WHERE m >= ?', fromM)) {
      this.ensure(r.mint).minutes.set(r.m, { fee: r.fee, vol: r.vol, trades: r.trades, buys: r.buys });
    }
    // runs that ended without closing their intervals: they ended when the server last said it was alive
    const end = aliveAt ?? t;
    this.db.run('UPDATE coverage SET end = MAX(start, ?) WHERE end IS NULL', end);
    for (const r of this.db.all('SELECT mint, start, end FROM coverage WHERE end >= ?', t - 24 * HOUR - HOUR)) this.ensure(r.mint).coverage.push([r.start, r.end]);
    const rec = (r) => ({ t: r.t, sig: r.sig, ix: r.ix, buy: !!r.buy, lam: r.lamports, fee: r.fee, wallet: r.wallet, venue: r.venue });
    for (const r of this.db.all('SELECT mint, t, buy, lamports, fee FROM trades WHERE t > ? ORDER BY t ASC', t - KEEP_TRADES_MS)) {
      const c = this.ensure(r.mint);
      c.trades.push({ t: r.t, fee: r.fee, lam: r.lamports, buy: !!r.buy });
      c.lastTradeAt = Math.max(c.lastTradeAt, r.t);
    }
    for (const r of this.db.all('SELECT sig, ix, mint, t, buy, lamports, fee, wallet, venue FROM recent ORDER BY t ASC')) {
      const c = this.ensure(r.mint);
      c.recent.push(rec(r));
      c.lastTradeAt = Math.max(c.lastTradeAt, r.t);
    }
    for (const c of this.coins.values()) if (c.recent.length > RECENT) c.recent.splice(0, c.recent.length - RECENT);
    for (const r of this.db.all('SELECT mint, json FROM coins WHERE t >= ?', t - 7 * 24 * HOUR)) {
      try {
        const p = JSON.parse(r.json);
        if (p.pump) this.onPump(p.pump);
        if (p.sharing) this.ensure(r.mint).sharing = p.sharing;
      } catch {
        // a bad row: skip it
      }
    }
  }

  /** Writes the changed minute buckets and the new trades; keeps the last 100 trades per coin. */
  flush() {
    if (!this.db) return;
    const dirty = [...this.dirtyMinutes];
    this.dirtyMinutes.clear();
    const trades = this.pendingTrades;
    this.pendingTrades = [];
    if (!dirty.length && !trades.length) return;
    try {
      this.db.tx(() => {
        for (const k of dirty) {
          const [mint, ms] = k.split('|');
          const b = this.coins.get(mint)?.minutes.get(Number(ms));
          if (!b) continue;
          this.db.run('INSERT INTO buckets (mint, m, fee, trades, buys, vol) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(mint, m) DO UPDATE SET fee = excluded.fee, trades = excluded.trades, buys = excluded.buys, vol = excluded.vol', mint, Number(ms), b.fee, b.trades, b.buys, b.vol);
        }
        const mints = new Set();
        for (const r of trades) {
          this.db.run('INSERT INTO trades (mint, t, buy, lamports, fee) VALUES (?, ?, ?, ?, ?)', r[2], r[3], r[4], r[5], r[6]);
          this.db.run('INSERT OR IGNORE INTO recent (sig, ix, mint, t, buy, lamports, fee, wallet, venue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ...r);
          mints.add(r[2]);
        }
        for (const mint of mints) {
          const cut = this.db.get('SELECT t FROM recent WHERE mint = ? ORDER BY t DESC LIMIT 1 OFFSET ?', mint, RECENT - 1);
          if (cut) this.db.run('DELETE FROM recent WHERE mint = ? AND t < ?', mint, cut.t);
        }
      });
    } catch (e) {
      logError('store.flush.fail', e);
    }
  }

  /** Saves the records of coins worth showing after a restart. */
  saveRecords(mints) {
    if (!this.db) return;
    const t = this.now();
    try {
      this.db.tx(() => {
        for (const mint of mints) {
          const c = this.coins.get(mint);
          if (!c?.ext.pump && !c?.sharing) continue;
          this.db.run('INSERT INTO coins (mint, json, t) VALUES (?, ?, ?) ON CONFLICT(mint) DO UPDATE SET json = excluded.json, t = excluded.t', mint, JSON.stringify({ pump: c.ext.pump ?? null, sharing: c.sharing ?? null }), t);
        }
      });
    } catch (e) {
      logError('store.records.fail', e);
    }
  }

  /** Drops trades older than the hour, buckets older than 24 h, and idle coins nobody needs. */
  prune() {
    const t = this.now();
    const cutM = Math.floor(t / MIN) - KEEP_MINUTES;
    for (const [mint, c] of this.coins) {
      let i = 0;
      while (i < c.trades.length && c.trades[i].t < t - KEEP_TRADES_MS) i++;
      if (i) c.trades.splice(0, i);
      for (const m of c.minutes.keys()) if (m < cutM) c.minutes.delete(m);
      c.coverage = c.coverage.filter(([, e]) => e === null || e > t - 25 * HOUR);
      const idle = !c.tracked && !this.keep.has(mint) && Math.max(c.seenAt, c.lastTradeAt) < t - 6 * HOUR && !c.minutes.size;
      if (idle) this.coins.delete(mint);
    }
    if (this.db) {
      try {
        this.db.run('DELETE FROM buckets WHERE m < ?', cutM);
        this.db.run('DELETE FROM trades WHERE t < ?', t - KEEP_TRADES_MS);
        this.db.run('DELETE FROM coverage WHERE end IS NOT NULL AND end < ?', t - 25 * HOUR);
        this.db.run('DELETE FROM coins WHERE t < ?', t - 7 * 24 * HOUR);
      } catch (e) {
        logError('store.prune.fail', e);
      }
    }
  }

  // ───────────── reads ─────────────

  /** Whether the coin stays off the board (slur name, pump.fun ban). */
  hidden(c) {
    return !!c && (c.banned || badCoin(c));
  }

  venue(c) {
    return c.graduated ? 'amm' : 'curve';
  }

  /** The SOL price per token: from the last trade (an hour at most), else from pump.fun's market cap. */
  priceSol(c) {
    if (c.priceSol && this.now() - c.priceAt < HOUR) return c.priceSol;
    if (c.mcapSolExt && c.supply) return c.mcapSolExt / c.supply;
    if (c.mcapUsdExt && this.solUsd && c.supply) return c.mcapUsdExt / this.solUsd / c.supply;
    return c.priceSol ?? null;
  }

  mcapSol(c) {
    const p = this.priceSol(c);
    return p ? p * (c.supply || PUMP_SUPPLY) : null;
  }

  mcapUsd(c) {
    const m = this.mcapSol(c);
    if (m && this.solUsd) return Math.round(m * this.solUsd);
    return c.mcapUsdExt ? Math.round(c.mcapUsdExt) : null;
  }

  /** The creator-fee rate now: the last trade's, else pump's rate for the venue and market cap (0: no creator fees). */
  rateBps(c) {
    if (c.cashback || c.mayhem || c.raydium) return 0;
    const v = this.venue(c);
    const seen = c.feeBps[v];
    if (Number.isFinite(seen) && seen !== null) return seen;
    return v === 'curve' ? this.tiers.curve : tierBps(this.tiers.amm, this.mcapSol(c) ?? 0);
  }

  /** Outside USD volume for a window ('h1' | 'h6' | 'h24'): pump.fun's activity, else DexScreener, else Jupiter. */
  extVolUsd(c, w) {
    const act = c.ext.act?.[w]?.volUsd;
    if (Number.isFinite(act) && c.ext.act && this.now() - c.ext.act.at < 15 * MIN) return act;
    const dex = c.ext.dex;
    const dv = w === 'h1' ? dex?.vol1hUsd : w === 'h6' ? dex?.vol6hUsd : dex?.vol24hUsd;
    if (Number.isFinite(dv) && dv !== null && this.now() - dex.at < 15 * MIN) return dv;
    const j = c.ext.jup;
    const jv = w === 'h1' ? j?.vol1h : w === 'h6' ? j?.vol6h : j?.vol24h;
    if (Number.isFinite(jv) && jv !== null && this.now() - j.at < 15 * MIN) return jv;
    if (w === 'h1' && Number.isFinite(c.ext.pump?.vol1hUsd) && c.ext.pump.vol1hUsd !== null) return c.ext.pump.vol1hUsd;
    return null;
  }

  /** Creator fees, trades and volume per window. `exact`: we followed every trade of the window. */
  windows(c) {
    const t = this.now();
    const out = {};
    for (const [k, ms] of Object.entries(WINDOWS)) {
      const s = ms <= HOUR ? sumTrades(c.trades, ms, t) : sumMinutes(c.minutes, ms, t);
      const covered = coveredMs(c.coverage, t - ms, t, t);
      const w = { ...amount(s.fee), exact: isExact(ms, covered), trades: s.trades, buys: s.buys, sells: s.sells, vol: amount(s.vol) };
      if (!w.exact) {
        w.coverSec = Math.round(covered / 1000);
        if (k === 'h1' || k === 'h6' || k === 'h24') {
          const est = estFee(this.extVolUsd(c, k), this.solUsd, this.rateBps(c));
          if (est !== null) w.est = amount(Math.max(est, s.fee));
        }
      }
      out[k] = w;
    }
    return out;
  }

  /** Fees in [from, to] (ms) from the trades of the last hour (exact) or the minute buckets beyond. */
  feesBetween(c, from, to = this.now()) {
    if (from >= this.now() - HOUR) {
      let fee = 0;
      for (let i = c.trades.length - 1; i >= 0; i--) {
        const tr = c.trades[i];
        if (tr.t < from) break;
        if (tr.t <= to) fee += tr.fee;
      }
      return fee;
    }
    let fee = 0;
    const a = Math.floor(from / MIN);
    const b = Math.floor(to / MIN);
    for (const [m, x] of c.minutes) if (m >= a && m <= b) fee += x.fee;
    return fee;
  }

  /** The share (0..1, 2 decimals) of [from, to) — capped at now — during which we followed the coin's trades. */
  cover(c, from, to) {
    const end = Math.min(to, this.now());
    if (end <= from) return 0;
    return Math.round((coveredMs(c.coverage, from, end, this.now()) / (end - from)) * 100) / 100;
  }

  /** The score that ranks Hot coins: creator fees of the last hour (exact when covered, else the estimate). */
  score(c) {
    const t = this.now();
    const s = sumTrades(c.trades, HOUR, t);
    const covered = coveredMs(c.coverage, t - HOUR, t, t);
    if (isExact(HOUR, covered)) return s.fee;
    const est = estFee(this.extVolUsd(c, 'h1'), this.solUsd, this.rateBps(c));
    // a coin we follow part of the hour: what we saw, scaled up, unless the outside estimate says more
    const seen = covered > 5 * MIN ? (s.fee * HOUR) / covered : 0;
    return Math.max(est ?? 0, seen, s.fee);
  }

  /** The coin's image: pump.fun's CDN for pump.fun coins, else the best known image. */
  image(c, size = '86x86') {
    return c.mint.endsWith('pump') || c.ext.pump ? imageUrl(c.mint, size) : c.image ?? null;
  }

  /** The row every list shows (the app's `Coin`, without the flipfee part). */
  row(c, extra = {}) {
    const w = this.windows(c);
    const createdAt = c.createdAt ?? null;
    const image = this.image(c);
    const priceSol = this.priceSol(c);
    const sharingKey = sharingConfigOf(c.mint);
    const row = {
      mint: c.mint,
      symbol: c.symbol || '',
      name: c.name || '',
      image,
      createdAt,
      ageSec: createdAt ? Math.max(0, Math.round((this.now() - createdAt) / 1000)) : null,
      mcapUsd: this.mcapUsd(c),
      priceSol: priceSol ? Number(priceSol.toPrecision(6)) : null,
      priceUsd: priceSol && this.solUsd ? Number((priceSol * this.solUsd).toPrecision(6)) : null,
      graduated: !!c.graduated,
      venue: this.venue(c),
      quote: c.quote === 'sol' ? 'sol' : 'other',
      creator: (c.graduated ? c.coinCreator : c.feeTo) ?? c.feeTo ?? c.dev ?? null,
      dev: c.dev ?? null,
      // who can set the coin's fee split: the sharing config's admin, else the creator pump pays (the pool's coin
      // creator once graduated: a takeover can move it away from the wallet that launched the coin)
      admin: c.sharing && !c.sharing.none ? c.sharing.admin : (c.graduated ? c.coinCreator : c.feeTo && c.feeTo !== sharingKey ? c.feeTo : null) ?? c.dev ?? null,
      sharing: c.feeTo === sharingKey || (c.sharing && !c.sharing.none) ? { config: sharingKey, revoked: c.sharing?.revoked ?? null, shareholders: c.sharing?.shareholders ?? c.shareholders ?? null } : null,
      // whether the coin could still join flipfee (pump allows one final fee split): false once a split is locked
      // to other wallets, for non-SOL coins and coins without creator fees; null while unknown
      canJoin: this.canJoin(c),
      feeBps: this.rateBps(c),
      fees: { m1: w.m1, m10: w.m10, h1: w.h1, h6: w.h6, h24: w.h24 },
      trades1h: w.h1.trades,
      buys1h: w.h1.buys,
      sells1h: w.h1.sells,
      volume1h: w.h1.vol,
      // [hour start ms, creator fees in SOL, share of the hour we followed (0..1: below 1 the fees are partial)]
      hourly: hourly(c.minutes, 24, this.now()).map(([h, l]) => [h, l / LAMPORTS, this.cover(c, h, h + HOUR)]),
      tracked: !!c.tracked,
      trackedSince: c.tracked ? c.trackedSince : null,
      lastTradeAt: c.lastTradeAt || null,
      socials: c.socials ?? {},
      hidden: this.hidden(c),
      links: linksOf(c.mint),
      ...extra,
    };
    return row;
  }

  canJoin(c) {
    if (c.quote !== 'sol' || this.rateBps(c) === 0) return false;
    if (!c.sharing) return null;
    if (c.sharing.none || !c.sharing.revoked) return true;
    // a locked split can only be flipfee's own vault (one shareholder, 100%): then the coin joins with `register`
    const sh = c.sharing.shareholders ?? [];
    return sh.length === 1 && sh[0].shareBps === 10_000 && !!this.isVault?.(c.mint, sh[0].address);
  }

  /** The coin page adds the description, the curve and pool addresses. */
  detail(c) {
    return {
      description: cleanAbout(c.description) ?? null,
      curve: c.curve ?? curveOf(c.mint),
      pool: c.pool ?? null,
      sharingConfig: sharingConfigOf(c.mint),
      supply: c.supply,
      solUsd: this.solUsd,
      image256: this.image(c, '256x256'),
    };
  }

  /** Trades for the stream and the coin page. */
  tradeOut(c, rec) {
    return {
      id: `${rec.sig}:${rec.ix}`,
      mint: c.mint,
      sig: rec.sig,
      ix: rec.ix,
      t: rec.t,
      side: rec.buy ? 'buy' : 'sell',
      sol: rec.lam / LAMPORTS,
      lamports: String(rec.lam),
      fee: amount(rec.fee),
      wallet: rec.wallet,
      venue: rec.venue,
    };
  }

  get size() {
    return this.coins.size;
  }
}

export { isSolQuote };
