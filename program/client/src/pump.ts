// pump.fun accounts and the pump.fun instructions flipfee needs (SOL-paired coins). Account lists follow
// pump-public-docs idl/*.json (2026-10) plus what the mainnet programs require beyond the docs (marked "not in the
// docs"); every builder here runs against the mainnet binaries in the program's tests.

import { Buffer } from 'buffer';
import { type Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';

import { type Address, Reader, Writer, bytesEqual, toPublicKey } from './codec.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DEFAULT_PUBKEY,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEES_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from './constants.js';
import {
  findAmmCreatorVaultAuthorityPda,
  findBondingCurvePda,
  findCanonicalPoolPda,
  findEventAuthorityPda,
  findFeeConfigPda,
  findPumpCreatorVaultPda,
  findPumpGlobalPda,
  findSharingConfigPda,
  getAta,
} from './pda.js';

export const PUMP_DISCRIMINATORS = {
  BondingCurve: [23, 183, 248, 55, 96, 216, 172, 96],
  SharingConfig: [216, 74, 9, 0, 56, 140, 93, 75],
  Pool: [241, 154, 109, 4, 17, 177, 109, 188],
  create_fee_sharing_config: [195, 78, 86, 76, 111, 52, 251, 213],
  update_fee_shares: [189, 13, 136, 99, 187, 164, 237, 35],
  update_fee_shares_v2: [111, 251, 49, 6, 78, 78, 106, 18],
  distribute_creator_fees_v2: [255, 203, 19, 79, 244, 68, 8, 159],
  get_minimum_distributable_fee: [117, 225, 127, 202, 134, 95, 68, 35],
  transfer_creator_fees_to_pump_v2: [1, 33, 78, 185, 33, 67, 44, 92],
  create_v2: [214, 144, 76, 236, 95, 139, 49, 180],
  buy_v2: [184, 23, 238, 97, 103, 197, 211, 61],
  sell_v2: [93, 246, 130, 60, 231, 233, 64, 178],
} as const;

// ── accounts ──

export interface BondingCurveAccount {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  /** The curve sold out: the coin trades on PumpSwap. */
  complete: boolean;
  /** Where the creator fee goes (the sharing config once fee sharing is set up). */
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** `PublicKey.default` on a SOL-paired coin. */
  quoteMint: PublicKey;
  creatorFeeBps: bigint;
  isHolderReward: boolean;
}

export interface Shareholder {
  address: PublicKey;
  shareBps: number;
}

export interface SharingConfigAccount {
  bump: number;
  version: number;
  status: 'Paused' | 'Active';
  mint: PublicKey;
  /** Kept after the split is final (mainnet, 2026-10): the key that set it. */
  admin: PublicKey;
  adminRevoked: boolean;
  shareholders: Shareholder[];
}

export interface PoolAccount {
  poolBump: number;
  index: number;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  lpSupply: bigint;
  /** Where AMM creator fees go (the sharing config once fee sharing is set up). */
  coinCreator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  isHolderReward: boolean;
}

function check(data: Uint8Array, disc: readonly number[], name: string): void {
  if (data.length < 8 || !bytesEqual(data.subarray(0, 8), disc)) throw new TypeError(`not a pump ${name} account`);
}
const keyAt = (d: Uint8Array, off: number): PublicKey =>
  d.length >= off + 32 ? new PublicKey(d.subarray(off, off + 32)) : DEFAULT_PUBKEY;
const flagAt = (d: Uint8Array, off: number): boolean => d.length > off && d[off] !== 0;

/** pump `BondingCurve`; missing trailing fields (older, shorter accounts) read as defaults. */
export function decodeBondingCurve(data: Uint8Array): BondingCurveAccount {
  check(data, PUMP_DISCRIMINATORS.BondingCurve, 'BondingCurve');
  const r = new Reader(data, 8);
  const out = {
    virtualTokenReserves: r.u64(),
    virtualQuoteReserves: r.u64(),
    realTokenReserves: r.u64(),
    realQuoteReserves: r.u64(),
    tokenTotalSupply: r.u64(),
    complete: r.bool(),
    creator: r.pubkey(),
  };
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    ...out,
    isMayhemMode: flagAt(data, 81),
    isCashbackCoin: flagAt(data, 82),
    quoteMint: keyAt(data, 83),
    creatorFeeBps: data.length >= 123 ? v.getBigUint64(115, true) : 0n,
    isHolderReward: flagAt(data, 124),
  };
}

