// The hero scene (owner, 2026-10-26: "more coins, interactive, smooth"): the coin's flipfee vault in the middle, five
// coins on a tipped orbit around it, all ray-cast and dithered into one canvas. Drag to spin the vault (it keeps the
// spin and slows down); click, tap or Enter flips it and throws the orbit wide, then it settles. Each real trade on the
// coin sends a small coin in from the left into the vault. Off screen or in a hidden tab: no frames. Reduced motion:
// one still frame.
import { useEffect, useRef } from 'react';
import { REDUCED } from '../state/store.ts';
import { onTrade } from '../state/trades.ts';
import { paint, renderCoins } from './coin.ts';
import type { CoinPose } from './coin.ts';

const W = 200; // cells
const H = 150;
const ORBIT = 5;
const PHI = 0.32;

interface Flyer {
  t0: number;
  y0: number;
}

export function VaultScene({ mint, size = 400, label }: { mint: string | null; size?: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const kickRef = useRef<() => void>(() => {});
  const flyRef = useRef<() => void>(() => {});

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const still = window.matchMedia(REDUCED).matches;
    let theta = 0.5;
    let spin = 0.9; // rad/s, eases back to the idle speed
    let orbitA = 0;
    let spread = 0; // 0 rest … 1 thrown wide
    let flipT = 0;
    const flyers: Flyer[] = [];
    let raf = 0;
    let timer = 0;
    let last = 0;
    let shown = true;
    let drag: { x: number; t: number } | null = null;

    const draw = (now: number) => {
      const coins: CoinPose[] = [];
      const ox = W / 2;
      const oy = H / 2;
      const rx = 74 + spread * 22;
      const ry = 22 + spread * 10;
      for (let i = 0; i < ORBIT; i++) {
        const a = orbitA + (i / ORBIT) * Math.PI * 2;
        const depth = Math.sin(a); // −1 back … 1 front
        coins.push({
          cx: ox + Math.cos(a) * rx,
          cy: oy + depth * ry + 4,
          r: 10 + depth * 3,
          theta: a * 2.2 + i,
          phi: PHI,
          z: depth * 100,
          dark: depth < 0 ? -0.22 : 0,
        });
      }
      for (const f of flyers) {
        const p = Math.min(1, (now - f.t0) / 900);
        const e = p * p * (3 - 2 * p);
        coins.push({ cx: -8 + (ox + 8) * e, cy: f.y0 + (oy - f.y0) * e - Math.sin(p * Math.PI) * 18, r: 8 * (1 - 0.6 * e), theta: p * 9, phi: PHI, z: 200 });
      }
      coins.push({ cx: ox, cy: oy, r: 52, theta, phi: PHI, z: 0 });
      paint(ctx, renderCoins(W, H, coins), W, H);
    };

    const frame = (now: number) => {
      raf = 0;
      if (!shown || document.visibilityState !== 'visible') return;
      const dt = last ? Math.min(64, now - last) / 1000 : 0.016;
      last = now;
      if (!drag) spin += (0.9 - spin) * Math.min(1, dt * 1.4); // inertia back to idle
      if (flipT > 0) {
        flipT = Math.max(0, flipT - dt);
        theta += dt * 14 * (flipT / 0.7);
      }
      theta += spin * dt;
      orbitA += dt * (0.45 + Math.abs(spin) * 0.15);
      spread += ((flipT > 0 ? 1 : 0) - spread) * Math.min(1, dt * 5);
      for (let i = flyers.length - 1; i >= 0; i--) if (now - flyers[i].t0 > 900) flyers.splice(i, 1);
      draw(now);
      timer = window.setTimeout(() => {
        timer = 0;
        raf = requestAnimationFrame(frame);
      }, 28);
    };
    const start = () => {
      if (still || raf || timer) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      raf = 0;
      timer = 0;
    };
    kickRef.current = () => {
      if (still) return;
      flipT = 0.7;
      start();
    };
    flyRef.current = () => {
      if (still || flyers.length >= 3) return;
      flyers.push({ t0: performance.now(), y0: 20 + Math.random() * (H - 40) });
    };

    draw(performance.now());
    start();
    const io = new IntersectionObserver(([e]) => {
      shown = e.isIntersecting;
      if (shown) start();
      else stop();
    });
    io.observe(cv);
    const onVis = () => (document.visibilityState === 'visible' ? start() : stop());
    document.addEventListener('visibilitychange', onVis);

    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, t: performance.now() };
      cv.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const now = performance.now();
      const dx = e.clientX - drag.x;
      const dt = Math.max(1, now - drag.t);
      theta += dx * 0.02;
      spin = Math.max(-12, Math.min(12, (dx * 0.02 * 1000) / dt));
      drag = { x: e.clientX, t: now };
      if (still) draw(now);
    };
    const up = (e: PointerEvent) => {
      if (!drag) return;
      const moved = Math.abs(spin) > 2;
      drag = null;
      if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
      if (!moved) kickRef.current();
    };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    return () => {
      stop();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      cv.removeEventListener('pointerdown', down);
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
    };
  }, []);

  // every real trade on this coin: a coin flies into the vault
  useEffect(() => (mint ? onTrade(mint, () => flyRef.current()) : undefined), [mint]);

  return (
    <canvas
      ref={ref}
      width={W}
      height={H}
      className="vault"
      style={{ width: size, height: (size * H) / W }}
      role="img"
      aria-label={label}
      data-vt="vault"
      data-vt-with="/docs"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          kickRef.current();
        }
      }}
    />
  );
}
