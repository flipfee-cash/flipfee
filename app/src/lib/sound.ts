// Optional sound (DESIGN.md §1.7): off by default, one toggle. A soft flap click when the board flips, and a register
// "ka-ching" when cash lands in your own wallet. WebAudio only, nothing to download; the context starts after a tap.
import { createStore } from '../state/store.ts';

const KEY = 'flipfee.sound';
let ctx: AudioContext | null = null;
let gestured = false;
let lastFlap = 0;

const saved = (() => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();

export const soundState = createStore<{ on: boolean }>({ on: saved });

if (typeof window !== 'undefined') {
  const mark = (): void => {
    gestured = true;
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  };
  window.addEventListener('pointerdown', mark, { capture: true, passive: true });
  window.addEventListener('keydown', mark, { capture: true, passive: true });
}

function ac(): AudioContext | null {
  if (!soundState.get().on || !gestured || document.visibilityState === 'hidden') return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  return ctx;
}

function noise(c: AudioContext, at: number, dur: number, freq: number, q: number, gain: number): void {
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(c.destination);
  src.start(at);
}

function bell(c: AudioContext, at: number, f: number, dur: number, gain: number): void {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(f, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(c.destination);
  o.start(at);
  o.stop(at + dur + 0.02);
}

export const sound = {
  enabled: (): boolean => soundState.get().on,
  set(on: boolean): void {
    soundState.set({ on });
    if (on) gestured = true;
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      // storage is optional
    }
  },
  /** A soft flap click (at most one every 70 ms, so a busy board stays quiet). */
  flap(): void {
    const now = performance.now();
    if (now - lastFlap < 70) return;
    const c = ac();
    if (!c) return;
    lastFlap = now;
    try {
      const t = c.currentTime;
      noise(c, t, 0.018, 2600, 1.4, 0.05);
      noise(c, t + 0.034, 0.012, 1700, 1.2, 0.03);
    } catch {
      // audio is optional
    }
  },
  /** The register: cash landed in your wallet. */
  kaching(): void {
    const c = ac();
    if (!c) return;
    try {
      const t = c.currentTime;
      noise(c, t, 0.05, 1200, 0.8, 0.09);
      bell(c, t + 0.06, 2093, 0.55, 0.07);
      bell(c, t + 0.06, 2637, 0.5, 0.05);
      bell(c, t + 0.06, 4186, 0.3, 0.02);
    } catch {
      // audio is optional
    }
  },
  tap(): void {
    const c = ac();
    if (!c) return;
    try {
      noise(c, c.currentTime, 0.014, 3200, 2, 0.035);
    } catch {
      // audio is optional
    }
  },
  buzz(ms = 12): void {
    try {
      navigator.vibrate?.(ms);
    } catch {
      // vibration is optional
    }
  },
};
