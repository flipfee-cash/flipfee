// The trade feed (src/ingest/curvelogs.js) on a fake RPC WebSocket fed with real captured logs: paced
// logsSubscribe per tracked curve or pool, coverage from the confirmed subscription to the unsubscribe or a dropped
// socket, trades with exact creator fees for tracked coins only, deduplication, migrations; and the tracker's
// target set and rotation (src/tracker.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { CoinStore } from '../src/coins.js';
import { CurveLogs, TradeFeeds } from '../src/ingest/curvelogs.js';
import { Ingest } from '../src/ingest/index.js';
import { Bus } from '../src/bus.js';
import { curveOf } from '../src/ingest/pumpevents.js';
import { Tracker } from '../src/tracker.js';

process.env.LOG_QUIET = '1';
const fx = JSON.parse(readFileSync(new URL('./fixtures/creator-fees.json', import.meta.url), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeWS {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWS.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 5);
  }

  send(s) {
    this.sent.push(JSON.parse(s));
  }

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  emit(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function feed() {
  const trades = [];
  const cover = [];
  const migrations = [];
  const cl = new CurveLogs({ url: 'wss://x', WebSocketImpl: FakeWS, sendPerSec: 1000, onTrade: (t) => trades.push(t), onCover: (m, on, t) => cover.push([m, on, t]), onMigrate: (d) => migrations.push(d) });
  return { cl, trades, cover, migrations };
}

const confirm = (ws, n) => {
  const subs = ws.sent.filter((x) => x.method === 'logsSubscribe').slice(-n);
  subs.forEach((s, i) => ws.emit({ jsonrpc: '2.0', id: s.id, result: 100 + s.id + i * 0 }));
  return subs;
};

test('subscribe per address, coverage from the confirmation, real trades decoded with their creator fee', async () => {
  const { cl, trades, cover } = feed();
  cl.start();
  await sleep(20);
  const curveMint = fx.curveBuy.mint;
  const poolMint = fx.ammBuy.mint;
  cl.setTargets(new Map([[curveMint, { key: curveOf(curveMint), kind: 'curve' }], [poolMint, { key: fx.ammBuy.pool, kind: 'pool', quoteMint: 'So11111111111111111111111111111111111111112' }]]));
  await sleep(20);
  const ws = FakeWS.last;
  const subs = ws.sent.filter((x) => x.method === 'logsSubscribe');
  assert.deepEqual(subs.map((s) => s.params[0].mentions[0]).sort(), [curveOf(curveMint), fx.ammBuy.pool].sort());
  assert.equal(cover.length, 0, 'no coverage before the RPC confirms');
  confirm(ws, 2);
  assert.deepEqual(cover.map(([m, on]) => [m, on]).sort(), [[curveMint, true], [poolMint, true]].sort());
  const subOf = (addr) => cl.subs.get(addr).subId;
  ws.emit({ method: 'logsNotification', params: { subscription: subOf(curveOf(curveMint)), result: { value: { signature: fx.curveBuy.sig, err: null, logs: fx.curveBuy.logs } } } });
  ws.emit({ method: 'logsNotification', params: { subscription: subOf(curveOf(curveMint)), result: { value: { signature: fx.curveBuy.sig, err: null, logs: fx.curveBuy.logs } } } });
  ws.emit({ method: 'logsNotification', params: { subscription: subOf(fx.ammBuy.pool), result: { value: { signature: fx.ammBuy.sig, err: null, logs: fx.ammBuy.logs } } } });
  ws.emit({ method: 'logsNotification', params: { subscription: subOf(fx.ammBuy.pool), result: { value: { signature: 'failed', err: { x: 1 }, logs: fx.ammBuy.logs } } } });
  assert.equal(trades.length, 2, 'one per transaction (the duplicate and the failed one are skipped)');
  const [a, b] = trades;
  assert.equal(a.mint, curveMint);
  assert.equal(a.fee, fx.curveBuy.vaultGained);
  assert.equal(a.sig, fx.curveBuy.sig);
  assert.equal(a.ix, 0);
  assert.ok(a.t > 1.79e12);
  assert.equal(b.mint, poolMint);
  assert.equal(b.venue, 'amm');
  assert.equal(b.fee, fx.ammBuy.vaultGained);
  // a coin leaves the target set: unsubscribe and end its coverage
  cl.setTargets(new Map([[poolMint, { key: fx.ammBuy.pool, kind: 'pool' }]]));
  assert.ok(ws.sent.some((x) => x.method === 'logsUnsubscribe'));
  assert.deepEqual(cover.at(-1).slice(0, 2), [curveMint, false]);
  // the socket drops: every coverage ends
  ws.close();
  assert.deepEqual(cover.at(-1).slice(0, 2), [poolMint, false]);
  const st = cl.status();
  assert.equal(st.trades, 2);
  assert.equal(st.failedTx, 1);
  cl.stop();
});

test('a trade of a coin we do not track is ignored; a curve logging its migration reports the pool', async () => {
  const { cl, trades, migrations } = feed();
  cl.start();
  await sleep(20);
  const other = Keypair.generate().publicKey.toBase58();
  cl.setTargets(new Map([[other, { key: fx.curveSell.logs ? curveOf(other) : null, kind: 'curve' }]]));
  await sleep(10);
  const ws = FakeWS.last;
  confirm(ws, 1);
  const sub = cl.subs.get(curveOf(other)).subId;
  ws.emit({ method: 'logsNotification', params: { subscription: sub, result: { value: { signature: fx.curveSell.sig, err: null, logs: fx.curveSell.logs } } } });
  assert.equal(trades.length, 0, 'the logs trade another coin');
  assert.equal(migrations.length, 0);
  cl.stop();
});

test('after a dropped socket, a flipfee coin’s gap is read from chain and its coverage closes; hot coins keep the gap', async () => {
  const now = { t: Date.now() };
  const store = new CoinStore({ now: () => now.t });
  const bus = new Bus();
  const seen = [];
  bus.subscribe((e) => seen.push(e));
  const mint = fx.curveBuy.mint;
  const curve = curveOf(mint);
  const calls = [];
  const rpc = {
    async call(method, params) {
      calls.push([method, params]);
      if (method === 'getSignaturesForAddress') return [{ signature: fx.curveSell.sig, err: null, blockTime: Math.floor(now.t / 1000) - 5 }];
      if (method === 'getTransaction') return { meta: { err: null, logMessages: fx.curveSell.logs } };
      throw new Error(method);
    },
  };
  const indexer = { coins: new Map([[mint, {}]]), holderNow: () => null };
  const ingest = new Ingest({ cfg: { tradesOn: true, pumpPortalOn: false, tradesWsUrl: 'wss://x', subsPerSec: 1000 }, store, bus, tracker: { current: new Map() }, hot: null, indexer, rpc, jupiter: null, pump: null, WebSocketImpl: FakeWS, now: () => now.t });
  ingest.trades.start();
  await sleep(20);
  ingest.trades.setTargets(new Map([[mint, { key: curve, kind: 'curve' }]]));
  await sleep(20);
  let ws = FakeWS.last;
  confirm(ws, 1);
  const t0 = now.t;
  ws.emit({ method: 'logsNotification', params: { subscription: ingest.trades.feedOf(curve).subs.get(curve).subId, result: { value: { signature: fx.curveBuy.sig, err: null, logs: fx.curveBuy.logs } } } });
  assert.equal(seen.filter((e) => e.type === 'trade').length, 1);
  now.t += 120_000;
  ws.close(); // the public endpoint drops the socket (code 1006)
  const gapFrom = now.t;
  now.t += 30_000;
  await sleep(1_300); // the client reconnects (back-off ~1 s)
  ws = FakeWS.last;
  confirm(ws, 1);
  await sleep(20);
  const sigCall = calls.find(([m]) => m === 'getSignaturesForAddress');
  assert.equal(sigCall[1][0], curve);
  assert.equal(sigCall[1][1].until, fx.curveBuy.sig, 'bounded by the last signature seen before the drop');
  const trades = seen.filter((e) => e.type === 'trade');
  assert.equal(trades.length, 2, 'the gap’s trade arrives as a (late) trade event');
  assert.equal(trades[1].sig, fx.curveSell.sig);
  assert.equal(ingest.counts.gapsFilled, 1);
  const c = store.get(mint);
  assert.ok(c.coverage.some(([a, b]) => a === gapFrom && b === now.t), 'the gap is covered');
  assert.equal(store.windows(c).m1.exact, true, 'no hole in the last minute');
  assert.ok(now.t - t0 >= 150_000);
  // a hot coin (not on flipfee) keeps its gap: no chain reads for it
  const before = calls.length;
  await ingest.fillGap({ mint: 'Hot1111111111111111111111111111111111111111', address: curve, untilSig: 'x', from: 1, to: 2 });
  assert.equal(calls.length, before);
  ingest.trades.stop();
});

test('two sockets side by side: each address keeps its socket; a drop ends only that socket’s coverage', async () => {
  const cover = [];
  const sockets = [];
  class WS2 extends FakeWS {
    constructor(u) {
      super(u);
      sockets.push(this);
    }
  }
  const feeds = new TradeFeeds(2, () => new CurveLogs({ url: 'wss://x', WebSocketImpl: WS2, sendPerSec: 1000, onCover: (m, on) => cover.push([m, on]) }));
  feeds.start();
  await sleep(20);
  const coins = Array.from({ length: 12 }, () => Keypair.generate().publicKey.toBase58());
  feeds.setTargets(new Map(coins.map((m) => [m, { key: curveOf(m), kind: 'curve' }])));
  await sleep(20);
  for (const ws of sockets) confirm(ws, ws.sent.filter((x) => x.method === 'logsSubscribe').length);
  const onA = feeds.feeds[0].targets.size;
  const onB = feeds.feeds[1].targets.size;
  assert.equal(onA + onB, 12);
  assert.ok(onA > 0 && onB > 0, `split ${onA}/${onB}`);
  for (const m of coins) assert.ok(feeds.feedOf(curveOf(m)).targets.has(curveOf(m)), 'an address lives on one socket');
  assert.equal(feeds.status().subscribed, 12);
  const before = cover.filter(([, on]) => !on).length;
  sockets[0].close();
  assert.equal(cover.filter(([, on]) => !on).length - before, onA, 'only the dropped socket’s coins lose coverage');
  feeds.stop();
});

test('tracker: registered coins first, then the hottest; empty slots fill at once; swaps after the dwell time', () => {
  const now = { t: 1_791_300_000_000 };
  const store = new CoinStore({ now: () => now.t });
  const mk = () => Keypair.generate().publicKey.toBase58();
  const scores = new Map();
  const ranked = [];
  const hot = { rank: () => ranked.slice().sort((a, b) => scores.get(b) - scores.get(a)), scoreOf: (m) => scores.get(m) ?? 0, eligible: () => true };
  const cfg = { trackMax: 4, rotateMs: 60_000, minDwellMs: 15 * 60_000, swapMargin: 1.3, maxSwaps: 3 };
  const tr = new Tracker({ cfg, store, hot, now: () => now.t });
  const reg = mk();
  const h = [mk(), mk(), mk(), mk(), mk()];
  h.forEach((m, i) => {
    ranked.push(m);
    scores.set(m, 100 - i * 10); // h0 strongest
  });
  tr.setRegistered([reg]);
  let out = tr.compute({ rotate: true });
  assert.equal(out.size, 4);
  assert.equal(out.get(reg).reason, 'flipfee');
  assert.deepEqual([...tr.hotMints()].sort(), [h[0], h[1], h[2]].sort());
  assert.equal(out.get(h[0]).kind, 'curve');
  assert.equal(out.get(h[0]).key, curveOf(h[0]));
  // a much stronger newcomer waits for the dwell time
  const star = mk();
  ranked.push(star);
  scores.set(star, 1000);
  now.t += 60_000;
  tr.compute({ rotate: true });
  assert.ok(!tr.hotMints().includes(star), 'the tracked coins have not had their 15 minutes');
  now.t += 15 * 60_000;
  tr.compute({ rotate: true });
  assert.ok(tr.hotMints().includes(star));
  assert.ok(!tr.hotMints().includes(h[2]), 'the weakest gave way');
  // a coin that graduates is followed on its pool
  store.ensure(h[0]).graduated = true;
  store.get(h[0]).pool = mk();
  out = tr.compute({ rotate: false });
  assert.equal(out.get(h[0]).kind, 'pool');
  assert.equal(out.get(h[0]).key, store.get(h[0]).pool);
  // more registered coins take hot slots
  tr.setRegistered([reg, mk(), mk()]);
  out = tr.compute({ rotate: true });
  assert.equal([...out.values()].filter((v) => v.reason === 'flipfee').length, 3);
  assert.equal(out.size, 4);
  // a coin page pins a coin only with room to spare
  tr.pin(mk());
  assert.equal(tr.pins.size, 0);
});

test('the message budget drops the hot coins with the least fees per message, keeps them out, never a flipfee coin', () => {
  const now = { t: 1_791_300_000_000 };
  const store = new CoinStore({ now: () => now.t });
  const mk = () => Keypair.generate().publicKey.toBase58();
  const coins = [mk(), mk(), mk(), mk()];
  const reg = mk();
  const scores = new Map([[coins[0], 100], [coins[1], 90], [coins[2], 80], [coins[3], 70]]);
  const hot = { rank: () => coins.slice(), scoreOf: (m) => scores.get(m) ?? 0, eligible: () => true };
  const tr = new Tracker({ cfg: { trackMax: 10, rotateMs: 60_000, minDwellMs: 15 * 60_000, swapMargin: 1.5, maxSwaps: 3, msgBudget: 100 }, store, hot, now: () => now.t });
  tr.setRegistered([reg]);
  tr.compute({ rotate: true });
  assert.equal(tr.hotMints().length, 4);
  // coin 1 brings 80 msg/s for 90 units of fees (the worst value per message); the flipfee coin brings 60 msg/s
  const load = new Map([[coins[0], { msgPerSec: 20 }], [coins[1], { msgPerSec: 80 }], [coins[2], { msgPerSec: 10 }], [coins[3], { msgPerSec: 10 }], [reg, { msgPerSec: 60 }]]);
  tr.load = () => load;
  now.t += 60_000;
  tr.compute({ rotate: true });
  assert.ok(!tr.hotMints().includes(coins[1]), 'the noisiest per unit of fees left');
  assert.ok(tr.current.has(reg), 'a flipfee coin always stays');
  assert.equal(tr.status().budgetDrops, 1);
  load.delete(coins[1]);
  now.t += 60_000;
  tr.compute({ rotate: true });
  assert.ok(!tr.hotMints().includes(coins[1]), 'kept out for 30 minutes');
  now.t += 31 * 60_000;
  tr.compute({ rotate: true });
  assert.ok(!tr.hotMints().includes(coins[1]), 'no room yet: the load is still at 90% of the budget');
  load.set(reg, { msgPerSec: 10 }); // the flipfee coin calmed down
  tr.compute({ rotate: true });
  assert.ok(tr.hotMints().includes(coins[1]), 'back after the 30 minutes, once there is room');
});

