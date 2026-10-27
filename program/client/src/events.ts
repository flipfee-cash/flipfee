import type { PublicKey } from '@solana/web3.js';

import { type Address, Reader, base64ToBytes, bytesEqual, toPublicKey } from './codec.js';
import { FLIPFEE_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from './constants.js';
import { EVENT_DISCRIMINATORS } from './generated.js';

// Amounts are lamports (bigint); times are unix seconds (chain clock).

export interface ConfigSetEvent { admin: PublicKey; treasury: PublicKey; feeBps: number; paused: boolean; at: number }
export interface RegisteredEvent {
  mint: PublicKey; coin: PublicKey; owner: PublicKey; vault: PublicKey; price: bigint; maxAhead: number;
  /** Lamports the owner put into the vault for its rent (0 if it already had it). */
  vaultFunded: bigint;
  /** Fees already in the vault when the coin joined; owed to the owner. */
  carried: bigint;
  at: number;
}
export interface TermsSetEvent { mint: PublicKey; coin: PublicKey; price: bigint; maxAhead: number; paused: boolean; at: number }
export interface OwnerTransferredEvent { mint: PublicKey; coin: PublicKey; from: PublicKey; to: PublicKey; paidToOldOwner: bigint; at: number }
export interface HoursBoughtEvent {
  mint: PublicKey; coin: PublicKey; buyer: PublicKey;
  /** The window `[start, end)` the buyer now holds. */
  start: number; end: number; hours: number;
  /** Price per hour. */
  price: bigint;
  /** price × hours, paid by the buyer. */
  total: bigint;
  /** total − fee, paid to the owner at once. */
  toOwner: bigint;
  fee: bigint;
  /** Windows the coin holds after this purchase. */
  windows: number;
  at: number;
}
export interface FeesSyncedEvent {
  mint: PublicKey; coin: PublicKey;
  /** Lamports allocated by this sync, over the time `(from, to]`. */
  amount: bigint; from: number; to: number;
  toOwner: bigint; toWindows: bigint;
  at: number;
}
export interface PaidEvent { mint: PublicKey; coin: PublicKey; to: PublicKey; amount: bigint; kind: 'Owner' | 'Holder'; at: number }
export interface WindowDoneEvent {
  mint: PublicKey; coin: PublicKey; holder: PublicKey; start: number; end: number;
  /** Final total the window earned (all paid). */
  earned: bigint;
  at: number;
}

export type FlipfeeEvent =
  | { name: 'ConfigSet'; data: ConfigSetEvent }
  | { name: 'Registered'; data: RegisteredEvent }
  | { name: 'TermsSet'; data: TermsSetEvent }
  | { name: 'OwnerTransferred'; data: OwnerTransferredEvent }
  | { name: 'HoursBought'; data: HoursBoughtEvent }
  | { name: 'FeesSynced'; data: FeesSyncedEvent }
  | { name: 'Paid'; data: PaidEvent }
  | { name: 'WindowDone'; data: WindowDoneEvent };

export type FlipfeeEventName = FlipfeeEvent['name'];

const DECODERS: { [K in FlipfeeEventName]: (r: Reader) => Extract<FlipfeeEvent, { name: K }>['data'] } = {
  ConfigSet: (r) => ({ admin: r.pubkey(), treasury: r.pubkey(), feeBps: r.u16(), paused: r.bool(), at: r.i64() }),
  Registered: (r) => ({
    mint: r.pubkey(), coin: r.pubkey(), owner: r.pubkey(), vault: r.pubkey(), price: r.u64(), maxAhead: r.u32(),
    vaultFunded: r.u64(), carried: r.u64(), at: r.i64(),
  }),
  TermsSet: (r) => ({ mint: r.pubkey(), coin: r.pubkey(), price: r.u64(), maxAhead: r.u32(), paused: r.bool(), at: r.i64() }),
  OwnerTransferred: (r) => ({ mint: r.pubkey(), coin: r.pubkey(), from: r.pubkey(), to: r.pubkey(), paidToOldOwner: r.u64(), at: r.i64() }),
  HoursBought: (r) => ({
    mint: r.pubkey(), coin: r.pubkey(), buyer: r.pubkey(), start: r.i64(), end: r.i64(), hours: r.u8(), price: r.u64(),
    total: r.u64(), toOwner: r.u64(), fee: r.u64(), windows: r.u8(), at: r.i64(),
  }),
  FeesSynced: (r) => ({
    mint: r.pubkey(), coin: r.pubkey(), amount: r.u64(), from: r.i64(), to: r.i64(), toOwner: r.u64(), toWindows: r.u64(),
    at: r.i64(),
  }),
  Paid: (r) => {
    const mint = r.pubkey();
    const coin = r.pubkey();
    const to = r.pubkey();
    const amount = r.u64();
    const k = r.u8();
    if (k > 1) throw new RangeError(`unknown pay kind ${k}`);
    return { mint, coin, to, amount, kind: k === 0 ? 'Owner' : 'Holder', at: r.i64() };
  },
  WindowDone: (r) => ({
    mint: r.pubkey(), coin: r.pubkey(), holder: r.pubkey(), start: r.i64(), end: r.i64(), earned: r.u64(), at: r.i64(),
  }),
};

/** Decodes one flipfee event payload (the bytes after `Program data: `, base64-decoded). */
export function decodeEvent(payload: Uint8Array): FlipfeeEvent | null {
  if (payload.length < 8) return null;
  const head = payload.subarray(0, 8);
  for (const [name, disc] of Object.entries(EVENT_DISCRIMINATORS)) {
    if (bytesEqual(head, disc)) {
      const decode = DECODERS[name as FlipfeeEventName];
      return { name, data: decode(new Reader(payload, 8)) } as FlipfeeEvent;
    }
  }
  return null;
}

const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const EXIT = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed)/;

