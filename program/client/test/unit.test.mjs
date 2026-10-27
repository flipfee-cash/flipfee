// Unit tests of the built client (dist/) against fixtures written by the Rust LiteSVM test
// programs/flipfee/tests/fixtures.rs: real account bytes, instructions built by Anchor (flipfee) and by the pump
// builders that run against the mainnet pump binaries, real transaction logs. Plus an IDL check with
// @coral-xyz/anchor 0.32.1. Run: npm run test:client
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';

import * as ff from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, 'fixtures/flipfee.json'), 'utf8'));
const idl = JSON.parse(readFileSync(join(here, '../idl/flipfee.json'), 'utf8'));
const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
const pk = (s) => new PublicKey(s);

/** bigint → string, PublicKey → base58 (the fixture's JSON conventions). */
function norm(v) {
  if (typeof v === 'bigint') return v.toString();
  if (v && typeof v.toBase58 === 'function') return v.toBase58();
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
  return v;
}
const keysOf = (ix) => ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }));
const fixIx = (name) => {
  const f = fx.instructions.find((i) => i.name === name);
  assert.ok(f, `fixture ${name}`);
  return f;
};
function sameIx(ix, name) {
  const f = fixIx(name);
  assert.equal(ix.programId.toBase58(), f.programId, `${name} program`);
  assert.deepEqual(keysOf(ix), f.keys, `${name} accounts`);
  assert.equal(Buffer.from(ix.data).toString('hex'), f.data, `${name} data`);
}

test('program id and IDL agree', () => {
  assert.equal(ff.FLIPFEE_PROGRAM_ID.toBase58(), fx.programId);
  assert.equal(idl.address, fx.programId);
  assert.equal(ff.IDL_ADDRESS, fx.programId);
});

test('PDAs match the program and pump', () => {
  assert.equal(ff.findConfigPda()[0].toBase58(), fx.pdas.config);
  assert.equal(ff.findProgramDataAddress().toBase58(), fx.pdas.programData);
  assert.equal(ff.findPumpGlobalPda()[0].toBase58(), fx.pdas.pumpGlobal);
  for (const c of fx.pdas.coins) {
    assert.equal(ff.findCoinPda(c.mint)[0].toBase58(), c.coin);
    assert.equal(ff.findVaultPda(pk(c.mint))[0].toBase58(), c.vault);
    assert.equal(ff.findSharingConfigPda(c.mint)[0].toBase58(), c.sharingConfig);
    assert.equal(ff.findBondingCurvePda(c.mint)[0].toBase58(), c.bondingCurve);
    assert.equal(ff.findPumpCreatorVaultPda(c.sharingConfig)[0].toBase58(), c.pumpCreatorVault);
    assert.equal(ff.findPoolAuthorityPda(c.mint)[0].toBase58(), c.poolAuthority);
    assert.equal(ff.findCanonicalPoolPda(c.mint)[0].toBase58(), c.canonicalPool);
    assert.equal(ff.findAmmCreatorVaultAuthorityPda(c.sharingConfig)[0].toBase58(), c.ammCreatorVaultAuthority);
    assert.equal(ff.getAmmCreatorVaultAta(c.sharingConfig).toBase58(), c.ammCreatorVaultAta);
  }
});

test('Config and Coin decode like the program wrote them', () => {
  const a = fx.accounts;
  const cfg = ff.decodeConfig(b64(a.config.data));
  assert.deepEqual(norm(cfg), { admin: a.config.admin, treasury: a.config.treasury, feeBps: a.config.feeBps, paused: a.config.paused, bump: a.config.bump });
  assert.equal(b64(a.config.data).length, ff.ACCOUNT_SIZE.Config);
  const data = b64(a.coin.data);
  assert.equal(data.length, ff.ACCOUNT_SIZE.Coin);
  const coin = ff.decodeCoin(data);
  const { data: _d, ...expect } = a.coin;
  assert.deepEqual(norm(coin), expect);
  assert.ok(coin.windows.length >= 1, 'the fixture coin holds windows');
  assert.equal(coin.credited, coin.ownerOwed + coin.windows.reduce((s, w) => s + w.owed, 0n));
  // memcmp offsets
  assert.equal(new PublicKey(data.subarray(ff.COIN_OFFSETS.mint, ff.COIN_OFFSETS.mint + 32)).toBase58(), a.coin.mint);
  assert.equal(new PublicKey(data.subarray(ff.COIN_OFFSETS.owner, ff.COIN_OFFSETS.owner + 32)).toBase58(), a.coin.owner);
  assert.throws(() => ff.decodeCoin(b64(a.config.data)), /not a flipfee Coin/);
  assert.throws(() => ff.decodeConfig(data), /not a flipfee Config/);
});

