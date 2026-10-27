// Fee windows, coverage, estimates and the suggested price (src/metrics.js), and the per-coin store built on them
// (src/coins.js): exact windows from decoded trades, honest labels (exact / coverSec / est) while coverage is partial.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { CoinStore } from '../src/coins.js';
import { Db } from '../src/db.js';
import { amount, coveredMs, DEFAULT_TIERS, estFee, HOUR, hourly, isExact, MIN, suggestedLamports, sumMinutes, sumTrades, tierBps } from '../src/metrics.js';

process.env.LOG_QUIET = '1';
const T0 = 1_791_300_000_000; // a fixed "now"
const mint = () => `${Keypair.generate().publicKey.toBase58().slice(0, 40)}pump`.slice(-44);
const key = () => Keypair.generate().publicKey.toBase58();

test('amount: exact lamports as a string, SOL for display', () => {
  assert.deepEqual(amount(123_456_789), { lamports: '123456789', sol: 0.123456789 });
  assert.deepEqual(amount(0), { lamports: '0', sol: 0 });
  assert.deepEqual(amount(-5), { lamports: '0', sol: 0 });
  assert.equal(amount(9_007_199_254_740_991).lamports, '9007199254740991');
});

test('coverage: merged intervals, open ends, the exact rule (1% or 5 s missed)', () => {
  const iv = [[T0 - 50 * MIN, T0 - 30 * MIN], [T0 - 35 * MIN, T0 - 10 * MIN], [T0 - 5 * MIN, null]];
  assert.equal(coveredMs(iv, T0 - HOUR, T0, T0), 40 * MIN + 5 * MIN);
  assert.equal(coveredMs([[T0 - 2 * HOUR, null]], T0 - HOUR, T0, T0), HOUR);
  assert.equal(coveredMs([], T0 - HOUR, T0, T0), 0);
  assert.equal(isExact(HOUR, HOUR - 30_000), true, 'a 30 s restart in an hour still counts');
  assert.equal(isExact(HOUR, HOUR - 40_000), false);
  assert.equal(isExact(MIN, MIN - 4_000), true);
  assert.equal(isExact(MIN, MIN - 6_000), false);
  assert.equal(isExact(24 * HOUR, 24 * HOUR - 10 * MIN), true);
});

test('sums: trades by time (exact), minute buckets, hourly series', () => {
  const trades = [
    { t: T0 - 2 * HOUR, fee: 1000, lam: 1e9, buy: true },
    { t: T0 - 30 * MIN, fee: 300, lam: 1e8, buy: true },
    { t: T0 - 9 * MIN, fee: 60, lam: 2e7, buy: false },
    { t: T0 - 30_000, fee: 6, lam: 2e6, buy: true },
  ];
  assert.deepEqual(sumTrades(trades, MIN, T0), { fee: 6, vol: 2e6, trades: 1, buys: 1, sells: 0 });
  assert.deepEqual(sumTrades(trades, 10 * MIN, T0), { fee: 66, vol: 2.2e7, trades: 2, buys: 1, sells: 1 });
  assert.equal(sumTrades(trades, HOUR, T0).fee, 366);
  const minutes = new Map([[Math.floor((T0 - 5 * HOUR) / MIN), { fee: 500, vol: 1, trades: 2, buys: 1 }], [Math.floor((T0 - 7 * HOUR) / MIN), { fee: 700, vol: 1, trades: 1, buys: 1 }], [Math.floor(T0 / MIN), { fee: 1, vol: 1, trades: 1, buys: 0 }]]);
  assert.equal(sumMinutes(minutes, 6 * HOUR, T0).fee, 501);
  assert.equal(sumMinutes(minutes, 24 * HOUR, T0).fee, 1201);
  const h = hourly(minutes, 24, T0);
  assert.equal(h.length, 24);
  assert.equal(h[23][0], Math.floor(T0 / HOUR) * HOUR, 'the last entry is the current clock hour');
  assert.equal(h.reduce((s, x) => s + x[1], 0), 1201);
});

