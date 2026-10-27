// pump.fun TradeEvent and PumpSwap Buy/Sell decoding with the exact creator fee, on real mainnet transactions
// (test/fixtures/creator-fees.json, captured by test/live/capture.mjs, which checked each decoded fee against the
// lamports / WSOL the creator vault gained in the same transaction), cross-checked field by field against pump's own
// IDLs (test/fixtures/pump-idl-subset.json) through the IDL-driven decoder.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IdlCoder } from '../src/chain/borsh.js';
import {
  canonicalPoolOf,
  creatorVaultOf,
  curveOf,
  decodeMigrationEvent,
  decodeSwapEvent,
  decodeTradeEvent,
  forProgramData,
  isSolQuote,
  migrationsFromLogs,
  PUMP_PROGRAM,
  PUMPSWAP_PROGRAM,
  sharingConfigOf,
  swapsFromLogs,
  swapTrade,
  tradesFromLogs,
} from '../src/ingest/pumpevents.js';
import { normCreate } from '../src/ingest/pumpportal.js';
import { IdlEncoder } from './helpers/encode.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/creator-fees.json', import.meta.url), 'utf8'));
const old = JSON.parse(readFileSync(new URL('./fixtures/mainnet-logs.json', import.meta.url), 'utf8'));
const idl = JSON.parse(readFileSync(new URL('./fixtures/pump-idl-subset.json', import.meta.url), 'utf8'));
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

test('real curve buy and sell: the creator fee is what the creator vault gained in the same transaction', () => {
  for (const k of ['curveBuy', 'curveSell']) {
    const f = fx[k];
    const trades = tradesFromLogs(f.logs).filter((t) => t.mint === f.mint);
    assert.equal(trades.length, 1, k);
    const t = trades[0];
    assert.equal(t.venue, 'curve');
    assert.equal(t.isBuy, k === 'curveBuy');
    assert.equal(t.fee, f.creatorFee, `${k}: decoded fee`);
    assert.equal(t.fee, f.vaultGained, `${k}: lamports the vault ["creator-vault", creator] gained`);
    assert.ok(t.fee > 0);
    assert.equal(t.feeBps, 30);
    assert.ok(Math.abs(t.fee - (t.lamports * t.feeBps) / 10_000) <= 1, 'fee = size × bps (rounded)');
    assert.equal(t.feeTo, f.creator);
    assert.ok(isSolQuote(t.quoteMint) && t.solQuote);
    assert.match(t.wallet, B58);
    assert.ok(t.ts > 1.79e9 && t.ts < 1.8e9);
    assert.ok(t.vSol > 0 && t.vTokens > 1e14);
    assert.ok(t.ix === 'buy' || t.ix === 'sell' || /^buy|^sell/.test(t.ix));
  }
});

test('real curve trade of a coin with fee sharing: the fee goes to its sharing config, the shareholders are listed', () => {
  const f = fx.curveShared;
  const t = tradesFromLogs(f.logs).find((x) => x.mint === f.mint);
  assert.ok(t);
  assert.equal(t.feeTo, sharingConfigOf(f.mint), 'bonding_curve.creator is the sharing_config PDA');
  assert.equal(t.fee, f.vaultGained, 'the vault ["creator-vault", sharing_config] gained the fee');
  assert.ok(t.shareholders.length >= 1);
  assert.equal(t.shareholders.reduce((s, x) => s + x.shareBps, 0), 10_000);
  for (const s of t.shareholders) assert.match(s.address, B58);
  assert.equal(creatorVaultOf(t.feeTo).length >= 32, true);
});

test('real PumpSwap buy and sell: coin_creator_fee is what the coin creator vault ATA gained', () => {
  for (const k of ['ammBuy', 'ammSell']) {
    const f = fx[k];
    const evs = swapsFromLogs(f.logs).filter((x) => x.pool === f.pool);
    assert.equal(evs.length, 1, k);
    const ev = evs[0];
    assert.equal(ev.isBuy, k === 'ammBuy');
    assert.equal(ev.coinCreatorFee, f.vaultGained, `${k}: WSOL the coin creator vault ATA gained`);
    assert.ok(ev.coinCreatorFee > 0 && ev.coinCreatorFeeBasisPoints > 0);
    assert.equal(ev.coinCreator, f.coinCreator);
    assert.ok(Math.abs(ev.coinCreatorFee - Math.ceil((ev.quoteAmount * ev.coinCreatorFeeBasisPoints) / 10_000)) <= 1);
    const t = swapTrade(ev, f.mint, f.quoteMint);
    assert.equal(t.venue, 'amm');
    assert.equal(t.mint, f.mint);
    assert.equal(t.lamports, ev.quoteAmount);
    assert.equal(t.fee, ev.coinCreatorFee);
    assert.ok(t.solQuote);
    assert.ok(t.vSol > 0 && t.vTokens > 0);
    assert.equal(canonicalPoolOf(f.mint), f.pool, 'the canonical pool PDA of a pump-graduated coin');
  }
});

