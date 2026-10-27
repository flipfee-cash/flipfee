// Which coins' trades we follow (trade subscriptions are the scarce resource: TRACK_MAX, default 60). Every
// registered flipfee coin first, then a few coins people opened (10 minutes each), then the hottest coins by creator
// fees. Rotation every ROTATE_MS: empty slots fill from the top of the ranking; a tracked hot coin that has had its
// MIN_DWELL_MIN gives way to a candidate whose score is SWAP_MARGIN times higher (at most MAX_SWAPS per round), so
// coins stay followed long enough for exact windows. A coin is followed on its bonding curve, or on its PumpSwap
// pool once graduated (a migration switches it at the next compute). MSG_BUDGET caps the messages per second the
// trade sockets bring (busy pools are mostly bot noise): over it, the coins with the least fees per message go first.
import { canonicalPoolOf, curveOf } from './ingest/pumpevents.js';

export class Tracker {
  constructor({ cfg, store, hot = null, now = () => Date.now() }) {
    Object.assign(this, { cfg, store, hot, now });
    this.registered = new Set();
    this.pins = new Map(); // mint → until (coin pages of coins we do not follow)
    this.hotSet = new Map(); // mint → since
    this.current = new Map(); // mint → { key, kind, reason }
    this.lastRotate = 0;
    this.load = () => null; // () → Map mint → { msgPerSec, tradesPerSec } of the followed coins (the trade sockets)
    this.noisy = new Map(); // mint → until: dropped to keep the sockets under MSG_BUDGET
    this.counts = { rotations: 0, swaps: 0, adds: 0, drops: 0, budgetDrops: 0 };
  }

  /** Resume the hot coins of the last run (a restart keeps following them: their windows stay exact). */
  resume(mints) {
    const t = this.now();
    for (const m of mints) if (!this.hotSet.has(m)) this.hotSet.set(m, t - this.cfg.minDwellMs);
  }

  setRegistered(mints) {
    this.registered = new Set(mints);
  }

  /** Follow a coin someone opened for 10 minutes, when there is room (at most 5 at once). */
  pin(mint) {
    if (this.registered.has(mint) || this.hotSet.has(mint)) return;
    const free = this.cfg.trackMax - this.registered.size;
    if (free <= 10) return;
    if (this.pins.size >= 5 && !this.pins.has(mint)) return;
    this.pins.set(mint, this.now() + 10 * 60_000);
  }

  target(c) {
    if (c.graduated) {
      const pool = c.pool ?? canonicalPoolOf(c.mint);
      return pool ? { key: pool, kind: 'pool', quoteMint: 'So11111111111111111111111111111111111111112' } : null;
    }
    const curve = c.curve ?? curveOf(c.mint);
    return curve ? { key: curve, kind: 'curve' } : null;
  }

