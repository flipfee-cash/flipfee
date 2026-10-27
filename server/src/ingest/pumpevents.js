// pump.fun and PumpSwap trade events from transaction logs, with the exact creator fee of each trade.
//
// Both programs are Anchor programs: an event is a "Program data: <base64>" log line, 8 bytes of discriminator
// (sha256("event:<Name>")[0..8]) then the Borsh fields. Only data logged while the program itself runs counts: the
// parser follows the invoke stack, so another program cannot plant a fake trade in a transaction that touches a curve.
//
// pump (6EF8…F6P) TradeEvent, Borsh (little endian), from idl/pump.json of pump-fun/pump-public-docs:
//   0 disc[8] · 8 mint[32] · 40 sol_amount u64 · 48 token_amount u64 · 56 is_buy u8 · 57 user[32] · 89 timestamp i64
//   97 virtual_sol_reserves · 105 virtual_token_reserves · 113 real_sol_reserves · 121 real_token_reserves (u64)
//   129 fee_recipient[32] · 161 fee_basis_points u64 · 169 fee u64
//   177 creator[32] · 209 creator_fee_basis_points u64 · 217 creator_fee u64
//   225 track_volume u8 · 226 total_unclaimed_tokens · 234 total_claimed_tokens · 242 current_sol_volume u64
//   250 last_update_timestamp i64 · 258 ix_name string (u32 len + utf8), then (from the cursor):
//   mayhem_mode u8 · cashback_fee_basis_points u64 · cashback u64 · buyback_fee_basis_points u64 · buyback_fee u64
//   shareholders vec<{ address[32], share_bps u16 }> · quote_mint[32] · quote_amount u64 · virtual_quote_reserves u64
//   real_quote_reserves u64 · holder_rewards_bps u64 · holder_rewards u64
// `creator` is the bonding curve's creator: the coin's dev, or its pump_fees `sharing_config` PDA once the coin has
// fee sharing (then `shareholders` lists who the fee goes to). `creator_fee` is in the quote token's base units
// (lamports for SOL-paired coins, whose `quote_mint` is the default key 1111…1111 or wrapped SOL).
//
// PumpSwap (pAMM…EA) BuyEvent / SellEvent, from idl/pump_amm.json (both share the head):
//   8 timestamp i64 · 16 base_amount (out on a buy, in on a sell) · 24 max_quote_in / min_quote_out
//   32 user_base_token_reserves · 40 user_quote_token_reserves · 48 pool_base_token_reserves
//   56 pool_quote_token_reserves (both pool reserves before the trade) · 64 quote_amount (in / out)
//   72 lp_fee_basis_points · 80 lp_fee · 88 protocol_fee_basis_points · 96 protocol_fee
//   104 quote_amount_in_with_lp_fee / quote_amount_out_without_lp_fee · 112 user_quote_amount (in / out)
//   120 pool[32] · 152 user[32] · 184 user_base_token_account · 216 user_quote_token_account
//   248 protocol_fee_recipient · 280 protocol_fee_recipient_token_account
//   312 coin_creator[32] · 344 coin_creator_fee_basis_points u64 · 352 coin_creator_fee u64
// Base = the coin (6 decimals), quote = the pool's quote mint (wrapped SOL for SOL-paired coins: lamports).
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMP_FEES_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const DEFAULT_KEY = '11111111111111111111111111111111';

export const TRADE_DISC = Buffer.from('bddb7fd34ee661ee', 'hex');
export const SWAP_BUY_DISC = Buffer.from('67f4521f2cf57777', 'hex');
export const SWAP_SELL_DISC = Buffer.from('3e2f370aa503dc2a', 'hex');
export const COMPLETE_MIGRATION_DISC = Buffer.from('bde95db95c94ea94', 'hex');
export const DISTRIBUTE_DISC = Buffer.from('a537817004b3ca28', 'hex');

const PUMP_KEY = new PublicKey(PUMP_PROGRAM);
const AMM_KEY = new PublicKey(PUMPSWAP_PROGRAM);
const FEES_KEY = new PublicKey(PUMP_FEES_PROGRAM);

