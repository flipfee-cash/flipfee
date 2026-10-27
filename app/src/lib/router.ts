// Path routes (DESIGN.md §2.3): `/` the board, `/c/<mint>` a coin, `/dev`, `/me`, `/docs`. Shared links are real paths
// (flipfee.cash/c/<mint>), so the host serves index.html for every route. Links inside the app use `go()`.
import { flushSync } from 'react-dom';
import { createStore } from '../state/store.ts';

/** A plausible Solana address (the server checks it exactly). */
const isAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export type Route = { name: 'board' } | { name: 'coin'; mint: string } | { name: 'dev'; mint?: string } | { name: 'me' } | { name: 'docs' } | { name: 'market' } | { name: 'terms' } | { name: 'privacy' };

export function parsePath(path: string): Route {
  const parts = path.split('?')[0].split('#')[0].split('/').filter(Boolean);
  switch (parts[0]) {
    case 'c': {
      const mint = decodeURIComponent(parts[1] ?? '');
      return isAddress(mint) ? { name: 'coin', mint } : { name: 'board' };
    }
    case 'dev': {
      const mint = decodeURIComponent(parts[1] ?? '');
      return isAddress(mint) ? { name: 'dev', mint } : { name: 'dev' };
    }
    case 'me':
      return { name: 'me' };
    case 'docs':
      return { name: 'docs' };
    case 'market':
      return { name: 'market' };
    case 'terms':
      return { name: 'terms' };
    case 'privacy':
      return { name: 'privacy' };
    default:
      return { name: 'board' };
  }
}

const read = (): Route => {
  try {
    return parsePath(window.location.pathname);
  } catch {
    return { name: 'board' };
  }
};

export const router = createStore<{ route: Route; path: string }>({ route: read(), path: typeof window !== 'undefined' ? window.location.pathname : '/' });

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => router.set({ route: read(), path: window.location.pathname }));
}

export function go(path: string, replace = false): void {
  if (window.location.pathname === path) {
    window.scrollTo({ top: 0 });
    return;
  }
  const apply = () => {
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
    router.set({ route: read(), path });
  };
  // seamless page changes (owner, 2026-10-26): elements that share a view-transition-name (a coin's picture and
  // ticker, the vault coin) move from the old page to the new one; the rest cross-fades. Off with reduced motion.
  const doc = document as Document & { startViewTransition?: (cb: () => Promise<void>) => { ready: Promise<void>; finished: Promise<void> } };
  if (!doc.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    apply();
    return;
  }
  const t = doc.startViewTransition(async () => {
    flushSync(apply);
    await pageShown();
  });
  // an aborted transition still lands on the new page; only the animation is lost
  t.ready.catch(() => {});
  t.finished.catch(() => {});
}

/** Resolves once the new page has painted past its loading state (at most ~400 ms). */
function pageShown(): Promise<void> {
  return new Promise((done) => {
    const t0 = performance.now();
    // timers, not frames: rendering is paused while a view transition waits for its update
    const check = () => {
      if (!document.querySelector('[data-page-wait]') || performance.now() - t0 > 400) done();
      else window.setTimeout(check, 16);
    };
    window.setTimeout(check, 16);
  });
}

/** An in-app link: a real href (open in a new tab works), a pushState on a plain click. */
export function linkProps(path: string): { href: string; onClick: (e: React.MouseEvent) => void } {
  return {
    href: path,
    onClick: (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      nameShared(e.currentTarget as Element, path);
      go(path);
    },
  };
}

/**
 * Names the elements that should travel to the next page (view transitions need each name once per page, so the
 * names are set only on what was clicked: [data-vt] inside the link, and [data-vt-with="<path>"] anywhere).
 */
function nameShared(link: Element, path: string): void {
  const els = [...link.querySelectorAll<HTMLElement>('[data-vt]'), ...document.querySelectorAll<HTMLElement>(`[data-vt-with="${CSS.escape(path)}"]`)];
  for (const el of els) el.style.setProperty('view-transition-name', el.dataset.vt ?? '');
  window.setTimeout(() => els.forEach((el) => el.style.removeProperty('view-transition-name')), 900);
}

export const coinPath = (mint: string) => '/c/' + mint;
export const SITE = 'https://flipfee.cash';
export const shareUrl = (mint: string) => SITE + coinPath(mint);
