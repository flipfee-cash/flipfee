// The chain's eligibility of a coin for a wallet (DESIGN §2.4), as the server computes it when the flipfee client is
// missing (src/chain/pumpchain.js), on pump accounts encoded with pump's own IDL layouts; and the pump account
// decoders the Hot list and the dev page use.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { decodeCurve, decodeSharing, eligibilityFromChain, readSharing } from '../src/chain/pumpchain.js';
import { canonicalPoolOf, curveOf, sharingConfigOf } from '../src/ingest/pumpevents.js';
import { IdlEncoder } from './helpers/encode.js';

const sub = JSON.parse(readFileSync(new URL('./fixtures/pump-idl-subset.json', import.meta.url), 'utf8'));
const pump = new IdlEncoder(sub.pump);
const amm = new IdlEncoder(sub.pump_amm);
const key = () => Keypair.generate().publicKey.toBase58();
const DEFAULT = '11111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const curve = (creator, { complete = false, quote = DEFAULT, cashback = false } = {}) =>
  pump.account('BondingCurve', { virtual_token_reserves: 1, virtual_quote_reserves: 1, real_token_reserves: 1, real_quote_reserves: 1, token_total_supply: 1e15, complete, creator, is_mayhem_mode: false, is_cashback_coin: cashback, quote_mint: quote, creator_fee_bps: 30, can_edit_creator_fee: false, is_holder_reward: false });
const sharing = (mint, admin, shareholders, revoked) => pump.account('SharingConfig', { bump: 1, version: 2, status: 'Active', mint, admin, admin_revoked: revoked, shareholders: shareholders.map(([address, share_bps]) => ({ address, share_bps })) });
const pool = (mint, coinCreator) =>
  amm.account('Pool', { pool_bump: 1, index: 0, creator: key(), base_mint: mint, quote_mint: 'So11111111111111111111111111111111111111112', lp_mint: key(), pool_base_token_account: key(), pool_quote_token_account: key(), lp_supply: 1, coin_creator: coinCreator, is_mayhem_mode: false, is_cashback_coin: false, virtual_quote_reserves: 0n, creator_fee_bps: 0, can_edit_creator_fee: false, is_holder_reward: false });

function chain(accounts) {
  const enc = (b) => (b ? { data: [b.toString('base64'), 'base64'] } : null);
  return {
    async call(method, params) {
      if (method === 'getMultipleAccounts') return { value: params[0].map((k) => enc(accounts.get(k))) };
      if (method === 'getAccountInfo') return { value: enc(accounts.get(params[0])) };
      throw new Error(method);
    },
  };
}

test('every eligibility state of DESIGN §2.4', async () => {
  const wallet = key();
  const vault = key();
  const cases = [];
  const add = (name, setup, expect, opts = {}) => cases.push({ name, setup, expect, opts });
  add('no sharing config, the wallet created the curve', (m) => [[curveOf(m), curve(wallet)]], 'ready-new');
  add('no sharing config, another creator', (m) => [[curveOf(m), curve(key())]], 'not-admin');
  add('graduated: the pool’s coin creator counts', (m) => [[curveOf(m), curve(key(), { complete: true })], [canonicalPoolOf(m), pool(m, wallet)]], 'ready-new');
  add('a sharing config the wallet still administers', (m) => [[curveOf(m), curve(sharingConfigOf(m))], [sharingConfigOf(m), sharing(m, wallet, [[wallet, 10_000]], false)]], 'ready');
  add('split already 100% to the flipfee vault', (m) => [[curveOf(m), curve(sharingConfigOf(m))], [sharingConfigOf(m), sharing(m, wallet, [[vault, 10_000]], true)]], 'almost');
  add('split locked to someone else', (m) => [[curveOf(m), curve(sharingConfigOf(m))], [sharingConfigOf(m), sharing(m, wallet, [[key(), 9_000], [wallet, 1_000]], true)]], 'locked');
  add('USDC-paired', (m) => [[curveOf(m), curve(wallet, { quote: USDC })]], 'usdc');
  add('already on flipfee', (m) => [[curveOf(m), curve(sharingConfigOf(m))], [sharingConfigOf(m), sharing(m, wallet, [[vault, 10_000]], true)]], 'flipfee', { hasCoinAccount: true });
  add('not a pump.fun coin', () => [], 'not-found');
  add('a cashback coin', (m) => [[curveOf(m), curve(wallet, { cashback: true })]], 'unsupported');
  add('a takeover: the curve creator left its sharing config', (m) => [[curveOf(m), curve(key())], [sharingConfigOf(m), sharing(m, wallet, [[wallet, 10_000]], false)]], 'locked');
  add('the split is the vault but another wallet administers it', (m) => [[curveOf(m), curve(sharingConfigOf(m))], [sharingConfigOf(m), sharing(m, key(), [[vault, 10_000]], true)]], 'not-admin');
  for (const c of cases) {
    const m = key();
    const r = await eligibilityFromChain(chain(new Map(c.setup(m))), m, wallet, { vault, ...c.opts });
    assert.equal(r.kind, c.expect, c.name);
  }
  const m = key();
  const r = await eligibilityFromChain(chain(new Map([[curveOf(m), curve(wallet, { complete: true })], [canonicalPoolOf(m), pool(m, key())]])), m, wallet, { vault });
  assert.equal(r.kind, 'not-admin', 'graduated: the pool’s coin creator decides, not the old curve creator');
  assert.equal(r.graduated, true);
  assert.equal(r.quoteMint, 'So11111111111111111111111111111111111111112');
});

test('pump account decoders and the batched fee-split read', async () => {
  const m = key();
  const admin = key();
  const c = decodeCurve(curve(admin, { complete: true }));
  assert.equal(c.creator, admin);
  assert.equal(c.complete, true);
  assert.equal(c.quoteMint, DEFAULT);
  assert.equal(c.creatorFeeBps, 30);
  const s = decodeSharing(sharing(m, admin, [[admin, 9_000], [key(), 1_000]], true));
  assert.equal(s.mint, m);
  assert.equal(s.admin, admin);
  assert.equal(s.revoked, true);
  assert.equal(s.status, 'Active');
  assert.equal(s.shareholders.length, 2);
  // a curve from before the newer fields: the missing ones read as defaults
  const short = curve(admin).subarray(0, 81);
  assert.equal(decodeCurve(short).quoteMint, DEFAULT);
  const r = await readSharing(chain(new Map([[sharingConfigOf(m), sharing(m, admin, [[admin, 10_000]], false)]])), [m, key()]);
  assert.equal(r.get(m).admin, admin);
  assert.equal([...r.values()][1], null);
});
