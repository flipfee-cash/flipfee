// Cash chips (DESIGN.md §1.7): a crisp "+0.0042 SOL" chip flies from a trade dot into the holder or dev chip. One
// fixed layer for every chip, transform and opacity only, a cap on chips in flight, nothing when the tab is hidden or
// the user asked for reduced motion.
import { reducedMotion } from '../state/store.ts';

let layer: HTMLDivElement | null = null;
let inFlight = 0;
const MAX = 10;

function ensureLayer(): HTMLDivElement {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement('div');
  layer.className = 'chip-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);
  return layer;
}

/** Chips fly when motion is welcome, the tab shows and no sheet covers the board. */
export const chipsOk = (): boolean => !reducedMotion() && document.visibilityState === 'visible' && inFlight < MAX && !document.documentElement.classList.contains('sheet-open');

interface Pt {
  x: number;
  y: number;
}

const center = (r: DOMRect): Pt => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** Flies a chip from `from` to `to` (elements or points). Resolves when it lands (or at once when skipped). */
export function flyChip(text: string, from: Element | Pt, to: Element | Pt, tone: 'cash' | 'amber' = 'cash', ms = 720): Promise<boolean> {
  if (!chipsOk()) return Promise.resolve(false);
  const a = from instanceof Element ? center(from.getBoundingClientRect()) : from;
  const b = to instanceof Element ? center(to.getBoundingClientRect()) : to;
  // off screen: skip
  const vh = window.innerHeight;
  if ((a.y < -40 && b.y < -40) || (a.y > vh + 40 && b.y > vh + 40)) return Promise.resolve(false);
  const el = document.createElement('span');
  el.className = 'chip-fly chip-' + tone;
  el.textContent = text;
  ensureLayer().appendChild(el);
  inFlight++;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const x0 = a.x - w / 2;
  const y0 = a.y - h / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lift = Math.min(70, 24 + Math.abs(dx) * 0.12);
  const anim = el.animate(
    [
      { transform: `translate(${x0}px, ${y0}px) scale(0.6)`, opacity: 0 },
      { transform: `translate(${x0}px, ${y0 - 10}px) scale(1)`, opacity: 1, offset: 0.16 },
      { transform: `translate(${x0 + dx * 0.55}px, ${y0 + dy * 0.55 - lift}px) scale(1)`, opacity: 1, offset: 0.6 },
      { transform: `translate(${x0 + dx}px, ${y0 + dy}px) scale(0.6)`, opacity: 0 },
    ],
    { duration: ms, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' },
  );
  return new Promise((res) => {
    const done = () => {
      el.remove();
      inFlight--;
      res(true);
    };
    anim.onfinish = done;
    anim.oncancel = done;
  });
}

/** A short pulse on the element a chip landed on. */
export function pulse(el: Element | null, cls = 'is-hit'): void {
  if (!el || reducedMotion()) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), 650);
}
