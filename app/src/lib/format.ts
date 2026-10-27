// Number and time formats. A real minus sign, mono digits, short units.
import { maskSlurs } from './clean.ts';
export const MINUS = '−';

function trim(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

function group(n: string): string {
  const [i, f] = n.split('.');
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f !== undefined ? g + '.' + f : g;
}

/** SOL amounts: 12.4 · 2.1 · 0.48 · 0.005 */
export function sol(x: number | undefined | null): string {
  if (x === undefined || x === null || !Number.isFinite(x)) return '0';
  const a = Math.abs(x);
  let s: string;
  if (a >= 1000) s = group(a.toFixed(0));
  else if (a >= 100) s = a.toFixed(0);
  else if (a >= 10) s = trim(a.toFixed(1));
  else if (a >= 1) s = trim(a.toFixed(2));
  else if (a >= 0.01) s = trim(a.toFixed(3));
  else s = trim(a.toFixed(4));
  return (x < 0 && Number(s.replace(/,/g, '')) !== 0 ? MINUS : '') + (s || '0');
}

/** Fixed decimals so a balance never jumps: 3.2140 */
export function solBal(x: number): string {
  return Math.max(0, x).toFixed(x >= 1000 ? 1 : 4);
}

/** A growing SOL count for rolling digits: fixed decimals keep each digit in its place. 0.4821 · 12.482 · 1,204.5 */
export function solCount(x: number | undefined | null): string {
  const v = typeof x === 'number' && Number.isFinite(x) ? Math.max(0, x) : 0;
  return group(v.toFixed(v >= 10000 ? 0 : v >= 1000 ? 1 : v >= 100 ? 2 : v >= 10 ? 3 : 4));
}

/** Token amounts in a wallet: 0.0042 · 12.5 · 8,420 · 84.2K · 12.4M · 1.2B */
export function qty(x: number | undefined | null): string {
  if (x === undefined || x === null || !Number.isFinite(x) || x <= 0) return '0';
  if (x >= 1e9) return trim((x / 1e9).toFixed(2)) + 'B';
  if (x >= 1e6) return trim((x / 1e6).toFixed(2)) + 'M';
  if (x >= 1e4) return trim((x / 1e3).toFixed(1)) + 'K';
  if (x >= 100) return group(x.toFixed(0));
  if (x >= 1) return trim(x.toFixed(2));
  const s = trim(x.toFixed(4));
  return s === '0' ? '<0.0001' : s;
}

/** The USD value of a holding: <$0.01 · $4.20 · $1,520.40 · $12,045 · $184K · $1.24M */
export function usdVal(x: number | undefined | null): string {
  if (x === undefined || x === null || !Number.isFinite(x)) return '—';
  if (x >= 1e5) return usdK(x);
  if (x >= 0.01) return usd(x);
  return x > 0 ? '<$0.01' : '$0';
}

/** Compact USD: $940 · $84.2K · $1.24M · $2.1B */
export function usdK(x: number | undefined | null): string {
  if (x === undefined || x === null || !Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  const sign = x < 0 ? MINUS : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

/** $121.94 */
export function usd(x: number | undefined | null, dp = 2): string {
  if (x === undefined || x === null || !Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  return (x < 0 ? MINUS : '') + '$' + group(a.toFixed(a >= 10000 ? 0 : dp));
}

const SUB = '₀₁₂₃₄₅₆₇₈₉';

/** Token prices: $0.0₅1234 for tiny prices (the zero count as a subscript), $1.42 otherwise. */
export function price(x: number | undefined | null): string {
  if (x === undefined || x === null || !Number.isFinite(x) || x <= 0) return '—';
  if (x >= 1) return usd(x, x >= 100 ? 0 : 2);
  if (x >= 0.001) return '$' + x.toFixed(4).replace(/0+$/, '');
  const s = x.toExponential(3); // 1.234e-7
  const [m, e] = s.split('e');
  const zeros = -Number(e) - 1;
  const digits = m.replace('.', '').replace(/0+$/, '');
  const sub = String(zeros)
    .split('')
    .map((d) => SUB[Number(d)])
    .join('');
  return `$0.0${sub}${digits}`;
}

/** +84% · −52% (one decimal under 10%) */
export function pct(p: number | undefined | null): string {
  if (p === undefined || p === null || !Number.isFinite(p)) return '—';
  const v = p * 100;
  const a = Math.abs(v);
  const s = a >= 10 ? a.toFixed(0) : a.toFixed(1);
  if (Number(s) === 0) return '0%';
  return (v > 0 ? '+' : MINUS) + s + '%';
}

/** 42% */
export function share(p: number): string {
  return Math.round(p * 100) + '%';
}

/** 2.1× */
export function mult(m: number | undefined | null): string {
  if (m === undefined || m === null || !Number.isFinite(m)) return '—';
  return (m >= 10 ? m.toFixed(0) : m.toFixed(m >= 3 ? 1 : 2)) + '×';
}

/** Ages: 3s · 1m · 12m · 2h · 3d */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

/** Time left: 18h 20m · 45m 10s · 30s */
export function left(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** 7a3f…91c2 */
export function short(addr: string | undefined | null, n = 4): string {
  if (!addr) return '';
  return addr.length <= n * 2 + 1 ? addr : addr.slice(0, n) + '…' + addr.slice(-n);
}

export function signClass(x: number | undefined | null): 'up' | 'down' | 'flat' {
  if (x === undefined || x === null) return 'flat';
  return x > 1e-9 ? 'up' : x < -1e-9 ? 'down' : 'flat';
}

/** Compact counts: 940 · 12.4K */
export function count(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return group(String(Math.round(n)));
}

/** A ticker as people write it: $GEMINI (a leading $ in the symbol is kept once). */
export function tick(symbol: string | undefined | null): string {
  const s = maskSlurs((symbol || '').trim().replace(/^\$+/, ''));
  return '$' + (s.length > 12 ? s.slice(0, 11) + '…' : s || '?');
}

/** A coin name for display (user text: slurs masked, one line). */
export function nm(name: string | undefined | null): string {
  return maskSlurs(String(name ?? '').replace(/\s+/g, ' ').trim()).slice(0, 48);
}

/**
 * SOL for flap tiles: fixed decimals by size, so each digit keeps its tile while it counts up.
 * 0.0042 · 0.184 · 2.418 · 12.48 · 312.4 · 1,204
 */
export function solFlap(x: number | undefined | null, maxDp = 4): string {
  const v = typeof x === 'number' && Number.isFinite(x) ? Math.max(0, x) : 0;
  const dp = v >= 1000 ? 0 : v >= 100 ? 1 : v >= 10 ? 2 : v >= 1 ? 3 : v >= 0.1 ? 3 : 4;
  return group(v.toFixed(Math.min(dp, maxDp)));
}

/** A price per hour as people type it: 0.3 · 0.05 · 1.25 · 12 */
export function solPlain(x: number | undefined | null): string {
  const v = typeof x === 'number' && Number.isFinite(x) ? x : 0;
  if (v >= 100) return trim(v.toFixed(1));
  if (v >= 1) return trim(v.toFixed(3));
  return trim(v.toFixed(4)) || '0';
}

/** 14:20 (local time) */
export function hhmm(t: number): string {
  const d = new Date(t);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 1h · 3h · 12h · 45m */
export function hrs(msLen: number): string {
  const m = Math.round(msLen / 60000);
  if (m < 60) return m + 'm';
  const h = m / 60;
  return (Number.isInteger(h) ? h : h.toFixed(1)) + 'h';
}
