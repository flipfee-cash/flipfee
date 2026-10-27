// Full transactions for the app, the server and the keeper: legacy `Transaction`s with fee payer, recent blockhash,
// compute-unit limit and optional priority fee, ready to sign.

import {
  ComputeBudgetProgram,
  type Commitment,
  type Connection,
  type PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';

import { type CoinAccount, coinStatus, decodeCoin, decodeConfig } from './accounts.js';
import { type Address, toPublicKey } from './codec.js';
import { COMPUTE_UNITS, DEFAULT_MAX_AHEAD, FLIPFEE_PROGRAM_ID, MAX_HOURS, MIN_HOURS, PUMP_PROGRAM_ID } from './constants.js';
import { type Eligibility, eligibility } from './eligibility.js';
import { buyIx, crankIx, registerIx } from './instructions.js';
import { saleSplit } from './math.js';
import { findBondingCurvePda, findCanonicalPoolPda, findCoinPda, findConfigPda, findSharingConfigPda, findVaultPda, getAmmCreatorVaultAta } from './pda.js';
import {
  createFeeSharingConfigIx,
  decodeBondingCurve,
  distributeCreatorFeesV2Ix,
  transferCreatorFeesToPumpV2Ix,
  updateFeeSharesIx,
  updateFeeSharesV2Ix,
} from './pump.js';

export interface TxOptions {
  /** Priority fee in micro-lamports per compute unit (0 / undefined = none). */
  microLamports?: number;
  programId?: Address;
  commitment?: Commitment;
}

/** Thrown by `connectCoinTx` when the wallet cannot connect the coin; `.eligibility` says why. */
export class NotEligibleError extends Error {
  constructor(readonly eligibility: Eligibility) {
    super(`coin cannot be connected by this wallet: ${eligibility.kind}${eligibility.reason ? ` (${eligibility.reason})` : ''}`);
    this.name = 'NotEligibleError';
  }
}

/** The chain clock (unix seconds), read from the Clock sysvar. */
export async function chainTime(conn: Connection, commitment: Commitment = 'confirmed'): Promise<number> {
  const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, commitment);
  if (!info) throw new Error('clock sysvar not found');
  return Number(new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength).getBigInt64(32, true));
}

/** A legacy transaction: compute-unit limit (+ price), then `ixs`, with a recent blockhash. */
export async function buildTx(
  conn: Connection,
  feePayer: Address,
  ixs: TransactionInstruction[],
  units: number,
  opts: TxOptions = {},
): Promise<Transaction> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(opts.commitment ?? 'confirmed');
  const tx = new Transaction({ feePayer: toPublicKey(feePayer), blockhash, lastValidBlockHeight });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(units, 1_400_000) }));
  if (opts.microLamports) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.microLamports }));
  tx.add(...ixs);
  return tx;
}

/**
 * The instructions that bring every fee pump holds for this coin into the vault: PumpSwap's
 * `transfer_creator_fees_to_pump_v2` when the AMM creator vault holds WSOL (graduated coins), then pump's
 * `distribute_creator_fees_v2` (a no-op below pump's minimum).
 */
export async function collectFeesIxs(
  conn: Connection,
  a: { payer: Address; mint: Address; programId?: Address },
): Promise<{ ixs: TransactionInstruction[]; units: number; graduated: boolean }> {
  const sc = findSharingConfigPda(a.mint)[0];
  const ammVault = getAmmCreatorVaultAta(sc);
  const [curveInfo, ammInfo] = await conn.getMultipleAccountsInfo([findBondingCurvePda(a.mint)[0], ammVault], 'confirmed');
  const graduated = !!curveInfo && curveInfo.owner.equals(PUMP_PROGRAM_ID) && decodeBondingCurve(curveInfo.data).complete;
  const ixs: TransactionInstruction[] = [];
  let units = 0;
  // Sweep whenever PumpSwap's creator vault exists (a no-op when empty), so an AMM trade landing between building and
  // sending cannot leave fees uncollected (`buy` would refuse). It fails only when the vault does not exist yet.
  if (ammInfo && ammInfo.data.length >= 72) {
    ixs.push(transferCreatorFeesToPumpV2Ix({ payer: a.payer, coinCreator: sc }));
    units += COMPUTE_UNITS.pump_transfer_creator_fees_to_pump;
  }
  ixs.push(distributeCreatorFeesV2Ix({ payer: a.payer, mint: a.mint, shareholders: [findVaultPda(a.mint, a.programId)[0]] }));
  units += COMPUTE_UNITS.pump_distribute_creator_fees;
  return { ixs, units, graduated };
}

/**
 * The dev's one-time connect (DESIGN §1.5), by eligibility:
 * - `ready-new`: `create_fee_sharing_config` + `update_fee_shares_v2 → [vault 100%]` + `register`
 * - `ready`: the split (`update_fee_shares_v2`, or v1 `update_fee_shares` on a version-1 config) + `register`
 * - `almost`: `register`
 * Throws `NotEligibleError` for any other state.
 */
