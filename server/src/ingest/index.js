// Ingest: real data in, numbers and stream events out.
//   trades (curvelogs.js): every trade of the tracked coins with its exact creator fee → the store's windows and the
//     stream's `trade` events (hidden coins stay out)
//   PumpPortal: launches (a new coin's creator) and migrations (a tracked curve moves to its pool)
//   loops: SOL/USD (Jupiter, pump.fun backup) 15 s · Hot discovery 60 s · tracker 5 s (rotation every ROTATE_MS) ·
//     prune 60 s · pump's fee tiers 1 h · fee-split state of new tracked coins 30 s (each coin every 10 min) ·
//     names from Token-2022 mints for coins no API names 5 s · pump.fun records of tracked coins 30 s
//   (the store flushes to SQLite every 5 s from main.js, next to the `aliveAt` mark)
import { log, logError } from '../log.js';
import { readMintMeta, readSharing, readTiers } from '../chain/pumpchain.js';
import { CurveLogs, TradeFeeds } from './curvelogs.js';
import { PumpPortal } from './pumpportal.js';

export class Ingest {
  constructor({ cfg, store, bus, tracker, hot, indexer = null, rpc, jupiter, pump, WebSocketImpl = globalThis.WebSocket, now = () => Date.now() }) {
    Object.assign(this, { cfg, store, bus, tracker, hot, indexer, rpc, jupiter, pump, now });
    this.pp = cfg.pumpPortalOn
      ? new PumpPortal({ url: cfg.pumpPortalUrl, apiKey: cfg.pumpPortalKey, WebSocketImpl, onCreate: (d) => this.onCreate(d), onMigrate: (d) => this.onMigrate(d), onTrade: () => {} })
      : null;
    this.trades = cfg.tradesOn
      ? new TradeFeeds(
          cfg.tradesConns ?? 1,
          () =>
            new CurveLogs({
              url: cfg.tradesWsUrl,
              WebSocketImpl,
              sendPerSec: cfg.subsPerSec,
              onTrade: (tr) => this.onTrade(tr),
              onCover: (mint, on, t) => (on ? store.coverStart(mint, t) : store.coverEnd(mint, t)),
              onMigrate: (d) => this.onMigrate(d),
              onGap: (g) => void this.fillGap(g),
              now,
            }),
        )
      : null;
    if (this.trades) tracker.load = () => this.trades.loadByMint(60_000);
    this.timers = [];
    this.loops = {};
    this.counts = { trades: 0, streamed: 0, skippedQuote: 0, launches: 0, migrations: 0, gaps: 0, gapsFilled: 0, gapTxs: 0 };
  }

  start() {
    this.pp?.start();
    this.trades?.start();
    if (this.cfg.pumpApi) this.every('sol', 15_000, () => this.solTick(), true);
    if (this.cfg.hotOn) this.every('hot', 60_000, () => this.hot.refresh(), true);
    this.every('track', 5_000, () => this.trackTick(), true);
    this.every('prune', 60_000, () => {
      this.store.prune();
      this.store.saveRecords([...this.tracker.current.keys()]);
    });
    this.every('tiers', 3_600_000, async () => this.store.setTiers(await readTiers(this.rpc)), true);
    this.every('sharing', 30_000, () => this.sharingTick());
    this.every('mintMeta', 5_000, () => this.mintMetaTick(), true);
    if (this.cfg.pumpApi) this.every('records', 30_000, () => this.recordsTick());
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.pp?.stop();
    this.trades?.stop();
    this.store.flush();
  }

  every(name, ms, fn, now = false) {
    const state = (this.loops[name] = { runs: 0, errors: 0, lastAt: 0, lastError: null, busy: false });
    const run = async () => {
      if (state.busy) return;
      state.busy = true;
      try {
        await fn();
        state.runs++;
        state.lastAt = this.now();
      } catch (e) {
        state.errors++;
        state.lastError = String(e?.message ?? e).slice(0, 160);
        if (state.errors <= 3 || state.errors % 20 === 0) logError(`ingest.${name}.fail`, e, { n: state.errors });
      } finally {
        state.busy = false;
      }
    };
    const t = setInterval(run, ms);
    t.unref?.();
    this.timers.push(t);
    if (now) void run();
    return run;
  }

  // ───────────── trades ─────────────

  onTrade(tr) {
    this.counts.trades++;
    const rec = this.store.onTrade(tr);
    if (!rec) {
      this.counts.skippedQuote++;
      return;
    }
    const c = this.store.get(tr.mint);
    if (!c || this.store.hidden(c)) return;
    const out = this.store.tradeOut(c, rec);
    const now = this.indexer?.holderNow(c.mint);
    if (now) out.to = { wallet: now.to, kind: now.kind };
    this.counts.streamed++;
    this.bus.push('trade', out);
  }

