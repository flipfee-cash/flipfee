// The HTTP API end to end on a real server (src/main.js startServer, port 0) with a fake chain: a registered coin in
// the flipfee index, pump accounts for eligibility, trades fed into the store. Board, coin page, dev, me, wants with
// Sign-In With Solana, health, errors and CORS.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { FlipfeeAdapter } from '../src/chain/flipfee.js';
import { loadConfig } from '../src/config.js';
import { curveOf, sharingConfigOf } from '../src/ingest/pumpevents.js';
import { startServer } from '../src/main.js';
import { IdlEncoder } from './helpers/encode.js';

process.env.LOG_QUIET = '1';
const ffIdl = JSON.parse(readFileSync(new URL('./fixtures/flipfee-idl.json', import.meta.url), 'utf8'));
const pumpIdl = JSON.parse(readFileSync(new URL('./fixtures/pump-idl-subset.json', import.meta.url), 'utf8')).pump;
const ff = new IdlEncoder(ffIdl);
const pumpEnc = new IdlEncoder(pumpIdl);
const PID = ffIdl.address;
const kp = () => Keypair.generate();
const DEFAULT = '11111111111111111111111111111111';

const dev = kp();
const buyer = kp();
const MINT = kp().publicKey.toBase58(); // registered on flipfee
const MINE = kp().publicKey.toBase58(); // created by `dev`, not connected yet (no sharing config)
const now = Math.floor(Date.now() / 1000);

const curveAcc = (creator) => pumpEnc.account('BondingCurve', { virtual_token_reserves: 8e14, virtual_quote_reserves: 4e10, real_token_reserves: 5e14, real_quote_reserves: 1e10, token_total_supply: 1e15, complete: false, creator, is_mayhem_mode: false, is_cashback_coin: false, quote_mint: DEFAULT, creator_fee_bps: 30, can_edit_creator_fee: false, is_holder_reward: false });
const sharingAcc = (mint, admin, shareholders, revoked) => pumpEnc.account('SharingConfig', { bump: 255, version: 2, status: 'Active', mint, admin, admin_revoked: revoked, shareholders: shareholders.map(([address, share_bps]) => ({ address, share_bps })) });

