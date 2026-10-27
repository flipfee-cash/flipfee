// The flipfee index (src/chain/indexer.js) through the adapter (src/chain/flipfee.js), on accounts and events encoded
// exactly as the program writes them (its Anchor IDL, test/fixtures/flipfee-idl.json, a snapshot of
// program/target/idl/flipfee.json): decoding, diffs → stream events, the event log (once per signature and index),
// window history, today's totals, a wallet's hours and coins, the backfill and emit_cpi! events.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Bus } from '../src/bus.js';
import { FlipfeeAdapter, normEvent } from '../src/chain/flipfee.js';
import { Indexer } from '../src/chain/indexer.js';
import { Db } from '../src/db.js';
import { IdlEncoder } from './helpers/encode.js';

process.env.LOG_QUIET = '1';
const idl = JSON.parse(readFileSync(new URL('./fixtures/flipfee-idl.json', import.meta.url), 'utf8'));
const PID = idl.address;
const enc = new IdlEncoder(idl);
const key = () => Keypair.generate().publicKey.toBase58();
const H = 3600;

function setup({ now = 1_791_300_000_000, idlSource = true } = {}) {
  const clock = { t: now };
  const adapter = new FlipfeeAdapter({ programId: PID, idl: idlSource ? { file: 'snapshot', idl } : null, source: idlSource ? 'idl' : 'design' });
  const accounts = new Map(); // pubkey → Buffer
  const sigs = []; // newest first
  const txs = new Map();
  const calls = [];
  const rpc = {
    async call(method, params) {
      calls.push([method, params]);
      if (method === 'getProgramAccounts') return [...accounts].map(([pubkey, b]) => ({ pubkey, account: { data: [b.toString('base64'), 'base64'] } }));
      if (method === 'getSignaturesForAddress') {
        const until = params[1]?.until;
        const out = [];
        for (const s of sigs) {
          if (s === until) break;
          out.push({ signature: s, err: null });
        }
        return out;
      }
      if (method === 'getTransaction') return txs.get(params[0]) ?? null;
      throw new Error(`unexpected ${method}`);
    },
  };
  const db = new Db(':memory:');
  const bus = new Bus({ now: () => clock.t });
  const seen = [];
  bus.subscribe((e) => seen.push(e));
  const ix = new Indexer({ adapter, rpc, wsUrl: null, db, bus, now: () => clock.t });
  return { clock, adapter, accounts, sigs, txs, calls, rpc, db, bus, seen, ix };
}

const coinValue = (mint, owner, nowSec, windows = [], extra = {}) => ({
  mint,
  owner,
  bump: 254,
  vault_bump: 253,
  price: 300_000_000,
  max_ahead: 86_400,
  paused: false,
  last_sync: nowSec - 30,
  owner_owed: 1000,
  credited: 5000,
  windows,
  fees_in: 9_000_000,
  sales: 600_000_000,
  hours_sold: 2,
  paid_out: 4_000_000,
  ...extra,
});

test('the DESIGN §2.1 shapes match the program: the fallback decoder reads the IDL-encoded accounts the same way', () => {
  const mint = key();
  const owner = key();
  const buf = enc.account('Coin', coinValue(mint, owner, 1_791_300_000, [{ holder: key(), start: 1_791_300_000, end: 1_791_303_600, owed: 7, earned: 9 }]));
  const viaIdl = new FlipfeeAdapter({ programId: PID, idl: { idl }, source: 'idl' }).decodeAccount('x', buf);
  const viaDesign = new FlipfeeAdapter({ programId: PID, source: 'design' }).decodeAccount('x', buf);
  assert.deepEqual(viaDesign, viaIdl);
  assert.equal(viaIdl.mint, mint);
  assert.equal(viaIdl.owner, owner);
  assert.equal(viaIdl.price, 300_000_000);
  assert.equal(viaIdl.maxAhead, 86_400);
  assert.equal(viaIdl.windows[0].earned, 9);
  const cfg = enc.account('Config', { admin: key(), treasury: key(), fee_bps: 500, paused: false, bump: 255 });
  assert.equal(new FlipfeeAdapter({ programId: PID, source: 'design' }).decodeAccount('c', cfg).feeBps, 500);
  // the snapshot is the program's current IDL
  const live = new URL('../../program/target/idl/flipfee.json', import.meta.url);
  if (existsSync(live)) assert.deepEqual(JSON.parse(readFileSync(live, 'utf8')).events.map((e) => e.name), idl.events.map((e) => e.name), 'refresh test/fixtures/flipfee-idl.json');
});

