// The adapter on the program builder's real TS client (FLIPFEE_CLIENT, else vendor/flipfee-client, else
// ../program/client/dist): accounts and events decode exactly as through the IDL, and the client's eligibility gives
// the same verdicts as the server's chain fallback on the same pump accounts. Skips when no client is built.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { FlipfeeAdapter, loadFlipfee } from '../src/chain/flipfee.js';
import { eligibilityFromChain } from '../src/chain/pumpchain.js';
import { loadConfig } from '../src/config.js';
import { canonicalPoolOf, curveOf, sharingConfigOf } from '../src/ingest/pumpevents.js';
import { IdlEncoder } from './helpers/encode.js';

process.env.LOG_QUIET = '1';
const cfg = loadConfig({ FLIPFEE_CLIENT: process.env.FLIPFEE_CLIENT ?? '' });
const found = cfg.clientPath.find((p) => existsSync(join(p, 'dist', 'index.js')));
const opts = found ? {} : { skip: 'no built flipfee client (build it in flipfee/program, or set FLIPFEE_CLIENT)' };
const sub = JSON.parse(readFileSync(new URL('./fixtures/pump-idl-subset.json', import.meta.url), 'utf8'));
const pump = new IdlEncoder(sub.pump);
const amm = new IdlEncoder(sub.pump_amm);
const key = () => Keypair.generate().publicKey.toBase58();
const DEFAULT = '11111111111111111111111111111111';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

test('the client decodes accounts and events exactly as the IDL does', opts, async () => {
  const a = await loadFlipfee({ clientPath: [found] });
  assert.equal(a.source, 'client');
  const idl = JSON.parse(readFileSync(a.idl.file, 'utf8'));
  assert.equal(a.programId, idl.address, 'the client’s FLIPFEE_PROGRAM_ID is its IDL address');
  const viaIdl = new FlipfeeAdapter({ programId: a.programId, idl: { idl }, source: 'idl' });
  const enc = new IdlEncoder(idl);
  const mint = key();
  const coin = enc.account('Coin', { mint, owner: key(), bump: 1, vault_bump: 2, price: 123_456_789, max_ahead: 7200, paused: true, last_sync: 1_791_300_000, owner_owed: 5, credited: 9, windows: [{ holder: key(), start: 1_791_300_000, end: 1_791_303_600, owed: 4, earned: 6 }], fees_in: 77, sales: 88, hours_sold: 3, paid_out: 11 });
  assert.deepEqual(a.decodeAccount('x', coin), viaIdl.decodeAccount('x', coin));
  const conf = enc.account('Config', { admin: key(), treasury: key(), fee_bps: 500, paused: false, bump: 254 });
  assert.deepEqual(a.decodeAccount('c', conf), viaIdl.decodeAccount('c', conf));
  const c = a.coinPda(mint);
  const evs = [
    ['ConfigSet', { admin: key(), treasury: key(), fee_bps: 400, paused: true, at: 5 }],
    ['Registered', { mint, coin: c, owner: key(), vault: a.vaultPda(mint), price: 10_000_000, max_ahead: 3600, vault_funded: 890_880, carried: 3, at: 6 }],
    ['TermsSet', { mint, coin: c, price: 20_000_000, max_ahead: 7200, paused: false, at: 7 }],
    ['OwnerTransferred', { mint, coin: c, from: key(), to: key(), paid_to_old_owner: 9, at: 8 }],
    ['HoursBought', { mint, coin: c, buyer: key(), start: 100, end: 3700, hours: 1, price: 20_000_000, total: 20_000_000, to_owner: 19_000_000, fee: 1_000_000, windows: 1, at: 100 }],
    ['FeesSynced', { mint, coin: c, amount: 1000, from: 40, to: 100, to_owner: 600, to_windows: 400, at: 100 }],
    ['Paid', { mint, coin: c, to: key(), amount: 400, kind: 'Holder', at: 101 }],
    ['WindowDone', { mint, coin: c, holder: key(), start: 100, end: 3700, earned: 400, at: 3800 }],
  ];
  const logs = enc.logs(a.programId, evs);
  const fromClient = a.eventsFromLogs(logs);
  assert.equal(fromClient.length, evs.length);
  assert.deepEqual(fromClient, viaIdl.eventsFromLogs(logs));
});

