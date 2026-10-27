// SSE /api/stream (DESIGN.md §2.2): named events `trade`, `fee`, `window`, `buy`, `paid`, `register`, `stats`, `want`
// (a plain `message` with a `type` field works too), and `: ping` comments. Events queue up and are handed over once
// per animation frame. The connection comes back on its own: EventSource retries network errors; a closed stream or
// 25 s of silence opens a new one with backoff.
import { API_BASE } from './http.ts';
import { streamEvent } from './norm.ts';
import type { StreamEvent } from './types.ts';

export type Conn = 'connecting' | 'live' | 'retry';

export interface StreamHandlers {
  events(list: StreamEvent[]): void;
  state(s: Conn): void;
  /** Called on every (re)open after the first: fill the gap from REST. */
  reopened(): void;
}

const NAMES = ['trade', 'fee', 'window', 'buy', 'paid', 'register', 'stats', 'want'] as const;
const QUEUE_CAP = 400;
const SILENCE_MS = 25000;

export function startStream(h: StreamHandlers): () => void {
  let es: EventSource | null = null;
  let queue: StreamEvent[] = [];
  let raf = 0;
  let flushTimer = 0;
  let retryTimer = 0;
  let backoff = 1000;
  let last = Date.now();
  let opens = 0;
  let stopped = false;
  /** the newest event id (ULID): a new connection asks the server to replay what came after it */
  let lastId = '';

  const flush = () => {
    raf = 0;
    window.clearTimeout(flushTimer);
    flushTimer = 0;
    if (!queue.length) return;
    const q = queue;
    queue = [];
    h.events(q);
  };
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(flush);
    // a hidden tab gets no frames: hand over at least every 1.5 s
    if (!flushTimer) flushTimer = window.setTimeout(flush, 1500);
  };
  const push = (type: string, data: string, id = '') => {
    last = Date.now();
    if (id && id > lastId) lastId = id;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const t = type === 'message' && raw && typeof raw === 'object' ? String((raw as { type?: unknown }).type ?? '') : type;
    const ev = streamEvent(t, raw);
    if (!ev) return;
    queue.push(ev);
    if (queue.length > QUEUE_CAP) queue = queue.slice(-QUEUE_CAP);
    schedule();
  };

  const close = () => {
    if (es) {
      es.onerror = null;
      es.close();
      es = null;
    }
  };

  const retry = () => {
    close();
    if (stopped) return;
    h.state('retry');
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(open, backoff);
    backoff = Math.min(15000, backoff * 1.8);
  };

  function open() {
    if (stopped) return;
    close();
    h.state(opens ? 'retry' : 'connecting');
    const src = new EventSource(API_BASE + '/stream' + (lastId ? '?after=' + encodeURIComponent(lastId) : ''));
    es = src;
    last = Date.now();
    src.onopen = () => {
      backoff = 1000;
      last = Date.now();
      h.state('live');
      if (opens > 0) h.reopened();
      opens++;
    };
    for (const n of NAMES) src.addEventListener(n, (m) => push(n, (m as MessageEvent<string>).data, (m as MessageEvent<string>).lastEventId));
    src.addEventListener('message', (m) => push('message', (m as MessageEvent<string>).data, (m as MessageEvent<string>).lastEventId));
    src.addEventListener('ping', () => {
      last = Date.now();
    });
    src.onerror = () => {
      if (src.readyState === EventSource.CLOSED) retry();
      else h.state('retry');
    };
  }

  // the server pings and sends stats every few seconds; a long silence means a dead connection behind a proxy
  const watchdog = window.setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    if (Date.now() - last > SILENCE_MS) retry();
  }, 5000);
  const onVis = () => {
    if (document.visibilityState === 'visible' && Date.now() - last > SILENCE_MS) retry();
  };
  document.addEventListener('visibilitychange', onVis);
  const onOnline = () => retry();
  window.addEventListener('online', onOnline);

  open();
  return () => {
    stopped = true;
    close();
    cancelAnimationFrame(raf);
    window.clearTimeout(flushTimer);
    window.clearTimeout(retryTimer);
    window.clearInterval(watchdog);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('online', onOnline);
  };
}
