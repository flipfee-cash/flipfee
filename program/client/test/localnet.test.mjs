// End-to-end test of the built client and keeper against a local solana-test-validator running target/deploy/flipfee.so
// next to the MAINNET binaries of pump, pump_amm, pump_fees and mayhem plus the mainnet accounts they read
// (fixtures/mainnet, fetched read-only by `npm run fixtures`). Real RPC, real signatures, real logs: coins are created
// with pump create_v2 and traded with buy_v2/sell_v2; connectCoinTx / buyTx / crankTx / eligibility / the keeper
// (module and CLI) run as the server and the app will run them. A sold hour cannot elapse on a wall-clock validator,
// so "after the hour" paths are covered by the LiteSVM tests (programs/flipfee/tests/splits.rs).
//
// Run: npm run test:localnet  (needs `anchor build`, `npm run build:client`, `npm run build:keeper`; uses ports
// 28899/29900/28001-28050 and .test-ledger/)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';

import * as ff from '../dist/index.js';
import { createKeeper } from '../../keeper/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const RPC = 'http://127.0.0.1:28899';
const bin = (name) => {
  const local = join(homedir(), '.local/share/solana/install/active_release/bin', name);
  return existsSync(local) ? local : name;
};
const manifest = JSON.parse(readFileSync(join(root, 'fixtures/mainnet/manifest.json'), 'utf8'));
const rc = { feeRecipient: manifest.roles.feeRecipients[0], buybackFeeRecipient: manifest.roles.buybackFeeRecipients[0] };