test('accounts: the first read is quiet; a new coin streams `register`, changed windows stream `window`', async () => {
  const { accounts, ix, seen, clock, adapter } = setup();
  const now = Math.floor(clock.t / 1000);
  const m1 = key();
  const owner = key();
  accounts.set(adapter.configPda(), enc.account('Config', { admin: key(), treasury: key(), fee_bps: 500, paused: false, bump: 255 }));
  accounts.set(adapter.coinPda(m1), enc.account('Coin', coinValue(m1, owner, now)));
  await ix.loadAll();
  assert.equal(ix.coins.size, 1);
  assert.equal(ix.config.feeBps, 500);
  assert.equal(seen.length, 0, 'what existed before the start is no news');
  const holder = key();
  const m2 = key();
  ix.applyAccount(adapter.coinPda(m2), enc.account('Coin', coinValue(m2, owner, now)));
  assert.equal(seen.at(-1).type, 'register');
  assert.equal(seen.at(-1).mint, m2);
  assert.deepEqual(seen.at(-1).price, { lamports: '300000000', sol: 0.3 });
  ix.applyAccount(adapter.coinPda(m1), enc.account('Coin', coinValue(m1, owner, now, [{ holder, start: now - 600, end: now + 3000, owed: 50, earned: 80 }], { hours_sold: 3 })));
  const w = seen.at(-1);
  assert.equal(w.type, 'window');
  assert.equal(w.mint, m1);
  assert.equal(w.windows.length, 1);
  assert.equal(w.windows[0].holder, holder);
  assert.equal(w.windows[0].start, (now - 600) * 1000, 'times in ms');
  assert.deepEqual(w.windows[0].earned, { lamports: '80', sol: 8e-8 });
  assert.equal(w.windows[0].live, true);
  assert.equal(w.hoursSold, 3);
  // the same data again: nothing new to say
  const n = seen.length;
  ix.applyAccount(adapter.coinPda(m1), enc.account('Coin', coinValue(m1, owner, now, [{ holder, start: now - 600, end: now + 3000, owed: 50, earned: 80 }], { hours_sold: 3 })));
  assert.equal(seen.length, n);
});

function eventsFor(mint, coin, { buyer, owner, now }) {
  return [
    ['Registered', { mint, coin, owner, vault: key(), price: 300_000_000, max_ahead: 86_400, vault_funded: 890_880, carried: 0, at: now - 7200 }],
    ['HoursBought', { mint, coin, buyer, start: now - 600, end: now + 6600, hours: 2, price: 300_000_000, total: 600_000_000, to_owner: 570_000_000, fee: 30_000_000, windows: 1, at: now - 600 }],
    ['FeesSynced', { mint, coin, amount: 120_000, from: now - 660, to: now - 600, to_owner: 120_000, to_windows: 0, at: now - 600 }],
    ['Paid', { mint, coin, to: buyer, amount: 400_000, kind: 'Holder', at: now - 60 }],
    ['Paid', { mint, coin, to: owner, amount: 120_000, kind: 'Owner', at: now - 60 }],
  ];
}

