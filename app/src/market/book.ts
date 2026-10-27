// The order book in the app (owner, 2026-10-28: "bids and asks on any coin, like Polymarket"): one coin's book,
// fresh on every `book` stream event; placing and cancelling orders (Phantom sign-in first, like Want).
import { useEffect, useState } from 'react';
import { ApiError, del, get, post } from '../api/http.ts';
import { onStream } from '../api/live.ts';
import { book as normBook } from '../api/norm.ts';
import type { Book } from '../api/types.ts';
import { copy, fill } from '../copy.ts';
import { tick } from '../lib/format.ts';
import { toast } from '../state/ui.ts';
import { connectWallet } from '../wallet/connectFlow.ts';
import { ensureSession, session } from '../wallet/session.ts';
import { isRejection } from '../wallet/wallet.ts';

export const emptyBook = (mint: string): Book => ({ mint, bids: [], asks: [], bestBid: null, bestAsk: null, spread: null, mid: null, orders: 0, mine: [] });

/** Calls `fn` (at most every `ms`) when the stream says these coins' books changed; `null` = any coin. */
export function onBook(mints: Set<string> | null, fn: () => void, ms = 1500): () => void {
  let t = 0;
  let last = 0;
  const fire = () => {
    t = 0;
    last = Date.now();
    fn();
  };
  const off = onStream((list) => {
    if (!list.some((e) => e.type === 'book' && (!mints || mints.has(e.mint)))) return;
    if (t) return;
    t = window.setTimeout(fire, Math.max(0, last + ms - Date.now()));
  });
  return () => {
    off();
    if (t) window.clearTimeout(t);
  };
}

/** One coin's book, live. `reload` after this tab's own order. */
export function useBook(mint: string): { book: Book; ready: boolean; reload: () => void } {
  const [state, setState] = useState<{ book: Book; ready: boolean }>({ book: emptyBook(mint), ready: false });
  const signed = session.use((s) => s.s?.token ?? null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = () =>
      get<unknown>('/book/' + mint, { auth: 'try' })
        .then((r) => alive && setState({ book: normBook(r, mint), ready: true }))
        .catch(() => alive && setState((s) => ({ ...s, ready: true })));
    void run();
    const off = onBook(new Set([mint]), run);
    return () => {
      alive = false;
      off();
    };
  }, [mint, signed, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

async function signedIn(): Promise<boolean> {
  if (!(await connectWallet())) return false;
  try {
    await ensureSession();
    return true;
  } catch (e) {
    toast({ kind: 'warn', title: isRejection(e) ? copy.err.rejected : copy.err.signIn });
    return false;
  }
}

const errTitle = (e: unknown) =>
  e instanceof ApiError ? (e.status === 0 ? copy.err.network : e.status === 401 ? copy.err.signIn : e.status < 500 && e.message ? e.message : copy.err.server) : copy.err.server;

export async function placeOrder(o: { mint: string; symbol: string; side: 'bid' | 'ask'; price: number; hours: number }): Promise<boolean> {
  if (!(await signedIn())) return false;
  try {
    await post('/orders', { mint: o.mint, side: o.side, price: o.price, hours: o.hours }, { auth: 'need' });
    toast({ kind: 'ok', title: fill(o.side === 'bid' ? copy.market.placedBid : copy.market.placedAsk, { ticker: tick(o.symbol) }) }, 2600);
    return true;
  } catch (e) {
    toast({ kind: 'warn', title: errTitle(e) });
    return false;
  }
}

export async function cancelOrder(id: string): Promise<boolean> {
  try {
    await del('/orders/' + encodeURIComponent(id), { auth: 'need' });
    toast({ kind: 'ok', title: copy.market.cancelled }, 1800);
    return true;
  } catch (e) {
    toast({ kind: 'warn', title: errTitle(e) });
    return false;
  }
}
