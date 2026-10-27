// Recent trades per coin, outside React: rows draw their trade dots and fly cash chips straight from here, so a busy
// stream never re-renders the board just to add a dot.
import type { Trade } from '../api/types.ts';

const CAP = 120;
const rings = new Map<string, Trade[]>();
const seen = new Set<string>();
const seenOrder: string[] = [];
type Fn = (t: Trade) => void;
const subs = new Map<string, Set<Fn>>();
const anySubs = new Set<Fn>();

function remember(id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  seenOrder.push(id);
  if (seenOrder.length > 4000) for (const old of seenOrder.splice(0, 1000)) seen.delete(old);
  return true;
}

/** Adds trades (newest last or any order). `live`: they just happened, so listeners animate them. */
export function addTrades(list: Trade[], live: boolean): Trade[] {
  const fresh: Trade[] = [];
  for (const t of list) {
    if (!remember(t.id)) continue;
    let r = rings.get(t.mint);
    if (!r) rings.set(t.mint, (r = []));
    r.push(t);
    if (r.length > 1 && r[r.length - 2].t > t.t) r.sort((a, b) => a.t - b.t);
    if (r.length > CAP) r.splice(0, r.length - CAP);
    fresh.push(t);
  }
  if (live) {
    for (const t of fresh) {
      const s = subs.get(t.mint);
      if (s) for (const fn of s) fn(t);
      for (const fn of anySubs) fn(t);
    }
  }
  return fresh;
}

/** Oldest first. */
export const recentTrades = (mint: string): Trade[] => rings.get(mint) ?? [];

export function onTrade(mint: string | null, fn: Fn): () => void {
  if (mint === null) {
    anySubs.add(fn);
    return () => void anySubs.delete(fn);
  }
  let s = subs.get(mint);
  if (!s) subs.set(mint, (s = new Set()));
  s.add(fn);
  return () => void s.delete(fn);
}
