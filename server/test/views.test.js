// What the views build (src/views.js) on a fixed clock: the coin page's hour timeline (past windows with their holder
// and fees, the dev's hours, the live hour, queued windows, open hours at the price), coverage labels on past fees,
// "this hour" for the holder and for the dev, the ticker's sums, the hero, and the dev page's guard on parallel reads.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { Bus } from '../src/bus.js';
import { FlipfeeAdapter } from '../src/chain/flipfee.js';
import { Indexer } from '../src/chain/indexer.js';
import { CoinStore } from '../src/coins.js';
import { Db } from '../src/db.js';
import { HOUR, MIN } from '../src/metrics.js';
import { Tracker } from '../src/tracker.js';
import { Views } from '../src/views.js';
import { Wants } from '../src/wants.js';
import { IdlEncoder } from './helpers/encode.js';

process.env.LOG_QUIET = '1';
const idl = JSON.parse(readFileSync(new URL('./fixtures/flipfee-idl.json', import.meta.url), 'utf8'));
const enc = new IdlEncoder(idl);
const key = () => Keypair.generate().publicKey.toBase58();
const NOW = 1_791_299_400_000; // 10 minutes past a clock hour
const S = 1000;

function setup() {
  const clock = { t: NOW };
  const now = () => clock.t;
  const db = new Db(':memory:');
  const bus = new Bus({ now });
  const store = new CoinStore({ db, now });
  store.setSolUsd(120);
  const adapter = new FlipfeeAdapter({ programId: idl.address, idl: { idl }, source: 'idl' });
  const indexer = new Indexer({ adapter, rpc: null, wsUrl: null, db, bus, now });
  const cfg = { trackMax: 60, hotMax: 30, rotateMs: 60_000, minDwellMs: 15 * MIN, swapMargin: 1.3, maxSwaps: 3 };
  const tracker = new Tracker({ cfg, store, now });
  const views = new Views({ cfg, store, tracker, indexer, wants: new Wants({ db, bus, now }), rpc: null, adapter, now });
  return { clock, db, bus, store, adapter, indexer, tracker, views };
}

const coin = (mint, owner, windows, extra = {}) => ({ mint, owner, bump: 1, vault_bump: 2, price: 200_000_000, max_ahead: 6 * 3600, paused: false, last_sync: NOW / S - 30, owner_owed: 0, credited: 0, windows, fees_in: 0, sales: 0, hours_sold: windows.length, paid_out: 0, ...extra });
const trade = (mint, t, fee) => ({ venue: 'curve', mint, isBuy: true, wallet: key(), lamports: fee * 100, fee, feeBps: 30, solQuote: true, vSol: 3e10, vTokens: 1e15, sig: `s${t}`, ix: 0, t });

test('timeline: past windows and dev hours with their fees, the live hour, the queue, open hours at the price', () => {
  const { store, adapter, indexer, views, db } = setup();
  const mint = key();
  const dev = key();
  const a = key();
  const b = key();
  const now = NOW / S;
  // a past window (ended 50 minutes ago, pruned from the account, kept in history), a live one, a queued one
  db.run('INSERT INTO windows (mint, holder, start, end, earned, owed, cost, seen) VALUES (?, ?, ?, ?, ?, 0, ?, ?)', mint, a, now - 2 * 3600 - 600, now - 3000, 777, 200_000_000, NOW);
  indexer.applyAccount(adapter.coinPda(mint), enc.account('Coin', coin(mint, dev, [{ holder: b, start: now - 300, end: now + 3300, owed: 0, earned: 5 }, { holder: a, start: now + 3300, end: now + 6900, owed: 0, earned: 0 }])), { quiet: true });
  store.coverStart(mint, NOW - 3 * HOUR);
  store.onTrade(trade(mint, NOW - 2 * HOUR, 1000)); // in the past window
  store.onTrade(trade(mint, NOW - 20 * MIN, 50)); // the dev's stretch between the windows
  store.onTrade(trade(mint, NOW - MIN, 7)); // the live window
  const row = views.row(mint);
  const tl = views.timeline(store.get(mint), row.flipfee);
  const segs = tl.segments;
  const past = segs.find((x) => x.kind === 'holder' && x.state === 'past');
  assert.equal(past.holder, a);
  assert.equal(past.holderShort, `${a.slice(0, 4)}…${a.slice(-4)}`);
  assert.deepEqual(past.earned, { lamports: '777', sol: 7.77e-7 });
  assert.equal(past.fees.lamports, '1000');
  assert.equal(past.fees.cover, 1);
  // a coin off flipfee: the hour running now is live, the ones before past
  const plain = views.timeline(store.ensure(key()), null).segments;
  assert.equal(plain.at(-1).state, 'live');
  assert.equal(plain.at(-1).end, NOW);
  assert.ok(plain.slice(0, -1).every((x) => x.state === 'past'));
  const devPast = segs.filter((x) => x.kind === 'dev' && x.state === 'past' && x.fees?.lamports === '50');
  assert.equal(devPast.length, 1, 'the dev hour that held the 50-lamport trade');
  assert.equal(devPast[0].to, dev);
  const live = segs.find((x) => x.state === 'live');
  assert.equal(live.kind, 'holder');
  assert.equal(live.holder, b);
  assert.equal(live.fees.lamports, '7');
  const queued = segs.find((x) => x.state === 'sold');
  assert.equal(queued.holder, a);
  assert.equal(queued.fees, null, 'a future hour has paid nothing yet');
  const open = segs.at(-1);
  assert.equal(open.kind, 'open');
  assert.equal(open.start, (now + 6900) * S);
  assert.equal(open.end, (now + 6 * 3600) * S, 'until max_ahead');
  assert.deepEqual(open.price, { lamports: '200000000', sol: 0.2 });
  // hours before we followed the coin say so
  const early = segs.find((x) => x.kind === 'dev' && x.end <= NOW - 3 * HOUR);
  assert.equal(early.fees, null);
  // segments are in order and do not overlap
  for (let i = 1; i < segs.length; i++) assert.ok(segs[i].start >= segs[i - 1].end - 1, `${i}`);
});