/** SOL-paired: the quote mint is the default key (pump's SOL coins) or wrapped SOL; unknown counts as SOL. */
export const isSolQuote = (q) => !q || q === DEFAULT_KEY || q === WSOL_MINT;

/** A forward-only Borsh reader that returns undefined past the end (older, shorter event versions). */
class Reader {
  constructor(buf, at = 0) {
    this.b = buf;
    this.o = at;
  }

  has(n) {
    return this.o + n <= this.b.length;
  }

  u8() {
    if (!this.has(1)) return undefined;
    return this.b[this.o++];
  }

  bool() {
    const v = this.u8();
    return v === undefined ? undefined : v === 1;
  }

  u16() {
    if (!this.has(2)) return undefined;
    const v = this.b.readUInt16LE(this.o);
    this.o += 2;
    return v;
  }

  u32() {
    if (!this.has(4)) return undefined;
    const v = this.b.readUInt32LE(this.o);
    this.o += 4;
    return v;
  }

  /** u64 as a Number (exact below 2^53: every amount here is far below). */
  u64() {
    if (!this.has(8)) return undefined;
    const v = this.b.readBigUInt64LE(this.o);
    this.o += 8;
    return Number(v);
  }

  i64() {
    if (!this.has(8)) return undefined;
    const v = this.b.readBigInt64LE(this.o);
    this.o += 8;
    return Number(v);
  }

  key() {
    if (!this.has(32)) return undefined;
    const v = bs58.encode(this.b.subarray(this.o, this.o + 32));
    this.o += 32;
    return v;
  }

  str(max = 64) {
    const n = this.u32();
    if (n === undefined || n > max || !this.has(n)) {
      this.o = this.b.length; // a bad length: nothing after it can be read
      return undefined;
    }
    const v = this.b.toString('utf8', this.o, this.o + n);
    this.o += n;
    return v;
  }

  shareholders() {
    const n = this.u32();
    if (n === undefined || n > 32 || !this.has(n * 34)) {
      this.o = this.b.length;
      return undefined;
    }
    const out = [];
    for (let i = 0; i < n; i++) out.push({ address: this.key(), shareBps: this.u16() });
    return out;
  }
}

/** The full pump.fun TradeEvent (amounts in base units: lamports / token atoms), or null. */
export function decodeTradeEvent(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 129 || !buf.subarray(0, 8).equals(TRADE_DISC)) return null;
  const r = new Reader(buf, 8);
  const ev = {
    mint: r.key(),
    solAmount: r.u64(),
    tokenAmount: r.u64(),
    isBuy: r.bool(),
    user: r.key(),
    timestamp: r.i64(),
    virtualSolReserves: r.u64(),
    virtualTokenReserves: r.u64(),
    realSolReserves: r.u64(),
    realTokenReserves: r.u64(),
    feeRecipient: r.key(),
    feeBasisPoints: r.u64(),
    fee: r.u64(),
    creator: r.key(),
    creatorFeeBasisPoints: r.u64(),
    creatorFee: r.u64(),
    trackVolume: r.bool(),
    totalUnclaimedTokens: r.u64(),
    totalClaimedTokens: r.u64(),
    currentSolVolume: r.u64(),
    lastUpdateTimestamp: r.i64(),
    ixName: r.str(),
  };
  Object.assign(ev, {
    mayhemMode: r.bool(),
    cashbackFeeBasisPoints: r.u64(),
    cashback: r.u64(),
    buybackFeeBasisPoints: r.u64(),
    buybackFee: r.u64(),
    shareholders: r.shareholders(),
    quoteMint: r.key(),
    quoteAmount: r.u64(),
    virtualQuoteReserves: r.u64(),
    realQuoteReserves: r.u64(),
    holderRewardsBps: r.u64(),
    holderRewards: r.u64(),
  });
  return ev;
}