  /** Recomputes the target set. `rotate`: also refill and swap the hot part (else only registrations and pins). */
  compute({ rotate = this.now() - this.lastRotate >= this.cfg.rotateMs } = {}) {
    const t = this.now();
    for (const [m, until] of this.pins) if (until <= t) this.pins.delete(m);
    const max = this.cfg.trackMax;
    const reg = [...this.registered].slice(0, max);
    const pins = [...this.pins.keys()].filter((m) => !this.registered.has(m)).slice(0, Math.max(0, max - reg.length));
    const slots = Math.max(0, max - reg.length - pins.length);
    for (const m of this.hotSet.keys()) if (this.registered.has(m)) this.hotSet.delete(m);

    if (rotate && this.hot) {
      this.lastRotate = t;
      this.counts.rotations++;
      for (const [m, until] of this.noisy) if (until <= t) this.noisy.delete(m);
      this.budget(t);
      const ranked = this.hot.rank().filter((m) => !this.registered.has(m) && !this.noisy.has(m));
      const rankedSet = new Set(ranked);
      // drop coins that left the candidates (hidden, non-SOL, no creator fee) or the top of the ranking for long
      for (const m of [...this.hotSet.keys()]) {
        const c = this.store.get(m);
        if (!c || !this.hot.eligible(c) || (!rankedSet.has(m) && t - this.hotSet.get(m) >= this.cfg.minDwellMs)) {
          this.hotSet.delete(m);
          this.counts.drops++;
        }
      }
      while (this.hotSet.size > slots) {
        const weakest = [...this.hotSet.keys()].sort((a, b) => this.hot.scoreOf(a) - this.hot.scoreOf(b))[0];
        this.hotSet.delete(weakest);
        this.counts.drops++;
      }
      let added = 0;
      for (const m of ranked) {
        if (this.hotSet.size >= slots || !this.fillRoom(added)) break;
        if (this.hotSet.has(m) || this.pins.has(m)) continue;
        this.hotSet.set(m, t);
        this.counts.adds++;
        added++;
      }
      // swaps: the strongest outside candidates against the weakest dwelt coins
      const outside = ranked.filter((m) => !this.hotSet.has(m) && !this.pins.has(m));
      let swaps = 0;
      for (const cand of outside) {
        if (swaps >= this.cfg.maxSwaps) break;
        const weak = [...this.hotSet.entries()].filter(([, since]) => t - since >= this.cfg.minDwellMs).map(([m]) => m).sort((a, b) => this.hot.scoreOf(a) - this.hot.scoreOf(b))[0];
        if (!weak) break;
        if (this.hot.scoreOf(cand) <= this.hot.scoreOf(weak) * this.cfg.swapMargin) break;
        this.hotSet.delete(weak);
        this.hotSet.set(cand, t);
        swaps++;
      }
      this.counts.swaps += swaps;
    } else if (this.hot && this.hotSet.size < slots && this.fillRoom(0)) {
      // empty slots fill at once (the first ranking after a start, a coin that left): no need to wait for a rotation
      let added = 0;
      for (const m of this.hot.rank()) {
        if (this.hotSet.size >= slots || !this.fillRoom(added)) break;
        if (this.registered.has(m) || this.hotSet.has(m) || this.pins.has(m) || this.noisy.has(m)) continue;
        this.hotSet.set(m, t);
        this.counts.adds++;
        added++;
      }
    }

    const out = new Map();
    const add = (m, reason) => {
      if (out.has(m) || out.size >= max) return;
      const c = this.store.ensure(m);
      const tg = this.target(c);
      if (tg) out.set(m, { ...tg, reason });
    };
    for (const m of reg) add(m, 'flipfee');
    for (const m of pins) add(m, 'view');
    for (const m of this.hotSet.keys()) add(m, 'hot');
    this.current = out;
    this.store.keep = new Set([...this.registered, ...out.keys()]);
    return out;
  }

  /**
   * The RPC budget (MSG_BUDGET messages per second over the trade sockets, 0 = none): when the followed coins bring
   * more, the hot coins with the least creator fees per message are dropped (and kept out for 30 minutes) until the
   * rest fits. Registered coins and pins always stay.
   */
  budget(t) {
    const max = this.cfg.msgBudget;
    const load = max > 0 ? this.load() : null;
    if (!load?.size) return;
    let total = 0;
    for (const v of load.values()) total += v.msgPerSec;
    if (total <= max) return;
    const value = (m) => (this.hot?.scoreOf(m) ?? 0) / Math.max(0.1, load.get(m)?.msgPerSec ?? 0.1);
    const hot = [...this.hotSet.keys()].filter((m) => load.has(m)).sort((a, b) => value(a) - value(b));
    for (const m of hot) {
      if (total <= max) break;
      total -= load.get(m).msgPerSec;
      this.hotSet.delete(m);
      this.noisy.set(m, t + 30 * 60_000);
      this.counts.budgetDrops++;
    }
  }

  /**
   * Whether another coin may be added now: always without a budget; with one, only while the measured load is under
   * 90% of it, and at most 5 coins per round once loads are measured (a new coin's load shows after a minute).
   */
  fillRoom(added) {
    const max = this.cfg.msgBudget;
    if (!max) return true;
    let total = 0;
    for (const v of this.load()?.values() ?? []) total += v.msgPerSec;
    if (total >= max * 0.9) return false;
    return total === 0 || added < 5;
  }

  /** The tracked hot coins (not registered), in no particular order. */
  hotMints() {
    return [...this.hotSet.keys()].filter((m) => this.current.has(m));
  }

  status() {
    const reasons = { flipfee: 0, view: 0, hot: 0 };
    let pools = 0;
    for (const v of this.current.values()) {
      reasons[v.reason]++;
      if (v.kind === 'pool') pools++;
    }
    return { tracked: this.current.size, max: this.cfg.trackMax, msgBudget: this.cfg.msgBudget || null, reasons, pools, curves: this.current.size - pools, pins: this.pins.size, outForLoad: this.noisy.size, ...this.counts };
  }
}
