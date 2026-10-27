// DEV ONLY (`npm run dev:fixture`). A synthetic flipfee world behind the /api contract (DESIGN.md §2.2), so the app
// can be built, tested and screenshotted before the server and the program exist. Coins, wallets and names are made
// up here (no user content). Trades stream at each coin's rate; a crank every 20 s allocates fees and pays holders and
// devs; other traders buy hours; wants tick up.
//
// Transactions: the fixture also answers a small Solana JSON-RPC at /fx/rpc. In fixture mode the app builds a memo
// transaction that names the action ({"ff":"buy",...}); the test wallet signs it and sends it here, and the fixture
// applies the action as the program would (a `buy` or `register` event on the stream).
//
// Switches (cookie `fx`, so one dev server serves every test): `fx=empty` zero live coins · `fx=down` /api/board fails.
// vite.config.ts loads this plugin only for `vite serve` with FLIPFEE_FIXTURE=1; nothing in src/ imports it.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { Plugin } from 'vite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const web3 = require('@solana/web3.js') as typeof import('@solana/web3.js');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function rnd(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A valid address (32 bytes, base58) from a seed: same seed, same address. */
function addr(seed: string): string {
  const r = rnd(seed);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Math.floor(r() * 256);
  bytes[0] = Math.max(1, bytes[0]);
  return bs58(bytes);
}
const lam = (sol: number) => ({ lamports: String(Math.round(sol * 1e9)), sol: Math.round(sol * 1e9) / 1e9 });
const HOUR = 3600e3;

// ───────── the world ─────────

interface W {
  holder: string;
  start: number;
  end: number;
  earned: number;
  paid: number;
  cost: number;
}
interface FxCoin {
  mint: string;
  symbol: string;
  name: string;
  hue: number;
  createdAt: number;
  mcapUsd: number;
  graduated: boolean;
  creator: string;
  quote: 'sol' | 'usdc';
  /** trades per second */
  rate: number;
  /** mean SOL per trade */
  size: number;
  /** creator fee share of a trade */
  feeBps: number;
  wants: number;
  wanted: Set<string>;
  hourly: [number, number][];
  trades: { t: number; side: 'buy' | 'sell'; sol: number; fee: number; wallet: string; sig: string; id: string }[];
  ff: null | {
    owner: string;
    price: number;
    maxAhead: number;
    paused: boolean;
    registeredAt: number;
    windows: W[];
    past: W[];
    hoursSold: number;
    sales: number;
    feesIn: number;
    ownerPaid: number;
    holderPaid: number;
    pending: number;
    lastSync: number;
  };
}

const NAMES: [string, string, number][] = [
  ['TIDE', 'Low Tide', 190],
  ['KITE', 'Kite Day', 32],
  ['LOAF', 'Bread Loaf', 40],
  ['OTTER', 'Sea Otter', 25],
  ['BORK', 'Bork Bork', 12],
  ['GLOW', 'Glow Worm', 95],
  ['FERN', 'Fern Club', 130],
  ['MOTH', 'Night Moth', 270],
  ['CRAB', 'Crab Walk', 8],
  ['PIXL', 'Pixel Cat', 300],
  ['BEAN', 'Cool Bean', 30],
  ['HOOT', 'Owl Hoot', 210],
  ['ZEST', 'Lemon Zest', 55],
  ['PUFF', 'Puff Fish', 180],
  ['YETI', 'Snow Yeti', 200],
  ['DRIP', 'Rain Drip', 220],
  ['MOSS', 'Moss Rock', 110],
  ['WAVE', 'Big Wave', 205],
  ['COIL', 'Copper Coil', 22],
  ['SPUD', 'Hot Spud', 35],
  ['NOVA', 'Nova Pup', 285],
  ['RUNE', 'Rune Stone', 260],
];

const DEV_NAMES: [string, string, number][] = [
  ['SNAIL', 'Turbo Snail', 85],
  ['PLUM', 'Plum Jam', 300],
  ['GECK', 'Gecko Grip', 120],
  ['DOLLA', 'Dolla Coin', 140],
];

function makeCoin(i: number, [symbol, name, hue]: [string, string, number], now: number, seed = 'c'): FxCoin {
  const r = rnd(seed + symbol);
  const rate = i < 2 ? 1.1 - i * 0.35 : 0.05 + r() * 0.5;
  const size = 0.25 + r() * 0.9;
  const feeBps = 30 + Math.floor(r() * 60);
  const hourly: [number, number][] = [];
  const top = Math.floor(now / HOUR) * HOUR;
  for (let h = 24; h >= 1; h--) {
    const v = rate * 3600 * size * (feeBps / 10000) * (0.55 + r() * 0.9);
    hourly.push([top - h * HOUR, Math.round(v * 1e4) / 1e4]);
  }
  return {
    mint: addr('mint' + symbol + seed),
    symbol,
    name,
    hue,
    createdAt: now - (2 + r() * 70) * HOUR,
    mcapUsd: 18000 + r() * 900000,
    graduated: r() > 0.7,
    creator: addr('creator' + symbol + seed),
    quote: 'sol',
    rate,
    size,
    feeBps,
    wants: Math.floor(r() * 40),
    wanted: new Set(),
    hourly,
    trades: [],
    ff: null,
  };
}