test('the IDL decodes the same accounts with @coral-xyz/anchor', () => {
  const coder = new anchor.BorshAccountsCoder(idl);
  const coin = coder.decode('Coin', Buffer.from(b64(fx.accounts.coin.data)));
  assert.equal(coin.mint.toBase58(), fx.accounts.coin.mint);
  assert.equal(coin.windows.length, fx.accounts.coin.windows.length);
  assert.equal(coin.fees_in.toString(), fx.accounts.coin.feesIn);
  const cfg = coder.decode('Config', Buffer.from(b64(fx.accounts.config.data)));
  assert.equal(cfg.fee_bps, fx.accounts.config.feeBps);
});

test('pump accounts decode (curve before/after fee sharing, graduated curve, sharing config, pool)', () => {
  const a = fx.accounts;
  const before = ff.decodeBondingCurve(b64(a.bondingCurveBefore.data));
  assert.equal(before.creator.toBase58(), a.bondingCurveBefore.creator);
  assert.equal(before.complete, false);
  assert.ok(ff.isSolPaired(before));
  assert.equal(before.isCashbackCoin, false);
  assert.equal(before.isHolderReward, false);
  assert.equal(b64(a.bondingCurveBefore.data).length, 141, 'create_v2 curve size');
  const after = ff.decodeBondingCurve(b64(a.bondingCurve.data));
  assert.equal(after.creator.toBase58(), a.bondingCurve.creator, 'curve creator = sharing config');
  assert.equal(b64(a.bondingCurve.data).length, 151, 'pump grows the curve when fee sharing starts');
  const grad = ff.decodeBondingCurve(b64(a.bondingCurveGraduated.data));
  assert.equal(grad.complete, true);
  assert.equal(grad.realTokenReserves, 0n);

  const sc = ff.decodeSharingConfig(b64(a.sharingConfig.data));
  assert.equal(sc.status, 'Active');
  assert.equal(sc.admin.toBase58(), a.sharingConfig.admin, 'admin kept after revoking');
  assert.equal(sc.adminRevoked, true);
  assert.equal(sc.mint.toBase58(), a.sharingConfig.mint);
  assert.deepEqual(norm(sc.shareholders), [{ address: a.sharingConfig.vault, shareBps: 10000 }]);
  assert.notEqual(sc.version, 1);

  const pool = ff.decodePool(b64(a.pool.data));
  assert.equal(pool.coinCreator.toBase58(), a.pool.coinCreator);
  assert.equal(pool.baseMint.toBase58(), a.pool.baseMint);
  assert.equal(pool.quoteMint.toBase58(), ff.WSOL_MINT.toBase58());
  assert.equal(pool.creator.toBase58(), a.pool.creator);
  assert.equal(pool.index, 0);

  // length tolerance: an old 83-byte curve reads its missing fields as defaults
  const short = b64(a.bondingCurveBefore.data).slice(0, 83);
  const old = ff.decodeBondingCurve(short);
  assert.ok(old.quoteMint.equals(ff.DEFAULT_PUBKEY));
  assert.ok(ff.isSolPaired(old));
  assert.equal(old.isHolderReward, false);
  assert.throws(() => ff.decodeSharingConfig(b64(a.pool.data)), /not a pump SharingConfig/);
});

