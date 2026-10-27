// pump.fun accounts read from chain (layouts from pump-fun/pump-public-docs idl/pump.json, pump_amm.json,
// pump_fees.json): BondingCurve, PumpSwap Pool, pump_fees SharingConfig. Used for the Hot list's fee-split state
// (one getMultipleAccounts per 100 coins), the dev page's chain search (a wallet's curves and sharing configs by
// getProgramAccounts with a memcmp filter), and as the eligibility fallback while the flipfee client is missing.
//
// BondingCurve: 8 disc · 8 virtual_token_reserves · 16 virtual_quote_reserves · 24 real_token_reserves
//   32 real_quote_reserves · 40 token_total_supply · 48 complete u8 · 49 creator[32] · 81 is_mayhem_mode
//   82 is_cashback_coin · 83 quote_mint[32] · 115 creator_fee_bps u64 · 123 can_edit_creator_fee · 124 is_holder_reward
//   (older curves end earlier: the missing fields read as their defaults)
// SharingConfig: 8 disc · 8 bump · 9 version · 10 status (0 Paused, 1 Active) · 11 mint[32] · 43 admin[32]
//   75 admin_revoked u8 · 76 shareholders vec<{ address[32], share_bps u16 }>
// Pool: 8 disc · 8 pool_bump · 9 index u16 · 11 creator · 43 base_mint · 75 quote_mint · 107 lp_mint
//   139 pool_base_token_account · 171 pool_quote_token_account · 203 lp_supply u64 · 211 coin_creator[32] …
import bs58 from 'bs58';
import { logError } from '../log.js';
import { DEFAULT_KEY, isSolQuote, PUMP_FEES_PROGRAM, PUMP_PROGRAM, sharingConfigOf, curveOf, canonicalPoolOf, WSOL_MINT as WSOL } from '../ingest/pumpevents.js';

export const CURVE_DISC = Buffer.from('17b7f83760d8ac60', 'hex');
export const SHARING_DISC = Buffer.from('d84a0900388c5d4b', 'hex');
export const POOL_DISC = Buffer.from('f19a6d0411b16dbc', 'hex');

const key = (b, o) => (o + 32 <= b.length ? bs58.encode(b.subarray(o, o + 32)) : null);

export function decodeCurve(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 81 || !buf.subarray(0, 8).equals(CURVE_DISC)) return null;
  const u = (o) => (o + 8 <= buf.length ? Number(buf.readBigUInt64LE(o)) : null);
  return {
    virtualTokenReserves: u(8),
    virtualQuoteReserves: u(16),
    realTokenReserves: u(24),
    realQuoteReserves: u(32),
    tokenTotalSupply: u(40),
    complete: buf[48] === 1,
    creator: key(buf, 49),
    mayhem: buf.length > 81 ? buf[81] === 1 : false,
    cashback: buf.length > 82 ? buf[82] === 1 : false,
    quoteMint: buf.length >= 115 ? key(buf, 83) : DEFAULT_KEY,
    creatorFeeBps: u(115),
    holderReward: buf.length > 124 ? buf[124] === 1 : false,
  };
}

export function decodeSharing(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 80 || !buf.subarray(0, 8).equals(SHARING_DISC)) return null;
  const n = buf.readUInt32LE(76);
  const shareholders = [];
  for (let i = 0; i < n && 80 + (i + 1) * 34 <= buf.length; i++) shareholders.push({ address: key(buf, 80 + i * 34), shareBps: buf.readUInt16LE(112 + i * 34) });
  return { version: buf[9], status: buf[10] === 1 ? 'Active' : 'Paused', mint: key(buf, 11), admin: key(buf, 43), revoked: buf[75] === 1, shareholders };
}

export function decodePool(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 243 || !buf.subarray(0, 8).equals(POOL_DISC)) return null;
  return { creator: key(buf, 11), baseMint: key(buf, 43), quoteMint: key(buf, 75), coinCreator: key(buf, 211) };
}

const data = (acc) => (acc?.data ? Buffer.from(acc.data[0], 'base64') : null);

/** Fee-split state of many coins at once: Map mint → { admin, revoked, shareholders, status } | null (no config). */
export async function readSharing(rpc, mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    const part = mints.slice(i, i + 100);
    const r = await rpc.call('getMultipleAccounts', [part.map(sharingConfigOf), { encoding: 'base64', commitment: 'confirmed' }]);
    part.forEach((m, k) => out.set(m, decodeSharing(data(r?.value?.[k]))));
  }
  return out;
}