let app;
let base;
let adapter;
before(async () => {
  adapter = new FlipfeeAdapter({ programId: PID, idl: { file: 'snapshot', idl: ffIdl }, source: 'idl' });
  const accounts = new Map();
  accounts.set(adapter.coinPda(MINT), ff.account('Coin', { mint: MINT, owner: dev.publicKey.toBase58(), bump: 1, vault_bump: 2, price: 250_000_000, max_ahead: 86_400, paused: false, last_sync: now - 20, owner_owed: 0, credited: 0, windows: [{ holder: buyer.publicKey.toBase58(), start: now - 300, end: now + 3300, owed: 1000, earned: 5000 }], fees_in: 5000, sales: 250_000_000, hours_sold: 1, paid_out: 4000 }));
  // the registered coin's curve points at its sharing config, whose only shareholder is the flipfee vault
  accounts.set(curveOf(MINT), curveAcc(sharingConfigOf(MINT)));
  accounts.set(sharingConfigOf(MINT), sharingAcc(MINT, dev.publicKey.toBase58(), [[adapter.vaultPda(MINT), 10_000]], true));
  accounts.set(curveOf(MINE), curveAcc(dev.publicKey.toBase58()));
  const rpc = {
    calls: [],
    async call(method, params) {
      this.calls.push(method);
      const enc = (b) => (b ? { data: [b.toString('base64'), 'base64'], owner: 'x', lamports: 1, executable: false } : null);
      if (method === 'getProgramAccounts') {
        if (params[0] === PID) return [...accounts].filter(([k]) => k === adapter.coinPda(MINT)).map(([pubkey, b]) => ({ pubkey, account: enc(b) }));
        const who = params[1]?.filters?.[1]?.memcmp?.bytes;
        if (params[0] === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' && who === dev.publicKey.toBase58()) return [{ pubkey: curveOf(MINE), account: { data: ['', 'base64'] } }];
        return [];
      }
      if (method === 'getTokenAccountsByOwner') return params[0] === curveOf(MINE) ? { value: [{ account: { data: { parsed: { info: { mint: MINE } } } } }] } : { value: [] };
      if (method === 'getSignaturesForAddress') return [];
      if (method === 'getMultipleAccounts') return { value: params[0].map((k) => enc(accounts.get(k))) };
      if (method === 'getAccountInfo') return { value: enc(accounts.get(params[0])) };
      throw new Error(`unexpected ${method}`);
    },
    connection() {
      return null;
    },
    status() {
      return { requests: this.calls.length };
    },
  };
  class NoWS {
    constructor() {
      this.readyState = 0;
    }

    send() {}

    close() {}
  }
  const cfg = loadConfig({ SOLANA_CLUSTER: 'localnet', DB_PATH: ':memory:', PORT: '0', PUMPFUN_API: '0', TRADES: '0', PUMPPORTAL: '0', INDEX_POLL_MS: '600000' });
  app = await startServer(cfg, { adapter, rpc, WebSocketImpl: NoWS });
  base = `http://127.0.0.1:${app.server.address().port}`;
  // trades of the registered coin while the buyer holds it
  app.store.coverStart(MINT, Date.now() - 2 * 3_600_000);
  for (let i = 0; i < 5; i++) {
    app.store.onTrade({ venue: 'curve', mint: MINT, isBuy: i % 2 === 0, wallet: kp().publicKey.toBase58(), lamports: 1e9, fee: 3_000_000, feeBps: 30, feeTo: sharingConfigOf(MINT), solQuote: true, vSol: 4e10, vTokens: 8e14, sig: `sig${i}`, ix: 0, t: Date.now() - (5 - i) * 30_000 });
  }
  app.store.onPump({ mint: MINT, name: 'Cat Coin', symbol: 'CAT', program: 'pump', quote: 'sol', creator: dev.publicKey.toBase58(), createdAt: Date.now() - 86_400_000, socials: { twitter: 'https://x.com/cat' }, at: Date.now() });
});
after(async () => {
  await app?.stop();
});

const get = async (path, headers = {}) => {
  const r = await fetch(base + path, { headers });
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const post = async (path, body, headers = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

async function signIn(k) {
  const { body } = await post('/api/auth/nonce', { address: k.publicKey.toBase58() }, { origin: 'http://localhost:5197' });
  assert.match(body.message, /Sign in to flipfee\./);
  const signature = bs58.encode(nacl.sign.detached(Buffer.from(body.message), k.secretKey));
  const v = await post('/api/auth/verify', { message: body.message, signature });
  assert.equal(v.status, 200);
  return { authorization: `Bearer ${v.body.token}` };
}

test('health names the program, the cluster, tracking and the RPC load', async () => {
  const { status, body } = await get('/health');
  assert.equal(status, 200);
  assert.equal(body.programId, PID);
  assert.equal(body.cluster, 'localnet');
  assert.equal(body.index.coins, 1);
  assert.equal(body.tracking.label, 'top coins');
  assert.ok(body.rpcLoad.http);
  assert.equal((await get('/api/health')).status, 200);
});

test('board: the registered coin is live with its flipfee part, this hour, and exact fees', async () => {
  const { status, body } = await get('/api/board');
  assert.equal(status, 200);
  assert.equal(body.live.length, 1);
  assert.deepEqual(body.hot, []);
  const c = body.live[0];
  assert.equal(c.mint, MINT);
  assert.equal(c.symbol, 'CAT');
  assert.equal(c.flipfee.owner, dev.publicKey.toBase58());
  assert.deepEqual(c.flipfee.price, { lamports: '250000000', sol: 0.25 });
  assert.equal(c.flipfee.windows[0].holder, buyer.publicKey.toBase58());
  assert.equal(c.flipfee.windows[0].live, true);
  assert.deepEqual(c.fees.h1, { lamports: '15000000', sol: 0.015, exact: true, trades: 5, buys: 3, sells: 2, vol: { lamports: '5000000000', sol: 5 } });
  assert.equal(c.thisHour.kind, 'holder');
  assert.equal(c.thisHour.to, buyer.publicKey.toBase58());
  assert.equal(c.thisHour.lamports, '15000000', 'every trade of the last 2.5 minutes went to the buyer');
  assert.equal(body.hero.mint, MINT);
  assert.equal(body.stats.liveCoins, 1);
  assert.deepEqual(body.stats.feesHour, { lamports: '15000000', sol: 0.015 });
  assert.equal(body.stats.scope, 'top coins');
  assert.equal(c.hourly.length, 24);
});

test('coin page: coin, timeline (live window, open hours at the price), the last trades newest first', async () => {
  const { status, body } = await get(`/api/coin/${MINT}`);
  assert.equal(status, 200);
  assert.equal(body.coin.mint, MINT);
  assert.equal(body.coin.sharingConfig, sharingConfigOf(MINT));
  assert.equal(body.trades.length, 5);
  assert.equal(body.trades[0].sig, 'sig4');
  assert.deepEqual(body.trades[0].fee, { lamports: '3000000', sol: 0.003 });
  assert.equal(body.trades[0].side, 'buy');
  const segs = body.timeline.segments;
  const live = segs.find((s) => s.state === 'live' && s.kind === 'holder');
  assert.equal(live.holder, buyer.publicKey.toBase58());
  const open = segs.find((s) => s.kind === 'open');
  assert.deepEqual(open.price, { lamports: '250000000', sol: 0.25 });
  assert.equal(open.start, (now + 3300) * 1000);
  assert.equal((await get(`/api/coin/${kp().publicKey.toBase58()}`)).status, 404);
  assert.equal((await get('/api/coin/nope')).status, 400);
});

test('wants: sign in, one per wallet per coin, counts, the stream event, Me lists them', async () => {
  const w1 = kp();
  const w2 = kp();
  assert.equal((await post('/api/want', { mint: MINE })).status, 401);
  const h1 = await signIn(w1);
  let r = await post('/api/want', { mint: MINE }, h1);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { mint: MINE, count: 1, wanted: true, added: true });
  r = await post('/api/want', { mint: MINE }, h1);
  assert.equal(r.body.count, 1, 'once per wallet');
  assert.equal(r.body.added, false);
  r = await post('/api/want', { mint: MINE }, await signIn(w2));
  assert.equal(r.body.count, 2);
  assert.equal(app.bus.recent({ types: new Set(['want']) }).at(-1).count, 2);
  assert.equal(app.bus.recent({ types: new Set(['want']) }).at(-1).wallet, undefined, 'who wanted stays private');
  assert.deepEqual((await get(`/api/me/${w1.publicKey.toBase58()}`)).body.wants, [MINE]);
  assert.equal((await post('/api/want', { mint: 'x' }, h1)).status, 400);
  assert.equal((await post('/api/want', { mint: kp().publicKey.toBase58() }, h1)).status, 404, 'no pump.fun coin');
  // a slur coin takes no wants
  const bad = kp().publicKey.toBase58();
  app.store.onPump({ mint: bad, name: 'nigga', symbol: 'NIGGA', program: 'pump', quote: 'sol', socials: {}, at: Date.now() });
  assert.equal((await post('/api/want', { mint: bad }, h1)).status, 403);
});

test('order book: sign in, bid and ask, crossing refused, cancel, the stream event, market search', async () => {
  const w = kp();
  assert.equal((await post('/api/orders', { mint: MINT, side: 'bid', price: 0.1, hours: 2 })).status, 401);
  const h = await signIn(w);
  let r = await post('/api/orders', { mint: MINT, side: 'bid', price: 0.1, hours: 2 }, h);
  assert.equal(r.status, 200);
  assert.equal(r.body.order.price.lamports, '100000000');
  assert.equal(r.body.book.bestBid.sol, 0.1);
  assert.equal(r.body.book.mine.length, 1);
  r = await post('/api/orders', { mint: MINT, side: 'ask', price: 0.25, hours: 1 }, h);
  assert.equal(r.status, 200);
  assert.equal((await post('/api/orders', { mint: MINT, side: 'bid', price: 0.3, hours: 1 }, h)).status, 409, 'crosses the ask');
  assert.equal((await post('/api/orders', { mint: MINT, side: 'bid', price: 'x', hours: 1 }, h)).status, 400);
  assert.equal(app.bus.recent({ types: new Set(['book']) }).at(-1).mint, MINT);
  const book = (await get(`/api/book/${MINT}`)).body;
  assert.equal(book.spread.sol, 0.15);
  assert.deepEqual(book.mine, [], 'no session: no own orders');
  const mine = (await get('/api/orders/mine', h)).body.orders;
  assert.equal(mine.length, 2);
  const del = await fetch(`${base}/api/orders/${mine[0].id}`, { method: 'DELETE', headers: h });
  assert.equal(del.status, 200);
  assert.equal((await get('/api/orders/mine', h)).body.orders.length, 1);
  // the market lists coins with orders and finds coins by ticker, name or CA
  const m = (await get('/api/market')).body;
  assert.ok(m.coins.some((c) => c.mint === MINT && c.book.orders === 1));
  assert.equal((await get('/api/market?q=%24cat')).body.coins[0].mint, MINT);
  assert.equal((await get('/api/market?q=cat%20co')).body.coins[0].mint, MINT);
  assert.equal((await get(`/api/market?q=${MINT}`)).body.coins[0].symbol, 'CAT');
  assert.deepEqual((await get('/api/market?q=zzzz')).body.coins, []);
});

test('dev: the wallet’s coins from chain and flipfee, with eligibility, wants, metrics and a suggested price', async () => {
  const { status, body } = await get(`/api/dev/${dev.publicKey.toBase58()}`);
  assert.equal(status, 200);
  const byMint = new Map(body.coins.map((c) => [c.mint, c]));
  assert.ok(byMint.has(MINT) && byMint.has(MINE));
  assert.equal(byMint.get(MINT).eligibility.kind, 'flipfee');
  assert.equal(byMint.get(MINE).eligibility.kind, 'ready-new', 'no sharing config, the wallet is the curve creator');
  assert.equal(byMint.get(MINE).wants, 2);
  assert.equal(body.coins[0].mint, MINT, 'flipfee coins first');
  assert.ok(Number(byMint.get(MINT).suggested.lamports) >= 0.01e9);
  const other = await get(`/api/dev/${buyer.publicKey.toBase58()}`);
  assert.deepEqual(other.body.coins, []);
  assert.equal((await get('/api/dev/nope')).status, 400);
});

test('me: the buyer’s live hour with what it earned; the dev’s coins', async () => {
  const b = (await get(`/api/me/${buyer.publicKey.toBase58()}`)).body;
  assert.equal(b.hours.length, 1);
  assert.equal(b.hours[0].mint, MINT);
  assert.equal(b.hours[0].state, 'live');
  assert.equal(b.hours[0].symbol, 'CAT');
  assert.deepEqual(b.hours[0].earned, { lamports: '5000', sol: 0.000005 });
  assert.equal(b.hours[0].live.kind, 'holder');
  assert.ok(b.totals.spent && b.totals.received);
  const d = (await get(`/api/me/${dev.publicKey.toBase58()}`)).body;
  assert.deepEqual(d.coins.map((c) => c.mint), [MINT]);
});

test('CORS for the dev app origin; unknown routes; stream opens', async () => {
  const r = await get('/api/board', { origin: 'http://localhost:5197' });
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5197');
  const evil = await get('/api/board', { origin: 'https://evil.example' });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal((await get('/api/nothing')).status, 404);
  const ac = new AbortController();
  const s = await fetch(`${base}/api/stream?types=trade,stats&mints=${MINT}`, { signal: ac.signal });
  assert.equal(s.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = s.body.getReader();
  let text = '';
  while (!text.includes('event: stats')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: stats\ndata: \{"stats":\{/);
  ac.abort();
});
