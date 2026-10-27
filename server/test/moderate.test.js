// Hate-slur filter: coin names are live user content. Names and tickers are masked, such coins
// are hidden (off the board, out of the stream, no wants); plain swearing stays.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoinStore, cleanName, cleanTicker } from '../src/coins.js';
import { Ingest } from '../src/ingest/index.js';
import { Bus } from '../src/bus.js';
import { badCoin, cleanAbout, hasSlur, maskSlurs } from '../src/moderate.js';

process.env.LOG_QUIET = '1';
const MINT = '4Eyierg7ZTZrDaD9LWP6K4gt2WvmREFLd54iUjmdpump';
const MINT2 = 'EQmifZ6svZZwawnowEY9MsrwWrzgVinYfuJHMJkDpump';

test('finds slurs through case, spacing, look-alikes and digits', () => {
  for (const s of ['this is BEST coin for NIGGERS', 'n.i.g.g.e.r', 'N1GG4', 'Nigga', 'nіgger' /* Cyrillic і */, 'ＮＩＧＧＡ', 'big faggot', 'kike', 'Wetback Inu', 'sp1c', 'HEIL HITLER']) {
    assert.equal(hasSlur(s), true, s);
  }
});

test('leaves plain words, swearing and look-alike real words', () => {
  for (const s of ['Niger', 'Nigeria coin', 'night', 'snigger', 'niggling doubt', 'spice', 'Pakistan', 'raccoon', 'Maine Coon', 'big gerbil', 'fuck it we ball', 'shit coin', '', null, undefined, 'Solphacup']) {
    assert.equal(hasSlur(s), false, String(s));
  }
});

test('masks the slur word in names and tickers; strips control and bidi characters', () => {
  assert.equal(maskSlurs('Nigga Cat'), '••••• Cat');
  assert.equal(maskSlurs('Good Cat'), 'Good Cat');
  assert.equal(cleanTicker('NIGGER'), '••••••');
  assert.equal(cleanName('kike coin'), '•••• coin');
  assert.equal(cleanTicker('D O T '), 'DOT', 'hair spaces in a ticker (seen on pump.fun)');
  assert.equal(cleanName('evil‮gnp.exe'), 'evilgnp.exe');
  assert.equal(badCoin({ symbol: '••••••', name: 'x' }), true);
  assert.equal(badCoin({ symbol: 'CAT', name: 'Cat' }), false);
  assert.equal(cleanAbout('the best coin for niggas'), null);
});

test('a slur coin is hidden: masked in the store and kept out of the trade stream', () => {
  const t = 1_800_000_000_000;
  const store = new CoinStore({ now: () => t });
  store.onPump({ mint: MINT, symbol: 'NIGGA', name: 'nigga coin', program: 'pump', quote: 'sol', socials: {}, at: t });
  store.onPump({ mint: MINT2, symbol: 'CAT', name: 'Cat', program: 'pump', quote: 'sol', socials: {}, at: t });
  assert.equal(store.row(store.get(MINT)).symbol, '•••••');
  assert.equal(store.row(store.get(MINT)).hidden, true);
  assert.equal(store.row(store.get(MINT2)).hidden, false);
  const bus = new Bus();
  const seen = [];
  bus.subscribe((e) => seen.push(e));
  const ingest = new Ingest({ cfg: { tradesOn: false, pumpPortalOn: false }, store, bus, tracker: { current: new Map() }, hot: null, rpc: null, jupiter: null, pump: null });
  const tr = (mint) => ({ venue: 'curve', mint, isBuy: true, wallet: MINT2, lamports: 1e9, fee: 3e6, feeBps: 30, solQuote: true, vSol: 3e10, vTokens: 1e15, sig: `s${mint}`, ix: 0, t });
  ingest.onTrade(tr(MINT));
  ingest.onTrade(tr(MINT2));
  assert.deepEqual(seen.map((e) => e.mint), [MINT2]);
  assert.equal(store.get(MINT).trades.length, 1, 'its fees still count where they are summed');
});