/** A PumpSwap BuyEvent / SellEvent (amounts in base units), or null. */
export function decodeSwapEvent(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 184) return null;
  const d = buf.subarray(0, 8);
  const isBuy = d.equals(SWAP_BUY_DISC);
  if (!isBuy && !d.equals(SWAP_SELL_DISC)) return null;
  const r = new Reader(buf, 8);
  const ev = {
    isBuy,
    timestamp: r.i64(),
    baseAmount: r.u64(),
    quoteLimit: r.u64(),
    userBaseReserves: r.u64(),
    userQuoteReserves: r.u64(),
    poolBaseReserves: r.u64(),
    poolQuoteReserves: r.u64(),
    quoteAmount: r.u64(),
    lpFeeBasisPoints: r.u64(),
    lpFee: r.u64(),
    protocolFeeBasisPoints: r.u64(),
    protocolFee: r.u64(),
    quoteAmountWithLpFee: r.u64(),
    userQuoteAmount: r.u64(),
    pool: r.key(),
    user: r.key(),
    userBaseTokenAccount: r.key(),
    userQuoteTokenAccount: r.key(),
    protocolFeeRecipient: r.key(),
    protocolFeeRecipientTokenAccount: r.key(),
    coinCreator: r.key(),
    coinCreatorFeeBasisPoints: r.u64(),
    coinCreatorFee: r.u64(),
  };
  return ev;
}

/** pump CompletePumpAmmMigrationEvent: the coin left the curve for this PumpSwap pool. */
export function decodeMigrationEvent(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 + 32 * 2 + 24 + 32 + 8 + 32 || !buf.subarray(0, 8).equals(COMPLETE_MIGRATION_DISC)) return null;
  const r = new Reader(buf, 8);
  const ev = { user: r.key(), mint: r.key(), mintAmount: r.u64(), solAmount: r.u64(), poolMigrationFee: r.u64(), bondingCurve: r.key(), timestamp: r.i64(), pool: r.key() };
  ev.quoteMint = r.key();
  return ev;
}

/** pump DistributeCreatorFeesEvent: a sharing config's vault paid its shareholders (`distributed` in quote units). */
export function decodeDistributeEvent(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 + 8 + 32 * 4 || !buf.subarray(0, 8).equals(DISTRIBUTE_DISC)) return null;
  const r = new Reader(buf, 8);
  const ev = { timestamp: r.i64(), mint: r.key(), bondingCurve: r.key(), sharingConfig: r.key(), admin: r.key(), shareholders: r.shareholders(), distributed: r.u64() };
  ev.quoteMint = r.key();
  return ev;
}

/** Calls `fn(buffer)` for each "Program data:" line logged while `program` itself runs (the invoke stack). */
export function forProgramData(logs, program, fn) {
  const stack = [];
  for (const l of Array.isArray(logs) ? logs : []) {
    if (typeof l !== 'string') continue;
    let m = /^Program (\w+) invoke \[\d+\]$/.exec(l);
    if (m) {
      stack.push(m[1]);
      continue;
    }
    m = /^Program (\w+) (success|failed)/.exec(l);
    if (m) {
      if (stack[stack.length - 1] === m[1]) stack.pop();
      continue;
    }
    if (l.startsWith('Program data: ') && stack[stack.length - 1] === program) {
      let buf = null;
      try {
        buf = Buffer.from(l.slice(14), 'base64');
      } catch {
        buf = null;
      }
      if (buf) fn(buf);
    }
  }
}

/**
 * The trade record the server works with (one shape for both venues). Amounts in lamports (integers) and token atoms;
 * `fee` = the creator fee of this trade in the quote's base units; `sol` = the trade size in SOL (the curve's
 * sol_amount without fees; PumpSwap's quote amount).
 */
export function curveTrade(ev) {
  const sol = isSolQuote(ev.quoteMint);
  return {
    venue: 'curve',
    mint: ev.mint,
    isBuy: !!ev.isBuy,
    wallet: ev.user,
    ts: ev.timestamp,
    lamports: ev.solAmount ?? 0,
    tokens: ev.tokenAmount ?? 0,
    fee: ev.creatorFee ?? 0,
    feeBps: ev.creatorFeeBasisPoints ?? null,
    feeTo: ev.creator ?? null,
    shareholders: ev.shareholders ?? null,
    cashback: ev.cashback ?? 0,
    quoteMint: ev.quoteMint ?? null,
    solQuote: sol,
    vSol: ev.virtualSolReserves,
    vTokens: ev.virtualTokenReserves,
    realTokens: ev.realTokenReserves,
    mayhem: !!ev.mayhemMode,
    ix: ev.ixName ?? null,
  };
}

