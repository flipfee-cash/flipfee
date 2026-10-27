import { useRef, useSyncExternalStore } from 'react';

export type Eq<T> = (a: T, b: T) => boolean;

export interface Store<T> {
  get(): T;
  set(next: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(fn: () => void): () => void;
  /** Read a slice. Re-renders only when the slice changes (by `eq`). */
  use<U>(sel: (s: T) => U, eq?: Eq<U>): U;
}

/** A tiny external store: one object, shallow merges, subscribers notified once per set. */
export function createStore<T extends object>(init: T): Store<T> {
  let state = init;
  const subs = new Set<() => void>();
  const get = () => state;
  const subscribe = (fn: () => void) => {
    subs.add(fn);
    return () => void subs.delete(fn);
  };
  const set = (next: Partial<T> | ((s: T) => Partial<T>)) => {
    const patch = typeof next === 'function' ? next(state) : next;
    let changed = false;
    for (const k in patch) {
      if (!Object.is((state as Record<string, unknown>)[k], (patch as Record<string, unknown>)[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...patch };
    for (const fn of subs) fn();
  };
  function use<U>(sel: (s: T) => U, eq: Eq<U> = Object.is): U {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const cache = useRef<{ v: U } | null>(null);
    const read = (): U => {
      const v = sel(state);
      const c = cache.current;
      if (c && eq(c.v, v)) return c.v;
      cache.current = { v };
      return v;
    };
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useSyncExternalStore(subscribe, read, read);
  }
  return { get, set, subscribe, use };
}

export function shallow<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], bb[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/** A media query as state. */
export function useMedia(q: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      const m = window.matchMedia(q);
      m.addEventListener('change', fn);
      return () => m.removeEventListener('change', fn);
    },
    () => window.matchMedia(q).matches,
    () => false,
  );
}

/** Wide board: every column of a coin row fits. */
export const WIDE = '(min-width: 1100px)';
/** Phone layout (DESIGN.md §1.6, ≤ 760 px): tabs, sticky bottom bar, bottom sheets. */
export const PHONE = '(max-width: 760px)';
export const REDUCED = '(prefers-reduced-motion: reduce)';
export const COARSE = '(pointer: coarse)';

export const reducedMotion = (): boolean => typeof window !== 'undefined' && window.matchMedia(REDUCED).matches;
