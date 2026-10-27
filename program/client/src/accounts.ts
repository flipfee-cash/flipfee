import type { Commitment, Connection, PublicKey } from '@solana/web3.js';

import { type Address, Reader, base58, bytesEqual, toPublicKey } from './codec.js';
import { ACCOUNT_SIZE, COIN_OFFSETS, FLIPFEE_PROGRAM_ID, HOUR, MAX_HOURS, MAX_WINDOWS } from './constants.js';
import { ACCOUNT_DISCRIMINATORS } from './generated.js';
import { findCoinPda, findConfigPda } from './pda.js';

export interface ConfigAccount {
  admin: PublicKey;
  treasury: PublicKey;
  /** flipfee's cut of an hour sale (500 = 5%). */
  feeBps: number;
  /** Stops `register` and `buy` (payouts never stop). */
  paused: boolean;
  bump: number;
}

/** A sold stretch of time `[start, end)`: the fees of those seconds belong to `holder`. */
export interface WindowAccount {
  holder: PublicKey;
  start: number;
  end: number;
  /** Allocated, not paid yet. */
  owed: bigint;
  /** Allocated in total. */
  earned: bigint;
}

export interface CoinAccount {
  mint: PublicKey;
  /** The dev: gets the sales (minus the fee) and every fee outside sold hours. */
  owner: PublicKey;
  bump: number;
  vaultBump: number;
  /** Lamports per hour. */
  price: bigint;
  /** Seconds from now to the end of the last sold hour, at most. */
  maxAhead: number;
  paused: boolean;
  lastSync: number;
  ownerOwed: bigint;
  /** `ownerOwed + Σ windows.owed`. */
  credited: bigint;
  /** Sorted by start, never overlapping. */
  windows: WindowAccount[];
  /** Lamports allocated in total. */
  feesIn: bigint;
  /** Lamports buyers paid in total (fee included). */
  sales: bigint;
  hoursSold: number;
  /** Lamports the vault paid out in total. */
  paidOut: bigint;
}

export interface FetchOptions {
  programId?: Address;
  commitment?: Commitment;
}

function checkDisc(data: Uint8Array, name: keyof typeof ACCOUNT_DISCRIMINATORS): void {
  if (data.length < 8 || !bytesEqual(data.subarray(0, 8), ACCOUNT_DISCRIMINATORS[name])) {
    throw new TypeError(`not a flipfee ${name} account`);
  }
}

export function decodeConfig(data: Uint8Array): ConfigAccount {
  checkDisc(data, 'Config');
  const r = new Reader(data, 8);
  return { admin: r.pubkey(), treasury: r.pubkey(), feeBps: r.u16(), paused: r.bool(), bump: r.u8() };
}

export function decodeCoin(data: Uint8Array): CoinAccount {
  checkDisc(data, 'Coin');
  const r = new Reader(data, 8);
  const mint = r.pubkey();
  const owner = r.pubkey();
  const bump = r.u8();
  const vaultBump = r.u8();
  const price = r.u64();
  const maxAhead = r.u32();
  const paused = r.bool();
  const lastSync = r.i64();
  const ownerOwed = r.u64();
  const credited = r.u64();
  const n = r.u32();
  if (n > MAX_WINDOWS) throw new RangeError(`coin holds ${n} windows (max ${MAX_WINDOWS})`);
  const windows: WindowAccount[] = [];
  for (let i = 0; i < n; i++) {
    windows.push({ holder: r.pubkey(), start: r.i64(), end: r.i64(), owed: r.u64(), earned: r.u64() });
  }
  return {
    mint,
    owner,
    bump,
    vaultBump,
    price,
    maxAhead,
    paused,
    lastSync,
    ownerOwed,
    credited,
    windows,
    feesIn: r.u64(),
    sales: r.u64(),
    hoursSold: r.u32(),
    paidOut: r.u64(),
  };
}

export async function fetchConfig(conn: Connection, opts: FetchOptions = {}): Promise<ConfigAccount> {
  const [address] = findConfigPda(opts.programId);
  const info = await conn.getAccountInfo(address, opts.commitment ?? 'confirmed');
  if (!info) throw new Error(`flipfee config ${address.toBase58()} not found (program not initialized?)`);
  return decodeConfig(info.data);
}

export async function fetchCoin(conn: Connection, mint: Address, opts: FetchOptions = {}): Promise<CoinAccount | null> {
  const [address] = findCoinPda(mint, opts.programId);
  const info = await conn.getAccountInfo(address, opts.commitment ?? 'confirmed');
  if (!info || info.data.length === 0) return null;
  return decodeCoin(info.data);
}

async function fetchCoinsWhere(
  conn: Connection,
  extra: { memcmp: { offset: number; bytes: string } }[],
  opts: FetchOptions,
): Promise<{ address: PublicKey; account: CoinAccount }[]> {
  const res = await conn.getProgramAccounts(toPublicKey(opts.programId ?? FLIPFEE_PROGRAM_ID), {
    commitment: opts.commitment ?? 'confirmed',
    filters: [
      { dataSize: ACCOUNT_SIZE.Coin },
      { memcmp: { offset: 0, bytes: base58(Uint8Array.from(ACCOUNT_DISCRIMINATORS.Coin)) } },
      ...extra,
    ],
  });
  return res.map((a) => ({ address: a.pubkey, account: decodeCoin(a.account.data) }));
}

/** Every registered coin (getProgramAccounts). */
export function fetchCoins(conn: Connection, opts: FetchOptions = {}) {
  return fetchCoinsWhere(conn, [], opts);
}

/** Coins owned by `owner` (the dev). */
export function fetchCoinsOfOwner(conn: Connection, owner: Address, opts: FetchOptions = {}) {
  return fetchCoinsWhere(conn, [{ memcmp: { offset: COIN_OFFSETS.owner, bytes: toPublicKey(owner).toBase58() } }], opts);
}

export interface CoinStatus {
  /** Who gets the fees right now; null = the owner. */
  holder: PublicKey | null;
  /** The window covering `now`. */
  live: WindowAccount | null;
  /** Seconds left in the live window (0 if none). */
  endsIn: number;
  /** Windows that start after `now`. */
  queue: WindowAccount[];
  /** Where hours bought now would start. */
  nextStart: number;
  /** Seconds still sellable: maxAhead − (nextStart − now), at least 0. */
  aheadLeft: number;
  /** Hours one buy can take now (0..12): 0 when paused, when the queue is full or nothing is left ahead. */
  maxHoursNow: number;
  queueFull: boolean;
}

/** What the coin looks like at `now` (unix seconds, chain clock). */
export function coinStatus(coin: CoinAccount, now: number): CoinStatus {
  const live = coin.windows.find((w) => w.start <= now && now < w.end) ?? null;
  const queue = coin.windows.filter((w) => w.start > now);
  const last = coin.windows[coin.windows.length - 1];
  const nextStart = last ? Math.max(now, last.end) : now;
  const aheadLeft = Math.max(0, coin.maxAhead - (nextStart - now));
  // `buy` drops windows that ended and are fully paid before it checks the queue
  const kept = coin.windows.filter((w) => !(w.end <= now && w.owed === 0n)).length;
  const queueFull = kept >= MAX_WINDOWS;
  const maxHoursNow = coin.paused || queueFull ? 0 : Math.min(MAX_HOURS, Math.floor(aheadLeft / HOUR));
  return {
    holder: live?.holder ?? null,
    live,
    endsIn: live ? live.end - now : 0,
    queue,
    nextStart,
    aheadLeft,
    maxHoursNow,
    queueFull,
  };
}