test('the hand-written decoders read every field exactly as pump’s IDL says', () => {
  const pump = new IdlCoder(idl.pump);
  const amm = new IdlCoder(idl.pump_amm);
  let curve = 0;
  let swaps = 0;
  for (const f of [fx.curveBuy, fx.curveSell, fx.curveShared, old.curve]) {
    forProgramData(f.logs, PUMP_PROGRAM, (buf) => {
      const r = pump.event(buf);
      if (r?.name !== 'TradeEvent') return;
      const d = r.data;
      const h = decodeTradeEvent(buf);
      curve++;
      assert.equal(h.mint, d.mint);
      assert.equal(h.solAmount, Number(d.sol_amount));
      assert.equal(h.tokenAmount, Number(d.token_amount));
      assert.equal(h.isBuy, d.is_buy);
      assert.equal(h.user, d.user);
      assert.equal(h.timestamp, Number(d.timestamp));
      assert.equal(h.virtualSolReserves, Number(d.virtual_sol_reserves));
      assert.equal(h.virtualTokenReserves, Number(d.virtual_token_reserves));
      assert.equal(h.realTokenReserves, Number(d.real_token_reserves));
      assert.equal(h.fee, Number(d.fee));
      assert.equal(h.creator, d.creator);
      assert.equal(h.creatorFeeBasisPoints, Number(d.creator_fee_basis_points));
      assert.equal(h.creatorFee, Number(d.creator_fee));
      assert.equal(h.ixName, d.ix_name);
      assert.equal(h.mayhemMode, d.mayhem_mode);
      assert.equal(h.cashback, Number(d.cashback));
      assert.deepEqual(h.shareholders, d.shareholders.map((s) => ({ address: s.address, shareBps: s.share_bps })));
      assert.equal(h.quoteMint, d.quote_mint);
      assert.equal(h.quoteAmount, Number(d.quote_amount));
      assert.equal(h.holderRewards, Number(d.holder_rewards));
    });
  }
  for (const f of [fx.ammBuy, fx.ammSell, old.swap]) {
    forProgramData(f.logs, PUMPSWAP_PROGRAM, (buf) => {
      const r = amm.event(buf);
      if (r?.name !== 'BuyEvent' && r?.name !== 'SellEvent') return;
      const d = r.data;
      const h = decodeSwapEvent(buf);
      swaps++;
      assert.equal(h.isBuy, r.name === 'BuyEvent');
      assert.equal(h.timestamp, Number(d.timestamp));
      assert.equal(h.baseAmount, Number(d.base_amount_out ?? d.base_amount_in));
      assert.equal(h.quoteAmount, Number(d.quote_amount_in ?? d.quote_amount_out));
      assert.equal(h.poolBaseReserves, Number(d.pool_base_token_reserves));
      assert.equal(h.poolQuoteReserves, Number(d.pool_quote_token_reserves));
      assert.equal(h.pool, d.pool);
      assert.equal(h.user, d.user);
      assert.equal(h.coinCreator, d.coin_creator);
      assert.equal(h.coinCreatorFeeBasisPoints, Number(d.coin_creator_fee_basis_points));
      assert.equal(h.coinCreatorFee, Number(d.coin_creator_fee));
    });
  }
  assert.ok(curve >= 4, `curve events checked: ${curve}`);
  assert.ok(swaps >= 3, `swap events checked: ${swaps}`);
});

test('data logged by another program inside the transaction is ignored', () => {
  const real = fx.curveBuy.logs.find((l) => l.startsWith('Program data: vdt/'));
  const planted = ['Program Evi1111111111111111111111111111111111111 invoke [1]', real, 'Program Evi1111111111111111111111111111111111111 success'];
  assert.equal(tradesFromLogs(planted).length, 0);
  const own = [`Program ${PUMP_PROGRAM} invoke [1]`, real, `Program ${PUMP_PROGRAM} success`];
  assert.equal(tradesFromLogs(own).length, 1);
  assert.equal(decodeTradeEvent(Buffer.alloc(50)), null);
  assert.equal(decodeSwapEvent(Buffer.alloc(400)), null);
});

test('a migration event names the new PumpSwap pool', () => {
  const enc = new IdlEncoder(idl.pump);
  const mint = fx.ammBuy.mint;
  const ev = { user: fx.ammBuy.coinCreator, mint, mint_amount: 206900000000000, sol_amount: 84990359057, pool_migration_fee: 15000001, bonding_curve: curveOf(mint), timestamp: 1791300000, pool: fx.ammBuy.pool, quote_mint: 'So11111111111111111111111111111111111111112' };
  const logs = [`Program ${PUMP_PROGRAM} invoke [1]`, `Program data: ${enc.event('CompletePumpAmmMigrationEvent', ev).toString('base64')}`, `Program ${PUMP_PROGRAM} success`];
  const out = migrationsFromLogs(logs);
  assert.equal(out.length, 1);
  assert.equal(out[0].mint, mint);
  assert.equal(out[0].pool, fx.ammBuy.pool);
  assert.equal(decodeMigrationEvent(Buffer.alloc(20)), null);
});

test('PumpPortal create messages', () => {
  const c = normCreate({ signature: 'sig', mint: '4Eyierg7ZTZrDaD9LWP6K4gt2WvmREFLd54iUjmdpump', traderPublicKey: 'DufqhthPLn3PhHJVJUoYSFvNJFj6ETZHEw6iyCUW1PHu', txType: 'create', solAmount: 0.42, bondingCurveKey: '3CnzEJTb4zEFdgaYhYedyPVC6FtetQq8mjA29QzkZxJy', name: 'Derby', symbol: 'DERBY', pool: 'pump' });
  assert.equal(c.creator, 'DufqhthPLn3PhHJVJUoYSFvNJFj6ETZHEw6iyCUW1PHu');
  assert.equal(c.curveKey, '3CnzEJTb4zEFdgaYhYedyPVC6FtetQq8mjA29QzkZxJy');
});