let validator;
let stopping = false;
const connection = new Connection(RPC, 'confirmed');
const authority = Keypair.generate(); // upgrade authority of flipfee = admin
const treasury = Keypair.generate();
const dev = Keypair.generate();
const trader = Keypair.generate();
const alice = Keypair.generate();
const bob = Keypair.generate();
const keeperKey = Keypair.generate();
const whale = Keypair.generate();
const T = 1_000_000_000_000n; // 1M tokens
const PRICE = 50_000_000n; // 0.05 SOL per hour
const keeperLog = [];
let rentMin;
/** Top-level compute units per "program:Instruction", from every transaction this test sends. */
const cu = new Map();
function recordUnits(logs) {
  let depth = 0;
  let name = null;
  for (const l of logs) {
    const inv = /^Program (\w+) invoke \[(\d+)\]$/.exec(l);
    if (inv) {
      depth++;
      if (depth === 1) name = null;
      continue;
    }
    const ixName = /^Program log: Instruction: (\w+)$/.exec(l);
    if (ixName && depth === 1 && !name) name = ixName[1];
    const used = /^Program (\w+) consumed (\d+) of/.exec(l);
    if (used && depth === 1) {
      const short = { [ff.FLIPFEE_PROGRAM_ID.toBase58()]: 'flipfee', [ff.PUMP_PROGRAM_ID.toBase58()]: 'pump', [ff.PUMP_AMM_PROGRAM_ID.toBase58()]: 'pump_amm', [ff.PUMP_FEES_PROGRAM_ID.toBase58()]: 'pump_fees' }[used[1]];
      if (short) {
        const k = `${short}:${name ?? '?'}`;
        cu.set(k, Math.max(cu.get(k) ?? 0, Number(used[2])));
      }
    }
    if (/^Program \w+ (success|failed)/.test(l)) depth = Math.max(0, depth - 1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lamports = async (k) => BigInt((await connection.getBalance(k instanceof PublicKey ? k : k.publicKey, 'confirmed')) ?? 0);

/** Signs, sends and waits for `confirmed` by polling over HTTP. Returns the signature and the logs. */
async function sendTx(tx, signers) {
  const uniq = signers.filter((s, i, a) => a.findIndex((x) => x.publicKey.equals(s.publicKey)) === i);
  tx.sign(...uniq);
  const sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  for (let i = 0; i < 160; i++) {
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st?.err) {
      const t = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      throw Object.assign(new Error(`transaction ${sig} failed`), { err: st.err, logs: t?.meta?.logMessages ?? [] });
    }
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') break;
    await sleep(250);
  }
  for (let i = 0; i < 40; i++) {
    const t = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (t?.meta) {
      recordUnits(t.meta.logMessages ?? []);
      return { sig, logs: t.meta.logMessages ?? [], events: ff.parseEvents(t.meta.logMessages ?? []) };
    }
    await sleep(250);
  }
  throw new Error(`transaction ${sig} not found`);
}

async function send(ixs, payer, signers = [], units = 600_000) {
  const tx = await ff.buildTx(connection, payer.publicKey, ixs, units);
  return sendTx(tx, [payer, ...signers]);
}

async function airdrop(k, sol) {
  const sig = await connection.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL);
  for (let i = 0; i < 160; i++) {
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return;
    await sleep(250);
  }
  throw new Error(`airdrop to ${k.publicKey.toBase58()} not confirmed`);
}

/** pump create_v2 by `creator`; returns the mint. */
async function createCoin(creator, symbol = 'FLIP') {
  const mint = Keypair.generate();
  await send([ff.pumpCreateV2Ix({ mint: mint.publicKey, user: creator.publicKey, creator: creator.publicKey, name: `Flip ${symbol}`, symbol, uri: 'https://flipfee.test/m.json' })], creator, [mint]);
  return mint.publicKey;
}

/** pump buy_v2 of `amount` base units by `who`. */
async function curveBuy(who, mint, amount) {
  const curve = await ff.fetchBondingCurve(connection, mint);
  return send(
    [
      ff.createAtaIdempotentIx({ payer: who.publicKey, owner: who.publicKey, mint, tokenProgram: ff.TOKEN_2022_PROGRAM_ID }),
      ff.pumpBuyV2Ix({ rc, mint, user: who.publicKey, curveCreator: curve.creator, amount, maxSolCost: 200n * BigInt(LAMPORTS_PER_SOL) }),
    ],
    who,
  );
}

async function curveSell(who, mint, amount) {
  const curve = await ff.fetchBondingCurve(connection, mint);
  return send([ff.pumpSellV2Ix({ rc, mint, user: who.publicKey, curveCreator: curve.creator, amount, minSolOutput: 0n })], who);
}

before(async () => {
  const so = join(root, 'target/deploy/flipfee.so');
  assert.ok(existsSync(so), 'target/deploy/flipfee.so missing: run anchor build');
  const ledger = join(root, '.test-ledger');
  rmSync(ledger, { recursive: true, force: true });
  mkdirSync(ledger, { recursive: true });
  const errLog = openSync(join(ledger, 'stderr.log'), 'a');
  const programs = Object.entries(manifest.programs).flatMap(([name, p]) => [
    '--upgradeable-program', p.id, join(root, `fixtures/mainnet/programs/${name}.so`), authority.publicKey.toBase58(),
  ]);
  validator = spawn(
    bin('solana-test-validator'),
    [
      '--reset', '--quiet', '--ledger', ledger, '--bind-address', '127.0.0.1',
      '--rpc-port', '28899', '--faucet-port', '29900', '--gossip-port', '28001', '--dynamic-port-range', '28002-28050',
      '--faucet-sol', '10000000',
      '--upgradeable-program', ff.FLIPFEE_PROGRAM_ID.toBase58(), so, authority.publicKey.toBase58(),
      ...programs,
      '--account-dir', join(root, 'fixtures/mainnet/accounts'),
    ],
    { stdio: ['ignore', 'ignore', errLog] },
  );
  validator.on('exit', (code, sig) => {
    if (!stopping) console.error(`solana-test-validator exited early (code ${code}, signal ${sig}); see .test-ledger/stderr.log`);
  });
  for (let i = 0; i < 240; i++) {
    try {
      if ((await connection.getSlot()) > 1) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  await Promise.all([authority, treasury, dev, trader, alice, bob, keeperKey].map((k) => airdrop(k, 1_000)));
  await airdrop(whale, 2_000);
  rentMin = BigInt(await connection.getMinimumBalanceForRentExemption(0));
});

after(() => {
  stopping = true;
  validator?.kill('SIGTERM');
  console.log('max top-level compute units on solana-test-validator:');
  for (const [k, v] of [...cu.entries()].sort()) console.log(`  ${k.padEnd(44)} ${v}`);
});

const keeper = () =>
  createKeeper({ connection, payer: keeperKey, intervalMs: 60_000, minPending: 1n, log: (l) => keeperLog.push(l) });

let mint; // the main coin

test('initialize, eligibility and the one-transaction connect', async () => {
  const { events } = await send([ff.initializeIx({ authority: authority.publicKey, treasury: treasury.publicKey, feeBps: 500 })], authority);
  assert.equal(events[0].name, 'ConfigSet');
  const cfg = await ff.fetchConfig(connection);
  assert.equal(cfg.admin.toBase58(), authority.publicKey.toBase58());
  assert.equal(cfg.feeBps, 500);

  mint = await createCoin(dev);
  await curveBuy(trader, mint, 2n * T);
  let e = await ff.eligibility(connection, mint, dev.publicKey);
  assert.equal(e.kind, 'ready-new');
  assert.equal(e.admin.toBase58(), dev.publicKey.toBase58());
  assert.equal(e.graduated, false);
  assert.equal((await ff.eligibility(connection, mint, alice.publicKey)).kind, 'not-admin');
  assert.equal((await ff.eligibility(connection, mint)).kind, 'not-admin');
  assert.equal((await ff.eligibility(connection, Keypair.generate().publicKey, dev.publicKey)).kind, 'not-found');

  const { tx, kind, coin, vault } = await ff.connectCoinTx(connection, { wallet: dev.publicKey, mint, price: PRICE, maxAhead: 86_400 });
  assert.equal(kind, 'ready-new');
  const size = tx.serialize({ requireAllSignatures: false }).length;
  console.log(`connect transaction (create config + split + register): ${size} bytes, ${tx.instructions.length} instructions`);
  assert.ok(size <= 1232, `fits one transaction: ${size}`);
  const sim = await ff.simulateTx(connection, tx);
  assert.ok(sim.ok, `simulation: ${JSON.stringify(sim.err)} ${sim.logs.join('\n')}`);
  const res = await sendTx(tx, [dev]);
  const reg = res.events.find((x) => x.name === 'Registered').data;
  assert.equal(reg.owner.toBase58(), dev.publicKey.toBase58());
  assert.equal(reg.vaultFunded, rentMin);
  assert.equal(coin.toBase58(), reg.coin.toBase58());
  assert.equal(vault.toBase58(), reg.vault.toBase58());
  e = await ff.eligibility(connection, mint, dev.publicKey);
  assert.equal(e.kind, 'flipfee');
  assert.equal(e.registered, true);
  assert.equal(e.sharing.adminRevoked, true);
  assert.equal(e.sharing.admin.toBase58(), dev.publicKey.toBase58(), 'pump keeps the admin after revoking');
  await assert.rejects(ff.connectCoinTx(connection, { wallet: dev.publicKey, mint, price: PRICE }), (err) => err instanceof ff.NotEligibleError && err.eligibility.kind === 'flipfee');
  const c = await ff.fetchCoin(connection, mint);
  assert.equal(c.price, PRICE);
  assert.equal((await ff.fetchCoins(connection)).length, 1);
  assert.equal((await ff.fetchCoinsOfOwner(connection, dev.publicKey)).length, 1);
});

test('the keeper pays the dev for fees outside sold hours', async () => {
  await curveBuy(trader, mint, 3n * T);
  await curveSell(trader, mint, T);
  const pumpVault = ff.findPumpCreatorVaultPda(ff.findSharingConfigPda(mint)[0])[0];
  const pending = (await lamports(pumpVault)) - rentMin;
  assert.ok(pending > 0n);
  const d0 = await lamports(dev);
  const r = await keeper().tick();
  assert.equal(r.coins, 1);
  assert.equal(r.acted.length, 1);
  const a = r.acted[0];
  assert.equal(a.error, undefined);
  assert.equal(a.distributed, true);
  assert.equal(a.synced, pending, 'everything pump held arrived and was allocated');
  assert.deepEqual(a.paid.map((p) => [p.to, p.kind, p.amount]), [[dev.publicKey.toBase58(), 'Owner', pending]]);
  assert.equal((await lamports(dev)) - d0, pending, 'SOL landed in the dev wallet');
  assert.match(keeperLog.at(-1), /^crank \w+ distributed synced 0\.\d+ SOL, paid owner/);
  // nothing to do now: skipped
  const r2 = await keeper().tick();
  assert.equal(r2.acted.length, 0);
  assert.equal(r2.skipped, 1);
});

let aliceWindow;
test('buyTx: the hour starts now, the next buyer queues, exact payments', async () => {
  const cfg = await ff.fetchConfig(connection);
  const [a0, d0, t0] = await Promise.all([lamports(alice), lamports(dev), lamports(treasury)]);
  const b = await ff.buyTx(connection, { buyer: alice.publicKey, mint, hours: 1 });
  assert.equal(b.total, PRICE);
  assert.equal(b.maxStart, b.start + 120);
  assert.deepEqual({ fee: b.fee, toOwner: b.toOwner }, ff.saleSplit(PRICE, cfg.feeBps));
  const res = await sendTx(b.tx, [alice]);
  const hb = res.events.find((x) => x.name === 'HoursBought').data;
  assert.equal(hb.buyer.toBase58(), alice.publicKey.toBase58());
  assert.equal(hb.end - hb.start, 3600);
  assert.ok(Math.abs(hb.start - b.start) <= 5, 'start as estimated from the chain clock');
  aliceWindow = hb;
  const fee = 5000n; // alice is the fee payer of her own transaction
  assert.equal(a0 - (await lamports(alice)), PRICE + fee);
  assert.equal((await lamports(dev)) - d0, b.toOwner);
  assert.equal((await lamports(treasury)) - t0, b.fee);

  const b2 = await ff.buyTx(connection, { buyer: bob.publicKey, mint, hours: 2 });
  assert.equal(b2.start, hb.end, 'queued right after alice');
  const res2 = await sendTx(b2.tx, [bob]);
  const hb2 = res2.events.find((x) => x.name === 'HoursBought').data;
  assert.equal(hb2.start, hb.end);
  assert.equal(hb2.end, hb.end + 7200);

  const c = await ff.fetchCoin(connection, mint);
  const now = await ff.chainTime(connection);
  const s = ff.coinStatus(c, now);
  assert.equal(s.holder.toBase58(), alice.publicKey.toBase58());
  assert.equal(s.queue.length, 1);
  assert.equal(s.nextStart, hb.end + 7200);
  assert.equal(s.maxHoursNow, Math.min(12, Math.floor((86_400 - (s.nextStart - now)) / 3600)));
  await assert.rejects(ff.buyTx(connection, { buyer: bob.publicKey, mint, hours: 13 }), RangeError);
});

test('fees inside the hour land in the buyer wallet; cranks are idempotent', async () => {
  await curveBuy(trader, mint, 4n * T);
  await curveSell(trader, mint, 2n * T);
  const pumpVault = ff.findPumpCreatorVaultPda(ff.findSharingConfigPda(mint)[0])[0];
  const pending = (await lamports(pumpVault)) - rentMin;
  const a0 = await lamports(alice);
  const r = await keeper().tick();
  const a = r.acted[0];
  assert.equal(a.synced, pending);
  // the sync interval starts at alice's purchase (inside her hour) and ends now (inside her hour): all hers
  assert.deepEqual(a.paid.map((p) => [p.to, p.kind, p.amount]), [[alice.publicKey.toBase58(), 'Holder', pending]]);
  assert.equal((await lamports(alice)) - a0, pending, 'SOL landed in the buyer wallet');
  const c = await ff.fetchCoin(connection, mint);
  assert.equal(c.windows[0].earned, pending);
  assert.equal(c.credited, 0n);

  // anyone's crank with nothing new: no sync, no payment
  const stranger = Keypair.generate();
  await airdrop(stranger, 1);
  const { tx, recipients } = await ff.crankTx(connection, { payer: stranger.publicKey, mint });
  assert.deepEqual(recipients.map(String), [dev.publicKey.toBase58(), alice.publicKey.toBase58()]);
  const res = await sendTx(tx, [stranger]);
  assert.deepEqual(res.events, []);
  const c2 = await ff.fetchCoin(connection, mint);
  assert.equal(c2.feesIn, c.feesIn);
  assert.equal(c2.paidOut, c.paidOut);
  // books
  const vault = await lamports(ff.findVaultPda(mint)[0]);
  assert.equal(vault, rentMin + c2.credited);
  assert.equal(c2.feesIn - c2.paidOut, c2.credited);
});

test('errors come back decoded through the client', async () => {
  const c = await ff.fetchCoin(connection, mint);
  const cfg = await ff.fetchConfig(connection);
  const low = ff.buyIx({ buyer: bob.publicKey, mint, owner: c.owner, treasury: cfg.treasury, hours: 1, maxPrice: PRICE - 1n, maxStart: 2 ** 40 });
  let tx = await ff.buildTx(connection, bob.publicKey, [low], 100_000);
  let sim = await ff.simulateTx(connection, tx);
  assert.equal(ff.parseFlipfeeError({ logs: sim.logs }).name, 'PriceAboveMax');
  tx = await ff.buildTx(connection, bob.publicKey, [ff.setTermsIx({ owner: bob.publicKey, mint, price: PRICE, maxAhead: 3600, paused: false })], 50_000);
  sim = await ff.simulateTx(connection, tx);
  assert.equal(ff.parseFlipfeeError({ logs: sim.logs }).name, 'NotOwner');
  await assert.rejects(
    send([ff.setTermsIx({ owner: bob.publicKey, mint, price: PRICE, maxAhead: 3600, paused: false })], bob),
    (err) => ff.parseFlipfeeError(err)?.name === 'NotOwner',
  );
  // a buy that skips collecting pump's fees is refused (it would take fees earned before it)
  await curveBuy(trader, mint, T);
  const bare = ff.buyIx({ buyer: bob.publicKey, mint, owner: c.owner, treasury: cfg.treasury, hours: 1, maxPrice: PRICE, maxStart: 2 ** 40 });
  sim = await ff.simulateTx(connection, await ff.buildTx(connection, bob.publicKey, [bare], 100_000));
  assert.equal(ff.parseFlipfeeError({ logs: sim.logs }).name, 'FeesNotCollected');
  // a buy whose hours would start later than the buyer accepted is refused
  const late = await ff.buyTx(connection, { buyer: bob.publicKey, mint, hours: 1, maxStart: 1 });
  sim = await ff.simulateTx(connection, late.tx);
  assert.equal(ff.parseFlipfeeError({ logs: sim.logs }).name, 'StartsTooLate');
  // the owner pauses and resumes sales
  await send([ff.setTermsIx({ owner: dev.publicKey, mint, price: PRICE, maxAhead: 86_400, paused: true })], dev);
  const b = await ff.buyTx(connection, { buyer: bob.publicKey, mint, hours: 1 });
  sim = await ff.simulateTx(connection, b.tx);
  assert.equal(ff.parseFlipfeeError({ logs: sim.logs }).name, 'CoinPaused');
  assert.equal(ff.coinStatus(await ff.fetchCoin(connection, mint), await ff.chainTime(connection)).maxHoursNow, 0);
  await send([ff.setTermsIx({ owner: dev.publicKey, mint, price: PRICE, maxAhead: 86_400, paused: false })], dev);
});

test('eligibility and connect for almost / ready / locked coins', async () => {
  const dev2 = Keypair.generate();
  await airdrop(dev2, 100);
  const vaultOf = (m) => ff.findVaultPda(m)[0];

  // "ready": a sharing config exists, the split is not final yet
  const m1 = await createCoin(dev2, 'RDY');
  await curveBuy(trader, m1, T);
  await send([ff.createFeeSharingConfigIx({ creator: dev2.publicKey, mint: m1 })], dev2);
  let e = await ff.eligibility(connection, m1, dev2.publicKey);
  assert.equal(e.kind, 'ready');
  let c = await ff.connectCoinTx(connection, { wallet: dev2.publicKey, mint: m1, price: PRICE });
  assert.equal(c.kind, 'ready');
  await sendTx(c.tx, [dev2]);
  assert.equal((await ff.eligibility(connection, m1, dev2.publicKey)).kind, 'flipfee');

  // "almost": the split already sends 100% to the vault, not registered
  const m2 = await createCoin(dev2, 'ALM');
  await send(
    [
      ff.createFeeSharingConfigIx({ creator: dev2.publicKey, mint: m2 }),
      ff.updateFeeSharesV2Ix({ authority: dev2.publicKey, mint: m2, current: [dev2.publicKey], next: [{ address: vaultOf(m2), shareBps: 10_000 }] }),
    ],
    dev2,
  );
  e = await ff.eligibility(connection, m2, dev2.publicKey);
  assert.equal(e.kind, 'almost');
  assert.equal((await ff.eligibility(connection, m2, alice.publicKey)).kind, 'not-admin');
  c = await ff.connectCoinTx(connection, { wallet: dev2.publicKey, mint: m2, price: PRICE });
  assert.equal(c.kind, 'almost');
  assert.equal(c.tx.instructions.length, 2, 'compute budget + register');
  await sendTx(c.tx, [dev2]);

  // "locked": the final split goes elsewhere
  const m3 = await createCoin(dev2, 'LCK');
  await send(
    [
      ff.createFeeSharingConfigIx({ creator: dev2.publicKey, mint: m3 }),
      ff.updateFeeSharesV2Ix({ authority: dev2.publicKey, mint: m3, current: [dev2.publicKey], next: [{ address: alice.publicKey, shareBps: 10_000 }] }),
    ],
    dev2,
  );
  e = await ff.eligibility(connection, m3, dev2.publicKey);
  assert.equal(e.kind, 'locked');
  await assert.rejects(ff.connectCoinTx(connection, { wallet: dev2.publicKey, mint: m3, price: PRICE }), ff.NotEligibleError);
  assert.equal((await ff.fetchCoinsOfOwner(connection, dev2.publicKey)).length, 2);
});

test('the keeper CLI runs one pass', async () => {
  await curveBuy(trader, mint, 2n * T);
  const kp = join(root, '.test-ledger/keeper.json');
  writeFileSync(kp, JSON.stringify(Array.from(keeperKey.secretKey)), { mode: 0o600 });
  const r = spawnSync(process.execPath, [join(root, 'keeper/dist/cli.js'), '--once', '--rpc', RPC, '--keypair', kp, '--min-pending', '1'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /crank \w+ distributed synced/);
  assert.match(r.stdout, /tick: 3 coins, 1 acted, 2 skipped/);
  assert.ok(!r.stdout.includes(JSON.stringify(Array.from(keeperKey.secretKey)).slice(1, 20)), 'never prints the key');
});

test('a graduated coin: connect with its pool, PumpSwap fees swept, distributed and paid', async () => {
  const dev3 = Keypair.generate();
  await airdrop(dev3, 100);
  const m = await createCoin(dev3, 'GRAD');
  // buy the whole curve, then migrate it to PumpSwap (permissionless)
  for (;;) {
    const curve = await ff.fetchBondingCurve(connection, m);
    if (curve.realTokenReserves === 0n) break;
    const amt = curve.realTokenReserves < 50_000_000n * 1_000_000n ? curve.realTokenReserves : 50_000_000n * 1_000_000n;
    await curveBuy(whale, m, amt);
  }
  const pool = ff.findCanonicalPoolPda(m)[0];
  const pa = ff.findPoolAuthorityPda(m)[0];
  const lpMint = PublicKey.findProgramAddressSync([Buffer.from('pool_lp_mint'), pool.toBuffer()], ff.PUMP_AMM_PROGRAM_ID)[0];
  const boost = PublicKey.findProgramAddressSync([Buffer.from('boost_vault'), pool.toBuffer()], ff.PUMP_AMM_PROGRAM_ID)[0];
  const bc = ff.findBondingCurvePda(m)[0];
  const W = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
  const R = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
  const ata = (o, mi, tp = ff.TOKEN_PROGRAM_ID) => ff.getAta(o, mi, tp);
  const T22 = ff.TOKEN_2022_PROGRAM_ID;
  const migrate = new TransactionInstruction({
    programId: ff.PUMP_PROGRAM_ID,
    keys: [
      R(ff.findPumpGlobalPda()[0]), W(new PublicKey(manifest.roles.withdrawAuthority)), R(m), R(ff.WSOL_MINT), W(bc),
      W(ata(bc, m, T22)), W(ata(bc, ff.WSOL_MINT)), { pubkey: whale.publicKey, isSigner: true, isWritable: true },
      R(SystemProgram.programId), R(ff.PUMP_AMM_PROGRAM_ID), W(pool), W(pa), W(ata(pa, m, T22)), W(ata(pa, ff.WSOL_MINT)),
      R(PublicKey.findProgramAddressSync([Buffer.from('global_config')], ff.PUMP_AMM_PROGRAM_ID)[0]), W(lpMint),
      W(ata(pa, lpMint, T22)), W(ata(pool, m, T22)), W(ata(pool, ff.WSOL_MINT)), R(T22), R(ff.TOKEN_PROGRAM_ID), R(T22),
      R(ff.ASSOCIATED_TOKEN_PROGRAM_ID), R(ff.findEventAuthorityPda(ff.PUMP_AMM_PROGRAM_ID)[0]),
      R(new PublicKey('SysvarRent111111111111111111111111111111111')), R(ff.findEventAuthorityPda(ff.PUMP_PROGRAM_ID)[0]),
      R(ff.PUMP_PROGRAM_ID), W(boost), W(ata(boost, ff.WSOL_MINT)),
    ],
    data: Buffer.from([187, 203, 18, 31, 206, 237, 254, 41]),
  });
  await send([migrate], whale, [], 1_000_000);
  let e = await ff.eligibility(connection, m, dev3.publicKey);
  assert.equal(e.graduated, true);
  assert.equal(e.kind, 'ready-new', 'pool.coin_creator is dev3');
  const c = await ff.connectCoinTx(connection, { wallet: dev3.publicKey, mint: m, price: PRICE });
  const size = c.tx.serialize({ requireAllSignatures: false }).length;
  console.log(`connect transaction of a graduated coin: ${size} bytes`);
  assert.ok(size <= 1232);
  await sendTx(c.tx, [dev3]);
  e = await ff.eligibility(connection, m, dev3.publicKey);
  assert.equal(e.kind, 'flipfee');
  assert.equal(e.pool.coinCreator.toBase58(), ff.findSharingConfigPda(m)[0].toBase58());

  // a PumpSwap buy (WSOL in), accrues AMM creator fees
  const wsol = ata(whale.publicKey, ff.WSOL_MINT);
  const sc = ff.findSharingConfigPda(m)[0];
  const auth = ff.findAmmCreatorVaultAuthorityPda(sc)[0];
  const ammBuyback = new PublicKey(manifest.roles.ammBuybackFeeRecipients[0]);
  const pfr = new PublicKey(manifest.roles.ammProtocolFeeRecipients[0]);
  const ammBuy = new TransactionInstruction({
    programId: ff.PUMP_AMM_PROGRAM_ID,
    keys: [
      W(pool), { pubkey: whale.publicKey, isSigner: true, isWritable: true },
      R(PublicKey.findProgramAddressSync([Buffer.from('global_config')], ff.PUMP_AMM_PROGRAM_ID)[0]), R(m), R(ff.WSOL_MINT),
      W(ata(whale.publicKey, m, T22)), W(wsol), W(ata(pool, m, T22)), W(ata(pool, ff.WSOL_MINT)), R(pfr), W(ata(pfr, ff.WSOL_MINT)),
      R(T22), R(ff.TOKEN_PROGRAM_ID), R(SystemProgram.programId), R(ff.ASSOCIATED_TOKEN_PROGRAM_ID),
      R(ff.findEventAuthorityPda(ff.PUMP_AMM_PROGRAM_ID)[0]), R(ff.PUMP_AMM_PROGRAM_ID), W(ata(auth, ff.WSOL_MINT)), R(auth),
      R(PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], ff.PUMP_AMM_PROGRAM_ID)[0]),
      W(PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'), whale.publicKey.toBuffer()], ff.PUMP_AMM_PROGRAM_ID)[0]),
      R(ff.findFeeConfigPda(ff.PUMP_AMM_PROGRAM_ID)[0]), R(ff.PUMP_FEES_PROGRAM_ID),
      R(PublicKey.findProgramAddressSync([Buffer.from('pool-v2'), m.toBuffer()], ff.PUMP_AMM_PROGRAM_ID)[0]), R(ammBuyback), W(ata(ammBuyback, ff.WSOL_MINT)),
    ],
    data: Buffer.concat([Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]), Buffer.from(new BigUint64Array([5_000_000n * 1_000_000n]).buffer), Buffer.from(new BigUint64Array([500n * BigInt(LAMPORTS_PER_SOL)]).buffer), Buffer.from([0])]),
  });
  await send(
    [
      ff.createAtaIdempotentIx({ payer: whale.publicKey, owner: whale.publicKey, mint: ff.WSOL_MINT }),
      SystemProgram.transfer({ fromPubkey: whale.publicKey, toPubkey: wsol, lamports: 100n * BigInt(LAMPORTS_PER_SOL) }),
      new TransactionInstruction({ programId: ff.TOKEN_PROGRAM_ID, keys: [W(wsol)], data: Buffer.from([17]) }),
      ff.createAtaIdempotentIx({ payer: whale.publicKey, owner: whale.publicKey, mint: m, tokenProgram: T22 }),
      ammBuy,
    ],
    whale,
  );
  const ammVault = ff.getAmmCreatorVaultAta(sc);
  const info = await connection.getAccountInfo(ammVault, 'confirmed');
  const ammFee = info.data.readBigUInt64LE(64);
  assert.ok(ammFee > 0n, 'AMM creator fee accrued');
  const d0 = await lamports(dev3);
  const r = await createKeeper({ connection, payer: keeperKey, mints: [m], minPending: 1n, log: (l) => keeperLog.push(l) }).tick();
  const a = r.acted[0];
  assert.equal(a.error, undefined, keeperLog.at(-1));
  assert.equal(a.swept, true);
  assert.equal(a.distributed, true);
  // the first sweep into pump's new creator vault keeps its rent, once
  assert.equal(a.synced, ammFee - rentMin);
  assert.equal((await lamports(dev3)) - d0, a.synced);
  assert.match(keeperLog.at(-1), /swept distributed synced/);

  // another PumpSwap trade, then a purchase: buyTx sweeps + distributes first, so the fees earned before the hour
  // are the dev's and the hour starts clean
  await send([ammBuy], whale);
  const fee2 = (await connection.getAccountInfo(ammVault, 'confirmed')).data.readBigUInt64LE(64);
  assert.ok(fee2 > 0n);
  const b = await ff.buyTx(connection, { buyer: alice.publicKey, mint: m, hours: 1 });
  assert.equal(b.tx.instructions.length, 4, 'compute budget + sweep + distribute + buy');
  const res = await sendTx(b.tx, [alice]);
  const synced = res.events.find((x) => x.name === 'FeesSynced').data;
  assert.equal(synced.amount, fee2, 'every AMM fee before the purchase reached the vault');
  assert.equal(synced.toOwner, fee2);
  assert.equal(res.events.find((x) => x.name === 'HoursBought').data.buyer.toBase58(), alice.publicKey.toBase58());
});