test('the client’s eligibility and the server’s fallback agree on every state', opts, async () => {
  const a = await loadFlipfee({ clientPath: [found] });
  const wallet = key();
  const vault = (m) => a.vaultPda(m);
  const curve = (creator, { complete = false, quote = DEFAULT, cashback = false } = {}) =>
    pump.account('BondingCurve', { virtual_token_reserves: 1, virtual_quote_reserves: 1, real_token_reserves: 1, real_quote_reserves: 1, token_total_supply: 1e15, complete, creator, is_mayhem_mode: false, is_cashback_coin: cashback, quote_mint: quote, creator_fee_bps: 30, can_edit_creator_fee: false, is_holder_reward: false });
  const sharing = (m, admin, shareholders, revoked) => pump.account('SharingConfig', { bump: 1, version: 2, status: 'Active', mint: m, admin, admin_revoked: revoked, shareholders: shareholders.map(([address, share_bps]) => ({ address, share_bps })) });
  const pool = (m, cc) => amm.account('Pool', { pool_bump: 1, index: 0, creator: key(), base_mint: m, quote_mint: 'So11111111111111111111111111111111111111112', lp_mint: key(), pool_base_token_account: key(), pool_quote_token_account: key(), lp_supply: 1, coin_creator: cc, is_mayhem_mode: false, is_cashback_coin: false, virtual_quote_reserves: 0n, creator_fee_bps: 0, can_edit_creator_fee: false, is_holder_reward: false });
  const states = {
    'ready-new': (m) => [[curveOf(m), PUMP, curve(wallet)]],
    'not-admin': (m) => [[curveOf(m), PUMP, curve(key())]],
    graduated: (m) => [[curveOf(m), PUMP, curve(key(), { complete: true })], [canonicalPoolOf(m), AMM, pool(m, wallet)]],
    ready: (m) => [[curveOf(m), PUMP, curve(sharingConfigOf(m))], [sharingConfigOf(m), FEES, sharing(m, wallet, [[wallet, 10_000]], false)]],
    almost: (m) => [[curveOf(m), PUMP, curve(sharingConfigOf(m))], [sharingConfigOf(m), FEES, sharing(m, wallet, [[vault(m), 10_000]], true)]],
    locked: (m) => [[curveOf(m), PUMP, curve(sharingConfigOf(m))], [sharingConfigOf(m), FEES, sharing(m, wallet, [[key(), 10_000]], true)]],
    takeover: (m) => [[curveOf(m), PUMP, curve(key())], [sharingConfigOf(m), FEES, sharing(m, wallet, [[wallet, 10_000]], false)]],
    usdc: (m) => [[curveOf(m), PUMP, curve(wallet, { quote: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' })]],
    cashback: (m) => [[curveOf(m), PUMP, curve(wallet, { cashback: true })]],
    'not-found': () => [],
  };
  for (const [name, make] of Object.entries(states)) {
    const m = key();
    const accounts = new Map(make(m).map(([k, owner, data]) => [k, { data, owner: new PublicKey(owner), lamports: 1, executable: false }]));
    const conn = {
      async getMultipleAccountsInfo(keys) {
        return keys.map((k) => accounts.get(k.toBase58()) ?? null);
      },
      async getAccountInfo(k) {
        return accounts.get(k.toBase58()) ?? null;
      },
    };
    const rpc = {
      async call(method, params) {
        const enc = (x) => (x ? { data: [x.data.toString('base64'), 'base64'] } : null);
        if (method === 'getMultipleAccounts') return { value: params[0].map((k) => enc(accounts.get(k))) };
        if (method === 'getAccountInfo') return { value: enc(accounts.get(params[0])) };
        throw new Error(method);
      },
    };
    const viaClient = await a.eligibility(conn, m, wallet);
    const viaChain = await eligibilityFromChain(rpc, m, wallet, { vault: vault(m), hasCoinAccount: false });
    assert.equal(viaClient.kind, viaChain.kind, name);
    assert.equal(viaClient.admin ?? null, viaChain.admin ?? null, `${name}: admin`);
    assert.equal(viaClient.graduated, viaChain.graduated, `${name}: graduated`);
    assert.doesNotThrow(() => JSON.stringify(viaClient), 'plain JSON (no bigint)');
  }
});
