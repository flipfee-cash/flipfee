// flipfee server: config → storage → live pump.fun data (trades with exact creator fees, Hot discovery, tracking)
// → the flipfee index (program accounts and events, through the program builder's client) → wants → views → HTTP + SSE
// → the keeper (program/keeper) when KEEPER=1. Read-only on chain unless the keeper runs.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listen, makeHandler, validMint } from './api.js';
import { Auth } from './auth.js';
import { Bus } from './bus.js';
import { loadFlipfee } from './chain/flipfee.js';
import { Indexer } from './chain/indexer.js';
import { Rpc } from './chain/rpc.js';
import { CoinStore } from './coins.js';
import { anchorProgramId, loadConfig, SERVER_ROOT } from './config.js';
import { Db } from './db.js';
import { httpError } from './errors.js';
import { Hot } from './hot.js';
import { Ingest } from './ingest/index.js';
import { startKeeper } from './keeper.js';
import { fileIsOpen } from './keys.js';
import { log, logError, redact } from './log.js';
import { withDeadline } from './net.js';
import { DexScreener } from './sources/dexscreener.js';
import { Jupiter } from './sources/jupiter.js';
import { PumpFun } from './sources/pumpfun.js';
import { SseHub } from './sse.js';
import { Tracker } from './tracker.js';
import { Views } from './views.js';
import { Wants } from './wants.js';
import { Orders } from './orders.js';
import { decodeCurve } from './chain/pumpchain.js';
import { curveOf } from './ingest/pumpevents.js';