test('events: stored once per (signature, index), streamed with lamports + SOL and ms, totals add up', async () => {
  const { ix, seen, clock, adapter, db } = setup();
  const now = Math.floor(clock.t / 1000);
  const mint = key();
  const owner = key();
  const buyer = key();
  ix.applyAccount(adapter.coinPda(mint), enc.account('Coin', coinValue(mint, owner, now, [{ holder: buyer, start: now - 600, end: now + 6600, owed: 0, earned: 400_000 }])), { quiet: true });
  const logs = enc.logs(PID, eventsFor(mint, adapter.coinPda(mint), { buyer, owner, now }));
  const evs = adapter.eventsFromLogs(logs);
  assert.deepEqual(evs.map((e) => e.type), ['register', 'buy', 'sync', 'paid', 'paid']);
  ix.onEvents('sigA', 100, clock.t, evs);
  ix.onEvents('sigA', 100, clock.t, adapter.eventsFromLogs(logs)); // the backfill sees it again
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chain_events').n, 5);
  const types = seen.map((e) => e.type);
  assert.deepEqual(types, ['buy', 'fee', 'paid', 'paid'], 'register is no news for a coin we hold');
  const buy = seen.find((e) => e.type === 'buy');
  assert.equal(buy.buyer, buyer);
  assert.equal(buy.hours, 2);
  assert.equal(buy.start, (now - 600) * 1000);
  assert.deepEqual(buy.paid, { lamports: '600000000', sol: 0.6 });
  const fee = seen.find((e) => e.type === 'fee');
  assert.deepEqual(fee.amount, { lamports: '120000', sol: 0.00012 });
  assert.equal(fee.to - fee.from, 60_000);
  const paid = seen.filter((e) => e.type === 'paid');
  assert.deepEqual(paid.map((p) => p.kind), ['holder', 'owner']);
  const today = ix.today();
  assert.equal(today.hoursSold, 2);
  assert.equal(today.buyers, 400_000);
  assert.equal(today.devSales, 570_000_000, 'the to_owner of the sale');
  assert.equal(today.devFees, 120_000);
  // the window remembers its cost and signature
  const f = ix.ff(mint);
  assert.deepEqual(f.windows[0].cost, { lamports: '600000000', sol: 0.6 });
  assert.equal(f.windows[0].sig, 'sigA');
  assert.equal(f.registeredAt, (now - 7200) * 1000, 'registered at the event’s chain clock');
  assert.deepEqual(f.holderPaid, { lamports: '400000', sol: 0.0004 });
  assert.deepEqual(f.ownerPaid, { lamports: '120000', sol: 0.00012 });
});

test('who gets the fees now, the coin’s flipfee part, and a wallet’s hours and coins', () => {
  const { ix, clock, adapter } = setup();
  const now = Math.floor(clock.t / 1000);
  const mint = key();
  const owner = key();
  const a = key();
  const b = key();
  const wins = [
    { holder: a, start: now - 2 * H - 600, end: now + H - 600, owed: 10, earned: 900 },
    { holder: b, start: now + H - 600, end: now + 2 * H - 600, owed: 0, earned: 0 },
  ];
  ix.applyAccount(adapter.coinPda(mint), enc.account('Coin', coinValue(mint, owner, now, wins)), { quiet: true });
  const h = ix.holderNow(mint);
  assert.equal(h.kind, 'holder');
  assert.equal(h.to, a);
  assert.equal(h.since, (now - 600) * 1000, 'the third hour of a 3-hour window started 10 minutes ago');
  const f = ix.ff(mint);
  assert.equal(f.windows.length, 2);
  assert.equal(f.live.holder, a);
  assert.equal(f.nextStart, (now + 2 * H - 600) * 1000);
  assert.equal(f.openUntil, (now + 86_400) * 1000);
  assert.equal(f.hoursOpen, 12, 'at most 12 hours per buy');
  assert.deepEqual(f.price, { lamports: '300000000', sol: 0.3 });
  const me = ix.me(a);
  assert.equal(me.hours.length, 1);
  assert.equal(me.hours[0].state, 'live');
  assert.equal(me.hours[0].hours, 3);
  assert.deepEqual(me.hours[0].earned, { lamports: '900', sol: 9e-7 });
  assert.deepEqual(me.hours[0].paid, { lamports: '890', sol: 8.9e-7 }, 'earned minus still owed');
  assert.equal(ix.me(b).hours[0].state, 'upcoming');
  assert.deepEqual(ix.me(owner).coins, [mint]);
  // after the windows: the dev
  clock.t += 3 * H * 1000;
  ix.applyAccount(adapter.coinPda(mint), enc.account('Coin', coinValue(mint, owner, now + 3 * H, [])), { quiet: true });
  const d = ix.holderNow(mint);
  assert.equal(d.kind, 'dev');
  assert.equal(d.to, owner);
  assert.equal(ix.me(a).hours[0].state, 'past', 'the history keeps pruned windows');
  assert.equal(ix.ff(mint).past.length, 2);
});

