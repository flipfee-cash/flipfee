// The board: ticker stats, every coin the app knows (live = on flipfee, hot = tracked pump.fun coins), and the stream
// state. Snapshots (`/api/board`, a localStorage copy on repeat visits) set it; stream events move the numbers between
// snapshots. Rows re-sort only on a snapshot, so the board stays calm while the numbers flip.
import { createStore } from './store.ts';
import type { Board, Coin, FF, Stats, StreamEvent, Trade, Win } from '../api/types.ts';
import type { Conn } from '../api/stream.ts';
import { addTrades, recentTrades } from './trades.ts';
import { serverNow } from '../lib/clock.tsx';

interface BoardState {
  stats: Stats | null;
  /** the server's pick for the hero counter */
  hero: string | null;
  coins: Record<string, Coin>;
  /** mints on flipfee, by paid last hour */
  live: string[];
  /** tracked pump.fun coins off flipfee, by creator fees last hour */
  hot: string[];
  ready: boolean;
  /** the first snapshot failed (and nothing was cached) */
  failed: boolean;
  /** showing the localStorage copy until the snapshot lands */
  cached: boolean;
  conn: Conn;
  at: number;
}

export const board = createStore<BoardState>({ stats: null, hero: null, coins: {}, live: [], hot: [], ready: false, failed: false, cached: false, conn: 'connecting', at: 0 });

// ───────── cash moments (rows, the hero and the sound listen) ─────────

export interface CashEvent {
  kind: 'paid' | 'sale' | 'buy';
  mint: string;
  to: string;
  amount: number;
  /** for a sale: the hours sold */
  hours?: number;
}
type CashFn = (e: CashEvent) => void;
const cashSubs = new Set<CashFn>();
export function onCash(fn: CashFn): () => void {
  cashSubs.add(fn);
  return () => void cashSubs.delete(fn);
}
const emitCash = (e: CashEvent) => {
  for (const fn of cashSubs) fn(e);
};

// ───────── helpers ─────────

const byPaid = (coins: Record<string, Coin>) => (a: string, b: string) => (coins[b]?.fees.h1 ?? 0) - (coins[a]?.fees.h1 ?? 0) || a.localeCompare(b);

/** The window that holds the coin now (start ≤ now < end). */
export function currentWindow(c: Coin, now = serverNow()): Win | null {
  for (const w of c.ff?.windows ?? []) if (w.start <= now && now < w.end) return w;
  return null;
}

/** When a new buy would start: now, or the end of the last sold hour. */
export function nextStart(c: Coin, now = serverNow()): number {
  let s = now;
  for (const w of c.ff?.windows ?? []) if (w.end > s) s = w.end;
  return s;
}

/** Hours a buyer can still take within the dev's limit (0..12). */
export function hoursOpen(c: Coin, now = serverNow()): number {
  if (!c.ff) return 0;
  const room = (now + c.ff.maxAhead * 1000 - nextStart(c, now)) / 3600e3;
  return Math.max(0, Math.min(12, Math.floor(room + 1e-6)));
}

/**
 * Who gets the fees right now and since when, as the server counts "this hour": a holder's hour starts on the window's
 * hour marks (a 3 h window has three hours); the dev's hour starts at the clock hour, the last window's end or the
 * listing, whichever is latest.
 */
export function recipientNow(c: Coin, now = serverNow()): { to: string; kind: 'holder' | 'dev'; since: number; until: number } {
  const w = currentWindow(c, now);
  if (w) {
    const since = w.start + Math.floor((now - w.start) / 3600e3) * 3600e3;
    return { to: w.holder, kind: 'holder', since, until: Math.min(w.end, since + 3600e3) };
  }
  let lastEnd = 0;
  for (const x of [...(c.ff?.windows ?? []), ...(c.ff?.past ?? [])]) if (x.end <= now && x.end > lastEnd) lastEnd = x.end;
  const since = Math.max(Math.floor(now / 3600e3) * 3600e3, lastEnd, c.ff?.registeredAt ?? 0);
  let until = 0;
  for (const x of c.ff?.windows ?? []) if (x.start > now && (!until || x.start < until)) until = x.start;
  return { to: c.ff?.owner ?? c.creator, kind: 'dev', since, until };
}

/** Rebuilds "this hour" from the coin's trades when the recipient changes. */
function freshThisHour(c: Coin, trades: Trade[], now = serverNow()): Coin['thisHour'] {
  const r = c.ff ? recipientNow(c, now) : { to: c.creator, kind: 'dev' as const, since: Math.floor(now / 3600e3) * 3600e3, until: 0 };
  let sol = 0;
  for (const t of trades) if (t.t >= r.since) sol += t.fee;
  return { sol, since: r.since, until: r.until, to: r.to, kind: r.kind };
}