export function decodeSharingConfig(data: Uint8Array): SharingConfigAccount {
  check(data, PUMP_DISCRIMINATORS.SharingConfig, 'SharingConfig');
  const r = new Reader(data, 8);
  const bump = r.u8();
  const version = r.u8();
  const status = r.u8();
  const mint = r.pubkey();
  const admin = r.pubkey();
  const adminRevoked = r.bool();
  const n = r.u32();
  if (n > 32) throw new RangeError(`sharing config lists ${n} shareholders`);
  const shareholders: Shareholder[] = [];
  for (let i = 0; i < n; i++) shareholders.push({ address: r.pubkey(), shareBps: r.u16() });
  return { bump, version, status: status === 1 ? 'Active' : 'Paused', mint, admin, adminRevoked, shareholders };
}

/** PumpSwap `Pool`; missing trailing fields read as defaults. */
export function decodePool(data: Uint8Array): PoolAccount {
  check(data, PUMP_DISCRIMINATORS.Pool, 'Pool');
  const r = new Reader(data, 8);
  return {
    poolBump: r.u8(),
    index: r.u16(),
    creator: r.pubkey(),
    baseMint: r.pubkey(),
    quoteMint: r.pubkey(),
    lpMint: r.pubkey(),
    poolBaseTokenAccount: r.pubkey(),
    poolQuoteTokenAccount: r.pubkey(),
    lpSupply: r.u64(),
    coinCreator: r.pubkey(),
    isMayhemMode: flagAt(data, 243),
    isCashbackCoin: flagAt(data, 244),
    isHolderReward: flagAt(data, 270),
  };
}

export async function fetchBondingCurve(conn: Connection, mint: Address): Promise<BondingCurveAccount | null> {
  const info = await conn.getAccountInfo(findBondingCurvePda(mint)[0], 'confirmed');
  return info && info.owner.equals(PUMP_PROGRAM_ID) ? decodeBondingCurve(info.data) : null;
}

export async function fetchSharingConfig(conn: Connection, mint: Address): Promise<SharingConfigAccount | null> {
  const info = await conn.getAccountInfo(findSharingConfigPda(mint)[0], 'confirmed');
  return info && info.owner.equals(PUMP_FEES_PROGRAM_ID) ? decodeSharingConfig(info.data) : null;
}

export async function fetchCanonicalPool(conn: Connection, mint: Address): Promise<PoolAccount | null> {
  const info = await conn.getAccountInfo(findCanonicalPoolPda(mint)[0], 'confirmed');
  return info && info.owner.equals(PUMP_AMM_PROGRAM_ID) ? decodePool(info.data) : null;
}

/** True when the curve's quote is SOL (`PublicKey.default` or WSOL). */
export function isSolPaired(curve: BondingCurveAccount): boolean {
  return curve.quoteMint.equals(DEFAULT_PUBKEY) || curve.quoteMint.equals(WSOL_MINT);
}

// ── instructions ──

const w = (k: Address) => ({ pubkey: toPublicKey(k), isSigner: false, isWritable: true });
const r = (k: Address) => ({ pubkey: toPublicKey(k), isSigner: false, isWritable: false });
const ws = (k: Address) => ({ pubkey: toPublicKey(k), isSigner: true, isWritable: true });
const ev = (p: PublicKey) => findEventAuthorityPda(p)[0];

function sharesData(disc: readonly number[], next: { address: Address; shareBps: number }[]): Uint8Array {
  const wr = new Writer(8 + 4 + next.length * 34).bytes(disc).u32(next.length);
  for (const s of next) wr.pubkey(s.address).u16(s.shareBps);
  return wr.done();
}

/**
 * Pump Fees `create_fee_sharing_config` (signer = the coin creator; pays the 1024-byte sharing config and pump's
 * growth of the curve account). `pool` = the canonical pool of a graduated coin (pump requires it then).
 */
