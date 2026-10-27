// The dithered coin on a canvas: `n` cells drawn at `size` CSS px (pixelated). `mode`:
//   'spin'  turns slowly while on screen (the hero), faster for a moment on hover;
//   'flip'  rests at a slight angle and flips once on mount and on hover (the logo).
// Reduced motion: one still frame. Off screen or in a hidden tab: no frames.
import { useEffect, useRef } from 'react';
import { REDUCED } from '../state/store.ts';
import { coinMask, paint } from './coin.ts';

const REST = 0.5;

export function DitherCoin({ n, size, mode, className, label, vtName }: { n: number; size: number; mode: 'spin' | 'flip'; className?: string; label?: string; vtName?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const still = window.matchMedia(REDUCED).matches;
    let theta = REST;
    let raf = 0;
    let timer = 0;
    let last = 0;
    let shown = true;
    let flipUntil = 0;
    let boost = 0;
    const draw = (t: number) => paint(ctx, coinMask(n, t), n, n);
    const frame = (now: number) => {
      raf = 0;
      if (!shown || document.visibilityState !== 'visible') return;
      const dt = last ? Math.min(64, now - last) : 16;
      last = now;
      if (mode === 'spin') {
        boost = Math.max(0, boost - dt / 900);
        theta += (dt / 1000) * (0.9 + 5 * boost);
      } else if (flipUntil) {
        const left = flipUntil - now;
        if (left <= 0) {
          flipUntil = 0;
          theta = REST;
        } else theta = REST + (1 - left / 700) * Math.PI * 2;
      }
      draw(theta);
      // ~30 fps is plenty for a dither
      if (mode === 'spin' || flipUntil) {
        raf = -1;
        timer = window.setTimeout(() => (raf = requestAnimationFrame(frame)), 30);
      }
    };
    const kick = () => {
      if (still) return;
      if (mode === 'spin') boost = 1;
      else flipUntil = performance.now() + 700;
      if (!raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    draw(theta);
    if (!still) {
      if (mode === 'spin') raf = requestAnimationFrame(frame);
      else kick();
    }
    const io = new IntersectionObserver(([e]) => {
      shown = e.isIntersecting;
      if (shown && !still && mode === 'spin' && !raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    });
    io.observe(cv);
    const host = cv.closest('a, button, .dither-host') ?? cv;
    host.addEventListener('mouseenter', kick);
    const onVis = () => {
      if (document.visibilityState === 'visible' && mode === 'spin' && !still && !raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (raf > 0) cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      io.disconnect();
      host.removeEventListener('mouseenter', kick);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [n, mode]);
  return <canvas ref={ref} width={n} height={n} className={'dcoin' + (className ? ' ' + className : '')} style={{ width: size, height: size, viewTransitionName: vtName }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
