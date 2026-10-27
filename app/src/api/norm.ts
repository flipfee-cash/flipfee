// Wire → app shapes. The server sends amounts as lamport strings plus SOL numbers (DESIGN.md §2.2) and times as ms or
// unix seconds; these readers accept either, so a renamed field shows up as a 0 here instead of a crash in a view.
import type { Board, Book, Coin, Level, Order, CoinPage, DevCoin, DevReply, Eligibility, FF, Fees, MeReply, MyHour, Seg, Stats, StreamEvent, ThisHour, Timeline, Trade, Win } from './types.ts';

type O = Record<string, unknown>;

const isObj = (x: unknown): x is O => !!x && typeof x === 'object' && !Array.isArray(x);

export function num(x: unknown, d = 0): number {
  if (typeof x === 'number') return Number.isFinite(x) ? x : d;
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x);
    return Number.isFinite(n) ? n : d;
  }
  if (typeof x === 'bigint') return Number(x);
  return d;
}

const str = (x: unknown, d = ''): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : d);

/** A time as ms: unix seconds, ms, or an ISO string. */
export function ms(x: unknown, d = 0): number {
  if (typeof x === 'string' && /[-T:]/.test(x)) {
    const t = Date.parse(x);
    return Number.isFinite(t) ? t : d;
  }
  const n = num(x, NaN);
  if (!Number.isFinite(n) || n <= 0) return d;
  return n < 1e11 ? n * 1000 : n;
}

/** A SOL amount under `k`: `kSol` · `k: {sol, lamports}` · `kLamports` · `k` (lamport string, or a SOL number). */
export function solOf(o: O | null | undefined, k: string, d = 0): number {
  if (!o) return d;
  const s = o[k + 'Sol'];
  if (typeof s === 'number' || typeof s === 'string') return num(s, d);
  const v = o[k];
  if (isObj(v)) {
    if (v.sol !== undefined) return num(v.sol, d);
    if (v.lamports !== undefined) return num(v.lamports, d * 1e9) / 1e9;
  }
  const l = o[k + 'Lamports'];
  if (l !== undefined) return num(l, d * 1e9) / 1e9;
  if (typeof v === 'string' && /^\d+$/.test(v)) return num(v) / 1e9;
  if (typeof v === 'number') return v;
  return d;
}

/** Exact lamports under `k` as a decimal string ('' when only a SOL number came). */
export function lamportsOf(o: O | null | undefined, k: string): string {
  if (!o) return '';
  const v = o[k];
  if (isObj(v) && v.lamports !== undefined) return str(v.lamports);
  const l = o[k + 'Lamports'];
  if (l !== undefined) return str(l);
  if (typeof v === 'string' && /^\d+$/.test(v)) return v;
  const s = solOf(o, k, NaN);
  return Number.isFinite(s) ? String(Math.round(s * 1e9)) : '';
}

function win(x: unknown): Win | null {
  if (!isObj(x)) return null;
  const holder = str(x.holder ?? x.buyer ?? x.wallet);
  const start = ms(x.start ?? x.startAt ?? x.from);
  const end = ms(x.end ?? x.endAt ?? x.to);
  if (!holder || !start || !end) return null;
  const w: Win = { holder, start, end, earned: solOf(x, 'earned') };
  if (x.paid !== undefined || x.paidSol !== undefined || x.paidLamports !== undefined) w.paid = solOf(x, 'paid');
  if (x.cost !== undefined || x.costSol !== undefined || x.costLamports !== undefined) w.cost = solOf(x, 'cost');
  else if (x.price !== undefined || x.priceSol !== undefined) w.cost = solOf(x, 'price');
  if (typeof x.sig === 'string') w.sig = x.sig;
  return w;
}

const wins = (x: unknown): Win[] => (Array.isArray(x) ? (x.map(win).filter(Boolean) as Win[]) : []);