export function createFeeSharingConfigIx(a: { creator: Address; mint: Address; pool?: Address | null }): TransactionInstruction {
  const keys = [
    r(ev(PUMP_FEES_PROGRAM_ID)),
    r(PUMP_FEES_PROGRAM_ID),
    ws(a.creator),
    r(findPumpGlobalPda()[0]),
    r(a.mint),
    w(findSharingConfigPda(a.mint)[0]),
    r(SYSTEM_PROGRAM_ID),
    w(findBondingCurvePda(a.mint)[0]),
    r(PUMP_PROGRAM_ID),
    r(ev(PUMP_PROGRAM_ID)),
    // optional accounts: the program's own id means "none"
    ...(a.pool
      ? [w(a.pool), r(PUMP_AMM_PROGRAM_ID), r(ev(PUMP_AMM_PROGRAM_ID))]
      : [r(PUMP_FEES_PROGRAM_ID), r(PUMP_FEES_PROGRAM_ID), r(PUMP_FEES_PROGRAM_ID)]),
  ];
  return new TransactionInstruction({
    programId: PUMP_FEES_PROGRAM_ID,
    keys,
    data: Buffer.from(PUMP_DISCRIMINATORS.create_fee_sharing_config),
  });
}

interface UpdateSharesArgs {
  /** `sharing_config.admin`. */
  authority: Address;
  mint: Address;
  /** The sharing config's current shareholders, in order (pump pays them what is pending first). */
  current: Address[];
  /** The final split (≤ 10 entries, share_bps > 0, Σ = 10000). */
  next: { address: Address; shareBps: number }[];
  /** Canonical pool of a graduated coin: pump reads it as the LAST remaining account (not in the docs). */
  pool?: Address | null;
}

function updateSharesKeys(a: UpdateSharesArgs, v2: boolean) {
  const sc = findSharingConfigPda(a.mint)[0];
  const cv = findPumpCreatorVaultPda(sc)[0];
  const ammAuth = findAmmCreatorVaultAuthorityPda(sc)[0];
  const keys = [
    r(ev(PUMP_FEES_PROGRAM_ID)),
    r(PUMP_FEES_PROGRAM_ID),
    v2 ? ws(a.authority) : { pubkey: toPublicKey(a.authority), isSigner: true, isWritable: false },
    r(findPumpGlobalPda()[0]),
    r(a.mint),
    w(sc),
    r(findBondingCurvePda(a.mint)[0]),
    w(cv),
    ...(v2 ? [w(getAta(cv, WSOL_MINT))] : []),
    r(SYSTEM_PROGRAM_ID),
    r(PUMP_PROGRAM_ID),
    r(ev(PUMP_PROGRAM_ID)),
    r(PUMP_AMM_PROGRAM_ID),
    r(ev(PUMP_AMM_PROGRAM_ID)),
    r(WSOL_MINT),
    r(TOKEN_PROGRAM_ID),
    r(ASSOCIATED_TOKEN_PROGRAM_ID),
    w(ammAuth),
    w(getAta(ammAuth, WSOL_MINT)),
    ...a.current.map(w),
    ...(a.pool ? [w(a.pool)] : []),
  ];
  return keys;
}

/** Pump Fees `update_fee_shares_v2`: sets the final split once and revokes the admin (who stays recorded). */
export function updateFeeSharesV2Ix(a: UpdateSharesArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_FEES_PROGRAM_ID,
    keys: updateSharesKeys(a, true),
    data: Buffer.from(sharesData(PUMP_DISCRIMINATORS.update_fee_shares_v2, a.next)),
  });
}

/** Pump Fees `update_fee_shares` (v1, WSOL only): what pump.fun's site sent through 2026-09; also the update that
 * works on a version-1 sharing config (`update_fee_shares_v2` requires version ≠ 1). */
export function updateFeeSharesIx(a: UpdateSharesArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_FEES_PROGRAM_ID,
    keys: updateSharesKeys(a, false),
    data: Buffer.from(sharesData(PUMP_DISCRIMINATORS.update_fee_shares, a.next)),
  });
}

/**
 * pump `distribute_creator_fees_v2` (permissionless, SOL-paired): pays the creator vault of the sharing config to
 * its shareholders (for a flipfee coin: `[vault]`). Below pump's minimum it succeeds and moves nothing.
 */
export function distributeCreatorFeesV2Ix(a: { payer: Address; mint: Address; shareholders: Address[] }): TransactionInstruction {
  const sc = findSharingConfigPda(a.mint)[0];
  const cv = findPumpCreatorVaultPda(sc)[0];
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      ws(a.payer),
      r(a.mint),
      r(findBondingCurvePda(a.mint)[0]),
      r(sc),
      w(cv),
      r(SYSTEM_PROGRAM_ID),
      r(ev(PUMP_PROGRAM_ID)),
      r(PUMP_PROGRAM_ID),
      w(getAta(cv, WSOL_MINT)),
      r(WSOL_MINT),
      r(TOKEN_PROGRAM_ID),
      r(ASSOCIATED_TOKEN_PROGRAM_ID),
      ...a.shareholders.map(w),
    ],
    data: Buffer.from([...PUMP_DISCRIMINATORS.distribute_creator_fees_v2, 0]), // initialize_ata = false
  });
}

