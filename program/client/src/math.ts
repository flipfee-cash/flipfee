// The program's money rules, mirrored for the server and the app (same integer math as on chain).

import type { WindowAccount } from './accounts.js';
import { BPS, MAX_PRICE, MIN_PRICE } from './constants.js';

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** An hour sale: `fee = floor(total × feeBps / 10000)` to the treasury, `toOwner = total − fee` to the dev. */
export function saleSplit(total: bigint, feeBps: number): { fee: bigint; toOwner: bigint } {
  const fee = (total * BigInt(feeBps)) / BPS;
  return { fee, toOwner: total - fee };
}

/**
 * The program's split of `amount` lamports over the time `(from, to]`: each window `[start, end)` gets
 * `floor(amount × overlap / (to − from))`, the owner the rest. Exactly what `crank`/`buy` allocate.
 */
export function allocate(
  windows: Pick<WindowAccount, 'start' | 'end'>[],
  amount: bigint,
  from: number,
  to: number,
): { perWindow: bigint[]; toOwner: bigint } {
  if (!(to > from)) throw new RangeError('allocate: empty interval');
  const span = BigInt(to - from);
  const perWindow = windows.map((w) => {
    const lo = Math.max(w.start, from);
    const hi = Math.min(w.end, to);
    return hi > lo ? (amount * BigInt(hi - lo)) / span : 0n;
  });
  return { perWindow, toOwner: amount - perWindow.reduce((a, b) => a + b, 0n) };
}

/**
 * Suggested price per hour (DESIGN §1.2): 80% of the coin's creator fees in the last hour; when the last hour paid
 * nothing, 80% of the last 6 hours ÷ 6. Rounded down to 0.001 SOL and kept within 0.01 ..= 1000 SOL.
 */
export function suggestedPrice(fees: { lastHour: bigint; last6h?: bigint }): bigint {
  const hourly = fees.lastHour > 0n ? fees.lastHour : (fees.last6h ?? 0n) / 6n;
  const step = 1_000_000n;
  const p = (((hourly * 8n) / 10n) / step) * step;
  return p < MIN_PRICE ? MIN_PRICE : p > MAX_PRICE ? MAX_PRICE : p;
}

/** True when `price` (lamports per hour) is within the program's bounds. */
export function isValidPrice(price: bigint): boolean {
  return price >= MIN_PRICE && price <= MAX_PRICE;
}

/**
 * Lamports → SOL as a decimal string. Without `digits`: exact, trailing zeros trimmed (1500000n → "0.0015"). With
 * `digits`: that many decimals, rounded down (1500000n, 2 → "0.00").
 */
export function formatSol(lamports: bigint, digits?: number): string {
  const neg = lamports < 0n;
  const v = neg ? -lamports : lamports;
  const whole = v / LAMPORTS_PER_SOL;
  let frac = (v % LAMPORTS_PER_SOL).toString().padStart(9, '0');
  if (digits === undefined) frac = frac.replace(/0+$/, '');
  else frac = frac.slice(0, Math.max(0, Math.min(9, digits)));
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Lamports → SOL as a JS number (for display math and charts only). */
export function toSol(lamports: bigint): number {
  return Number(lamports) / 1e9;
}

/** SOL decimal string → lamports (exact). */
export function parseSol(sol: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(sol.trim());
  if (!m) throw new TypeError(`not a SOL amount: ${sol}`);
  return BigInt(m[1]!) * LAMPORTS_PER_SOL + BigInt((m[2] ?? '').padEnd(9, '0'));
}