function ff(x: unknown): FF | null {
  if (!isObj(x)) return null;
  const owner = str(x.owner ?? x.dev);
  if (!owner) return null;
  const windows = wins(x.windows).sort((a, b) => a.start - b.start);
  return {
    owner,
    price: solOf(x, 'price'),
    priceLamports: lamportsOf(x, 'price'),
    maxAhead: num(x.maxAhead ?? x.max_ahead, 86400),
    paused: !!x.paused,
    registeredAt: ms(x.registeredAt ?? x.createdAt),
    windows,
    past: wins(x.past ?? x.pastWindows).sort((a, b) => b.start - a.start),
    hoursSold: num(x.hoursSold ?? x.hours_sold),
    sales: solOf(x, 'sales'),
    feesIn: solOf(x, 'feesIn'),
    ownerPaid: solOf(x, 'ownerPaid', solOf(x, 'devPaid')),
    holderPaid: solOf(x, 'holderPaid', solOf(x, 'holdersPaid')),
  };
}

/** A fee window: `{ lamports, sol, exact, est? }`. A window the server saw only in part shows its estimate. */
function feeWin(f: O, ...ks: string[]): [number, boolean] {
  for (const k of ks) {
    const w = f[k];
    if (isObj(w) && w.exact === false && isObj(w.est)) return [Math.max(num(w.est.sol, 0), num(w.sol, 0)), true];
    const v = solOf(f, k, NaN);
    if (Number.isFinite(v)) return [v, false];
  }
  return [0, false];
}

function fees(o: O): Fees {
  const f = isObj(o.fees) ? o.fees : isObj(o.metrics) && isObj(o.metrics.fees) ? o.metrics.fees : isObj(o.metrics) ? o.metrics : o;
  const [m1] = feeWin(f, 'm1', '1m', 'fees1m');
  const [m10] = feeWin(f, 'm10', '10m', 'fees10m');
  const [h1, e1] = feeWin(f, 'h1', '1h', 'fees1h', 'lastHour');
  const [h6, e6] = feeWin(f, 'h6', '6h', 'fees6h');
  const [h24, e24] = feeWin(f, 'h24', '24h', 'fees24h');
  return { m1, m10, h1, h6, h24, est: { h1: e1, h6: e6, h24: e24 } };
}

function thisHour(x: unknown, f: FF | null, creator: string): ThisHour | null {
  if (!isObj(x)) return null;
  const kind = x.kind === 'holder' || x.kind === 'dev' ? x.kind : x.kind === 'owner' ? 'dev' : f?.windows.length ? 'holder' : 'dev';
  return { sol: solOf(x, 'sol', solOf(x, 'amount')), since: ms(x.since ?? x.from, Date.now()), until: ms(x.until), to: str(x.to, f?.owner ?? creator), kind };
}

const QUOTES = new Set(['sol', 'usdc']);

export function coin(x: unknown): Coin | null {
  if (!isObj(x)) return null;
  const mint = str(x.mint ?? x.address);
  if (!mint) return null;
  const m = isObj(x.metrics) ? x.metrics : x;
  const f = ff(x.flipfee ?? x.ff ?? x.listing ?? null);
  const creator = str(x.creator ?? x.dev);
  const quoteRaw = str(x.quote ?? x.quoteMint ?? 'sol').toLowerCase();
  const quote = QUOTES.has(quoteRaw) ? (quoteRaw as 'sol' | 'usdc') : quoteRaw.startsWith('so111') || quoteRaw === 'wsol' ? 'sol' : quoteRaw.startsWith('epjfw') ? 'usdc' : 'other';
  const hourly: [number, number][] = Array.isArray(x.hourly)
    ? (x.hourly as unknown[]).map((h) => (Array.isArray(h) ? [ms(h[0]), num(h[1])] : isObj(h) ? [ms(h.start ?? h.t), solOf(h, 'fees', solOf(h, 'sol'))] : [0, 0]) as [number, number]).filter((h) => h[0] > 0)
    : [];
  const c: Coin = {
    mint,
    symbol: str(x.symbol ?? x.ticker).slice(0, 24),
    name: str(x.name).slice(0, 64),
    image: str(x.image ?? x.imageUri ?? x.image_uri),
    createdAt: ms(x.createdAt ?? x.created ?? x.created_timestamp),
    mcapUsd: num(m.mcapUsd ?? m.marketCapUsd ?? m.usd_market_cap ?? x.mcapUsd),
    graduated: !!(x.graduated ?? x.complete),
    creator,
    admin: str(x.admin ?? x.feeAdmin ?? creator),
    quote,
    fees: fees(x),
    trades1h: num(m.trades1h ?? m.trades ?? x.trades1h),
    trades1hPart: isObj(x.fees) && isObj(x.fees.h1) && x.fees.h1.exact === false,
    volume1h: solOf(m, 'volume1h', solOf(m, 'volume')),
    wants: num(x.wants ?? x.want),
    hourly,
    hidden: !!(x.hidden ?? x.masked ?? x.flagged),
    ff: f,
    thisHour: null,
    socials: isObj(x.socials) ? { twitter: str(x.socials.twitter) || undefined, telegram: str(x.socials.telegram) || undefined, website: str(x.socials.website) || undefined } : {},
    ageSec: num(x.ageSec, 0),
    canJoin: typeof x.canJoin === 'boolean' ? x.canJoin : null,
    links: isObj(x.links) ? { pumpfun: str(x.links.pumpfun) || undefined, dexscreener: str(x.links.dexscreener) || undefined, solscan: str(x.links.solscan) || undefined } : {},
    description: typeof x.description === 'string' ? x.description : undefined,
  };
  c.thisHour = thisHour(x.thisHour ?? x.now ?? null, f, creator);
  const rec = x.recent ?? x.trades;
  if (Array.isArray(rec) && rec.length) c.recent = (rec as unknown[]).map((t) => trade(isObj(t) && !t.mint ? { ...t, mint } : t)).filter(Boolean) as Trade[];
  return c;
}

