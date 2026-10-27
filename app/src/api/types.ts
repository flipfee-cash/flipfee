// The /api contract (DESIGN.md §2.2) as the app reads it. The server sends amounts as lamport strings plus SOL numbers
// for display; times as ms (or unix seconds). Everything that comes over the wire goes through `norm.ts`, so the views
// only ever see the clean shapes below.

/** One trade on a tracked coin, with the exact creator fee it paid. */
export interface Trade {
  id: string;
  mint: string;
  /** ms */
  t: number;
  side: 'buy' | 'sell';
  /** SOL traded */
  sol: number;
  /** creator fee paid by this trade, SOL */
  fee: number;
  wallet: string;
  sig?: string;
}

/** A sold stretch of hours on a coin (Window on chain). Times in ms. */
export interface Win {
  holder: string;
  start: number;
  end: number;
  /** fees this window earned so far (allocated by the crank), SOL */
  earned: number;
  /** earned and paid out to the holder, SOL (when the server knows) */
  paid?: number;
  /** what the buyer paid for it, SOL (when the server knows) */
  cost?: number;
  sig?: string;
}

/** The flipfee side of a coin (registered: the Coin account plus the index's totals). */
export interface FF {
  owner: string;
  /** SOL per hour */
  price: number;
  /** lamports per hour, exact (for max_price) */
  priceLamports: string;
  /** seconds ahead the dev sells (3600..172800) */
  maxAhead: number;
  paused: boolean;
  registeredAt: number;
  /** live and queued windows, sorted by start */
  windows: Win[];
  /** ended windows (newest first), for the timeline and Me */
  past: Win[];
  hoursSold: number;
  /** SOL buyers paid for hours (100%: the dev got 95% of it) */
  sales: number;
  /** creator fees that reached the flipfee vault, SOL */
  feesIn: number;
  /** fees paid out to the dev (outside sold hours), SOL */
  ownerPaid: number;
  /** fees paid out to holders, SOL */
  holderPaid: number;
}

export interface Fees {
  m1: number;
  m10: number;
  h1: number;
  h6: number;
  h24: number;
  /** windows the server saw only in part: the number is an estimate from the coin's volume */
  est: { h1: boolean; h6: boolean; h24: boolean };
}

/** Fees going to whoever holds the coin right now, since `since` (ms). */
export interface ThisHour {
  sol: number;
  since: number;
  /** when this hour ends (a holder's hour mark), 0 when open-ended */
  until: number;
  to: string;
  kind: 'holder' | 'dev';
}

export type Eligibility = 'ready-new' | 'ready' | 'almost' | 'locked' | 'flipfee' | 'usdc' | 'not-admin' | 'unsupported' | 'not-found';

export interface Coin {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  /** ms */
  createdAt: number;
  mcapUsd: number;
  graduated: boolean;
  /** curve creator (or the sharing config once it moved) */
  creator: string;
  /** the wallet that controls the fee split (sharing_config.admin), when known */
  admin: string;
  quote: 'sol' | 'usdc' | 'other';
  fees: Fees;
  trades1h: number;
  /** the trade count covers only part of the hour */
  trades1hPart: boolean;
  volume1h: number;
  wants: number;
  /** hourly creator fees for the last 24 h, oldest first: [startMs, SOL] */
  hourly: [number, number][];
  /** masked or flagged by moderation (kept off the board) */
  hidden: boolean;
  ff: FF | null;
  thisHour: ThisHour | null;
  socials: { twitter?: string; telegram?: string; website?: string };
  /** the last few trades (a snapshot carries them so the trade dots start full) */
  recent?: Trade[];
  ageSec: number;
  /** the server's read of whether the coin can join flipfee (false: USDC pair, no creator fee, or a final split elsewhere) */
  canJoin: boolean | null;
  links: { pumpfun?: string; dexscreener?: string; solscan?: string };
  description?: string;
}

export interface Stats {
  /** creator fees in the last hour across the tracked (top) coins, SOL */
  feesHour: number;
  trackedCoins: number;
  hoursSoldToday: number;
  paidBuyersToday: number;
  paidDevsToday: number;
  solUsd: number;
  liveCoins: number;
  /** coins whose trades the last-hour fee number sums */
  feesHourCoins: number;
}

export interface Board {
  at: number;
  stats: Stats;
  live: Coin[];
  hot: Coin[];
  /** the server's pick for the hero counter: the live coin whose hour paid most */
  hero: string | null;
}

/** One stretch of the coin page's hour timeline (GET /api/coin timeline). */
export interface Seg {
  start: number;
  end: number;
  /** a holder's window, the dev's time, or open time for sale */
  kind: 'holder' | 'dev' | 'open';
  state: 'past' | 'live' | 'sold' | 'open';
  holder?: string;
  /** creator fees in the part that already happened, SOL */
  fees?: number;
  earned?: number;
  cost?: number;
  price?: number;
  hours?: number;
}

export interface Timeline {
  now: number;
  from: number;
  segments: Seg[];
  price: number;
  nextStart: number;
  hoursOpen: number;
  paused: boolean;
}

export interface CoinPage {
  coin: Coin;
  trades: Trade[];
  timeline: Timeline | null;
}

export interface DevCoin extends Coin {
  eligibility: Eligibility;
  /** the SOL price per hour the app suggests (80% of last hour's fees, or last 6 h ÷ 6) */
  suggested: number;
}

export interface DevReply {
  wallet: string;
  coins: DevCoin[];
}

export interface MyHour extends Win {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  hours: number;
  state: 'live' | 'upcoming' | 'past';
  /** a live hour: what this hour paid so far */
  live: ThisHour | null;
}

export interface MeReply {
  wallet: string;
  hours: MyHour[];
  coins: Coin[];
  spent: number;
  received: number;
  /** SOL the dev got from hour sales (95%) and from fees outside sold hours */
  devSales: number;
  devFees: number;
  /** coins this wallet wants */
  wants: string[];
}

/** Stream events (DESIGN.md §2.2): `trade`, `fee`, `window`, `buy`, `paid`, `register`, `stats`, `want`. */
export type StreamEvent =
  | { type: 'trade'; trade: Trade }
  | { type: 'fee'; mint: string; amount: number; from: number; to: number }
  | { type: 'window'; mint: string; windows: Win[]; ff?: Partial<FF> }
  | { type: 'buy'; mint: string; buyer: string; hours: number; start: number; end: number; paid: number; sig?: string }
  | { type: 'paid'; mint: string; to: string; amount: number; kind: 'holder' | 'owner'; sig?: string }
  | { type: 'register'; mint: string; owner: string; coin: Coin | null; price: number; maxAhead: number; sig?: string }
  | { type: 'stats'; stats: Stats }
  | { type: 'want'; mint: string; count: number; wallet?: string };