test('pump fee tiers, estimates and the suggested price', () => {
  assert.equal(tierBps(DEFAULT_TIERS.amm, 100), 30);
  assert.equal(tierBps(DEFAULT_TIERS.amm, 420), 95);
  assert.equal(tierBps(DEFAULT_TIERS.amm, 5_000), 75);
  assert.equal(tierBps(DEFAULT_TIERS.amm, 1e6), 5);
  assert.equal(estFee(12_000, 120, 30), 0.3e9, '$12,000 at $120/SOL = 100 SOL × 0.30% = 0.3 SOL');
  assert.equal(estFee(null, 120, 30), null);
  assert.equal(estFee(100, null, 30), null);
  assert.equal(suggestedLamports(0.39e9, 0), 0.312e9, '80% of the last hour');
  assert.equal(suggestedLamports(0, 2.4e9), 0.32e9, 'else the last 6 h ÷ 6, 80%');
  assert.equal(suggestedLamports(0, 0), 0.01e9, 'at least 0.01 SOL');
  assert.equal(suggestedLamports(5_000e9, 0), 1_000e9, 'at most 1000 SOL');
});

function storeAt(now, db = null) {
  const s = new CoinStore({ db, now: () => now.t });
  s.setSolUsd(120);
  return s;
}

const trade = (m, t, fee, lam = fee * 334, extra = {}) => ({ venue: 'curve', mint: m, isBuy: true, wallet: key(), ts: Math.floor(t / 1000), t, lamports: lam, fee, feeBps: 30, feeTo: extra.feeTo ?? null, shareholders: [], solQuote: true, quoteMint: '11111111111111111111111111111111', vSol: 40e9, vTokens: 8e14, sig: `s${t}${fee}`, ix: 0, ...extra });

test('store: windows are exact once followed for the whole window, partial ones carry coverSec and an estimate', () => {
  const now = { t: T0 - 2 * HOUR };
  const s = storeAt(now);
  const m = mint();
  s.onPump({ mint: m, name: 'Cat', symbol: 'CAT', program: 'pump', quote: 'sol', creator: key(), createdAt: T0 - 5 * HOUR, socials: {}, at: now.t });
  s.coverStart(m, T0 - 2 * HOUR);
  now.t = T0 - 50 * MIN;
  s.onTrade(trade(m, now.t, 1000));
  now.t = T0 - 5 * MIN;
  s.onTrade(trade(m, now.t, 500));
  now.t = T0 - 20_000;
  s.onTrade(trade(m, now.t, 25));
  now.t = T0;
  const w = s.windows(s.get(m));
  assert.equal(w.m1.lamports, '25');
  assert.equal(w.m10.lamports, '525');
  assert.equal(w.h1.lamports, '1525');
  assert.equal(w.h1.exact, true);
  assert.equal(w.h1.trades, 3);
  assert.equal(w.h6.exact, false, 'followed 2 h of 6');
  assert.equal(w.h6.coverSec, 2 * 3600);
  assert.equal(w.h6.lamports, '1525');
  // with outside volume, the partial windows also say what the whole window likely paid
  s.onActivity(m, { h1: { volUsd: 1 }, h6: { volUsd: 120_000 }, h24: { volUsd: 240_000 }, at: now.t });
  const w2 = s.windows(s.get(m));
  assert.equal(w2.h6.est.sol, 3, '$120,000 / $120 × 0.30% = 3 SOL');
  assert.equal(w2.h1.est, undefined, 'an exact window has no estimate');
  // coverage ends: windows that reach past the end are no longer exact
  s.coverEnd(m, T0);
  now.t = T0 + 5 * MIN;
  assert.equal(s.windows(s.get(m)).m1.exact, false);
  assert.equal(s.windows(s.get(m)).m1.coverSec, 0);
});