// ───────── snapshot ─────────

const CACHE = 'flipfee.board.v1';

export function applyBoard(b: Board, fromCache = false): void {
  const s = board.get();
  const coins: Record<string, Coin> = {};
  // a coin the stream already moved keeps its newer live numbers until the next snapshot says otherwise
  for (const c of [...b.live, ...b.hot]) {
    if (c.hidden) continue;
    if (c.recent?.length) addTrades(c.recent, false);
    delete c.recent;
    coins[c.mint] = c;
  }
  // keep coins pages or Me opened (they are off the board) so their rows keep working
  for (const [m, c] of Object.entries(s.coins)) if (!coins[m] && keep.has(m)) coins[m] = c;
  const live = b.live.filter((c) => !c.hidden && c.ff).map((c) => c.mint);
  const hot = b.hot.filter((c) => !c.hidden && !c.ff && !live.includes(c.mint)).map((c) => c.mint);
  const now = serverNow();
  for (const m of [...live, ...hot]) {
    const c = coins[m];
    if (!c.thisHour) c.thisHour = freshThisHour(c, [], now);
  }
  live.sort(byPaid(coins));
  hot.sort(byPaid(coins));
  board.set({ stats: b.stats, hero: b.hero && live.includes(b.hero) ? b.hero : null, coins, live, hot, ready: true, failed: false, cached: fromCache, at: b.at });
  if (!fromCache) saveSoon();
}

/** Coins the app looked at off the board (coin page, Me, Dev). */
const keep = new Set<string>();
export function putCoin(c: Coin): void {
  keep.add(c.mint);
  const cur = board.get().coins[c.mint];
  if (!c.thisHour) c.thisHour = cur?.thisHour ?? freshThisHour(c, []);
  board.set((s) => ({ coins: { ...s.coins, [c.mint]: c } }));
}

let saveTimer = 0;
function saveSoon(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const s = board.get();
    if (!s.stats) return;
    try {
      const pick = (m: string) => s.coins[m];
      localStorage.setItem(CACHE, JSON.stringify({ v: 1, at: s.at, stats: s.stats, live: s.live.slice(0, 30).map(pick), hot: s.hot.slice(0, 30).map(pick) }));
    } catch {
      // storage is optional
    }
  }, 1500);
}

/** The last board this browser saw (for a first paint before the snapshot lands), if under 6 hours old. */
export function cachedBoard(): Board | null {
  try {
    const j = JSON.parse(localStorage.getItem(CACHE) || 'null') as (Board & { v: number }) | null;
    if (!j || j.v !== 1 || !Array.isArray(j.live) || Date.now() - j.at > 6 * 3600e3) return null;
    return { at: j.at, stats: j.stats, live: j.live.filter(Boolean), hot: j.hot.filter(Boolean), hero: null };
  } catch {
    return null;
  }
}

// ───────── stream ─────────

function patchFF(c: Coin, p: Partial<FF>): Coin {
  if (!c.ff) return c;
  return { ...c, ff: { ...c.ff, ...p } };
}