function svgImage(c: { symbol: string; hue: number }): string {
  const h = c.hue;
  const letters = c.symbol.slice(0, 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 70% 62%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360} 65% 38%)"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><circle cx="70" cy="24" r="30" fill="hsl(${(h + 180) % 360} 80% 80%)" opacity=".25"/><text x="48" y="60" font-family="Helvetica, Arial" font-weight="800" font-size="34" text-anchor="middle" fill="rgba(255,255,255,.92)">${letters}</text></svg>`;
}

const WALLETS = Array.from({ length: 40 }, (_, i) => addr('trader' + i));

class World {
  coins = new Map<string, FxCoin>();
  devCoins = new Map<string, FxCoin[]>();
  started = Date.now();
  solUsd = 182.4;
  hoursToday = 0;
  buyersToday = 0;
  devsToday = 0;
  clients = new Set<{ res: ServerResponse; empty: boolean }>();
  seq = 0;
  sessions = new Map<string, { address: string; exp: number }>();
  nonces = new Map<string, { address: string; message: string }>();
  sigs = new Map<string, { err: unknown; slot: number }>();
  slot = 300_000_000;

  constructor() {
    const now = Date.now();
    NAMES.forEach((n, i) => {
      const c = makeCoin(i, n, now);
      this.coins.set(c.mint, c);
    });
    const list = [...this.coins.values()];
    // six coins are live on flipfee, each in a different state
    const live = list.slice(0, 6);
    const owners = live.map((c) => c.creator);
    const price = (c: FxCoin) => Math.max(0.01, Math.round(c.hourly[c.hourly.length - 1][1] * 0.8 * 1000) / 1000);
    live.forEach((c, i) => {
      c.ff = {
        owner: owners[i],
        price: price(c),
        maxAhead: i === 3 ? 3 * 3600 : 24 * 3600,
        paused: i === 4,
        registeredAt: now - (5 + i * 7) * HOUR,
        windows: [],
        past: [],
        hoursSold: 0,
        sales: 0,
        feesIn: 0,
        ownerPaid: 0,
        holderPaid: 0,
        pending: 0,
        lastSync: now,
      };
      const f = c.ff;
      const w = (holder: string, start: number, hours: number, earned = 0): W => ({ holder, start, end: start + hours * HOUR, earned, paid: earned * 0.9, cost: f.price * hours });
      // past hours (what they paid)
      for (let k = 1; k <= 4; k++) {
        const st = now - (k + 1.3) * HOUR;
        f.past.push(w(WALLETS[(i * 3 + k) % WALLETS.length], st, 1, c.hourly[24 - k - 1][1]));
      }
      if (i === 0) {
        f.windows.push(w(WALLETS[1], now - 22 * 60e3, 1, 0));
        f.windows.push(w(WALLETS[2], now + 38 * 60e3, 2));
        f.windows.push(w(WALLETS[5], now + 158 * 60e3, 1));
      } else if (i === 2) {
        f.windows.push(w(WALLETS[3], now - 50 * 60e3, 1, 0));
        f.windows.push(w(WALLETS[4], now + 10 * 60e3, 3));
      } else if (i === 3) {
        // the dev sells 3 h ahead and all 3 are sold
        f.windows.push(w(WALLETS[6], now - 15 * 60e3, 1));
        f.windows.push(w(WALLETS[7], now + 45 * 60e3, 2));
      }
      f.hoursSold = f.past.length + f.windows.reduce((a, x) => a + (x.end - x.start) / HOUR, 0) + Math.floor(i * 3.3);
      f.sales = f.hoursSold * f.price;
      f.feesIn = c.hourly.slice(-6).reduce((a, h) => a + h[1], 0);
      f.ownerPaid = f.feesIn * 0.6;
      f.holderPaid = f.feesIn * 0.35;
    });
    // the last hour of trades, so the 1 h numbers and the dots start full
    for (const c of this.coins.values()) {
      const n = Math.min(1500, Math.floor(c.rate * 3600 * 0.8));
      for (let k = 0; k < n; k++) this.trade(c, now - Math.random() * HOUR, false);
      c.trades.sort((a, b) => a.t - b.t);
    }
    // what the current windows earned so far
    for (const c of live) {
      for (const w of c.ff!.windows) {
        if (w.start > now) continue;
        w.earned = c.trades.filter((t) => t.t >= w.start).reduce((a, t) => a + t.fee, 0);
        w.paid = w.earned * 0.85;
      }
    }
    this.hoursToday = 41;
    this.buyersToday = 18.2;
    this.devsToday = 25.9;
  }