/** `Program data:` payloads logged while `program` itself was executing (follows invoke/success lines, so another
 * program cannot forge them). Pass logs of successful transactions only. */
export function programDataPayloads(logs: readonly string[] | null | undefined, program: Address): Uint8Array[] {
  if (!logs) return [];
  const self = toPublicKey(program).toBase58();
  const stack: string[] = [];
  const out: Uint8Array[] = [];
  for (const line of logs) {
    const inv = INVOKE.exec(line);
    if (inv) {
      stack.push(inv[1]!);
      continue;
    }
    if (EXIT.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith('Program data: ') && stack[stack.length - 1] === self) {
      for (const part of line.slice('Program data: '.length).split(' ')) {
        try {
          out.push(base64ToBytes(part));
        } catch {
          /* not base64 */
        }
      }
    }
  }
  return out;
}

/** flipfee events of a transaction's logs (`meta.logMessages`), in order. */
export function parseEvents(logs: readonly string[] | null | undefined, programId: Address = FLIPFEE_PROGRAM_ID): FlipfeeEvent[] {
  return programDataPayloads(logs, programId)
    .map(decodeEvent)
    .filter((e): e is FlipfeeEvent => e !== null);
}

/** Events of a confirmed transaction fetched by signature (null when not found or failed). */
export async function fetchTransactionEvents(
  connection: { getTransaction: (sig: string, cfg: { commitment?: 'confirmed' | 'finalized'; maxSupportedTransactionVersion: number }) => Promise<{ meta: { err: unknown; logMessages?: string[] | null } | null } | null> },
  signature: string,
  programId: Address = FLIPFEE_PROGRAM_ID,
): Promise<FlipfeeEvent[] | null> {
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx?.meta || tx.meta.err) return null;
  return parseEvents(tx.meta.logMessages ?? [], programId);
}

// ── pump.fun trade events (the creator fee of each trade) ──

export const PUMP_EVENT_DISCRIMINATORS = {
  TradeEvent: [189, 219, 127, 211, 78, 230, 97, 238],
  DistributeCreatorFeesEvent: [165, 55, 129, 112, 4, 179, 202, 40],
  BuyEvent: [103, 244, 82, 31, 44, 245, 119, 119],
  SellEvent: [62, 47, 55, 10, 165, 3, 220, 42],
} as const;
/** Anchor's `emit_cpi!` prefix when an event is read from inner-instruction data instead of the logs. */
const EVENT_IX_TAG = [228, 69, 165, 46, 81, 203, 154, 29];

function stripCpiTag(b: Uint8Array): Uint8Array {
  return b.length >= 16 && bytesEqual(b.subarray(0, 8), EVENT_IX_TAG) ? b.subarray(8) : b;
}

export interface PumpTradeEvent {
  mint: PublicKey;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: PublicKey;
  timestamp: number;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  feeBps: bigint;
  fee: bigint;
  /** Where the creator fee went (`bonding_curve.creator`: the sharing config on a flipfee coin). */
  creator: PublicKey;
  creatorFeeBps: bigint;
  /** Lamports of creator fee this trade paid. */
  creatorFee: bigint;
}