/** Applies a batch of stream events (one animation frame's worth). */
export function applyEvents(list: StreamEvent[]): void {
  const s = board.get();
  let coins: Record<string, Coin> | null = null;
  let stats: Stats | null = s.stats;
  let live = s.live;
  let hot = s.hot;
  const now = serverNow();
  const edit = (mint: string): Coin | null => {
    const cur = (coins ?? s.coins)[mint];
    if (!cur) return null;
    coins ??= { ...s.coins };
    return cur;
  };
  const tradesIn: Trade[] = [];
  const cash: CashEvent[] = [];

  for (const e of list) {
    switch (e.type) {
      case 'trade':
        tradesIn.push(e.trade);
        break;
      case 'stats':
        stats = e.stats;
        break;
      case 'want': {
        const c = edit(e.mint);
        if (c) coins![e.mint] = { ...c, wants: Math.max(e.count, 0) };
        break;
      }
      case 'fee': {
        const c = edit(e.mint);
        if (c?.ff) coins![e.mint] = patchFF(c, { feesIn: c.ff.feesIn + e.amount });
        break;
      }
      case 'window': {
        const c = edit(e.mint);
        if (c?.ff) {
          const p: Partial<FF> = { windows: e.windows.sort((a, b) => a.start - b.start) };
          if (e.ff) for (const k of ['price', 'priceLamports', 'maxAhead', 'paused', 'hoursSold', 'sales', 'feesIn', 'ownerPaid', 'holderPaid'] as const) if (e.ff[k] !== undefined && (k !== 'priceLamports' || e.ff[k])) (p as Record<string, unknown>)[k] = e.ff[k];
          // windows that dropped out of the live list ended: keep them as past for the timeline
          const gone = c.ff.windows.filter((w) => w.end <= now && !e.windows.some((x) => x.start === w.start && x.holder === w.holder));
          if (gone.length) p.past = [...gone, ...c.ff.past].slice(0, 48);
          coins![e.mint] = patchFF(c, p);
        }
        break;
      }
      case 'buy': {
        const c = edit(e.mint);
        if (c?.ff) {
          const has = c.ff.windows.some((w) => w.start === e.start && w.holder === e.buyer);
          const windows = has ? c.ff.windows : [...c.ff.windows, { holder: e.buyer, start: e.start, end: e.end, earned: 0, cost: e.paid, sig: e.sig }].sort((a, b) => a.start - b.start);
          coins![e.mint] = patchFF(c, { windows, hoursSold: c.ff.hoursSold + (has ? 0 : e.hours), sales: c.ff.sales + (has ? 0 : e.paid) });
          if (!has) cash.push({ kind: 'sale', mint: e.mint, to: c.ff.owner, amount: e.paid, hours: e.hours });
        }
        if (stats) stats = { ...stats, hoursSoldToday: stats.hoursSoldToday + e.hours };
        break;
      }
      case 'paid': {
        const c = edit(e.mint);
        if (c?.ff) coins![e.mint] = patchFF(c, e.kind === 'owner' ? { ownerPaid: c.ff.ownerPaid + e.amount } : { holderPaid: c.ff.holderPaid + e.amount });
        if (stats) stats = e.kind === 'owner' ? { ...stats, paidDevsToday: stats.paidDevsToday + e.amount } : { ...stats, paidBuyersToday: stats.paidBuyersToday + e.amount };
        cash.push({ kind: 'paid', mint: e.mint, to: e.to, amount: e.amount });
        break;
      }
      case 'register': {
        const cur = (coins ?? s.coins)[e.mint];
        const base = e.coin ?? cur;
        if (!base) break;
        coins ??= { ...s.coins };
        const ffv: FF = base.ff ?? {
          owner: e.owner,
          price: e.price,
          priceLamports: String(Math.round(e.price * 1e9)),
          maxAhead: e.maxAhead,
          paused: false,
          registeredAt: now,
          windows: [],
          past: [],
          hoursSold: 0,
          sales: 0,
          feesIn: 0,
          ownerPaid: 0,
          holderPaid: 0,
        };
        const c: Coin = { ...base, ff: ffv };
        c.thisHour = freshThisHour(c, [], now);
        coins[e.mint] = c;
        if (!live.includes(e.mint)) live = [...live, e.mint];
        hot = hot.filter((m) => m !== e.mint);
        break;
      }
    }
  }

  // trades: dots and chips (listeners), and the live numbers they move
  const fresh = addTrades(tradesIn, true);
  for (const t of fresh) {
    const c = edit(t.mint);
    if (!c) continue;
    const f = c.fees;
    const th = c.thisHour && t.t >= c.thisHour.since ? { ...c.thisHour, sol: c.thisHour.sol + t.fee } : c.thisHour;
    coins![t.mint] = {
      ...c,
      fees: { ...f, m1: f.m1 + t.fee, m10: f.m10 + t.fee, h1: f.h1 + t.fee, h6: f.h6 + t.fee, h24: f.h24 + t.fee },
      trades1h: c.trades1h + 1,
      volume1h: c.volume1h + t.sol,
      thisHour: th,
    };
    if (stats && t.fee > 0) stats = { ...stats, feesHour: stats.feesHour + t.fee };
  }

  const patch: Partial<BoardState> = {};
  if (coins) patch.coins = coins;
  if (stats !== s.stats) patch.stats = stats;
  if (live !== s.live) patch.live = live;
  if (hot !== s.hot) patch.hot = hot;
  if (Object.keys(patch).length) board.set(patch);
  for (const c of cash) emitCash(c);
}

/** Once a second: a window that just started or ended hands "this hour" to the next recipient. */
export function tickRecipients(): void {
  const s = board.get();
  const now = serverNow();
  let coins: Record<string, Coin> | null = null;
  for (const m of s.live) {
    const c = s.coins[m];
    if (!c?.ff || !c.thisHour) continue;
    const r = recipientNow(c, now);
    if (r.to === c.thisHour.to && r.kind === c.thisHour.kind && r.since === c.thisHour.since) continue;
    coins ??= { ...s.coins };
    coins[m] = { ...c, thisHour: freshThisHour(c, recentTrades(m), now) };
  }
  if (coins) board.set({ coins });
}

export const setConn = (conn: Conn) => board.set({ conn });