  /**
   * A dropped trade socket left a gap in a flipfee coin's trades (its holders' "this hour" counts every fee): read
   * the gap's transactions from chain (the address's signatures after the last one we saw, at most 300) and decode
   * them like live ones; a complete read closes the coin's coverage gap. Hot coins keep the gap (their windows say so).
   */
  async fillGap({ mint, address, untilSig, from, to }) {
    this.counts.gaps++;
    if (!untilSig || !this.indexer?.coins.has(mint) || !this.trades) return;
    try {
      const sigs = await this.rpc.call('getSignaturesForAddress', [address, { until: untilSig, limit: 1000, commitment: 'confirmed' }]);
      if (!Array.isArray(sigs)) return;
      const inGap = sigs.filter((x) => !x.err && (!x.blockTime || x.blockTime * 1000 <= to + 5_000)).reverse();
      if (sigs.length >= 1000 || inGap.length > 300) return;
      for (const x of inGap) {
        const tx = await this.rpc.call('getTransaction', [x.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
        if (!tx?.meta) return; // not readable yet: the gap stays open
        this.counts.gapTxs++;
        if (!tx.meta.err) this.trades.handleLogs(address, { signature: x.signature, logs: tx.meta.logMessages ?? [] });
      }
      this.store.coverPatch(mint, from, to);
      this.counts.gapsFilled++;
      log('ingest.gap.filled', { mint, txs: inGap.length, sec: Math.round((to - from) / 1000) });
    } catch (e) {
      logError('ingest.gap.fail', e, { mint });
    }
  }

  onCreate(d) {
    this.counts.launches++;
    const c = this.store.get(d.mint);
    if (c && !c.dev && d.creator) c.dev = d.creator;
  }

  onMigrate(d) {
    if (!d?.mint) return;
    const c = this.store.get(d.mint);
    if (!c) return;
    this.counts.migrations++;
    // PumpPortal names the venue ("pump-amm"), the curve's migration event the pool address: only an address counts
    const pool = typeof d.pool === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(d.pool) ? d.pool : null;
    this.store.onMigrate(d.mint, pool);
    if (this.tracker.current.has(d.mint)) {
      log('ingest.migrate', { mint: d.mint, pool: d.pool });
      this.trackTick();
    }
  }

  // ───────────── loops ─────────────

  async solTick() {
    let v = await this.jupiter.solUsd(10_000);
    if (!v) v = await this.pump.solUsd().catch(() => null);
    if (v) this.store.setSolUsd(v);
  }

  trackTick() {
    if (this.indexer) this.tracker.setRegistered([...this.indexer.coins.keys()]);
    const out = this.tracker.compute();
    this.trades?.setTargets(out);
  }

  /** The fee-split state (pump_fees sharing config) of tracked coins: new ones at once, the rest every 10 minutes. */
  async sharingTick() {
    const mints = [...this.tracker.current.keys()].filter((m) => {
      const c = this.store.get(m);
      return !c?.sharing || this.now() - c.sharing.at > 10 * 60_000;
    });
    if (!mints.length) return;
    const r = await readSharing(this.rpc, mints.slice(0, 100));
    for (const [m, s] of r) this.store.onSharing(m, s);
  }

  /** Names from the mints themselves for registered and tracked coins no API named (localnet coins, brand-new ones). */
  async mintMetaTick() {
    const mints = [...new Set([...(this.indexer?.coins.keys() ?? []), ...this.tracker.current.keys()])].filter((m) => {
      const c = this.store.get(m);
      return !c || (!c.symbol && !c.triedMeta);
    });
    if (!mints.length) return;
    const part = mints.slice(0, 100);
    const found = await readMintMeta(this.rpc, part);
    for (const m of part) this.store.ensure(m).triedMeta = true;
    for (const [m, meta] of found) this.store.onChainMeta(m, meta);
  }

  async recordsTick() {
    const need = [...this.tracker.current.keys()].filter((m) => {
      const p = this.store.get(m)?.ext.pump;
      return !p || this.now() - p.at > 10 * 60_000;
    });
    for (const m of need.slice(0, 5)) {
      try {
        const p = await this.pump.coin(m, { maxAgeMs: 5 * 60_000 });
        if (p) this.store.onPump(p);
      } catch (e) {
        logError('ingest.record.fail', e);
        break;
      }
    }
  }

  status() {
    const tr = this.trades?.status();
    return {
      ok: !this.trades || !!tr?.connected,
      trades: tr ?? { off: true },
      pumpportal: this.pp ? this.pp.status() : { off: true },
      tracker: this.tracker.status(),
      hot: this.hot?.status() ?? null,
      counts: this.counts,
      loops: this.loops,
      coins: this.store.size,
      solUsd: this.store.solUsd,
    };
  }
}