  trade(c: FxCoin, t: number, live: boolean) {
    const side: 'buy' | 'sell' = Math.random() < 0.56 ? 'buy' : 'sell';
    const sol = Math.max(0.01, c.size * Math.exp((Math.random() - 0.5) * 2.2));
    const fee = (sol * c.feeBps) / 10000;
    const sig = randomBytes(32).toString('hex').slice(0, 30);
    const tr = { t, side, sol: Math.round(sol * 1e4) / 1e4, fee: Math.round(fee * 1e7) / 1e7, wallet: WALLETS[Math.floor(Math.random() * WALLETS.length)], sig, id: sig };
    c.trades.push(tr);
    if (c.trades.length > 4000) c.trades.splice(0, c.trades.length - 3000);
    if (c.ff) c.ff.pending += tr.fee;
    if (live) this.emit('trade', this.tradeOut(c, tr), c);
  }

  tradeOut(c: FxCoin, tr: FxCoin['trades'][number]) {
    const out: Record<string, unknown> = { mint: c.mint, sig: tr.sig, ix: 0, t: tr.t, side: tr.side, sol: tr.sol, lamports: String(Math.round(tr.sol * 1e9)), fee: lam(tr.fee), wallet: tr.wallet, venue: c.graduated ? 'amm' : 'curve', id: tr.id };
    if (c.ff) {
      const r = this.recipient(c, tr.t);
      out.to = { wallet: r.to, kind: r.kind };
    }
    return out;
  }

  fees(c: FxCoin, now = Date.now()) {
    const list = (ms: number) => c.trades.filter((t) => t.t > now - ms);
    const sum = (ms: number) => list(ms).reduce((a, t) => a + t.fee, 0);
    const h1 = sum(HOUR);
    const older = (k: number) => c.hourly.slice(-k).reduce((a, h) => a + h[1], 0);
    // three hot coins came into view late: the server saw part of their hours and estimates the rest from volume
    const part = !c.ff && c.symbol.length === 4 && 'CRAB PIXL BEAN'.includes(c.symbol);
    const win = (v: number, ms: number) => {
      const l = list(Math.min(ms, HOUR));
      const w: Record<string, unknown> = { ...lam(part && ms >= HOUR ? v * 0.35 : v), exact: !(part && ms >= HOUR), trades: part && ms >= HOUR ? Math.round(l.length * 0.35) : l.length, buys: l.filter((t) => t.side === 'buy').length, sells: l.filter((t) => t.side === 'sell').length, vol: lam(l.reduce((a, t) => a + t.sol, 0)) };
      if (part && ms >= HOUR) {
        w.coverSec = 1200;
        w.est = lam(v);
      }
      return w as ReturnType<typeof lam> & { exact: boolean; trades: number };
    };
    return { m1: win(sum(60e3), 60e3), m10: win(sum(600e3), 600e3), h1: win(h1, HOUR), h6: win(h1 + older(5), 6 * HOUR), h24: win(h1 + older(23), 24 * HOUR) };
  }

  /** The server's "this hour" (src/chain/indexer.js holderNow). */
  recipient(c: FxCoin, now = Date.now()) {
    const f = c.ff!;
    const w = f.windows.find((x) => x.start <= now && now < x.end);
    if (w) {
      const since = w.start + Math.floor((now - w.start) / HOUR) * HOUR;
      return { to: w.holder, kind: 'holder', since, until: Math.min(w.end, since + HOUR) };
    }
    let lastEnd = 0;
    for (const x of [...f.windows, ...f.past]) if (x.end <= now && x.end > lastEnd) lastEnd = x.end;
    return { to: f.owner, kind: 'dev', since: Math.max(Math.floor(now / HOUR) * HOUR, lastEnd, f.registeredAt), until: null };
  }