/** pump `TradeEvent` (bonding-curve trades): the fixed fields up to `creator_fee`. */
export function decodePumpTradeEvent(bytes: Uint8Array): PumpTradeEvent | null {
  const b = stripCpiTag(bytes);
  if (b.length < 8 + 217 || !bytesEqual(b.subarray(0, 8), PUMP_EVENT_DISCRIMINATORS.TradeEvent)) return null;
  const r = new Reader(b, 8);
  const mint = r.pubkey();
  const solAmount = r.u64();
  const tokenAmount = r.u64();
  const isBuy = r.bool();
  const user = r.pubkey();
  const timestamp = r.i64();
  const virtualSolReserves = r.u64();
  const virtualTokenReserves = r.u64();
  r.u64(); // real_sol_reserves
  r.u64(); // real_token_reserves
  r.pubkey(); // fee_recipient
  const feeBps = r.u64();
  const fee = r.u64();
  const creator = r.pubkey();
  const creatorFeeBps = r.u64();
  const creatorFee = r.u64();
  return { mint, solAmount, tokenAmount, isBuy, user, timestamp, virtualSolReserves, virtualTokenReserves, feeBps, fee, creator, creatorFeeBps, creatorFee };
}

export interface AmmTradeEvent {
  side: 'buy' | 'sell';
  timestamp: number;
  /** Base tokens out (buy) or in (sell). */
  baseAmount: bigint;
  /** Quote (WSOL lamports) in (buy, `quote_amount_in`) or out (sell, `quote_amount_out`). */
  quoteAmount: bigint;
  pool: PublicKey;
  user: PublicKey;
  /** `pool.coin_creator` (the sharing config on a flipfee coin). */
  coinCreator: PublicKey;
  coinCreatorFeeBps: bigint;
  /** Lamports (WSOL) of creator fee this trade paid. */
  coinCreatorFee: bigint;
}

/** PumpSwap `BuyEvent` / `SellEvent`: the fixed fields up to `coin_creator_fee`. */
export function decodeAmmTradeEvent(bytes: Uint8Array): AmmTradeEvent | null {
  const b = stripCpiTag(bytes);
  if (b.length < 8 + 352) return null;
  const head = b.subarray(0, 8);
  const side = bytesEqual(head, PUMP_EVENT_DISCRIMINATORS.BuyEvent) ? 'buy' : bytesEqual(head, PUMP_EVENT_DISCRIMINATORS.SellEvent) ? 'sell' : null;
  if (!side) return null;
  const r = new Reader(b, 8);
  const timestamp = r.i64();
  const baseAmount = r.u64();
  for (let i = 0; i < 5; i++) r.u64(); // limit, user reserves ×2, pool reserves ×2
  const quoteAmount = r.u64();
  for (let i = 0; i < 6; i++) r.u64(); // fees and totals
  const pool = r.pubkey();
  const user = r.pubkey();
  for (let i = 0; i < 4; i++) r.pubkey(); // user token accounts, protocol fee recipient + account
  const coinCreator = r.pubkey();
  const coinCreatorFeeBps = r.u64();
  const coinCreatorFee = r.u64();
  return { side, timestamp, baseAmount, quoteAmount, pool, user, coinCreator, coinCreatorFeeBps, coinCreatorFee };
}

/** pump and PumpSwap trade events of a transaction's logs, in order. */
export function parsePumpEvents(logs: readonly string[] | null | undefined): Array<
  { program: 'pump'; event: PumpTradeEvent } | { program: 'pump_amm'; event: AmmTradeEvent }
> {
  const out: Array<{ program: 'pump'; event: PumpTradeEvent } | { program: 'pump_amm'; event: AmmTradeEvent }> = [];
  if (!logs) return out;
  const pump = PUMP_PROGRAM_ID.toBase58();
  const amm = PUMP_AMM_PROGRAM_ID.toBase58();
  const stack: string[] = [];
  for (const line of logs) {
    const inv = INVOKE.exec(line);
    if (inv) {
      stack.push(inv[1]!);
      continue;
    }
    if (EXIT.test(line)) {
      stack.pop();
      continue;
    }
    if (!line.startsWith('Program data: ')) continue;
    const top = stack[stack.length - 1];
    if (top !== pump && top !== amm) continue;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(line.slice('Program data: '.length).trim());
    } catch {
      continue;
    }
    if (top === pump) {
      const e = decodePumpTradeEvent(bytes);
      if (e) out.push({ program: 'pump', event: e });
    } else {
      const e = decodeAmmTradeEvent(bytes);
      if (e) out.push({ program: 'pump_amm', event: e });
    }
  }
  return out;
}