test('flipfee instruction builders match Anchor byte for byte', () => {
  let a = fixIx('initialize').args;
  sameIx(ff.initializeIx({ authority: a.authority, treasury: a.treasury, feeBps: a.feeBps }), 'initialize');
  a = fixIx('set_config').args;
  sameIx(ff.setConfigIx({ admin: a.admin, treasury: a.treasury, feeBps: a.feeBps, paused: a.paused }), 'set_config');
  a = fixIx('set_admin').args;
  sameIx(ff.setAdminIx({ admin: a.admin, newAdmin: a.newAdmin }), 'set_admin');
  a = fixIx('register').args;
  sameIx(ff.registerIx({ owner: a.owner, mint: a.mint, price: BigInt(a.price), maxAhead: a.maxAhead }), 'register');
  a = fixIx('set_terms').args;
  sameIx(ff.setTermsIx({ owner: a.owner, mint: a.mint, price: a.price, maxAhead: a.maxAhead, paused: a.paused }), 'set_terms');
  a = fixIx('transfer_owner').args;
  sameIx(ff.transferOwnerIx({ owner: a.owner, mint: a.mint, newOwner: a.newOwner }), 'transfer_owner');
  a = fixIx('buy').args;
  sameIx(ff.buyIx({ buyer: a.buyer, mint: a.mint, owner: a.owner, treasury: a.treasury, hours: a.hours, maxPrice: BigInt(a.maxPrice), maxStart: a.maxStart }), 'buy');
  a = fixIx('crank').args;
  sameIx(ff.crankIx({ mint: a.mint, recipients: a.recipients }), 'crank');
});

test('pump instruction builders match the ones run against the mainnet binaries', () => {
  let a = fixIx('pump_create_fee_sharing_config').args;
  sameIx(ff.createFeeSharingConfigIx({ creator: a.creator, mint: a.mint }), 'pump_create_fee_sharing_config');
  a = fixIx('pump_create_fee_sharing_config_pool').args;
  sameIx(ff.createFeeSharingConfigIx({ creator: a.creator, mint: a.mint, pool: a.pool }), 'pump_create_fee_sharing_config_pool');
  a = fixIx('pump_update_fee_shares_v2').args;
  sameIx(ff.updateFeeSharesV2Ix({ authority: a.authority, mint: a.mint, current: a.current, next: a.next }), 'pump_update_fee_shares_v2');
  a = fixIx('pump_update_fee_shares_v2_pool').args;
  sameIx(ff.updateFeeSharesV2Ix({ authority: a.authority, mint: a.mint, current: a.current, next: a.next, pool: a.pool }), 'pump_update_fee_shares_v2_pool');
  a = fixIx('pump_update_fee_shares_v1').args;
  sameIx(ff.updateFeeSharesIx({ authority: a.authority, mint: a.mint, current: a.current, next: a.next }), 'pump_update_fee_shares_v1');
  a = fixIx('pump_distribute_creator_fees_v2').args;
  sameIx(ff.distributeCreatorFeesV2Ix({ payer: a.payer, mint: a.mint, shareholders: a.shareholders }), 'pump_distribute_creator_fees_v2');
  a = fixIx('pump_get_minimum_distributable_fee').args;
  sameIx(ff.getMinimumDistributableFeeIx({ mint: a.mint, shareholders: a.shareholders }), 'pump_get_minimum_distributable_fee');
  a = fixIx('pump_transfer_creator_fees_to_pump_v2').args;
  sameIx(ff.transferCreatorFeesToPumpV2Ix({ payer: a.payer, coinCreator: a.coinCreator }), 'pump_transfer_creator_fees_to_pump_v2');
  a = fixIx('pump_create_v2').args;
  sameIx(ff.pumpCreateV2Ix(a), 'pump_create_v2');
  a = fixIx('pump_buy_v2').args;
  const rc = { feeRecipient: a.feeRecipient, buybackFeeRecipient: a.buybackFeeRecipient };
  sameIx(ff.pumpBuyV2Ix({ rc, mint: a.mint, user: a.user, curveCreator: a.curveCreator, amount: BigInt(a.amount), maxSolCost: BigInt(a.maxSolCost) }), 'pump_buy_v2');
  a = fixIx('pump_sell_v2').args;
  sameIx(ff.pumpSellV2Ix({ rc, mint: a.mint, user: a.user, curveCreator: a.curveCreator, amount: BigInt(a.amount), minSolOutput: BigInt(a.minSolOutput) }), 'pump_sell_v2');
  a = fixIx('create_ata').args;
  sameIx(ff.createAtaIdempotentIx(a), 'create_ata');
  assert.deepEqual(
    norm(ff.decodeMinimumDistributableFee(Uint8Array.from([0, 216, 19, 0, 0, 0, 0, 0, 245, 71, 1, 0, 0, 0, 0, 0, 0]))),
    { minimumRequired: '1300480', distributableFees: '83957', canDistribute: false },
  );
});