  coinJson(c: FxCoin, withPast = false) {
    const now = Date.now();
    const out: Record<string, unknown> = {
      mint: c.mint,
      symbol: c.symbol,
      name: c.name,
      image: `/fx/img/${c.mint}.svg`,
      createdAt: c.createdAt,
      mcapUsd: Math.round(c.mcapUsd),
      graduated: c.graduated,
      creator: c.creator,
      quote: c.quote,
      fees: this.fees(c, now),
      trades1h: (this.fees(c, now).h1 as { trades: number }).trades,
      ageSec: Math.round((now - c.createdAt) / 1000),
      links: { pumpfun: `https://pump.fun/coin/${c.mint}`, dexscreener: `https://dexscreener.com/solana/${c.mint}`, solscan: `https://solscan.io/token/${c.mint}` },
      volume1h: lam(c.trades.filter((t) => t.t > now - HOUR).reduce((a, t) => a + t.sol, 0)),
      wants: c.wants,
      hourly: c.hourly,
      recent: c.trades.filter((t) => t.t > now - 120e3).slice(-60).map((t) => this.tradeOut(c, t)),
    };
    if (c.ff) {
      const f = c.ff;
      const r = this.recipient(c, now);
      const since = r.since;
      out.flipfee = {
        owner: f.owner,
        price: lam(f.price),
        maxAhead: f.maxAhead,
        paused: f.paused,
        registeredAt: f.registeredAt,
        windows: f.windows.map((w) => ({ holder: w.holder, start: w.start, end: w.end, earned: lam(w.earned), paid: lam(w.paid), cost: lam(w.cost) })),
        past: withPast ? f.past.map((w) => ({ holder: w.holder, start: w.start, end: w.end, earned: lam(w.earned), paid: lam(w.paid), cost: lam(w.cost) })) : f.past.slice(0, 6).map((w) => ({ holder: w.holder, start: w.start, end: w.end, earned: lam(w.earned), paid: lam(w.paid), cost: lam(w.cost) })),
        hoursSold: f.hoursSold,
        sales: lam(f.sales),
        feesIn: lam(f.feesIn),
        ownerPaid: lam(f.ownerPaid),
        holderPaid: lam(f.holderPaid),
      };
      out.thisHour = { ...lam(c.trades.filter((t) => t.t >= since).reduce((a, t) => a + t.fee, 0)), since, until: r.until, to: r.to, kind: r.kind };
    }
    return out;
  }

  /** The coin page's hour timeline, as src/views.js builds it: the last 12 hours, now, and the hours ahead. */
  timeline(c: FxCoin) {
    const t = Date.now();
    const f = c.ff;
    const segs: Record<string, unknown>[] = [];
    const from = Math.floor((t - 12 * HOUR) / HOUR) * HOUR;
    const feesBetween = (a: number, b: number) => lam(c.trades.filter((x) => x.t >= a && x.t < b).reduce((s, x) => s + x.fee, 0) + (a < t - HOUR ? c.hourly.filter((h) => h[0] >= a && h[0] < Math.min(b, t - HOUR)).reduce((s, h) => s + h[1], 0) : 0));
    const sold = f ? [...f.past, ...f.windows].sort((a, b) => a.start - b.start) : [];
    const devStretch = (a: number, b: number) => {
      for (let x = a; x < b; ) {
        const y = Math.min(b, (Math.floor(x / HOUR) + 1) * HOUR);
        segs.push({ start: x, end: y, kind: 'dev', state: y <= t ? 'past' : x <= t ? 'live' : 'open', to: f?.owner ?? null, fees: x < t ? feesBetween(x, Math.min(y, t)) : null });
        x = y;
      }
    };
    let cur = from;
    for (const w of sold) {
      if (w.end <= from) continue;
      if (w.start > cur) devStretch(cur, Math.min(w.start, Math.max(t, cur)));
      const state = w.end <= t ? 'past' : w.start <= t ? 'live' : 'sold';
      segs.push({ start: Math.max(w.start, from), end: w.end, kind: 'holder', state, holder: w.holder, earned: lam(w.earned), fees: w.start < t ? feesBetween(Math.max(w.start, from), Math.min(w.end, t)) : null, cost: lam(w.cost) });
      cur = Math.max(cur, w.end);
    }
    if (cur < t) devStretch(cur, t);
    const nextStart = f ? Math.max(t, ...f.windows.map((w) => w.end)) : t;
    if (f) {
      const start = Math.max(cur, t);
      const until = t + f.maxAhead * 1000;
      if (until > start) segs.push({ start, end: until, kind: 'open', state: 'open', price: lam(f.price), hours: Math.floor((until - start) / HOUR) });
    }
    return { now: t, from, segments: segs, price: f ? lam(f.price) : null, nextStart, hoursOpen: f ? Math.max(0, Math.min(12, Math.floor((t + f.maxAhead * 1000 - nextStart) / HOUR))) : 0, paused: f ? f.paused : null };
  }

  stats() {
    let feesHour = 0;
    let live = 0;
    for (const c of this.coins.values()) {
      feesHour += this.fees(c).h1.sol;
      if (c.ff) live++;
    }
    return {
      feesHour: lam(feesHour),
      trackedCoins: this.coins.size,
      hoursSoldToday: this.hoursToday,
      paidBuyersToday: lam(this.buyersToday),
      paidDevsToday: lam(this.devsToday),
      solUsd: this.solUsd,
      liveCoins: live,
    };
  }