/** PumpSwap trade → the same shape (pool reserves after the trade for the price). `mint` comes from the pool map. */
export function swapTrade(ev, mint, quoteMint = null) {
  const baseAfter = ev.isBuy ? ev.poolBaseReserves - ev.baseAmount : ev.poolBaseReserves + ev.baseAmount;
  const quoteAfter = ev.isBuy ? ev.poolQuoteReserves + ev.quoteAmount : ev.poolQuoteReserves - ev.quoteAmount;
  return {
    venue: 'amm',
    mint,
    pool: ev.pool,
    isBuy: ev.isBuy,
    wallet: ev.user,
    ts: ev.timestamp,
    lamports: ev.quoteAmount ?? 0,
    tokens: ev.baseAmount ?? 0,
    fee: ev.coinCreatorFee ?? 0,
    feeBps: ev.coinCreatorFeeBasisPoints ?? null,
    feeTo: ev.coinCreator && ev.coinCreator !== DEFAULT_KEY ? ev.coinCreator : null,
    shareholders: null,
    cashback: 0,
    quoteMint,
    solQuote: isSolQuote(quoteMint),
    vSol: quoteAfter > 0 ? quoteAfter : ev.poolQuoteReserves,
    vTokens: baseAfter > 0 ? baseAfter : ev.poolBaseReserves,
    realTokens: null,
    mayhem: false,
    ix: null,
  };
}

/** Every pump.fun trade logged by the pump.fun program in one transaction's logs. */
export function tradesFromLogs(logs, program = PUMP_PROGRAM) {
  const out = [];
  forProgramData(logs, program, (buf) => {
    const ev = decodeTradeEvent(buf);
    if (ev) out.push(curveTrade(ev));
  });
  return out;
}

/** Every PumpSwap Buy/Sell event (raw decode, pool named) in one transaction's logs. */
export function swapsFromLogs(logs) {
  const out = [];
  forProgramData(logs, PUMPSWAP_PROGRAM, (buf) => {
    const ev = decodeSwapEvent(buf);
    if (ev) out.push(ev);
  });
  return out;
}

/** Migrations (curve → PumpSwap pool) logged by pump in one transaction. */
export function migrationsFromLogs(logs) {
  const out = [];
  forProgramData(logs, PUMP_PROGRAM, (buf) => {
    const ev = decodeMigrationEvent(buf);
    if (ev) out.push(ev);
  });
  return out;
}

const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];
const key = (s) => new PublicKey(s);

/** The bonding curve PDA of a pump.fun mint. */
export function curveOf(mint) {
  try {
    return pda([Buffer.from('bonding-curve'), key(mint).toBuffer()], PUMP_KEY).toBase58();
  } catch {
    return null;
  }
}

/** pump_fees sharing_config PDA of a mint. */
export function sharingConfigOf(mint) {
  try {
    return pda([Buffer.from('sharing-config'), key(mint).toBuffer()], FEES_KEY).toBase58();
  } catch {
    return null;
  }
}

/** pump creator vault of a creator (or of a sharing config): ["creator-vault", creator]. */
export function creatorVaultOf(creator) {
  return pda([Buffer.from('creator-vault'), key(creator).toBuffer()], PUMP_KEY).toBase58();
}

/** The canonical PumpSwap pool of a graduated pump coin: ["pool", 0u16, pool-authority(mint), mint, quote]. */
export function canonicalPoolOf(mint, quoteMint = WSOL_MINT) {
  try {
    const authority = pda([Buffer.from('pool-authority'), key(mint).toBuffer()], PUMP_KEY);
    const index = Buffer.alloc(2);
    return pda([Buffer.from('pool'), index, authority.toBuffer(), key(mint).toBuffer(), key(isSolQuote(quoteMint) ? WSOL_MINT : quoteMint).toBuffer()], AMM_KEY).toBase58();
  } catch {
    return null;
  }
}
