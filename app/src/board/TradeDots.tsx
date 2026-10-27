// Trade dots: each trade drops a dot at the right edge (green buy, red sell, size = SOL) and the whole track drifts
// left. One compositor animation per strip (the track), so a busy coin costs the same as a quiet one.
import { memo, useEffect, useRef } from 'react';
import { copy } from '../copy.ts';
import type { Trade } from '../api/types.ts';
import { onTrade, recentTrades } from '../state/trades.ts';
import { serverNow } from '../lib/clock.tsx';
import { reducedMotion } from '../state/store.ts';

const dotSize = (sol: number) => Math.max(3, Math.min(12, 3 + Math.sqrt(Math.max(0, sol)) * 3.4));

export interface DotsApi {
  /** the newest dot's element (chips start there) */
  last(): HTMLElement | null;
}

export const TradeDots = memo(function TradeDots({ mint, span = 120, api, className }: { mint: string; span?: number; api?: React.RefObject<DotsApi | null>; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const track = strip.firstElementChild as HTMLDivElement;
    let W = strip.clientWidth || 120;
    let speed = W / (span * 1000);
    let t0 = serverNow();
    let anim: Animation | null = null;
    let lastDot: HTMLElement | null = null;
    const still = reducedMotion();
    const RUN = 10 * 60e3;

    const xOf = (t: number) => (t - t0) * speed + W;
    const place = (t: Trade, fresh: boolean) => {
      const d = document.createElement('i');
      const s = dotSize(t.sol);
      d.className = 'td td-' + t.side + (fresh ? ' is-new' : '');
      d.dataset.t = String(t.t);
      d.style.left = xOf(t.t).toFixed(1) + 'px';
      d.style.width = d.style.height = s.toFixed(1) + 'px';
      d.style.marginTop = (-s / 2).toFixed(1) + 'px';
      track.appendChild(d);
      lastDot = d;
    };
    const start = () => {
      anim?.cancel();
      track.replaceChildren();
      t0 = serverNow();
      const from = t0 - span * 1000;
      const list = recentTrades(mint).filter((t) => t.t > from);
      for (const t of list.slice(-70)) place(t, false);
      if (!still) {
        anim = track.animate([{ transform: 'translate3d(0,0,0)' }, { transform: `translate3d(${(-RUN * speed).toFixed(1)}px,0,0)` }], { duration: RUN, easing: 'linear', fill: 'forwards' });
      }
    };
    start();
    if (api) api.current = { last: () => lastDot };

    // a strip off screen draws nothing; it rebuilds from the recent trades when it shows again
    let shown = true;
    const io = new IntersectionObserver(
      (es) => {
        const now = es[es.length - 1]?.isIntersecting ?? true;
        if (now && !shown) start();
        shown = now;
      },
      { rootMargin: '80px' },
    );
    io.observe(strip);
    const MAXDOTS = 70;
    const off = onTrade(mint, (t) => {
      if (!shown) return;
      place(t, true);
      if (track.childElementCount > MAXDOTS) track.firstElementChild?.remove();
    });
    // drop dots that slid out; restart the run before it ends; a still strip re-places by age
    const sweep = window.setInterval(() => {
      const now = serverNow();
      if (still || now - t0 > RUN - 30000) {
        start();
        return;
      }
      const cut = now - span * 1000 - 2000;
      for (const el of Array.from(track.children) as HTMLElement[]) {
        if (Number(el.dataset.t) < cut) el.remove();
        else break;
      }
    }, still ? 5000 : 4000);
    const ro = new ResizeObserver(() => {
      const w = strip.clientWidth;
      if (w && Math.abs(w - W) > 2) {
        W = w;
        speed = W / (span * 1000);
        start();
      }
    });
    ro.observe(strip);
    return () => {
      off();
      io.disconnect();
      window.clearInterval(sweep);
      ro.disconnect();
      anim?.cancel();
      if (api) api.current = null;
    };
  }, [mint, span, api]);

  return (
    <div ref={ref} className={'tdots' + (className ? ' ' + className : '')} role="img" aria-label={copy.a11y.trades}>
      <div className="td-track" />
    </div>
  );
});