  board(empty: boolean) {
    const all = [...this.coins.values()];
    const live = empty ? [] : all.filter((c) => c.ff);
    const hot = all.filter((c) => !c.ff || empty).sort((a, b) => this.fees(b).h1.sol - this.fees(a).h1.sol);
    const stats = this.stats();
    if (empty) Object.assign(stats, { hoursSoldToday: 0, paidBuyersToday: lam(0), paidDevsToday: lam(0), liveCoins: 0 });
    const liveRows = live.map((c) => this.coinJson(c));
    let hero: Record<string, unknown> | null = null;
    for (const r of liveRows) {
      const th = r.thisHour as { sol: number } | null;
      if (th && (!hero || th.sol > (hero.thisHour as { sol: number }).sol)) hero = r;
    }
    return { at: Date.now(), v: 1, stats, hero: hero ? { mint: hero.mint, symbol: hero.symbol, image: hero.image, thisHour: hero.thisHour } : null, live: liveRows, hot: hot.map((c) => (empty ? { ...this.coinJson({ ...c, ff: null }) } : this.coinJson(c))) };
  }

  emit(type: string, data: unknown, c?: FxCoin) {
    // sortable ids, like the server's ULIDs
    const id = String(++this.seq).padStart(12, '0');
    const frame = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ ...(data as object), id, type })}\n\n`;
    for (const cl of this.clients) {
      // the empty world shows no live coins: their flipfee events stay out of it
      if (cl.empty && c?.ff && type !== 'trade') continue;
      try {
        cl.res.write(frame);
      } catch {
        this.clients.delete(cl);
      }
    }
  }

  devList(wallet: string): FxCoin[] {
    let list = this.devCoins.get(wallet);
    if (!list) {
      const now = Date.now();
      list = DEV_NAMES.map((n, i) => {
        const c = makeCoin(10 + i, n, now, 'dev' + wallet);
        c.creator = wallet;
        if (i === 3) c.quote = 'usdc';
        return c;
      });
      for (const c of list) {
        for (let k = 0; k < Math.min(600, c.rate * 3600 * 0.5); k++) this.trade(c, now - Math.random() * HOUR, false);
        c.trades.sort((a, b) => a.t - b.t);
        this.coins.set(c.mint, c);
      }
      this.devCoins.set(wallet, list);
    }
    return list;
  }

  register(wallet: string, mint: string, price: number, maxAhead: number) {
    const c = this.coins.get(mint);
    if (!c || c.ff) return false;
    const now = Date.now();
    c.ff = { owner: wallet, price, maxAhead, paused: false, registeredAt: now, windows: [], past: [], hoursSold: 0, sales: 0, feesIn: 0, ownerPaid: 0, holderPaid: 0, pending: 0, lastSync: now };
    this.emit('register', { mint, owner: wallet, price: lam(price), maxAhead, coin: this.coinJson(c) });
    return true;
  }

  buy(buyer: string, mint: string, hours: number, maxPrice: number): string | null {
    const c = this.coins.get(mint);
    if (!c?.ff) return 'NotRegistered';
    const f = c.ff;
    if (f.paused) return 'Paused';
    if (f.price > maxPrice + 1e-9) return 'PriceAboveMax';
    const now = Date.now();
    const start = Math.max(now, ...f.windows.map((w) => w.end));
    const end = start + hours * HOUR;
    if (end - now > f.maxAhead * 1000 + 1000) return 'TooFarAhead';
    const cost = f.price * hours;
    const w: W = { holder: buyer, start, end, earned: 0, paid: 0, cost };
    f.windows.push(w);
    f.hoursSold += hours;
    f.sales += cost;
    this.hoursToday += hours;
    this.emit('buy', { mint, buyer, hours, start, end, paid: lam(cost), price: lam(f.price), sig: '' }, c);
    return null;
  }

  crank() {
    const now = Date.now();
    for (const c of this.coins.values()) {
      const f = c.ff;
      if (!f) continue;
      const amount = f.pending;
      f.pending = 0;
      const from = f.lastSync;
      f.lastSync = now;
      if (amount <= 0) continue;
      f.feesIn += amount;
      this.emit('fee', { mint: c.mint, amount: lam(amount), from, to: now }, c);
      // time-weighted over (from, now]
      let rest = amount;
      for (const w of f.windows) {
        const ov = Math.max(0, Math.min(now, w.end) - Math.max(from, w.start));
        if (!ov) continue;
        const share = (amount * ov) / (now - from);
        w.earned += share;
        w.paid += share;
        rest -= share;
        f.holderPaid += share;
        this.buyersToday += share;
        this.emit('paid', { mint: c.mint, to: w.holder, amount: lam(share), kind: 'holder' }, c);
      }
      if (rest > 1e-9) {
        f.ownerPaid += rest;
        this.devsToday += rest;
        this.emit('paid', { mint: c.mint, to: f.owner, amount: lam(rest), kind: 'owner' }, c);
      }
      // ended windows move to past
      const ended = f.windows.filter((w) => w.end <= now);
      if (ended.length) {
        f.windows = f.windows.filter((w) => w.end > now);
        f.past = [...ended, ...f.past].slice(0, 30);
      }
      this.emit('window', { mint: c.mint, windows: f.windows.map((w) => ({ holder: w.holder, start: w.start, end: w.end, earned: lam(w.earned), paid: lam(w.paid), cost: lam(w.cost) })), feesIn: lam(f.feesIn), ownerPaid: lam(f.ownerPaid), holderPaid: lam(f.holderPaid), hoursSold: f.hoursSold, sales: lam(f.sales), price: lam(f.price), maxAhead: f.maxAhead, paused: f.paused }, c);
    }
  }
}

// ───────── HTTP ─────────

function cookie(req: IncomingMessage, k: string): string {
  const m = new RegExp('(?:^|;\\s*)' + k + '=([^;]*)').exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/** The memo in a fixture transaction: {"ff":"buy"|"connect"|"terms", ...}. */
function readMemo(tx: InstanceType<typeof web3.VersionedTransaction>): { payer: string; memo: Record<string, unknown> | null } {
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  for (const ix of msg.compiledInstructions) {
    if (keys[ix.programIdIndex] !== MEMO) continue;
    try {
      return { payer: keys[0], memo: JSON.parse(Buffer.from(ix.data).toString('utf8')) };
    } catch {
      return { payer: keys[0], memo: null };
    }
  }
  return { payer: keys[0], memo: null };
}

export function fixturePlugin(): Plugin {
  const w = new World();
  let ticking = false;
  const start = () => {
    if (ticking) return;
    ticking = true;
    // trades: each coin at its own rate
    setInterval(() => {
      const now = Date.now();
      for (const c of w.coins.values()) {
        const p = c.rate * 0.25;
        let n = 0;
        let x = Math.random();
        while (x < p && n < 4) {
          n++;
          x += Math.random();
        }
        for (let k = 0; k < n; k++) w.trade(c, now, true);
      }
    }, 250);
    setInterval(() => w.crank(), 20000);
    setInterval(() => {
      w.solUsd = Math.max(120, w.solUsd + (Math.random() - 0.5) * 0.6);
      w.emit('stats', { stats: w.stats() });
    }, 5000);
    // other traders buy hours now and then
    setInterval(() => {
      // KITE and GLOW stay open for tests: an hour bought there starts now and pays at the next crank
      const live = [...w.coins.values()].filter((c) => c.ff && !c.ff.paused && c.symbol !== 'KITE' && c.symbol !== 'GLOW');
      const c = live[Math.floor(Math.random() * live.length)];
      if (c) w.buy(WALLETS[Math.floor(Math.random() * WALLETS.length)], c.mint, 1 + Math.floor(Math.random() * 2), 1e9);
    }, 45000);
    setInterval(() => {
      const hot = [...w.coins.values()].filter((c) => !c.ff);
      const c = hot[Math.floor(Math.random() * Math.min(8, hot.length))];
      if (c) {
        c.wants++;
        w.emit('want', { mint: c.mint, count: c.wants });
      }
    }, 9000);
    setInterval(() => {
      const now = Date.now();
      for (const cl of w.clients) {
        try {
          cl.res.write(`: ping ${now}\n\n`);
        } catch {
          w.clients.delete(cl);
        }
      }
    }, 15000);
  };

  return {
    name: 'flipfee-fixture',
    apply: 'serve',
    configureServer(server) {
      start();
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://x');
        const p = url.pathname;
        const mode = cookie(req, 'fx');
        const empty = mode === 'empty';
        try {
          if (p.startsWith('/fx/img/')) {
            const mint = p.slice(8).replace(/\.svg$/, '');
            const c = w.coins.get(mint);
            res.setHeader('content-type', 'image/svg+xml');
            res.setHeader('cache-control', 'max-age=3600');
            res.end(svgImage(c ?? { symbol: '?', hue: 0 }));
            return;
          }
          if (p === '/fx/rpc' && req.method === 'POST') {
            const b = await body(req);
            const id = b.id;
            const params = (b.params as unknown[]) || [];
            const ok = (result: unknown) => json(res, 200, { jsonrpc: '2.0', id, result });
            const fail = (code: number, message: string, data?: unknown) => json(res, 200, { jsonrpc: '2.0', id, error: { code, message, data } });
            switch (b.method) {
              case 'getBalance':
                return ok({ context: { slot: w.slot }, value: 12_480_000_000 });
              case 'getLatestBlockhash':
                return ok({ context: { slot: w.slot }, value: { blockhash: web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: w.slot + 150 } });
              case 'getSlot':
                return ok(w.slot);
              case 'simulateTransaction': {
                const tx = web3.VersionedTransaction.deserialize(Buffer.from(String(params[0]), 'base64'));
                const { memo } = readMemo(tx);
                if (memo?.ff === 'fail') return ok({ context: { slot: w.slot }, value: { err: { InstructionError: [0, { Custom: 6003 }] }, logs: ['Program log: AnchorError occurred. Error Code: PriceAboveMax. Error Number: 6003.'], unitsConsumed: 1200 } });
                return ok({ context: { slot: w.slot }, value: { err: null, logs: ['Program log: fixture ok'], unitsConsumed: 48_000 } });
              }
              case 'sendTransaction': {
                const raw = Buffer.from(String(params[0]), 'base64');
                const tx = web3.VersionedTransaction.deserialize(raw);
                const sig = tx.signatures[0] ? bs58(tx.signatures[0]) : createHash('sha256').update(raw).digest('hex');
                const { payer, memo } = readMemo(tx);
                let err: unknown = null;
                if (memo?.ff === 'buy') {
                  const e = w.buy(payer, String(memo.mint), Number(memo.hours), Number(memo.maxPrice));
                  if (e) err = { InstructionError: [1, { Custom: 6000 }] };
                } else if (memo?.ff === 'connect') {
                  if (!w.register(payer, String(memo.mint), Number(memo.price), Number(memo.maxAhead))) err = { InstructionError: [0, { Custom: 6010 }] };
                } else if (memo?.ff === 'terms') {
                  const c = w.coins.get(String(memo.mint));
                  if (c?.ff && c.ff.owner === payer) {
                    c.ff.price = Number(memo.price);
                    c.ff.maxAhead = Number(memo.maxAhead);
                    c.ff.paused = !!memo.paused;
                    w.emit('window', { mint: c.mint, windows: c.ff.windows.map((x) => ({ holder: x.holder, start: x.start, end: x.end, earned: lam(x.earned), cost: lam(x.cost) })), price: lam(c.ff.price), maxAhead: c.ff.maxAhead, paused: c.ff.paused }, c);
                  } else err = { InstructionError: [0, { Custom: 6011 }] };
                }
                w.slot++;
                setTimeout(() => w.sigs.set(sig, { err, slot: w.slot }), 700);
                return ok(sig);
              }
              case 'getSignatureStatuses': {
                const list = (params[0] as string[]) || [];
                return ok({ context: { slot: w.slot }, value: list.map((s) => (w.sigs.has(s) ? { slot: w.sigs.get(s)!.slot, confirmations: 1, err: w.sigs.get(s)!.err, confirmationStatus: 'confirmed' } : null)) });
              }
              case 'getAccountInfo':
                return ok({ context: { slot: w.slot }, value: null });
              default:
                return fail(-32601, 'fixture: method ' + String(b.method));
            }
          }
          if (!p.startsWith('/api/')) return next();
          const a = p.slice(4);
          if (a === '/health') return json(res, 200, { ok: true, fixture: true, cluster: 'mainnet-beta', programId: null });
          if (a === '/board') {
            if (mode === 'down') return json(res, 503, { error: 'busy' });
            return json(res, 200, w.board(empty));
          }
          if (a.startsWith('/coin/')) {
            const c = w.coins.get(a.slice(6));
            if (!c) return json(res, 404, { error: 'notFound' });
            const j = empty ? w.coinJson({ ...c, ff: null }, true) : w.coinJson(c, true);
            return json(res, 200, { coin: j, trades: c.trades.slice(-100).reverse().map((t) => w.tradeOut(c, t)), timeline: empty ? null : w.timeline(c) });
          }
          if (a.startsWith('/dev/')) {
            const wallet = a.slice(5);
            const list = w.devList(wallet);
            const elig = ['ready-new', 'almost', 'locked', 'usdc'];
            return json(res, 200, {
              wallet,
              coins: list.map((c, i) => {
                const fees = w.fees(c);
                const sug = fees.h1.sol > 0 ? fees.h1.sol * 0.8 : fees.h6.sol / 6 * 0.8;
                return { ...w.coinJson(c), eligibility: { kind: c.ff ? 'flipfee' : elig[i], admin: wallet, graduated: c.graduated, quoteMint: c.quote === 'usdc' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : 'So11111111111111111111111111111111111111112' }, suggested: lam(Math.max(0.01, Math.round(sug * 1000) / 1000)) };
              }),
            });
          }
          if (a.startsWith('/me/')) {
            const wallet = a.slice(4);
            const hours: unknown[] = [];
            let spent = 0;
            let received = 0;
            for (const c of w.coins.values()) {
              if (!c.ff) continue;
              for (const x of [...c.ff.windows, ...c.ff.past]) {
                if (x.holder !== wallet) continue;
                spent += x.cost;
                received += x.paid;
                const now = Date.now();
                const state = x.start <= now && now < x.end ? 'live' : x.start > now ? 'upcoming' : 'past';
                const r = state === 'live' ? w.recipient(c, now) : null;
                const live = r ? { ...lam(c.trades.filter((t) => t.t >= r.since).reduce((a, t) => a + t.fee, 0)), since: r.since, until: r.until, to: r.to, kind: r.kind } : null;
                hours.push({ mint: c.mint, symbol: c.symbol, name: c.name, image: `/fx/img/${c.mint}.svg`, holder: x.holder, start: x.start, end: x.end, hours: Math.round((x.end - x.start) / HOUR), earned: lam(x.earned), paid: lam(x.paid), cost: lam(x.cost), state, live });
              }
            }
            const mine = [...w.coins.values()].filter((c) => c.ff?.owner === wallet);
            const wanted = [...w.coins.values()].filter((c) => c.wanted.has(wallet)).map((c) => c.mint);
            return json(res, 200, { wallet, hours, wants: wanted, coins: mine.map((c) => w.coinJson(c)), totals: { spent: lam(spent), received: lam(received), devSales: lam(mine.reduce((s, c) => s + c.ff!.sales * 0.95, 0)), devFees: lam(mine.reduce((s, c) => s + c.ff!.ownerPaid, 0)) } });
          }
          if (a === '/stream') {
            res.statusCode = 200;
            res.setHeader('content-type', 'text/event-stream');
            res.setHeader('cache-control', 'no-cache, no-transform');
            res.setHeader('connection', 'keep-alive');
            res.write('retry: 2000\n\n');
            const cl = { res, empty };
            w.clients.add(cl);
            res.write(`event: stats\ndata: ${JSON.stringify({ stats: w.stats() })}\n\n`);
            req.on('close', () => w.clients.delete(cl));
            return;
          }
          if (a === '/auth/nonce' && req.method === 'POST') {
            const b = await body(req);
            const address = String(b.address || '');
            const nonce = randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');
            const host = req.headers.host || '127.0.0.1:5197';
            const t = new Date();
            const input = { domain: host, address, statement: 'Sign in to flipfee.', uri: 'http://' + host, version: '1', chainId: 'mainnet', nonce, issuedAt: t.toISOString(), expirationTime: new Date(t.getTime() + 600e3).toISOString() };
            const message = `${host} wants you to sign in with your Solana account:\n${address}\n\nSign in to flipfee.\n\nURI: http://${host}\nVersion: 1\nChain ID: mainnet\nNonce: ${nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expirationTime}`;
            w.nonces.set(nonce, { address, message });
            return json(res, 200, { nonce, message, input });
          }
          if (a === '/auth/verify' && req.method === 'POST') {
            const b = await body(req);
            const address = String(b.address || '');
            const sig = String(b.signature || '');
            const msg = typeof b.signedMessage === 'string' ? Buffer.from(b.signedMessage, 'base64').toString('utf8') : String(b.message || '');
            let ok = false;
            try {
              const pub = new web3.PublicKey(address).toBytes();
              const sigBytes = fromB58(sig);
              const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub)]), format: 'der', type: 'spki' });
              ok = verify(null, Buffer.from(msg, 'utf8'), key, Buffer.from(sigBytes));
            } catch {
              ok = false;
            }
            if (!ok) return json(res, 401, { error: 'badSignature', message: 'signature check failed' });
            const token = randomBytes(18).toString('base64url');
            const exp = Date.now() + 24 * HOUR;
            w.sessions.set(token, { address, exp });
            return json(res, 200, { token, address, expiresAt: exp });
          }
          if (a === '/want' && req.method === 'POST') {
            const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            const s = w.sessions.get(tok);
            if (!s) return json(res, 401, { error: 'signIn', message: 'sign in first' });
            const b = await body(req);
            const c = w.coins.get(String(b.mint || ''));
            if (!c) return json(res, 404, { error: 'notFound' });
            if (!c.wanted.has(s.address)) {
              c.wanted.add(s.address);
              c.wants++;
              w.emit('want', { mint: c.mint, count: c.wants, wallet: s.address });
            }
            return json(res, 200, { ok: true, mint: c.mint, count: c.wants, wanted: true });
          }
          if (a.startsWith('/wants/')) {
            const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            const s = w.sessions.get(tok);
            const mine = s ? [...w.coins.values()].filter((c) => c.wanted.has(s.address)).map((c) => c.mint) : [];
            return json(res, 200, { mints: mine });
          }
          return json(res, 404, { error: 'notFound' });
        } catch (e) {
          return json(res, 500, { error: 'fixture', message: String(e) });
        }
      });
    },
  };
}

function bs58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const d: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let c = bytes[i];
    for (let j = 0; j < d.length; j++) {
      c += d[j] << 8;
      d[j] = c % 58;
      c = (c / 58) | 0;
    }
    while (c) {
      d.push(c % 58);
      c = (c / 58) | 0;
    }
  }
  let s = '1'.repeat(zeros);
  for (let i = d.length - 1; i >= 0; i--) s += B58[d[i]];
  return s;
}

function fromB58(s: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new Error('b58');
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}