const coins = (x: unknown): Coin[] => (Array.isArray(x) ? (x.map(coin).filter(Boolean) as Coin[]) : []);

export function stats(x: unknown): Stats | null {
  if (!isObj(x)) return null;
  return {
    feesHour: solOf(x, 'feesHour', solOf(x, 'creatorFeesHour', solOf(x, 'fees1h'))),
    trackedCoins: num(x.trackedCoins ?? x.tracked),
    feesHourCoins: num(x.feesHourCoins),
    hoursSoldToday: num(x.hoursSoldToday ?? x.hoursToday),
    paidBuyersToday: solOf(x, 'paidBuyersToday', solOf(x, 'buyersToday')),
    paidDevsToday: solOf(x, 'paidDevsToday', solOf(x, 'devsToday')),
    solUsd: num(x.solUsd ?? x.sol_usd),
    liveCoins: num(x.liveCoins ?? x.live),
  };
}

export function board(x: unknown): Board | null {
  if (!isObj(x)) return null;
  const s = stats(x.stats);
  if (!s && !Array.isArray(x.live) && !Array.isArray(x.hot)) return null;
  return {
    at: ms(x.at ?? x.now, Date.now()),
    stats: s ?? stats({})!,
    live: coins(x.live),
    hot: coins(x.hot),
    hero: isObj(x.hero) && typeof x.hero.mint === 'string' ? x.hero.mint : typeof x.hero === 'string' ? x.hero : null,
  };
}

export function trade(x: unknown): Trade | null {
  if (!isObj(x)) return null;
  const mint = str(x.mint);
  if (!mint) return null;
  const sig = str(x.sig ?? x.signature) || undefined;
  const side = x.side === 'sell' || x.isBuy === false || x.type === 'sell' ? 'sell' : 'buy';
  const t = ms(x.t ?? x.at ?? x.ts ?? x.time, Date.now());
  return {
    // the same trade comes from a snapshot (no event id) and the stream (an event id): key it by signature + index
    id: sig ? sig + ':' + str(x.ix ?? 0) : str(x.id) || mint + ':' + t + ':' + Math.random().toString(36).slice(2, 7),
    mint,
    t,
    side,
    sol: solOf(x, 'sol', solOf(x, 'amount')),
    fee: solOf(x, 'fee', solOf(x, 'creatorFee')),
    wallet: str(x.wallet ?? x.trader ?? x.user),
    sig,
  };
}

export const trades = (x: unknown): Trade[] => (Array.isArray(x) ? (x.map(trade).filter(Boolean) as Trade[]) : []);

function seg(x: unknown): Seg | null {
  if (!isObj(x)) return null;
  const start = ms(x.start);
  const end = ms(x.end);
  if (!start || !end) return null;
  const kind = x.kind === 'holder' || x.kind === 'open' ? x.kind : 'dev';
  const state = x.state === 'past' || x.state === 'live' || x.state === 'sold' ? x.state : 'open';
  const out: Seg = { start, end, kind, state };
  if (typeof x.holder === 'string') out.holder = x.holder;
  if (x.fees !== undefined && x.fees !== null) out.fees = solOf(x, 'fees');
  if (x.earned !== undefined && x.earned !== null) out.earned = solOf(x, 'earned');
  if (x.cost !== undefined && x.cost !== null) out.cost = solOf(x, 'cost');
  if (x.price !== undefined && x.price !== null) out.price = solOf(x, 'price');
  if (x.hours !== undefined) out.hours = num(x.hours);
  return out;
}

