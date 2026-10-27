// Hot coins: candidates from pump.fun's own lists (recently traded, biggest market caps, live streams) and Jupiter's
// top traded tokens of the last hour (pump.fun launchpad only), filled with DexScreener pair data (1h/6h/24h volume
// and trades, 30 coins per request) and pump.fun's per-coin market activity for the leaders. Ranked by creator fees
// of the last hour: exact once we follow the coin for the whole hour, else estimated from that volume at pump's
// creator-fee rate for the coin (curve 0.30%, PumpSwap tiers by market cap; 0 for cashback, mayhem, Raydium coins).
// Only SOL-paired pump.fun coins qualify (flipfee v1 sells SOL fees), never hidden (slur names, bans) ones. A coin whose
// fee split is already locked to other wallets (pump allows one) ranks at half its score: it can never join.
import { logError } from './log.js';
import { HOUR } from './metrics.js';

const isPumpish = (c) => c.ext.pump?.program === 'pump' || c.ext.jup?.launchpad === 'pump.fun' || c.mint.endsWith('pump');

export class Hot {
  constructor({ cfg, store, pump, dex, jupiter, now = () => Date.now() }) {
    Object.assign(this, { cfg, store, pump, dex, jupiter, now });
    this.cands = new Map(); // mint → { at, src: Set }
    this.counts = { refreshes: 0, candidates: 0, ranked: 0 };
    this.lastRanked = [];
  }

  /** Candidates from the last run (their records came back from SQLite with the store). */
  seed(mints) {
    for (const m of mints) this.add(m, 'restart');
  }

  add(mint, src) {
    const x = this.cands.get(mint) ?? { at: 0, src: new Set() };
    x.at = this.now();
    x.src.add(src);
    this.cands.set(mint, x);
  }

  /** Whether a coin may be on the Hot list at all. */
  eligible(c) {
    if (!c || this.store.hidden(c) || c.nsfw) return false;
    if (c.quote !== 'sol' || c.raydium) return false;
    if (!isPumpish(c)) return false;
    if (c.ext.pump && c.ext.pump.program && c.ext.pump.program !== 'pump') return false;
    return this.store.rateBps(c) > 0;
  }

  /** One discovery round (the lists, then volumes for the best candidates). */
  async refresh() {
    const t = this.now();
    const lists = await Promise.allSettled([
      this.pump.list({ sort: 'last_trade_timestamp', limit: 50 }),
      this.pump.list({ sort: 'market_cap', limit: 50, maxAgeMs: 60_000 }),
      this.pump.live({ limit: 50 }),
      this.jupiter.toptraded('1h', 100),
    ]);
    const names = ['recent', 'mcap', 'live'];
    lists.slice(0, 3).forEach((r, i) => {
      if (r.status !== 'fulfilled') return logError(`hot.pump.${names[i]}.fail`, r.reason);
      for (const p of r.value) {
        // a coin quiet for 6 hours is no hot coin, whatever its market cap
        if (p.lastTradeAt && t - p.lastTradeAt > 6 * HOUR) continue;
        this.store.onPump(p);
        this.add(p.mint, names[i]);
      }
    });
    if (lists[3].status === 'fulfilled') {
      for (const j of lists[3].value) {
        if (j.launchpad !== 'pump.fun') continue;
        this.store.onJup(j);
        this.add(j.mint, 'jupiter');
      }
    } else logError('hot.jupiter.fail', lists[3].reason);
    for (const [m, x] of this.cands) if (t - x.at > 30 * 60_000 && !this.store.get(m)?.tracked) this.cands.delete(m);

    // volumes: DexScreener for every candidate without fresh pair data (30 per request, ≤ 4 requests)
    const stale = [...this.cands.keys()].filter((m) => {
      const c = this.store.get(m);
      return c && (!c.ext.dex || t - c.ext.dex.at > 90_000);
    });
    stale.sort((a, b) => this.store.score(this.store.get(b)) - this.store.score(this.store.get(a)));
    try {
      for (const pair of (await this.dex.pairs(stale.slice(0, 120))).values()) this.store.onDex(pair);
    } catch (e) {
      logError('hot.dex.fail', e);
    }
    // pump.fun's record (curve, pool, quote, creator) for strong candidates seen only through Jupiter or DexScreener
    const ranked = this.rank();
    const missing = ranked.filter((m) => !this.store.get(m)?.ext.pump).slice(0, 8);
    for (const m of missing) {
      try {
        const p = await this.pump.coin(m);
        if (p) this.store.onPump(p);
      } catch (e) {
        logError('hot.pump.coin.fail', e);
        break;
      }
    }
    // pump.fun's own 1h/6h/24h activity for the leaders (estimates for windows we did not follow)
    for (const m of this.rank().slice(0, Math.min(20, this.cfg.trackMax))) {
      const c = this.store.get(m);
      if (c.ext.act && t - c.ext.act.at < 5 * 60_000) continue;
      try {
        this.store.onActivity(m, await this.pump.activity(m));
      } catch (e) {
        logError('hot.activity.fail', e);
        break;
      }
    }
    this.counts.refreshes++;
    this.counts.candidates = this.cands.size;
  }

  /** Eligible candidates (and tracked hot coins) by score, best first. */
  rank() {
    const out = [];
    const seen = new Set();
    for (const m of [...this.cands.keys()]) {
      const c = this.store.get(m);
      if (seen.has(m) || !this.eligible(c)) continue;
      seen.add(m);
      out.push([m, this.weighted(c)]);
    }
    out.sort((a, b) => b[1] - a[1]);
    this.lastRanked = out;
    this.counts.ranked = out.length;
    return out.map(([m]) => m);
  }

  /** The score, halved for a coin whose fee split is locked to other wallets (it can never join flipfee). */
  weighted(c) {
    return this.store.score(c) * (this.store.canJoin(c) === false ? 0.5 : 1);
  }

  scoreOf(mint) {
    const c = this.store.get(mint);
    return c ? this.weighted(c) : 0;
  }

  status() {
    return { ...this.counts, top: this.lastRanked.slice(0, 5).map(([m, s]) => ({ mint: m, symbol: this.store.get(m)?.symbol, estFeesHourSol: Math.round(s / 1e6) / 1e3 })) };
  }
}