test('this hour: the holder’s hour marks inside a window, the dev’s clock hour outside; the hero is the busiest', () => {
  const { store, adapter, indexer, views } = setup();
  const now = NOW / S;
  const m1 = key();
  const m2 = key();
  const dev = key();
  const buyer = key();
  indexer.applyAccount(adapter.coinPda(m1), enc.account('Coin', coin(m1, dev, [{ holder: buyer, start: now - 2 * 3600 - 60, end: now + 3600, owed: 0, earned: 0 }])), { quiet: true });
  indexer.applyAccount(adapter.coinPda(m2), enc.account('Coin', coin(m2, dev, [])), { quiet: true });
  store.coverStart(m1, NOW - 3 * HOUR);
  store.coverStart(m2, NOW - 3 * HOUR);
  store.onTrade(trade(m1, NOW - 2 * MIN, 30)); // before the window's hour mark (60 s ago)
  store.onTrade(trade(m1, NOW - 30_000, 40)); // after it
  store.onTrade(trade(m2, NOW - 5 * MIN, 9));
  const h1 = views.thisHour(m1);
  assert.equal(h1.kind, 'holder');
  assert.equal(h1.to, buyer);
  assert.equal(h1.since, NOW - 60_000, 'the window’s third hour started 60 s ago');
  assert.equal(h1.lamports, '40');
  const h2 = views.thisHour(m2);
  assert.equal(h2.kind, 'dev');
  assert.equal(h2.to, dev);
  assert.equal(h2.since, NOW - 10 * MIN, 'the clock hour');
  assert.equal(h2.lamports, '9');
  const board = views.board();
  assert.equal(board.hero.mint, m1);
  assert.deepEqual(board.live.map((r) => r.mint), [m1, m2], 'live coins by fees of the last hour');
  assert.equal(board.stats.liveCoins, 2);
  assert.deepEqual(board.stats.feesHour, { lamports: '79', sol: 7.9e-8 });
  assert.equal(board.live[0].recent.length, 2, 'rows carry their last trades');
  assert.equal(board.live[0].recent[0].id, `s${NOW - 2 * MIN}:0`);
});

test('hourly fees say how much of each hour we followed', () => {
  const { store, views } = setup();
  const m = key();
  store.coverStart(m, NOW - 60 * MIN); // 10 minutes into the previous clock hour
  store.onTrade(trade(m, NOW - 50 * MIN, 11));
  store.onTrade(trade(m, NOW - 5 * MIN, 22));
  const h = views.row(m).hourly;
  assert.equal(h.length, 24);
  const [cur, prev, before] = [h[23], h[22], h[21]];
  assert.equal(cur[0], Math.floor(NOW / HOUR) * HOUR);
  assert.equal(cur[1], 22e-9);
  assert.equal(cur[2], 1, 'followed all of the current hour so far');
  assert.equal(prev[1], 11e-9);
  assert.equal(prev[2], 0.83, `followed 50 of the 60 minutes`);
  assert.equal(before[2], 0);
});

test('the dev page reads at most two wallets at once and shares a read of the same wallet', async () => {
  const { views } = setup();
  let release;
  const gate = new Promise((r) => (release = r));
  views.devNow = async (w) => {
    await gate;
    return { wallet: w, coins: [] };
  };
  const a = views.dev('A');
  const a2 = views.dev('A');
  const b = views.dev('B');
  await assert.rejects(views.dev('C'), (e) => e.code === 'busy' && e.status === 503);
  release();
  assert.equal(await a, await a2);
  assert.equal((await b).wallet, 'B');
  assert.equal(views.devRuns.size, 0);
});