function timeline(x: unknown): Timeline | null {
  if (!isObj(x) || !Array.isArray(x.segments)) return null;
  return {
    now: ms(x.now, Date.now()),
    from: ms(x.from),
    segments: (x.segments as unknown[]).map(seg).filter(Boolean) as Seg[],
    price: solOf(x, 'price'),
    nextStart: ms(x.nextStart),
    hoursOpen: num(x.hoursOpen),
    paused: !!x.paused,
  };
}

export function coinPage(x: unknown): CoinPage | null {
  if (!isObj(x)) return null;
  const c = coin(x.coin ?? x);
  if (!c) return null;
  return { coin: c, trades: trades(x.trades), timeline: timeline(x.timeline) };
}

const ELIG = new Set<Eligibility>(['ready-new', 'ready', 'almost', 'locked', 'flipfee', 'usdc', 'not-admin', 'unsupported', 'not-found']);

export function devReply(x: unknown, wallet: string): DevReply {
  const list = isObj(x) && Array.isArray(x.coins) ? x.coins : Array.isArray(x) ? x : [];
  const out: DevCoin[] = [];
  for (const raw of list) {
    const c = coin(raw);
    if (!c || !isObj(raw)) continue;
    const e = isObj(raw.eligibility) ? raw.eligibility : { kind: raw.eligibility };
    const kind = str(e.kind) as Eligibility;
    if (isObj(raw.eligibility) && typeof raw.eligibility.admin === 'string') c.admin = raw.eligibility.admin;
    if (isObj(raw.eligibility) && typeof raw.eligibility.graduated === 'boolean') c.graduated = raw.eligibility.graduated;
    const sug = solOf(raw, 'suggested', solOf(raw, 'suggestedPrice', 0));
    out.push({ ...c, eligibility: ELIG.has(kind) ? kind : c.ff ? 'flipfee' : 'not-admin', suggested: sug > 0 ? sug : suggestPrice(c) });
  }
  return { wallet: isObj(x) ? str(x.wallet, wallet) : wallet, coins: out };
}

/** DESIGN.md §1.2: 80% of the last hour's creator fees (fallback: last 6 h ÷ 6), inside 0.01–1000 SOL. */
export function suggestPrice(c: Pick<Coin, 'fees'>): number {
  const base = c.fees.h1 > 0 ? c.fees.h1 : c.fees.h6 / 6;
  const p = base * 0.8;
  if (!(p > 0)) return 0.01;
  const r = p >= 1 ? Math.round(p * 100) / 100 : p >= 0.1 ? Math.round(p * 1000) / 1000 : Math.round(p * 10000) / 10000;
  return Math.min(1000, Math.max(0.01, r));
}

export function meReply(x: unknown, wallet: string): MeReply {
  const o = isObj(x) ? x : {};
  const hours: MyHour[] = [];
  for (const raw of Array.isArray(o.hours) ? o.hours : []) {
    const w = win(raw);
    if (!w || !isObj(raw)) continue;
    const c = isObj(raw.coin) ? raw.coin : raw;
    const now = Date.now();
    const state = raw.state === 'live' || raw.state === 'upcoming' || raw.state === 'past' ? raw.state : w.start <= now && now < w.end ? 'live' : w.start > now ? 'upcoming' : 'past';
    hours.push({
      ...w,
      mint: str(c.mint ?? raw.mint),
      symbol: str(c.symbol),
      name: str(c.name),
      image: str(c.image),
      hours: num(raw.hours, Math.round((w.end - w.start) / 3600e3)),
      state,
      live: thisHour(raw.live ?? null, null, ''),
    });
  }
  const t = isObj(o.totals) ? o.totals : o;
  return {
    wallet: str(o.wallet, wallet),
    hours: hours.sort((a, b) => b.start - a.start),
    coins: coins(o.coins),
    spent: solOf(t, 'spent'),
    received: solOf(t, 'received'),
    devSales: solOf(t, 'devSales'),
    devFees: solOf(t, 'devFees'),
    wants: Array.isArray(o.wants) ? (o.wants as unknown[]).filter((m): m is string => typeof m === 'string') : [],
  };
}

