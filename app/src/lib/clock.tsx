// One shared clock. Ages, countdowns and hour bars register their element and a single 1 s timer writes them, so a
// busy board never re-renders just to tick a second. Components that need a re-render read `useNow`.
import { memo, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { ago, left } from './format.ts';

type Writer = (now: number) => void;
const writers = new Set<Writer>();
const subs = new Set<() => void>();
let now = Date.now();
let timer = 0;

/** Server time skew: the board's times come from the server's clock. */
let skew = 0;
export function setSkew(ms: number): void {
  if (Number.isFinite(ms) && Math.abs(ms) < 6 * 3600e3) skew = ms;
}
export const serverNow = (): number => Date.now() + skew;

function tick(): void {
  now = Date.now();
  const s = now + skew;
  for (const w of writers) w(s);
  for (const fn of subs) fn();
}

function ensure(): void {
  if (timer || typeof window === 'undefined') return;
  // align to the second so every countdown on the page changes together
  window.setTimeout(() => {
    tick();
    timer = window.setInterval(tick, 1000);
  }, 1000 - (Date.now() % 1000));
  timer = -1;
}

/** Runs `fn(serverNow)` every second (and once now). */
export function onTick(fn: Writer): () => void {
  ensure();
  writers.add(fn);
  fn(serverNow());
  return () => void writers.delete(fn);
}

/** "12s" · "4m" · "2h": time since `t` (server ms). */
export const Age = memo(function Age({ t, className }: { t: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return onTick((n) => {
      const s = ago(n - t);
      if (el.textContent !== s) el.textContent = s;
    });
  }, [t]);
  return <span ref={ref} className={className} />;
});

/** "34m 12s": time until `t` (server ms); `done` once it passed. */
export const Countdown = memo(function Countdown({ t, className, done = '0s' }: { t: number; className?: string; done?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return onTick((n) => {
      const s = t > n ? left(t - n) : done;
      if (el.textContent !== s) el.textContent = s;
    });
  }, [t, done]);
  return <span ref={ref} className={className} />;
});

const subscribe = (fn: () => void) => {
  ensure();
  subs.add(fn);
  return () => void subs.delete(fn);
};

/** Re-renders every `stepMs` (rounded), with server time. */
export function useNow(stepMs = 1000): number {
  return useSyncExternalStore(
    subscribe,
    () => Math.floor((now + skew) / stepMs) * stepMs,
    () => Math.floor((now + skew) / stepMs) * stepMs,
  );
}
