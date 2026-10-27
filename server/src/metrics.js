// Pure helpers for per-coin numbers: fee windows (exact, from decoded trades), tracking coverage, estimates from
// outside volume, pump's creator-fee tiers, and lamport/SOL formatting. No I/O here (test/metrics.test.js).

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const WINDOWS = { m1: MIN, m10: 10 * MIN, h1: HOUR, h6: 6 * HOUR, h24: 24 * HOUR };
export const LAMPORTS = 1_000_000_000;

/** Lamports (integer Number) → SOL rounded to 9 decimals. */
export const sol = (lamports) => Math.round(Number(lamports) || 0) / LAMPORTS;

/** { lamports: "123", sol: 1.23e-7 }: exact lamports as a string, SOL for display (DESIGN §2.2). */
export const amount = (lamports) => {
  const l = Math.max(0, Math.round(Number(lamports) || 0));
  return { lamports: String(l), sol: sol(l) };
};

/** Milliseconds of [from, to) covered by `intervals` ([start, end|null] pairs; null = still open at `now`). */
export function coveredMs(intervals, from, to, now = Date.now()) {
  if (!(to > from)) return 0;
  // merge first: intervals can overlap after restarts
  const list = intervals
    .map(([a, b]) => [Math.max(a, from), Math.min(b ?? now, to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curA = null;
  let curB = null;
  for (const [a, b] of list) {
    if (curB === null || a > curB) {
      if (curB !== null) total += curB - curA;
      curA = a;
      curB = b;
    } else if (b > curB) curB = b;
  }
  if (curB !== null) total += curB - curA;
  return total;
}

/** A window counts as exact when what we missed is at most 1% of it (a quick restart) or 5 seconds. */
export const isExact = (windowMs, covered) => windowMs - covered <= Math.max(5_000, windowMs * 0.01);

/** Sums trades ({ t, fee, lam, buy }) with t in (now - ms, now]. `trades` ascending by t. */
export function sumTrades(trades, ms, now = Date.now()) {
  const cut = now - ms;
  let fee = 0;
  let vol = 0;
  let n = 0;
  let buys = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    const tr = trades[i];
    if (tr.t <= cut) break;
    if (tr.t > now) continue;
    fee += tr.fee;
    vol += tr.lam;
    n++;
    if (tr.buy) buys++;
  }
  return { fee, vol, trades: n, buys, sells: n - buys };
}

/** Sums minute buckets (Map m → { fee, vol, trades, buys }) for minutes m >= floor((now - ms) / MIN). */
export function sumMinutes(minutes, ms, now = Date.now()) {
  const from = Math.floor((now - ms) / MIN);
  const to = Math.floor(now / MIN);
  let fee = 0;
  let vol = 0;
  let n = 0;
  let buys = 0;
  if (minutes.size < to - from) {
    for (const [m, b] of minutes) {
      if (m < from || m > to) continue;
      fee += b.fee;
      vol += b.vol;
      n += b.trades;
      buys += b.buys;
    }
  } else {
    for (let m = from; m <= to; m++) {
      const b = minutes.get(m);
      if (!b) continue;
      fee += b.fee;
      vol += b.vol;
      n += b.trades;
      buys += b.buys;
    }
  }
  return { fee, vol, trades: n, buys, sells: n - buys };
}

/** Creator fees per clock hour for the last `hours` hours, oldest first: [[hourStartMs, lamports], …]. */
export function hourly(minutes, hours = 24, now = Date.now()) {
  const cur = Math.floor(now / HOUR);
  const out = [];
  for (let h = cur - hours + 1; h <= cur; h++) out.push([h * HOUR, 0]);
  const first = (cur - hours + 1) * 60;
  for (const [m, b] of minutes) {
    if (m < first) continue;
    const i = Math.floor(m / 60) - (cur - hours + 1);
    if (i >= 0 && i < out.length) out[i][1] += b.fee;
  }
  return out;
}

/**
 * pump's creator-fee rate (bps) by venue and market cap in SOL: the bonding curve's flat rate, PumpSwap's tiers
 * (pump_fees FeeConfig of the AMM; `tiers` = [{ thresholdSol, creator }] ascending). Mainnet values on 2026-10-06:
 * curve 30; AMM 30 under 420 SOL, then 95 → 5 as the market cap grows.
 */
export const DEFAULT_TIERS = {
  curve: 30,
  amm: [
    [0, 30], [420, 95], [1470, 90], [2460, 85], [3440, 80], [4420, 75], [9820, 70], [14740, 65], [19650, 60], [24560, 55],
    [29470, 50], [34380, 45], [39300, 40], [44210, 35], [49120, 30], [54030, 28], [58940, 25], [63860, 23], [68770, 20],
    [73681, 18], [78590, 15], [83500, 13], [88400, 10], [93330, 8], [98240, 5],
  ].map(([thresholdSol, creator]) => ({ thresholdSol, creator })),
};

export function tierBps(tiers, mcapSol) {
  let bps = tiers[0]?.creator ?? 0;
  for (const t of tiers) if ((mcapSol ?? 0) >= t.thresholdSol) bps = t.creator;
  return bps;
}

/** Estimated creator fees (lamports) for an outside USD volume at `bps`. */
export function estFee(volUsd, solUsd, bps) {
  if (!(volUsd > 0) || !(solUsd > 0) || !(bps >= 0)) return null;
  return Math.round((volUsd / solUsd) * LAMPORTS * (bps / 10_000));
}

/** DESIGN §1.2: suggested price per hour = 80% of last hour's creator fees (fallback: last 6 h ÷ 6), 0.01–1000 SOL. */
export function suggestedLamports(h1Lamports, h6Lamports) {
  const base = h1Lamports > 0 ? h1Lamports : (h6Lamports ?? 0) / 6;
  const p = Math.round(base * 0.8);
  return Math.min(1000 * LAMPORTS, Math.max(0.01 * LAMPORTS, p));
}
