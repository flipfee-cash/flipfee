// UI state: sheets (buy, connect a coin), the Phantom sheet, the wallet menu, the phone tab, toasts.
import { createStore } from './store.ts';

export type HomeTab = 'live' | 'hot';

export type Sheet =
  /** Buy hours of a coin: `go` starts the transaction at once (the row's one-tap Buy 1h). */
  | { kind: 'buy'; mint: string; hours: number; go: boolean }
  /** The one-time dev connect sheet (DESIGN.md §1.5). */
  | { kind: 'connect'; mint: string };

export interface Toast {
  id: number;
  kind: 'ok' | 'warn' | 'cash' | 'info';
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

interface UiState {
  tab: HomeTab;
  sheet: Sheet | null;
  /** Phantom is missing: the sheet with the one way in */
  phantom: boolean;
  menu: boolean;
  toasts: Toast[];
}

export const ui = createStore<UiState>({ tab: 'live', sheet: null, phantom: false, menu: false, toasts: [] });

export const setTab = (tab: HomeTab) => ui.set({ tab });

// ───────── sheets (the phone Back button closes them) ─────────

let pushed = false;

function pushBack(): void {
  if (pushed) return;
  try {
    history.pushState({ ffSheet: 1 }, '');
    pushed = true;
  } catch {
    pushed = false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'popstate',
    (e) => {
      if (!pushed) return;
      pushed = false;
      const s = ui.get();
      if (s.phantom) ui.set({ phantom: false });
      else if (s.menu) ui.set({ menu: false });
      else if (s.sheet) ui.set({ sheet: null });
      // the router ignores this pop: the path did not change
      e.stopImmediatePropagation();
    },
    { capture: true },
  );
}

function popBack(): void {
  if (!pushed) return;
  pushed = false;
  try {
    history.back();
  } catch {
    // nothing to undo
  }
}

const anyOpen = () => {
  const s = ui.get();
  return !!s.sheet || s.phantom || s.menu;
};

/** `push: false` when the URL itself opened the sheet (/dev/<mint>): Back already leaves that page. */
export function openSheet(sheet: Sheet, push = true): void {
  const had = anyOpen();
  ui.set({ sheet });
  if (!had && push) pushBack();
}

export function closeSheet(): void {
  if (!ui.get().sheet) return;
  ui.set({ sheet: null });
  if (!anyOpen()) popBack();
}

export function setPhantomSheet(on: boolean): void {
  const had = anyOpen();
  ui.set({ phantom: on });
  if (on && !had) pushBack();
  else if (!on && !anyOpen()) popBack();
}

export function setMenu(on: boolean): void {
  const had = anyOpen();
  ui.set({ menu: on });
  if (on && !had) pushBack();
  else if (!on && !anyOpen()) popBack();
}

/** Leaves sheets without touching history (a route change took over). */
export function dropOverlays(): void {
  pushed = false;
  ui.set({ sheet: null, phantom: false, menu: false });
}

/**
 * Closes every overlay and goes to `path` in one history step: the entry a sheet pushed for the Back button becomes the
 * new page (a history.back() here would race the navigation).
 */
export function leaveTo(path: string, go: (p: string, replace: boolean) => void): void {
  const had = pushed;
  dropOverlays();
  go(path, had);
}

// ───────── toasts ─────────

let toastId = 0;

export function toast(t: Omit<Toast, 'id'>, ms = 2800): number {
  const id = ++toastId;
  ui.set((s) => ({ toasts: [...s.toasts.slice(-2), { ...t, id }] }));
  window.setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id: number): void {
  ui.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