test('backfill: new signatures oldest first, each transaction once, then only what came after', async () => {
  const { ix, sigs, txs, clock, adapter, calls, seen } = setup();
  const now = Math.floor(clock.t / 1000);
  const mint = key();
  const owner = key();
  const buyer = key();
  ix.applyAccount(adapter.coinPda(mint), enc.account('Coin', coinValue(mint, owner, now)), { quiet: true });
  const all = eventsFor(mint, adapter.coinPda(mint), { buyer, owner, now });
  const tx = (events) => ({ slot: 5, blockTime: now - 30, meta: { err: null, logMessages: enc.logs(PID, events) }, transaction: { message: { accountKeys: [] } } });
  sigs.push('s2', 's1');
  txs.set('s1', tx(all.slice(0, 2)));
  txs.set('s2', tx(all.slice(3)));
  await ix.backfill();
  assert.equal(ix.counts.backfilled, 4);
  assert.deepEqual(seen.map((e) => e.type), ['buy', 'paid', 'paid']);
  assert.equal(ix.db.getMeta(`index:lastSig:${PID}`), 's2');
  const n = calls.filter(([m]) => m === 'getTransaction').length;
  await ix.backfill();
  assert.equal(calls.filter(([m]) => m === 'getTransaction').length, n, 'nothing new: no transaction read');
  sigs.unshift('s3');
  txs.set('s3', tx([all[2]]));
  await ix.backfill();
  assert.equal(seen.at(-1).type, 'fee');
  assert.equal(calls.at(-2)[1][1].until, 's2');
});

test('events emitted with emit_cpi! (inner instructions) are read from the transaction', () => {
  const { ix, clock, adapter } = setup();
  const now = Math.floor(clock.t / 1000);
  const mint = key();
  const buyer = key();
  const ev = enc.event('Paid', { mint, coin: adapter.coinPda(mint), to: buyer, amount: 5, kind: 'Holder', at: now });
  const data = bs58.encode(Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), ev]));
  const tx = { meta: { err: null, logMessages: [], innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, data }] }] }, transaction: { message: { accountKeys: [key(), PID] } } };
  const out = ix.cpiEvents(tx);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'paid');
  assert.equal(out[0].to, buyer);
});

test('events in the client’s camelCase with BN-like numbers normalize the same way', () => {
  const bn = (v) => ({ toString: () => String(v) });
  const e = normEvent('HoursBought', { mint: key(), buyer: key(), start: bn(10), end: bn(3610), hours: 1, price: bn(5), total: bn(5), toOwner: bn(4), fee: bn(1), at: bn(10) });
  assert.equal(e.type, 'buy');
  assert.equal(e.paid, 5);
  assert.equal(e.toOwner, 4);
  assert.equal(e.at, 10);
  assert.equal(normEvent('Paid', { kind: { owner: {} }, amount: 3 }).kind, 'owner');
  assert.equal(normEvent('Paid', { kind: 'Holder', amount: 3 }).kind, 'holder');
  assert.equal(normEvent('OwnerTransferred', { from: 'a', to: 'b' }).owner, 'b');
  assert.equal(normEvent('Nope', {}).type, 'other');
});
