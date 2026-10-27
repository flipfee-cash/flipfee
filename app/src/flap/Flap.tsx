// Live numbers in a dot-matrix face (owner, 2026-10-26: dither style). A character that changes is written at once
// and dithers in: an ordered-dither mask lets 25%, 50%, 75% of its dots through, then all of it (~160 ms), staggered from
// the first changed character. The DOM per character is fixed and written imperatively, so React only re-renders the
// characters that changed. Reduced motion, or off screen: the characters change in place.
import { memo, useLayoutEffect, useRef } from 'react';
import { REDUCED } from '../state/store.ts';
import { sound } from '../lib/sound.ts';

export type FlapSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type FlapTone = 'ink' | 'cash' | 'amber' | 'dim' | 'sell';

/** The dither-in, ms (matches .fc.go in flap.css). */
const FLAP_MS = 160;
const STAGGER = 30;
const NARROW = new Set(['.', ',', ':', ' ']);

let reduced = typeof window !== 'undefined' && window.matchMedia(REDUCED).matches;
if (typeof window !== 'undefined') window.matchMedia(REDUCED).addEventListener('change', (e) => (reduced = e.matches));
const motionOk = () => !reduced && document.visibilityState === 'visible';

// Tiles off screen change in place: one observer for every flap row, so a long board only animates what shows.
const visible = new WeakMap<Element, boolean>();
const io =
  typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((es) => {
        for (const e of es) visible.set(e.target, e.isIntersecting);
      }, { rootMargin: '60px' })
    : null;
const onScreen = (row: Element | null) => !row || visible.get(row) !== false;

interface CharProps {
  ch: string;
  delay: number;
  /** flip in from a blank tile on mount */
  intro: boolean;
  /** click when it flips (with sound on): the hero counter only, so the board stays quiet */
  loud: boolean;
}

const FlapChar = memo(function FlapChar({ ch, delay, intro, loud }: CharProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<string | null>(null);
  const timer = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const g = el.firstElementChild as HTMLElement;
    const prev = shown.current;
    shown.current = ch;
    if (prev === ch) return;
    if (g.textContent !== ch) g.textContent = ch;
    const from = prev ?? (intro ? ' ' : ch);
    if (from === ch || ch === ' ' || !motionOk() || !onScreen(el.parentElement)) {
      window.clearTimeout(timer.current);
      el.classList.remove('go', 'go2');
      return;
    }
    el.style.setProperty('--fd', delay + 'ms');
    // two classes with the same motion under different animation names: swapping them restarts it without a layout
    const again = el.classList.contains('go');
    el.classList.remove(again ? 'go' : 'go2');
    el.classList.add(again ? 'go2' : 'go');
    window.clearTimeout(timer.current);
    if (loud && sound.enabled()) window.setTimeout(() => sound.flap(), delay);
    timer.current = window.setTimeout(() => el.classList.remove('go', 'go2'), delay + FLAP_MS + 40);
  }, [ch, delay, intro, loud]);

  useLayoutEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <span ref={ref} className={'fc' + (NARROW.has(ch) ? ' fc-n' : '')} aria-hidden="true">
      <i />
    </span>
  );
});

interface FlapProps {
  text: string;
  size?: FlapSize;
  tone?: FlapTone;
  /** pad on the left with blank tiles to this many characters (numbers keep their place) */
  pad?: number;
  /** what a screen reader says (defaults to the text) */
  label?: string;
  /** flip in from blank tiles when it first shows */
  intro?: boolean;
  /** a soft click on each flip when sound is on */
  sound?: boolean;
  className?: string;
  testid?: string;
}

/** A dot-matrix number. Characters are keyed from the right, so a growing number keeps its last digits in place. */
export const Flap = memo(function Flap({ text, size = 'md', tone = 'ink', pad = 0, label, intro = false, sound: loud = false, className, testid }: FlapProps) {
  const t = text.length < pad ? ' '.repeat(pad - text.length) + text : text;
  const prev = useRef(t);
  // stagger from the first tile that changed (so a ticking last digit flips at once)
  let first = 0;
  const p = prev.current;
  if (p !== t) {
    const off = t.length - p.length;
    first = t.length;
    for (let i = 0; i < t.length; i++) {
      const j = i - off;
      if (j < 0 || p[j] !== t[i]) {
        first = i;
        break;
      }
    }
  }
  useLayoutEffect(() => {
    prev.current = t;
  });
  const row = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el || !io) return;
    io.observe(el);
    return () => {
      io.unobserve(el);
      visible.delete(el);
    };
  }, []);
  const chars = [...t];
  return (
    <span ref={row} className={'flap flap-' + size + ' tone-' + tone + (className ? ' ' + className : '')} data-testid={testid} data-value={text}>
      <span className="sr">{label ?? text}</span>
      {chars.map((c, i) => (
        <FlapChar key={chars.length - i} ch={c} delay={intro && p === t ? i * STAGGER : Math.max(0, i - first) * STAGGER} intro={intro} loud={loud} />
      ))}
    </span>
  );
});