/**
 * The chain's view of a coin for a wallet (DESIGN §2.4), the same rules as the flipfee client's `eligibility()` (used
 * when the client is missing): `{ kind, admin, graduated, quoteMint, registered, reason? }` with kind one of
 * ready-new · ready · almost · locked · flipfee · usdc · not-admin · unsupported (cashback / holder-rewards coin, or
 * fee sharing paused) · not-found (no pump curve). `vault` = the coin's flipfee vault, `hasCoinAccount` = its flipfee
 * Coin account exists.
 */
export async function eligibilityFromChain(rpc, mint, wallet, { vault, hasCoinAccount = false }) {
  const sharingAddr = sharingConfigOf(mint);
  const poolAddr = canonicalPoolOf(mint);
  const r = await rpc.call('getMultipleAccounts', [[curveOf(mint), sharingAddr, poolAddr], { encoding: 'base64', commitment: 'confirmed' }]);
  const curve = decodeCurve(data(r?.value?.[0]));
  const sharing = decodeSharing(data(r?.value?.[1]));
  const pool = decodePool(data(r?.value?.[2]));
  const base = { admin: null, graduated: false, quoteMint: WSOL, sharingConfig: sharingAddr, vault: vault ?? null, registered: !!hasCoinAccount };
  if (!curve) return { ...base, kind: 'not-found' };
  const e = {
    ...base,
    graduated: curve.complete,
    quoteMint: isSolQuote(curve.quoteMint) ? WSOL : curve.quoteMint,
    admin: sharing ? sharing.admin : curve.complete && pool ? pool.coinCreator : curve.creator,
  };
  if (hasCoinAccount) return { ...e, kind: 'flipfee' };
  if (!isSolQuote(curve.quoteMint)) return { ...e, kind: 'usdc' };
  if (curve.cashback) return { ...e, kind: 'unsupported', reason: 'cashback coin: its creator fee goes to traders' };
  if (curve.holderReward) return { ...e, kind: 'unsupported', reason: 'holder-rewards coin: its creator fee goes to holders' };
  if (!sharing) return { ...e, kind: e.admin === wallet ? 'ready-new' : 'not-admin' };
  if (curve.creator !== sharingAddr || (curve.complete && pool && pool.coinCreator !== sharingAddr)) return { ...e, kind: 'locked', reason: 'the coin creator no longer points at its sharing config' };
  if (sharing.status !== 'Active') return { ...e, kind: 'unsupported', reason: 'pump.fun paused fee sharing of this coin' };
  const toVault = !!vault && sharing.shareholders.length === 1 && sharing.shareholders[0].address === vault && sharing.shareholders[0].shareBps === 10_000;
  if (sharing.revoked) return toVault ? { ...e, kind: sharing.admin === wallet ? 'almost' : 'not-admin' } : { ...e, kind: 'locked' };
  return { ...e, kind: sharing.admin === wallet ? 'ready' : 'not-admin' };
}

/**
 * Coins a wallet controls on chain: pump curves whose creator is the wallet (the mint comes from the curve's token
 * account) and sharing configs whose admin is the wallet. Two filtered getProgramAccounts calls (fast on mainnet's
 * public RPC: indexed by memcmp), then one getTokenAccountsByOwner per new curve (capped).
 */
export async function chainCoinsOf(rpc, wallet, { maxCurves = 10, knownCurves = new Set() } = {}) {
  const mints = new Set();
  const fail = (what) => (e) => {
    logError(`dev.chain.${what}.fail`, e);
    return [];
  };
  const cfgs = await rpc.call('getProgramAccounts', [PUMP_FEES_PROGRAM, { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: bs58.encode(SHARING_DISC) } }, { memcmp: { offset: 43, bytes: wallet } }], dataSlice: { offset: 11, length: 32 } }]).catch(fail('sharing'));
  for (const a of cfgs ?? []) mints.add(bs58.encode(Buffer.from(a.account.data[0], 'base64')));
  const curves = await rpc.call('getProgramAccounts', [PUMP_PROGRAM, { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: bs58.encode(CURVE_DISC) } }, { memcmp: { offset: 49, bytes: wallet } }], dataSlice: { offset: 0, length: 0 } }]).catch(fail('curves'));
  // curves the pump.fun API already named need no lookup
  for (const a of (curves ?? []).filter((x) => !knownCurves.has(x.pubkey)).slice(0, maxCurves)) {
    for (const program of ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']) {
      const r = await rpc.call('getTokenAccountsByOwner', [a.pubkey, { programId: program }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => null);
      const mint = r?.value?.[0]?.account?.data?.parsed?.info?.mint;
      if (mint) {
        mints.add(mint);
        break;
      }
    }
  }
  return [...mints];
}

