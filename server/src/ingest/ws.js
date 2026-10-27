// A WebSocket that stays connected (forked from peek-sol): exponential back-off with jitter on every close, a stall
// watchdog (no message for `stallMs` = reconnect), a paced send queue (sources limit how fast a client may send), and
// message/byte counters (the RPC load in /health).
import { log, logError, redact } from '../log.js';

export class Backoff {
  constructor(minMs = 1_000, maxMs = 60_000) {
    this.min = minMs;
    this.max = maxMs;
    this.n = 0;
  }

  next() {
    const base = Math.min(this.max, this.min * 2 ** this.n);
    this.n++;
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  reset() {
    this.n = 0;
  }
}

export class WsClient {
  constructor({ name, url, WebSocketImpl = globalThis.WebSocket, stallMs = 60_000, sendPerSec = 20, onOpen, onMessage, onClose, minBackoffMs = 1_000, maxBackoffMs = 60_000 }) {
    this.name = name;
    this.url = url;
    this.WS = WebSocketImpl;
    this.stallMs = stallMs;
    this.sendGap = Math.ceil(1000 / sendPerSec);
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.backoff = new Backoff(minBackoffMs, maxBackoffMs);
    this.ws = null;
    this.stopped = true;
    this.queue = [];
    this.sendTimer = null;
    this.retryTimer = null;
    this.watchTimer = null;
    this.stats = { connects: 0, reconnects: 0, messages: 0, bytes: 0, sent: 0, connectedAt: 0, lastMsgAt: 0, lastError: null, lastCloseAt: 0 };
    this.rate = []; // [t, messages, bytes] per second, the last 10 minutes
  }

  get open() {
    return !!this.ws && this.ws.readyState === 1;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.watchTimer = setInterval(() => this.watch(), Math.min(10_000, Math.max(1_000, this.stallMs / 3)));
    this.watchTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.sendTimer);
    this.sendTimer = null;
    this.queue = [];
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }

  connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new this.WS(this.url);
    } catch (e) {
      this.stats.lastError = String(e?.message ?? e).slice(0, 160);
      this.schedule();
      return;
    }
    this.ws = ws;
    this.queue = [];
    const t0 = Date.now();
    this.connectStartedAt = t0;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.stats.connects++;
      this.stats.connectedAt = Date.now();
      this.stats.lastMsgAt = Date.now();
      log(`${this.name}.open`, { url: redact(this.url), ms: Date.now() - t0 });
      try {
        this.onOpen?.();
      } catch (e) {
        logError(`${this.name}.onopen.fail`, e);
      }
    };
    ws.onmessage = (m) => {
      if (this.ws !== ws) return;
      this.stats.messages++;
      this.stats.lastMsgAt = Date.now();
      const text = typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8');
      this.stats.bytes += text.length;
      this.tick(text.length);
      let d;
      try {
        d = JSON.parse(text);
      } catch {
        return;
      }
      try {
        this.onMessage?.(d);
      } catch (e) {
        logError(`${this.name}.message.fail`, e);
      }
    };
    ws.onerror = (e) => {
      if (this.ws !== ws) return;
      this.stats.lastError = String(e?.message ?? e?.error?.message ?? 'socket error').slice(0, 160);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stats.lastCloseAt = Date.now();
      const lived = this.stats.connectedAt && this.stats.connectedAt >= t0 ? Date.now() - this.stats.connectedAt : 0;
      if (lived > 60_000) this.backoff.reset();
      log(`${this.name}.close`, { code: e?.code, lived, reason: String(e?.reason ?? '').slice(0, 80) || undefined });
      try {
        this.onClose?.();
      } catch (err) {
        logError(`${this.name}.onclose.fail`, err);
      }
      this.schedule();
    };
  }

  schedule() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const ms = this.backoff.next();
    this.stats.reconnects++;
    this.retryTimer = setTimeout(() => this.connect(), ms);
    this.retryTimer.unref?.();
  }

  /** Per-second message and byte counts (the last 10 minutes). */
  tick(bytes) {
    const s = Math.floor(Date.now() / 1000);
    const last = this.rate[this.rate.length - 1];
    if (last && last[0] === s) {
      last[1]++;
      last[2] += bytes;
    } else {
      this.rate.push([s, 1, bytes]);
      if (this.rate.length > 700) this.rate.splice(0, this.rate.length - 600);
    }
  }

  /** Messages and KB per second over the last `sec` seconds. */
  load(sec = 60) {
    const cut = Math.floor(Date.now() / 1000) - sec;
    let n = 0;
    let b = 0;
    for (let i = this.rate.length - 1; i >= 0 && this.rate[i][0] > cut; i--) {
      n += this.rate[i][1];
      b += this.rate[i][2];
    }
    return { msgPerSec: Math.round((n / sec) * 10) / 10, kbPerSec: Math.round((b / sec / 1024) * 10) / 10 };
  }

  /** Reconnect now (stall, or a caller asked). */
  restart(reason) {
    log(`${this.name}.restart`, { reason });
    const ws = this.ws;
    this.ws = null;
    try {
      this.onClose?.();
    } catch (err) {
      logError(`${this.name}.onclose.fail`, err);
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.schedule();
  }

  watch() {
    if (this.stopped || !this.ws) return;
    if (this.ws.readyState === 0 && Date.now() - this.connectStartedAt > 20_000) this.restart('connect stalled');
    else if (this.open && Date.now() - this.stats.lastMsgAt > this.stallMs) this.restart('no messages');
  }

  /** Queues a JSON message (paced). Dropped when the socket is closed: onOpen sends the full state again. */
  send(obj) {
    if (!this.open) return false;
    this.queue.push(JSON.stringify(obj));
    this.drain();
    return true;
  }

  drain() {
    if (this.sendTimer || !this.queue.length) return;
    const ws = this.ws;
    const msg = this.queue.shift();
    if (ws && ws.readyState === 1) {
      try {
        this.stats.sent++;
        ws.send(msg);
      } catch (e) {
        this.stats.lastError = String(e?.message ?? e).slice(0, 160);
      }
    }
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.drain();
    }, this.sendGap);
    this.sendTimer.unref?.();
  }

  status() {
    const s = this.stats;
    return {
      connected: this.open,
      url: redact(this.url),
      connectedAt: this.open ? s.connectedAt : null,
      lastMsgAt: s.lastMsgAt || null,
      connects: s.connects,
      reconnects: s.reconnects,
      messages: s.messages,
      bytes: s.bytes,
      sent: s.sent,
      last1m: this.load(60),
      lastError: s.lastError,
    };
  }
}