/** pump `get_minimum_distributable_fee` (simulate it; decode the return data with `decodeMinimumDistributableFee`). */
export function getMinimumDistributableFeeIx(a: { mint: Address; shareholders: Address[] }): TransactionInstruction {
  const sc = findSharingConfigPda(a.mint)[0];
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      r(a.mint),
      r(findBondingCurvePda(a.mint)[0]),
      r(sc),
      r(findPumpCreatorVaultPda(sc)[0]),
      ...a.shareholders.map(r),
    ],
    data: Buffer.from(PUMP_DISCRIMINATORS.get_minimum_distributable_fee),
  });
}

export function decodeMinimumDistributableFee(returnData: Uint8Array): {
  minimumRequired: bigint;
  distributableFees: bigint;
  canDistribute: boolean;
} {
  const r = new Reader(returnData);
  return { minimumRequired: r.u64(), distributableFees: r.u64(), canDistribute: r.bool() };
}

/** PumpSwap `transfer_creator_fees_to_pump_v2` (permissionless, SOL-paired): AMM creator fees (WSOL) → pump's creator
 * vault, so `distribute_creator_fees_v2` can pay them. `coinCreator` = `pool.coin_creator` (the sharing config). */
export function transferCreatorFeesToPumpV2Ix(a: { payer: Address; coinCreator: Address }): TransactionInstruction {
  const auth = findAmmCreatorVaultAuthorityPda(a.coinCreator)[0];
  const pcv = findPumpCreatorVaultPda(a.coinCreator)[0];
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      ws(a.payer),
      r(WSOL_MINT),
      r(TOKEN_PROGRAM_ID),
      r(SYSTEM_PROGRAM_ID),
      r(ASSOCIATED_TOKEN_PROGRAM_ID),
      r(a.coinCreator),
      w(auth),
      w(getAta(auth, WSOL_MINT)),
      w(pcv),
      w(getAta(pcv, WSOL_MINT)),
      r(ev(PUMP_AMM_PROGRAM_ID)),
      r(PUMP_AMM_PROGRAM_ID),
    ],
    data: Buffer.from(PUMP_DISCRIMINATORS.transfer_creator_fees_to_pump_v2),
  });
}

// ── coin creation and curve trades (for local tests and tools; the app does not trade) ──

export interface PumpTradeRecipients {
  /** One of `Global.fee_recipients` (normal coins). */
  feeRecipient: Address;
  /** One of `Global.buyback_fee_recipients`. */
  buybackFeeRecipient: Address;
}

/** pump `create_v2`: a SOL-paired Token-2022 coin (not mayhem, not cashback, not holder-rewards). */
export function pumpCreateV2Ix(a: { mint: Address; user: Address; creator: Address; name: string; symbol: string; uri: string }): TransactionInstruction {
  const MAYHEM = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');
  const enc = new TextEncoder();
  const [name, symbol, uri] = [enc.encode(a.name), enc.encode(a.symbol), enc.encode(a.uri)];
  const data = new Writer(8 + 12 + name.length + symbol.length + uri.length + 32 + 2)
    .bytes(PUMP_DISCRIMINATORS.create_v2)
    .u32(name.length)
    .bytes(name)
    .u32(symbol.length)
    .bytes(symbol)
    .u32(uri.length)
    .bytes(uri)
    .pubkey(a.creator)
    .bool(false) // is_mayhem_mode
    .bool(false) // is_cashback_enabled: OptionBool(false)
    .done();
  const bc = findBondingCurvePda(a.mint)[0];
  const solVault = PublicKey.findProgramAddressSync([new TextEncoder().encode('sol-vault')], MAYHEM)[0];
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      ws(a.mint),
      r(PublicKey.findProgramAddressSync([new TextEncoder().encode('mint-authority')], PUMP_PROGRAM_ID)[0]),
      w(bc),
      w(getAta(bc, a.mint, TOKEN_2022_PROGRAM_ID)),
      r(findPumpGlobalPda()[0]),
      ws(a.user),
      r(SYSTEM_PROGRAM_ID),
      r(TOKEN_2022_PROGRAM_ID),
      r(ASSOCIATED_TOKEN_PROGRAM_ID),
      w(MAYHEM),
      r(PublicKey.findProgramAddressSync([new TextEncoder().encode('global-params')], MAYHEM)[0]),
      w(solVault),
      w(PublicKey.findProgramAddressSync([new TextEncoder().encode('mayhem-state'), toPublicKey(a.mint).toBytes()], MAYHEM)[0]),
      w(getAta(solVault, a.mint, TOKEN_2022_PROGRAM_ID)),
      r(ev(PUMP_PROGRAM_ID)),
      r(PUMP_PROGRAM_ID),
    ],
    data: Buffer.from(data),
  });
}