export async function startServer(cfg, { listenHttp = true, WebSocketImpl = globalThis.WebSocket, fetchFn, adapter: adapterIn = null, rpc: rpcIn = null } = {}) {
  const db = new Db(cfg.dbPath);
  const bus = new Bus({ db, size: cfg.ringSize });
  const store = new CoinStore({ db });
  store.load(Number(db.getMeta('aliveAt')) || null);
  const rpc = rpcIn ?? new Rpc({ url: cfg.rpcUrl, wsUrl: cfg.rpcWsUrl, minIntervalMs: cfg.rpcMinIntervalMs, fetchFn });
  const pump = cfg.pumpApi ? new PumpFun({ fetchFn }) : null;
  const dex = cfg.pumpApi ? new DexScreener({ fetchFn }) : null;
  const jupiter = cfg.pumpApi ? new Jupiter({ fetchFn }) : null;
  const wants = new Wants({ db, bus });
  const orders = new Orders({ db, bus });
  const hot = cfg.hotOn && pump ? new Hot({ cfg, store, pump, dex, jupiter }) : null;
  const tracker = new Tracker({ cfg, store, hot });
  // a restart resumes the coins it followed (their records and buckets came back with the store)
  try {
    const last = JSON.parse(db.getMeta('hotSet', '[]'));
    if (hot && Array.isArray(last) && last.length) {
      hot.seed(last);
      tracker.resume(last.filter((m) => store.get(m)));
    }
  } catch {
    // no saved set
  }

  // the flipfee program (client → IDL → DESIGN shapes), and its index
  const loadAdapter = () => loadFlipfee({ clientPath: cfg.clientPath, programId: cfg.programId, fallbackProgramId: cfg.localnet ? anchorProgramId() : '' });
  let adapter = adapterIn ?? (await loadAdapter());
  log('flipfee.adapter', adapter.describe());
  store.isVault = (mint, address) => adapter.ready && adapter.vaultPda(mint) === address;
  const app = {};
  const makeIndexer = (a) => (cfg.indexOn && a.ready ? new Indexer({ adapter: a, rpc, wsUrl: cfg.rpcWsUrl, WebSocketImpl, db, bus, pollMs: cfg.indexPollMs }) : null);
  let indexer = makeIndexer(adapter);
  const views = new Views({ cfg, store, tracker, hot, indexer, wants, pump, rpc, adapter });
  const ingest = new Ingest({ cfg, store, bus, tracker, hot, indexer, rpc, jupiter, pump, WebSocketImpl });
  const attach = (ix) => {
    if (ix) ix.rowFn = (mint) => views.row(mint);
    views.indexer = ix;
    ingest.indexer = ix;
    app.indexer = ix;
  };
  attach(indexer);

  // chain events: the next board snapshot is rebuilt; a new coin is followed at once (its first trades count)
  bus.subscribe((ev) => {
    if (ev.type === 'trade' || ev.type === 'book') return;
    views.invalidate(ev.type === 'register' ? ev.mint : null);
    if (ev.type === 'register' && cfg.ingestOn) {
      queueMicrotask(() => {
        ingest.trackTick();
        ingest.mintMetaTick().catch(() => {});
      });
    }
  });

  const auth = new Auth(db, { origins: cfg.origins, chainId: cfg.siwsChainId, sessionHours: cfg.sessionHours, devAnyLocal: !cfg.production });
  const sse = new SseHub({ bus, statsFn: () => views.statsFrame(), maxPerIp: cfg.sseMaxPerIp, tradesPerSec: cfg.sseTradesPerSec, priority: () => app.indexer?.coins ?? null });

  /** A coin may get wants when we know it as a pump.fun coin (store, pump.fun, or its curve on chain) and it is shown. */
  const checkWantable = async (mint) => {
    let c = store.get(mint);
    if (!c?.ext.pump && pump) {
      const p = await withDeadline(pump.coin(mint, { front: true }), 3_000, 'pump.fun').catch(() => null);
      if (p) c = store.onPump(p);
    }
    if (!c?.ext.pump && !c?.lastTradeAt && !app.indexer?.coins.has(mint)) {
      const a = await rpc.call('getAccountInfo', [curveOf(mint), { encoding: 'base64', commitment: 'confirmed' }]).catch(() => null);
      if (!decodeCurve(a?.value?.data ? Buffer.from(a.value.data[0], 'base64') : null)) throw httpError(404, 'unknownCoin');
      c = store.ensure(mint);
    }
    if (store.hidden(c)) throw httpError(403, 'hidden');
  };

  const startedAt = Date.now();
  let keeper = null;
  const health = () => {
    const ing = ingest.status();
    const ix = app.indexer;
    const tr = ing.trades;
    const tradesWs = tr?.connected !== undefined ? { connected: tr.connected, sockets: tr.sockets, subscriptions: tr.subscribed, targets: tr.targets, ...tr.last1m, notifications: tr.notifications, failedTx: tr.failedTx, trades: tr.trades, tradesPerMin: tr.tradesPerMin, subErrors: tr.subErrors, reconnects: tr.reconnects, perSocket: tr.perSocket } : tr;
    return {
      ok: ing.ok && (!ix || ix.loaded),
      service: 'flipfee-server',
      cluster: cfg.cluster,
      production: cfg.production,
      programId: adapter.programId || null,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      siws: { domains: cfg.origins.map((o) => new URL(o).host), uri: cfg.origins[0], chainId: cfg.siwsChainId, trustProxy: cfg.trustProxy },
      tracking: { ...tracker.status(), label: 'top coins' },
      rpcLoad: { http: rpc.status(), tradesWs, indexWs: ix?.ws ? { connected: ix.ws.open, ...ix.ws.load(60) } : null },
      index: ix ? ix.status() : { off: true, reason: adapter.ready ? 'INDEX=0' : 'no program id (FLIPFEE_PROGRAM_ID or the client)', adapter: adapter.describe() },
      ingest: ing,
      sources: pump ? { pumpfun: pump.status(), dexPairs: dex.pairsSrc.status(), jupiter: jupiter.src.status() } : { off: true },
      sse: sse.status(),
      keeper: keeper ? keeper.status() : { on: false, reason: cfg.keeperOn ? 'starting' : 'KEEPER=0' },
      bus: { ring: bus.ring.length, counts: bus.counts },
      db: cfg.dbPath === ':memory:' ? ':memory:' : redact(`file://${cfg.dbPath}`).replace('file://', ''),
    };
  };

  /** The market list: coins with orders and the hottest coins, or a search (ticker, name or CA). Each row carries a
   *  short book (3 levels a side). */
  const market = async (q = '') => {
    const term = String(q).trim().replace(/^\$/, '').toLowerCase().slice(0, 64);
    let mints;
    if (term) {
      const ca = validMint(String(q).trim());
      if (ca) {
        await checkWantable(ca).catch(() => null);
        mints = store.get(ca) && !store.hidden(store.get(ca)) ? [ca] : [];
      } else {
        const hits = [];
        for (const c of store.coins.values()) {
          if (store.hidden(c) || !c.symbol) continue;
          const sym = c.symbol.toLowerCase();
          const name = (c.name || '').toLowerCase();
          const rank = sym === term ? 0 : sym.startsWith(term) ? 1 : name.startsWith(term) ? 2 : sym.includes(term) || name.includes(term) ? 3 : -1;
          if (rank >= 0) hits.push([rank, c]);
        }
        mints = hits.sort((a, b) => a[0] - b[0] || (b[1].lastTradeAt ?? 0) - (a[1].lastTradeAt ?? 0)).slice(0, 30).map(([, c]) => c.mint);
      }
    } else {
      const board = views.board();
      const withOrders = orders.active(40).map((r) => r.mint);
      mints = [...new Set([...board.live.map((r) => r.mint), ...withOrders, ...board.hot.map((r) => r.mint)])]
        .filter((m) => store.get(m) && !store.hidden(store.get(m)))
        .slice(0, 40);
    }
    return {
      q: term,
      coins: mints.map((m) => {
        const r = views.row(m);
        delete r.hourly;
        const b = orders.book(m, { depth: 3 });
        return { ...r, book: { bids: b.bids, asks: b.asks, bestBid: b.bestBid, bestAsk: b.bestAsk, spread: b.spread, orders: b.orders } };
      }),
    };
  };

  Object.assign(app, { market });
  Object.assign(app, { cfg, db, bus, store, rpc, pump, dex, jupiter, wants, orders, hot, tracker, views, ingest, auth, sse, health, checkWantable, indexer });
  const handler = makeHandler(app);
  const server = listenHttp ? await listen(handler, cfg.port, cfg.host) : null;

  const timers = [];
  const every = (ms, fn) => {
    const t = setInterval(() => void Promise.resolve().then(fn).catch((e) => logError('loop.fail', e)), ms);
    t.unref?.();
    timers.push(t);
  };
  // `aliveAt` right after each flush: a crash ends the coverage no later than the last trades we saved
  every(5_000, () => {
    store.flush();
    db.setMeta('aliveAt', Date.now());
  });
  every(30_000, () => db.setMeta('hotSet', JSON.stringify(tracker.hotMints())));
  if (cfg.ingestOn) ingest.start();
  // flipfee's own quotes: a ladder on the 12 hottest coins around what their fees paid in the last hour
  if (cfg.houseQuotes) {
    const houseTick = () => {
      const top = views.board().hot.filter((r) => views.hourKey(r) > 0).slice(0, 12);
      if (!top.length) return; // the hot list is still loading after a start
      const keep = new Set(top.map((r) => r.mint));
      for (const r of top) orders.quote(r.mint, views.hourKey(r));
      for (const { mint } of db.all("SELECT DISTINCT mint FROM orders WHERE house = 1 AND status = 'open'")) if (!keep.has(mint)) orders.quote(mint, 0);
    };
    setTimeout(() => void Promise.resolve().then(houseTick).catch((e) => logError('house.fail', e)), 20_000).unref?.();
    every(60_000, houseTick);
    every(3_600_000, () => orders.prune());
  }
  if (indexer) await indexer.start();

  // the program builder's client may land while we run: switch to it (and to its program id) when it does
  if (adapter.source !== 'client' && !adapterIn) {
    every(cfg.clientPollMs, async () => {
      if (adapter.source === 'client') return;
      const next = await loadAdapter();
      if (next.source === 'design' || (next.source === adapter.source && next.programId === adapter.programId)) return;
      log('flipfee.adapter.switch', { from: adapter.source, to: next.source, program: next.programId || 'none' });
      app.indexer?.stop();
      adapter = next;
      views.adapter = next;
      indexer = makeIndexer(next);
      attach(indexer);
      if (indexer) await indexer.start();
    });
  }

  if (cfg.keeperOn) {
    try {
      keeper = await startKeeper({ cfg, rpc, adapter, log });
      app.keeper = keeper;
    } catch (e) {
      logError('keeper.start.fail', e);
      keeper = { status: () => ({ on: false, error: String(e?.message ?? e).slice(0, 200) }), stop() {} };
    }
  }

  log('start', {
    env: cfg.production ? 'production' : 'dev',
    cluster: cfg.cluster,
    port: server ? server.address().port : undefined,
    rpc: redact(cfg.rpcUrl),
    trades: cfg.tradesOn ? redact(cfg.tradesWsUrl) : 'off',
    program: adapter.programId || 'none',
    adapter: adapter.source,
    trackMax: cfg.trackMax,
    hot: hot ? 'on' : 'off',
    keeper: cfg.keeperOn ? 'on' : 'off',
    keeperKeyOpen: cfg.keeperKeypairFile && fileIsOpen(cfg.keeperKeypairFile) ? 'yes' : undefined,
    origins: cfg.origins.join(','),
    db: cfg.dbPath,
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const t of timers) clearInterval(t);
    await Promise.resolve(keeper?.stop?.()).catch(() => {});
    ingest.stop();
    app.indexer?.stop();
    sse.close();
    if (server) {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    }
    db.setMeta('aliveAt', Date.now());
    db.setMeta('hotSet', JSON.stringify(tracker.hotMints()));
    db.close();
  };
  Object.assign(app, { server, handler, stop });
  Object.defineProperty(app, 'adapter', { get: () => adapter, enumerable: true });
  return app;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const envFile = join(SERVER_ROOT, '.env');
  if (existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
  let app;
  try {
    app = await startServer(loadConfig());
  } catch (e) {
    logError('start.fail', e);
    process.exit(1);
  }
  const shutdown = async (sig) => {
    log('stop', { signal: sig });
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