test('events parse from real logs', () => {
  const L = fx.logs;
  const coin = ff.decodeCoin(b64(fx.accounts.coin.data));
  const P = fx.people;

  const reg = ff.parseEvents(L.connect);
  assert.deepEqual(reg.map((e) => e.name), ['Registered']);
  assert.equal(reg[0].data.owner.toBase58(), P.dev);
  assert.equal(reg[0].data.vaultFunded, ff.RENT_MIN_0);
  assert.equal(reg[0].data.carried, 0n);

  const t1 = ff.parseEvents(L.tickOwner);
  assert.deepEqual(t1.map((e) => e.name), ['FeesSynced', 'Paid']);
  assert.equal(t1[0].data.toOwner, t1[0].data.amount);
  assert.equal(t1[1].data.kind, 'Owner');
  assert.equal(t1[1].data.amount, t1[0].data.amount);

  const buy = ff.parseEvents(L.buy).filter((e) => e.name === 'HoursBought');
  assert.equal(buy.length, 1);
  const hb = buy[0].data;
  assert.equal(hb.buyer.toBase58(), P.alice);
  assert.equal(hb.hours, 2);
  assert.equal(hb.end - hb.start, 7200);
  assert.equal(hb.total, hb.price * 2n);
  assert.deepEqual(ff.saleSplit(hb.total, 500), { fee: hb.fee, toOwner: hb.toOwner });

  const t2 = ff.parseEvents(L.tickHolder);
  const synced = t2.find((e) => e.name === 'FeesSynced').data;
  assert.equal(synced.toWindows, synced.amount);
  const paid = t2.filter((e) => e.name === 'Paid');
  assert.deepEqual(paid.map((p) => [p.data.to.toBase58(), p.data.kind]), [[P.alice, 'Holder']]);

  const t3 = ff.parseEvents(L.tickDone);
  const done = t3.filter((e) => e.name === 'WindowDone');
  assert.equal(done.length, 1);
  assert.equal(done[0].data.holder.toBase58(), P.alice);
  const s3 = t3.find((e) => e.name === 'FeesSynced').data;
  assert.equal(s3.toOwner + s3.toWindows, s3.amount);

  assert.equal(ff.parseEvents(L.setTerms)[0].name, 'TermsSet');
  const ot = ff.parseEvents(L.transferOwner).find((e) => e.name === 'OwnerTransferred').data;
  assert.equal(ot.from.toBase58(), P.dev);
  assert.equal(ot.to.toBase58(), P.heir);
  assert.equal(coin.owner.toBase58(), P.heir);
  const cs = ff.parseEvents(L.setConfig)[0];
  assert.equal(cs.name, 'ConfigSet');
  assert.equal(cs.data.feeBps, 400);

  // events of other programs never count as flipfee events
  assert.deepEqual(ff.parseEvents(L.firstTrade), []);
});

test('pump and PumpSwap trade events carry the creator fee', () => {
  const sc = fx.pdas.coins[0].sharingConfig;
  const buy = ff.parsePumpEvents(fx.logs.firstTrade);
  assert.equal(buy.length, 1);
  assert.equal(buy[0].program, 'pump');
  assert.equal(buy[0].event.isBuy, true);
  assert.equal(buy[0].event.mint.toBase58(), fx.pdas.coins[0].mint);
  assert.equal(buy[0].event.creator.toBase58(), sc);
  assert.ok(buy[0].event.creatorFee > 0n);
  assert.equal(buy[0].event.user.toBase58(), fx.people.trader);
  const sell = ff.parsePumpEvents(fx.logs.sellTrade);
  assert.equal(sell[0].event.isBuy, false);
  assert.ok(sell[0].event.creatorFee > 0n);

  const sc2 = fx.pdas.coins[1].sharingConfig;
  const ab = ff.parsePumpEvents(fx.logs.ammBuy);
  assert.equal(ab.length, 1);
  assert.equal(ab[0].program, 'pump_amm');
  assert.equal(ab[0].event.side, 'buy');
  assert.equal(ab[0].event.coinCreator.toBase58(), sc2);
  assert.ok(ab[0].event.coinCreatorFee > 0n);
  assert.equal(ab[0].event.pool.toBase58(), fx.pdas.coins[1].canonicalPool);
  const as = ff.parsePumpEvents(fx.logs.ammSell);
  assert.equal(as[0].event.side, 'sell');
  assert.ok(as[0].event.coinCreatorFee > 0n);
});

