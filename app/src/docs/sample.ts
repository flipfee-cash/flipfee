// Example data for the docs, dev and me pages (owner, 2026-10-26: "demo data for the charts and backtests"). Fixed
// seed, so the numbers stay the same on every visit; every chart that uses it is labelled "Example data". The model:
// a coin's creator fees per hour follow a daily rhythm with noise; a buyer pays the suggested price (80% of the last
// hour's fees) and gets whatever the next hour pays.

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A normal draw (Box–Muller). */
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

const round = (x: number, dp = 3) => Math.round(x * 10 ** dp) / 10 ** dp;

export interface HourBar {
  hour: number;
  fees: number;
  sold: boolean;
}

/** One example coin, one day: creator fees per hour (UTC), and which hours a buyer held. */
export function exampleDay(): { bars: HourBar[]; toBuyers: number; toDev: number } {
  const r = rng(7);
  const bars: HourBar[] = [];
  for (let h = 0; h < 24; h++) {
    const rhythm = 0.35 + 0.65 * Math.max(0, Math.sin(((h - 9) / 24) * Math.PI * 2)) ** 1.4;
    const fees = round(Math.max(0.04, (0.18 + 0.9 * rhythm) * Math.exp(0.28 * gauss(r))));
    bars.push({ hour: h, fees, sold: h >= 13 && h <= 21 && h !== 17 });
  }
  const toBuyers = round(bars.filter((b) => b.sold).reduce((s, b) => s + b.fees, 0), 2);
  const toDev = round(bars.filter((b) => !b.sold).reduce((s, b) => s + b.fees, 0), 2);
  return { bars, toBuyers, toDev };
}

export interface Backtest {
  hours: number;
  winRate: number;
  median: number;
  mean: number;
  best: number;
  worst: number;
  /** returns per hour, in %, bucketed */
  buckets: { label: string; n: number; up: boolean }[];
  /** net SOL of a buyer who took one hour a day at the suggested price, day by day */
  curve: { day: number; net: number }[];
}

/** 30 days of example hours bought at the suggested price (80% of the last hour's fees). */
export function exampleBacktest(): Backtest {
  const r = rng(42);
  const rets: number[] = [];
  const curve: { day: number; net: number }[] = [];
  let net = 0;
  for (let day = 1; day <= 30; day++) {
    for (let k = 0; k < 8; k++) {
      const last = 0.15 + r() * 0.9;
      const price = 0.8 * last;
      const paid = last * Math.exp(-0.06 + 0.42 * gauss(r));
      rets.push((paid / price - 1) * 100);
      if (k === 0) net += paid - price;
    }
    curve.push({ day, net: round(net, 3) });
  }
  const sorted = [...rets].sort((a, b) => a - b);
  const edges: [string, number, number][] = [
    ['≤ −50%', -Infinity, -50],
    ['−50…−25%', -50, -25],
    ['−25…0%', -25, 0],
    ['0…+25%', 0, 25],
    ['+25…+50%', 25, 50],
    ['+50…+100%', 50, 100],
    ['≥ +100%', 100, Infinity],
  ];
  return {
    hours: rets.length,
    winRate: Math.round((rets.filter((x) => x > 0).length / rets.length) * 100),
    median: Math.round(sorted[Math.floor(sorted.length / 2)]),
    mean: Math.round(rets.reduce((s, x) => s + x, 0) / rets.length),
    best: Math.round(sorted[sorted.length - 1]),
    worst: Math.round(sorted[0]),
    buckets: edges.map(([label, lo, hi]) => ({ label, n: rets.filter((x) => x > lo && x <= hi).length, up: lo >= 0 })),
    curve,
  };
}

/** A dev who sells 8 hours a day at 0.30 SOL: SOL per day from sales (95%) and from open hours. */
export function exampleDev(): { day: number; total: number }[] {
  const r = rng(11);
  const out: { day: number; total: number }[] = [];
  for (let day = 1; day <= 30; day++) {
    const sales = 8 * 0.3 * 0.95;
    const open = 16 * (0.18 + 0.25 * r());
    out.push({ day, total: round(sales + open, 2) });
  }
  return out;
}