function tradeKeys(rc: PumpTradeRecipients, mint: Address, user: Address, curveCreator: Address, buy: boolean) {
  const bc = findBondingCurvePda(mint)[0];
  const cv = findPumpCreatorVaultPda(curveCreator)[0];
  const uva = PublicKey.findProgramAddressSync([new TextEncoder().encode('user_volume_accumulator'), toPublicKey(user).toBytes()], PUMP_PROGRAM_ID)[0];
  return [
    r(findPumpGlobalPda()[0]),
    r(mint),
    r(WSOL_MINT),
    r(TOKEN_2022_PROGRAM_ID),
    r(TOKEN_PROGRAM_ID),
    r(ASSOCIATED_TOKEN_PROGRAM_ID),
    w(rc.feeRecipient),
    w(getAta(rc.feeRecipient, WSOL_MINT)),
    w(rc.buybackFeeRecipient),
    w(getAta(rc.buybackFeeRecipient, WSOL_MINT)),
    w(bc),
    w(getAta(bc, mint, TOKEN_2022_PROGRAM_ID)),
    w(getAta(bc, WSOL_MINT)),
    ws(user),
    w(getAta(user, mint, TOKEN_2022_PROGRAM_ID)),
    w(getAta(user, WSOL_MINT)),
    w(cv),
    w(getAta(cv, WSOL_MINT)),
    r(findSharingConfigPda(mint)[0]),
    ...(buy ? [r(PublicKey.findProgramAddressSync([new TextEncoder().encode('global_volume_accumulator')], PUMP_PROGRAM_ID)[0])] : []),
    w(uva),
    w(getAta(uva, WSOL_MINT)),
    r(findFeeConfigPda(PUMP_PROGRAM_ID)[0]),
    r(PUMP_FEES_PROGRAM_ID),
    r(SYSTEM_PROGRAM_ID),
    r(ev(PUMP_PROGRAM_ID)),
    r(PUMP_PROGRAM_ID),
  ];
}

/** pump `buy_v2` of `amount` base units for at most `maxSolCost` lamports (Token-2022 coin, SOL-paired). The user's
 * Token-2022 account of the mint must exist (`createAtaIdempotentIx`). `curveCreator` = `bonding_curve.creator`. */
export function pumpBuyV2Ix(a: { rc: PumpTradeRecipients; mint: Address; user: Address; curveCreator: Address; amount: bigint; maxSolCost: bigint }): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: tradeKeys(a.rc, a.mint, a.user, a.curveCreator, true),
    data: Buffer.from(new Writer(24).bytes(PUMP_DISCRIMINATORS.buy_v2).u64(a.amount).u64(a.maxSolCost).done()),
  });
}

/** pump `sell_v2` of `amount` base units for at least `minSolOutput` lamports. */
export function pumpSellV2Ix(a: { rc: PumpTradeRecipients; mint: Address; user: Address; curveCreator: Address; amount: bigint; minSolOutput: bigint }): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: tradeKeys(a.rc, a.mint, a.user, a.curveCreator, false),
    data: Buffer.from(new Writer(24).bytes(PUMP_DISCRIMINATORS.sell_v2).u64(a.amount).u64(a.minSolOutput).done()),
  });
}

/** ATA program `CreateIdempotent`. */
export function createAtaIdempotentIx(a: { payer: Address; owner: Address; mint: Address; tokenProgram?: Address }): TransactionInstruction {
  const tp = a.tokenProgram ?? TOKEN_PROGRAM_ID;
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [ws(a.payer), w(getAta(a.owner, a.mint, tp)), r(a.owner), r(a.mint), r(SYSTEM_PROGRAM_ID), r(tp)],
    data: Buffer.from([1]),
  });
}