test('errors decode from logs', () => {
  const e = ff.parseFlipfeeError({ logs: fx.logs.failedBuy });
  assert.equal(e.name, 'BadHours');
  assert.equal(e.source, 'program');
  assert.equal(e.code, 6011);
  assert.equal(ff.parseFlipfeeError({ InstructionError: [1, { Custom: 6014 }] }).name, 'QueueFull');
  assert.equal(ff.parseFlipfeeError({ message: 'failed: custom program error: 0x177c' }).name, 'PriceAboveMax');
  const pumpErr = ff.parseFlipfeeError({
    logs: [`Program ${ff.PUMP_FEES_PROGRAM_ID.toBase58()} failed: custom program error: 0x1779`],
  });
  assert.deepEqual([pumpErr.source, pumpErr.name], ['pump', 'SharingConfigAdminRevoked']);
  assert.equal(ff.parseFlipfeeError(null), null);
});

test('math mirrors the program', () => {
  assert.deepEqual(ff.saleSplit(300_000_000n, 500), { fee: 15_000_000n, toOwner: 285_000_000n });
  assert.deepEqual(ff.saleSplit(10_000_001n, 500), { fee: 500_000n, toOwner: 9_500_001n });
  const w = [{ start: 1050, end: 1080 }, { start: 1080, end: 4680 }];
  assert.deepEqual(ff.allocate(w, 1_000_000n, 1000, 1100), { perWindow: [300_000n, 200_000n], toOwner: 500_000n });
  assert.deepEqual(ff.allocate([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }], 100n, 0, 3), { perWindow: [33n, 33n, 33n], toOwner: 1n });
  assert.throws(() => ff.allocate(w, 1n, 5, 5), RangeError);
  assert.equal(ff.suggestedPrice({ lastHour: 390_000_000n }), 312_000_000n);
  assert.equal(ff.suggestedPrice({ lastHour: 0n, last6h: 2_220_000_000n }), 296_000_000n);
  assert.equal(ff.suggestedPrice({ lastHour: 1n }), ff.MIN_PRICE);
  assert.equal(ff.suggestedPrice({ lastHour: 10n ** 13n }), ff.MAX_PRICE);
  assert.equal(ff.formatSol(1_500_000n), '0.0015');
  assert.equal(ff.formatSol(312_345_678n, 2), '0.31');
  assert.equal(ff.formatSol(5n * 10n ** 9n, 4), '5.0000');
  assert.equal(ff.parseSol('0.31'), 310_000_000n);
  assert.throws(() => ff.parseSol('1e9'), TypeError);
});

test('coinStatus reads the queue', () => {
  const holder = (n) => new PublicKey(new Uint8Array(32).fill(n));
  const coin = {
    ...ff.decodeCoin(b64(fx.accounts.coin.data)),
    paused: false,
    maxAhead: 86_400,
    windows: [
      { holder: holder(1), start: 1_000, end: 4_600, owed: 0n, earned: 5n },
      { holder: holder(2), start: 4_600, end: 11_800, owed: 0n, earned: 0n },
    ],
  };
  let s = ff.coinStatus(coin, 2_000);
  assert.ok(s.holder.equals(holder(1)));
  assert.equal(s.endsIn, 2_600);
  assert.equal(s.queue.length, 1);
  assert.equal(s.nextStart, 11_800);
  assert.equal(s.aheadLeft, 86_400 - 9_800);
  assert.equal(s.maxHoursNow, 12);
  s = ff.coinStatus(coin, 20_000);
  assert.equal(s.holder, null);
  assert.equal(s.nextStart, 20_000);
  assert.equal(s.queue.length, 0);
  s = ff.coinStatus({ ...coin, maxAhead: 3_600 }, 2_000);
  assert.equal(s.maxHoursNow, 0, 'the queue already reaches past 1 h ahead');
  s = ff.coinStatus({ ...coin, paused: true }, 2_000);
  assert.equal(s.maxHoursNow, 0);
  const full = { ...coin, windows: Array.from({ length: 32 }, (_, i) => ({ holder: holder(3), start: 100_000 + i * 3_600, end: 103_600 + i * 3_600, owed: 0n, earned: 0n })) };
  assert.equal(ff.coinStatus(full, 2_000).queueFull, true);
  assert.equal(ff.coinStatus(full, 2_000).maxHoursNow, 0);
});

