// The header's dot field: a fine grid of
// faint dots behind the top bar. Near the pointer the dots push away like a lens, grow a little and take the ink, then
// spring back. Frames run only while something moves; touch screens and reduced motion get the still grid.
import { useEffect, useRef } from 'react';
import { REDUCED } from '../state/store.ts';

const GAP = 7; // px between dots
const RADIUS = 90; // px of the lens
const PUSH = 16; // px a dot moves at the lens edge

export function HeaderField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const host = cv?.parentElement;
    const ctx = cv?.getContext('2d');
    if (!cv || !host || !ctx) return;
    const calm = window.matchMedia(REDUCED).matches || window.matchMedia('(hover: none)').matches;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let px = -1e4;
    let py = -1e4;
    let tx = -1e4;
    let ty = -1e4;
    let strength = 0; // 0 … 1, eases in and out with the pointer
    let target = 0;
    let raf = 0;

    const size = () => {
      const r = host.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = r.width;
      h = r.height;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      draw();
    };
    // the lens breathes and follows motion: it grows with pointer speed, stretches along the direction of travel,
    // wobbles slowly, and every quick move leaves a ripple ring that spreads and fades
    let vx = 0;
    let vy = 0;
    let speed = 0;
    let t = 0;
    const ripples: { x: number; y: number; r: number; a: number }[] = [];
    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const rad = RADIUS * (0.85 + 0.12 * Math.sin(t * 1.7) + Math.min(0.9, speed * 0.04));
      const ang = Math.atan2(vy, vx);
      const stretch = 1 + Math.min(0.8, speed * 0.03);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      for (let y = GAP / 2; y < h; y += GAP) {
        for (let x = GAP / 2; x < w; x += GAP) {
          let ox = x;
          let oy = y;
          let k = 0;
          const dx = x - px;
          const dy = y - py;
          if (strength > 0.001) {
            // distance in the lens frame: squashed across the motion, wobbling a little with the angle
            const u = (dx * ca + dy * sa) / stretch;
            const v = -dx * sa + dy * ca;
            const th = Math.atan2(v, u);
            const d = Math.hypot(u, v) / (1 + 0.08 * Math.sin(th * 3 + t * 2.3));
            if (d < rad) {
              const f = d / rad;
              k = Math.sin(f * Math.PI) ** 1.3 * strength;
              const n = Math.hypot(dx, dy) || 1;
              ox += (dx / n) * PUSH * k;
              oy += (dy / n) * PUSH * k;
            }
          }
          for (const r of ripples) {
            const d = Math.hypot(x - r.x, y - r.y);
            const band = Math.exp(-(((d - r.r) / 10) ** 2)) * r.a;
            if (band > 0.02) {
              const n = d || 1;
              ox += ((x - r.x) / n) * 5 * band;
              oy += ((y - r.y) / n) * 5 * band;
              k = Math.max(k, band * 0.7);
            }
          }
          const sz = 0.7 + 1.1 * k;
          ctx.fillStyle = k > 0.12 ? `rgba(31, 43, 255, ${0.2 + 0.65 * k})` : 'rgba(14, 14, 16, 0.13)';
          ctx.fillRect(ox - sz / 2, oy - sz / 2, sz, sz);
        }
      }
    };
    const frame = () => {
      raf = 0;
      t += 1 / 60;
      const nx = px + (tx - px) * 0.14;
      const ny = py + (ty - py) * 0.14;
      vx += (nx - px - vx) * 0.25;
      vy += (ny - py - vy) * 0.25;
      px = nx;
      py = ny;
      const sp = Math.hypot(vx, vy);
      speed += (sp - speed) * 0.15;
      if (sp > 6 && (!ripples.length || ripples[ripples.length - 1].r > 40) && strength > 0.5) ripples.push({ x: px, y: py, r: 0, a: Math.min(1, sp / 25) });
      for (let i = ripples.length - 1; i >= 0; i--) {
        ripples[i].r += 3.2;
        ripples[i].a *= 0.96;
        if (ripples[i].a < 0.03) ripples.splice(i, 1);
      }
      strength += (target - strength) * 0.08;
      draw();
      // keep breathing while the pointer is in; stop once it has left and everything settled
      if (target > 0 || strength > 0.003 || ripples.length) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const move = (e: PointerEvent) => {
      if (calm || e.pointerType === 'touch') return;
      const r = host.getBoundingClientRect();
      tx = e.clientX - r.left;
      ty = e.clientY - r.top;
      if (target === 0) {
        px = tx;
        py = ty;
      }
      target = 1;
      kick();
    };
    const leave = () => {
      target = 0;
      kick();
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(host);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerleave', leave);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerleave', leave);
    };
  }, []);
  return <canvas ref={ref} className="top-field" aria-hidden="true" />;
}