export async function connectCoinTx(
  conn: Connection,
  a: { wallet: Address; mint: Address; price: bigint; maxAhead?: number } & TxOptions,
): Promise<{ tx: Transaction; kind: 'ready-new' | 'ready' | 'almost'; coin: PublicKey; vault: PublicKey; eligibility: Eligibility }> {
  const e = await eligibility(conn, a.mint, a.wallet, { programId: a.programId });
  if (e.kind !== 'ready-new' && e.kind !== 'ready' && e.kind !== 'almost') throw new NotEligibleError(e);
  const wallet = toPublicKey(a.wallet);
  const pool = e.graduated ? findCanonicalPoolPda(a.mint)[0] : null;
  const next = [{ address: e.vault, shareBps: 10_000 }];
  const ixs: TransactionInstruction[] = [];
  let units = COMPUTE_UNITS.register;
  if (e.kind === 'ready-new') {
    ixs.push(createFeeSharingConfigIx({ creator: wallet, mint: a.mint, pool }));
    ixs.push(updateFeeSharesV2Ix({ authority: wallet, mint: a.mint, current: [wallet], next, pool }));
    units += COMPUTE_UNITS.pump_create_fee_sharing_config + COMPUTE_UNITS.pump_update_fee_shares;
  } else if (e.kind === 'ready') {
    const current = e.sharing!.shareholders.map((s) => s.address);
    const update = e.sharing!.version === 1 ? updateFeeSharesIx : updateFeeSharesV2Ix;
    ixs.push(update({ authority: wallet, mint: a.mint, current, next, pool }));
    units += COMPUTE_UNITS.pump_update_fee_shares;
  }
  ixs.push(registerIx({ owner: wallet, mint: a.mint, price: a.price, maxAhead: a.maxAhead ?? DEFAULT_MAX_AHEAD, programId: a.programId }));
  const tx = await buildTx(conn, wallet, ixs, units, a);
  return { tx, kind: e.kind, coin: e.coin, vault: e.vault, eligibility: e };
}

/**
 * A purchase of `hours` hours (DESIGN §1.3): pump fees are brought in first (so fees earned before the purchase are
 * allocated before the hour starts), then `buy`. `start`/`end` are computed from the chain clock at build time.
 */
export async function buyTx(
  conn: Connection,
  a: {
    buyer: Address;
    mint: Address;
    hours: number;
    maxPrice?: bigint;
    /** Latest acceptable start (unix seconds). Default: the expected start + `startSlack`. */
    maxStart?: number;
    /** Seconds the start may move after building (another purchase landing first, clock drift). Default 120. */
    startSlack?: number;
  } & TxOptions,
): Promise<{ tx: Transaction; start: number; end: number; maxStart: number; price: bigint; total: bigint; toOwner: bigint; fee: bigint; coin: CoinAccount }> {
  if (!Number.isInteger(a.hours) || a.hours < MIN_HOURS || a.hours > MAX_HOURS) throw new RangeError(`hours must be ${MIN_HOURS}..${MAX_HOURS}`);
  const programId = toPublicKey(a.programId ?? FLIPFEE_PROGRAM_ID);
  const [coinInfo, configInfo] = await conn.getMultipleAccountsInfo([findCoinPda(a.mint, programId)[0], findConfigPda(programId)[0]], 'confirmed');
  if (!coinInfo) throw new Error('coin is not on flipfee');
  if (!configInfo) throw new Error('flipfee config not found');
  const coin = decodeCoin(coinInfo.data);
  const config = decodeConfig(configInfo.data);
  const now = await chainTime(conn);
  const start = coinStatus(coin, now).nextStart;
  const end = start + a.hours * 3_600;
  const total = coin.price * BigInt(a.hours);
  const { fee, toOwner } = saleSplit(total, config.feeBps);
  const maxStart = a.maxStart ?? start + (a.startSlack ?? 120);
  const collect = await collectFeesIxs(conn, { payer: a.buyer, mint: a.mint, programId });
  const ixs = [
    ...collect.ixs,
    buyIx({
      buyer: a.buyer,
      mint: a.mint,
      owner: coin.owner,
      treasury: config.treasury,
      hours: a.hours,
      maxPrice: a.maxPrice ?? coin.price,
      maxStart,
      programId,
    }),
  ];
  const tx = await buildTx(conn, a.buyer, ixs, collect.units + COMPUTE_UNITS.buy, a);
  return { tx, start, end, maxStart, price: coin.price, total, toOwner, fee, coin };
}

/** Who a crank should pay: the owner, then the holders of live and ended windows (deduplicated), at most `max`
 * (15 keeps a crank's events under mainnet's 10,000-byte log limit). */
export function crankRecipients(coin: CoinAccount, now: number, max = 15): PublicKey[] {
  const out: PublicKey[] = [coin.owner];
  for (const w of coin.windows) {
    if (w.start > now && w.owed === 0n) continue; // queued and owed nothing yet
    if (!out.some((k) => k.equals(w.holder))) out.push(w.holder);
  }
  return out.slice(0, max);
}

/** The keeper's crank (and anyone's): bring pump fees in, sync, pay the owner and the holders. */
export async function crankTx(
  conn: Connection,
  a: { payer: Address; mint: Address; recipients?: Address[] } & TxOptions,
): Promise<{ tx: Transaction; recipients: PublicKey[] }> {
  const programId = toPublicKey(a.programId ?? FLIPFEE_PROGRAM_ID);
  let recipients = a.recipients?.map(toPublicKey);
  if (!recipients) {
    const info = await conn.getAccountInfo(findCoinPda(a.mint, programId)[0], 'confirmed');
    if (!info) throw new Error('coin is not on flipfee');
    recipients = crankRecipients(decodeCoin(info.data), await chainTime(conn));
  }
  const collect = await collectFeesIxs(conn, { payer: a.payer, mint: a.mint, programId });
  const ixs = [...collect.ixs, crankIx({ mint: a.mint, recipients, programId })];
  const tx = await buildTx(conn, a.payer, ixs, collect.units + COMPUTE_UNITS.crank, a);
  return { tx, recipients };
}

/** Simulates a transaction (no signature check) and decodes a failure. */
export async function simulateTx(
  conn: Connection,
  tx: Transaction,
): Promise<{ ok: boolean; logs: string[]; unitsConsumed?: number; err: unknown }> {
  const res = await conn.simulateTransaction(tx);
  return { ok: !res.value.err, logs: res.value.logs ?? [], unitsConsumed: res.value.unitsConsumed, err: res.value.err };
}