test('eligibility: every state, from real account bytes', async () => {
  const c0 = fx.pdas.coins[0];
  const mint = c0.mint;
  const dev = pk(fx.people.dev);
  const other = pk(fx.people.alice);
  const curveBefore = b64(fx.accounts.bondingCurveBefore.data); // creator = dev, no sharing config yet
  const curveAfter = b64(fx.accounts.bondingCurve.data); // creator = sharing config
  const sharing = b64(fx.accounts.sharingConfig.data); // revoked, 100% → vault, admin = dev
  const coinData = b64(fx.accounts.coin.data);
  const own = (owner, data) => ({ owner, data: Buffer.from(data), lamports: 1, executable: false });
  /** A connection whose accounts are { curve, sharing, coin, pool } (null = missing). */
  const conn = (s) => ({
    getMultipleAccountsInfo: async (keys) =>
      keys.map((k) => {
        const a = k.toBase58();
        if (a === c0.bondingCurve) return s.curve ? own(ff.PUMP_PROGRAM_ID, s.curve) : null;
        if (a === c0.sharingConfig) return s.sharing ? own(ff.PUMP_FEES_PROGRAM_ID, s.sharing) : null;
        if (a === c0.coin) return s.coin ? own(ff.FLIPFEE_PROGRAM_ID, s.coin) : null;
        if (a === c0.canonicalPool) return s.pool ? own(ff.PUMP_AMM_PROGRAM_ID, s.pool) : null;
        return null;
      }),
  });
  const patch = (bytes, offset, value) => {
    const b = Uint8Array.from(bytes);
    b.set(value, offset);
    return b;
  };
  const kind = async (s, wallet = dev) => (await ff.eligibility(conn(s), mint, wallet)).kind;

  assert.equal(await kind({}), 'not-found');
  assert.equal(await kind({ curve: curveBefore }), 'ready-new');
  assert.equal(await kind({ curve: curveBefore }, other), 'not-admin');
  assert.equal(await kind({ curve: curveBefore }, null), 'not-admin');
  assert.equal(await kind({ curve: patch(curveBefore, 83, ff.USDC_MINT.toBytes()) }), 'usdc');
  assert.equal(await kind({ curve: patch(curveBefore, 82, [1]) }), 'unsupported', 'cashback');
  assert.equal(await kind({ curve: patch(curveBefore, 124, [1]) }), 'unsupported', 'holder rewards');
  // split not final yet: admin_revoked = false
  const open = patch(sharing, 75, [0]);
  assert.equal(await kind({ curve: curveAfter, sharing: open }), 'ready');
  assert.equal(await kind({ curve: curveAfter, sharing: open }, other), 'not-admin');
  // final split to the flipfee vault, not registered
  assert.equal(await kind({ curve: curveAfter, sharing }), 'almost');
  assert.equal(await kind({ curve: curveAfter, sharing }, other), 'not-admin');
  // final split to someone else
  assert.equal(await kind({ curve: curveAfter, sharing: patch(sharing, 80, other.toBytes()) }), 'locked');
  // a takeover moved the curve's creator away from the sharing config
  const moved = await ff.eligibility(conn({ curve: curveBefore, sharing }), mint, dev);
  assert.equal(moved.kind, 'locked');
  assert.match(moved.reason, /takeover/);
  // pump paused fee sharing
  assert.equal(await kind({ curve: curveAfter, sharing: patch(sharing, 10, [0]) }), 'unsupported');
  // on flipfee
  const live = await ff.eligibility(conn({ curve: curveAfter, sharing, coin: coinData }), mint, other);
  assert.equal(live.kind, 'flipfee');
  assert.equal(live.registered, true);
  assert.equal(live.admin.toBase58(), dev.toBase58());
  // graduated, no sharing config: the pool's coin creator decides
  const done = patch(curveBefore, 48, [1]);
  const pool = patch(b64(fx.accounts.pool.data), 211, dev.toBytes());
  const g = await ff.eligibility(conn({ curve: done, pool }), mint, dev);
  assert.deepEqual([g.kind, g.graduated, g.admin.toBase58()], ['ready-new', true, dev.toBase58()]);
  assert.equal(await kind({ curve: done, pool: patch(pool, 211, other.toBytes()) }), 'not-admin');
  // graduated with the split to the vault but a pool paying someone else
  const gradCurve = patch(curveAfter, 48, [1]);
  assert.equal(await kind({ curve: gradCurve, sharing, pool }), 'locked');
  assert.equal(await kind({ curve: gradCurve, sharing, pool: patch(pool, 211, pk(c0.sharingConfig).toBytes()) }), 'almost');
});