/**
 * pump's creator-fee rates from chain (pump_fees FeeConfig PDAs ["fee_config", program]): the curve's flat rate and
 * PumpSwap's market-cap tiers → { curve, amm: [{ thresholdSol, creator }] }. FeeConfig: 8 disc · bump u8 · admin[32]
 * · flat_fees { lp, protocol, creator: u64 } · fee_tiers vec<{ threshold u128 (lamports), fees }> · …
 */
export async function readTiers(rpc) {
  const { PublicKey } = await import('@solana/web3.js');
  const fees = new PublicKey(PUMP_FEES_PROGRAM);
  const pdaOf = (program) => PublicKey.findProgramAddressSync([Buffer.from('fee_config'), new PublicKey(program).toBuffer()], fees)[0].toBase58();
  const r = await rpc.call('getMultipleAccounts', [[pdaOf(PUMP_PROGRAM), pdaOf('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')], { encoding: 'base64', commitment: 'confirmed' }]);
  const parse = (acc) => {
    const b = data(acc);
    if (!b || b.length < 8 + 1 + 32 + 24 + 4) return null;
    let o = 8 + 1 + 32;
    const flat = Number(b.readBigUInt64LE(o + 16));
    o += 24;
    const n = b.readUInt32LE(o);
    o += 4;
    const tiers = [];
    for (let i = 0; i < n && o + 40 <= b.length; i++) {
      const th = b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
      tiers.push({ thresholdSol: Number(th) / 1e9, creator: Number(b.readBigUInt64LE(o + 32)) });
      o += 40;
    }
    return { flat, tiers };
  };
  const curve = parse(r?.value?.[0]);
  const amm = parse(r?.value?.[1]);
  if (!amm?.tiers?.length) return null;
  return { curve: curve?.tiers?.[0]?.creator ?? curve?.flat ?? 30, amm: amm.tiers };
}

/**
 * Name, symbol and uri from a Token-2022 mint's TokenMetadata extension (pump's create_v2 coins carry it), or null.
 * Mint layout: 82 bytes of base mint, padding to 165, account type (1 = mint) at 165, then TLV entries
 * { type u16, length u16, value } from 166; TokenMetadata is type 19: update_authority[32] · mint[32] · name ·
 * symbol · uri (u32 length + utf8 each) · additional_metadata.
 */
export function token2022Meta(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 170 || buf[165] !== 1) return null;
  let o = 166;
  while (o + 4 <= buf.length) {
    const type = buf.readUInt16LE(o);
    const len = buf.readUInt16LE(o + 2);
    const v = o + 4;
    if (type === 19 && v + 64 + 12 <= buf.length) {
      let p = v + 64;
      const str = () => {
        const n = buf.readUInt32LE(p);
        if (n > 200 || p + 4 + n > buf.length) throw new RangeError('bad metadata string');
        const s = buf.toString('utf8', p + 4, p + 4 + n);
        p += 4 + n;
        return s;
      };
      try {
        return { name: str(), symbol: str(), uri: str() };
      } catch {
        return null;
      }
    }
    if (type === 0 && len === 0) break;
    o = v + len;
  }
  return null;
}

/** Map mint → { name, symbol, uri } for Token-2022 mints with metadata (one getMultipleAccounts per 100 mints). */
export async function readMintMeta(rpc, mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    const part = mints.slice(i, i + 100);
    const r = await rpc.call('getMultipleAccounts', [part, { encoding: 'base64', commitment: 'confirmed' }]);
    part.forEach((m, k) => {
      const meta = token2022Meta(data(r?.value?.[k]));
      if (meta) out.set(m, meta);
    });
  }
  return out;
}
