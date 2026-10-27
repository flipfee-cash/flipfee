// Boot and keep the board live (DESIGN.md §2.3): the localStorage copy paints at once on a repeat visit, the
// `/api/board` snapshot (asked for by index.html before the app code loads) replaces it, then SSE moves every number.
// A fresh snapshot every minute re-sorts the rows and corrects the rolling numbers.
import { get } from './http.ts';
import { board as normBoard } from './norm.ts';
import { startStream } from './stream.ts';
import type { Board, StreamEvent } from './types.ts';
import { applyBoard, applyEvents, board, cachedBoard, setConn, tickRecipients } from '../state/board.ts';
import { setSkew, onTick } from '../lib/clock.tsx';

interface Boot {
  at: number;
  board: Promise<unknown>;
}

declare global {
  interface Window {
    __ffBoot?: Boot;
  }
}

function takeBoot(): Boot | null {
  const b = window.__ffBoot ?? null;
  window.__ffBoot = undefined;
  // a boot older than 20 s (a tab restored from cache) is stale
  return b && Date.now() - b.at < 20000 ? b : null;
}

function apply(raw: unknown, sentAt: number): boolean {
  const b: Board | null = normBoard(raw);
  if (!b) return false;
  // the server's clock, corrected by half the round trip
  const rtt = Date.now() - sentAt;
  if (b.at > 0 && rtt < 5000) setSkew(b.at + rtt / 2 - Date.now());
  applyBoard(b);
  return true;
}

type StreamFn = (list: StreamEvent[]) => void;
const streamSubs = new Set<StreamFn>();

/** Raw stream batches (after the board applied them): transaction confirmations listen here. */
export function onStream(fn: StreamFn): () => void {
  streamSubs.add(fn);
  return () => void streamSubs.delete(fn);
}

let inflight: Promise<void> | null = null;

function fetchBoard(): Promise<void> {
  const t0 = Date.now();
  return get<unknown>('/board', { timeoutMs: 12000 })
    .then((r) => {
      if (!apply(r, t0) && !board.get().at) board.set({ ready: true, failed: true });
    })
    .catch(() => {
      // no snapshot yet (a cached copy is not one): say the server is busy; a later snapshot clears it
      const s = board.get();
      if (!s.at || s.cached) board.set({ ready: true, failed: true });
    });
}

export function loadBoard(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchBoard().finally(() => {
    inflight = null;
  });
  return inflight;
}

let started = false;

export function bootLive(): void {
  if (started) return;
  started = true;
  const cached = cachedBoard();
  if (cached) applyBoard(cached, true);
  const b = takeBoot();
  if (b) {
    const t0 = b.at;
    inflight = b.board
      .then((r) => (apply(r, t0) ? undefined : fetchBoard()))
      .catch(() => fetchBoard())
      .finally(() => {
        inflight = null;
      });
  } else void loadBoard();

  startStream({
    events: (list) => {
      applyEvents(list);
      for (const fn of streamSubs) fn(list);
    },
    state: setConn,
    reopened: () => void loadBoard(),
  });

  onTick(() => tickRecipients());
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void loadBoard();
  }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - board.get().at > 60000) void loadBoard();
  });
}