test('store: price, market cap, venue and fee rate from trades; non-SOL quotes and hidden coins', () => {
  const now = { t: T0 };
  const s = storeAt(now);
  const m = mint();
  s.onTrade(trade(m, T0, 30, 10_000, { vSol: 30e9, vTokens: 1e15 }));
  const c = s.get(m);
  assert.ok(Math.abs(s.priceSol(c) - 3e-8) < 1e-15, '30 SOL / 1e9 tokens');
  assert.equal(s.mcapUsd(c), Math.round(30 * 120));
  assert.equal(s.venue(c), 'curve');
  assert.equal(s.rateBps(c), 30);
  s.onTrade({ ...trade(m, T0 + 1000, 9), venue: 'amm', pool: key(), feeBps: 95 });
  assert.equal(s.venue(c), 'amm');
  assert.equal(s.rateBps(c), 95, 'the AMM rate of the last trade');
  const other = mint();
  assert.equal(s.onTrade({ ...trade(other, T0, 5), solQuote: false, quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }), null, 'a USDC fee is no SOL fee');
  assert.equal(s.get(other).quote, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const bad = mint();
  s.onPump({ mint: bad, name: 'nigga coin', symbol: 'NIGGA', program: 'pump', quote: 'sol', socials: {}, at: T0 });
  assert.equal(s.hidden(s.get(bad)), true);
  assert.equal(s.get(bad).symbol, '•••••');
  const banned = mint();
  s.onPump({ mint: banned, name: 'Cat', symbol: 'CAT', program: 'pump', quote: 'sol', banned: true, socials: {}, at: T0 });
  assert.equal(s.hidden(s.get(banned)), true);
  const cb = mint();
  s.onPump({ mint: cb, name: 'Cat', symbol: 'CAT', program: 'pump', quote: 'sol', cashback: true, socials: {}, at: T0 });
  assert.equal(s.rateBps(s.get(cb)), 0, 'cashback coins pay no creator fee');
});

test('store: score ranks by the last hour (exact when covered, else the estimate)', () => {
  const now = { t: T0 - HOUR - MIN };
  const s = storeAt(now);
  const a = mint();
  const b = mint();
  s.coverStart(a, now.t);
  now.t = T0 - 10 * MIN;
  s.onTrade(trade(a, now.t, 2_000_000));
  now.t = T0;
  s.onPump({ mint: b, name: 'B', symbol: 'B', program: 'pump', quote: 'sol', complete: false, socials: {}, at: T0 });
  s.onActivity(b, { h1: { volUsd: 120_000 }, at: T0 });
  assert.equal(s.score(s.get(a)), 2_000_000, 'exact');
  assert.equal(s.score(s.get(b)), 3e9, '$120,000 → 1000 SOL × 0.30% = 3 SOL');
});

test('store: buckets, coverage and recent trades survive a restart (SQLite)', () => {
  const db = new Db(':memory:');
  const now = { t: T0 - 30 * MIN };
  const s = storeAt(now, db);
  const m = mint();
  s.coverStart(m, now.t);
  for (let i = 0; i < 120; i++) {
    now.t += 10_000;
    s.onTrade(trade(m, now.t, 100 + i));
  }
  s.flush();
  s.coverEnd(m, now.t);
  const s2 = new CoinStore({ db, now: () => now.t });
  s2.load(now.t);
  const c = s2.get(m);
  assert.equal(c.recent.length, 100, 'the coin page keeps the last 100 trades');
  assert.equal(c.trades.length, 120, 'every trade of the last hour comes back');
  const sumAll = Array.from({ length: 120 }, (_, i) => 100 + i).reduce((x, y) => x + y, 0);
  assert.equal([...c.minutes.values()].reduce((x, b) => x + b.fee, 0), sumAll, 'minute buckets keep every fee');
  assert.equal(c.coverage.length, 1);
  assert.deepEqual(c.coverage[0], [T0 - 30 * MIN, now.t]);
  // a quick restart: coverage resumes, the last 10 minutes stay exact and complete
  s2.coverStart(m, now.t + 3_000);
  now.t += 4_000;
  const w = s2.windows(s2.get(m));
  assert.equal(w.m10.exact, true);
  // trades every 10 s, the last at T0 − 10 min; the window (T0 − 20 min + 4 s, T0 − 10 min + 4 s] holds fees 160…219
  assert.equal(w.m10.lamports, String(60 * (160 + 219) / 2));
  assert.equal(w.m10.trades, 60);
});