/** One SSE frame → a typed event (null when it carries nothing the app reads). */
export function streamEvent(type: string, x: unknown): StreamEvent | null {
  if (!isObj(x)) return null;
  const mint = str(x.mint);
  switch (type) {
    case 'trade': {
      const t = trade(x.trade ?? x);
      return t ? { type, trade: t } : null;
    }
    case 'fee':
      return mint ? { type, mint, amount: solOf(x, 'amount'), from: ms(x.from), to: ms(x.to, Date.now()) } : null;
    case 'window': {
      if (!mint) return null;
      const f = ff({ owner: 'x', ...x });
      return { type, mint, windows: wins(x.windows), ff: f ? { ...f, owner: str(x.owner) || undefined } as Partial<FF> : undefined };
    }
    case 'buy':
      return mint
        ? { type, mint, buyer: str(x.buyer ?? x.holder ?? x.wallet), hours: num(x.hours, 1), start: ms(x.start), end: ms(x.end), paid: solOf(x, 'paid', solOf(x, 'cost', solOf(x, 'amount'))), sig: str(x.sig) || undefined }
        : null;
    case 'paid':
      return mint ? { type, mint, to: str(x.to ?? x.wallet), amount: solOf(x, 'amount'), kind: x.kind === 'owner' || x.kind === 'dev' ? 'owner' : 'holder', sig: str(x.sig) || undefined } : null;
    case 'register': {
      const c = coin(x.coin ?? null);
      return mint || c ? { type, mint: mint || c!.mint, owner: str(x.owner), coin: c, price: solOf(x, 'price'), maxAhead: num(x.maxAhead, 86400), sig: str(x.sig) || undefined } : null;
    }
    case 'stats': {
      const s = stats(x.stats ?? x);
      return s ? { type, stats: s } : null;
    }
    case 'want':
      return mint ? { type, mint, count: num(x.count ?? x.wants), wallet: str(x.wallet) || undefined } : null;
    case 'book':
      return mint ? { type, mint } : null;
    default:
      return null;
  }
}

const solAmt = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const o = v as { sol?: unknown; lamports?: unknown };
  if (typeof o.lamports === 'string' && /^\d+$/.test(o.lamports)) return Number(o.lamports) / 1e9;
  return Number.isFinite(Number(o.sol)) ? Number(o.sol) : null;
};

function level(x: unknown): Level | null {
  const o = (x ?? {}) as Record<string, unknown>;
  const price = solAmt(o);
  if (price === null) return null;
  return { price, hours: num(o.hours), orders: num(o.orders), house: o.house === true, mine: num(o.mine) };
}

export function order(x: unknown): Order | null {
  const o = (x ?? {}) as Record<string, unknown>;
  const price = solAmt(o.price);
  if (typeof o.id !== 'string' || price === null || (o.side !== 'bid' && o.side !== 'ask')) return null;
  return { id: o.id, mint: str(o.mint), side: o.side, price, hours: num(o.hours), t: num(o.t), house: o.house === true };
}

/** GET /api/book/:mint (and the short book on market rows). */
export function book(x: unknown, mint = ''): Book {
  const o = (x ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(level).filter((l): l is Level => !!l) : []);
  return {
    mint: str(o.mint) || mint,
    bids: list(o.bids),
    asks: list(o.asks),
    bestBid: solAmt(o.bestBid),
    bestAsk: solAmt(o.bestAsk),
    spread: solAmt(o.spread),
    mid: solAmt(o.mid),
    orders: num(o.orders),
    mine: Array.isArray(o.mine) ? o.mine.map(order).filter((r): r is Order => !!r) : [],
  };
}

/** GET /api/market: rows with a short book each. */
export function market(x: unknown): { coin: Coin; book: Book }[] {
  const list = (x as { coins?: unknown } | null)?.coins;
  if (!Array.isArray(list)) return [];
  const out: { coin: Coin; book: Book }[] = [];
  for (const r of list) {
    const c = coin(r);
    if (c) out.push({ coin: c, book: book((r as { book?: unknown }).book, c.mint) });
  }
  return out;
}
