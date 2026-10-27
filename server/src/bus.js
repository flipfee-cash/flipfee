// The event bus behind GET /api/stream. Every stream event goes through push(type, data): it gets a ULID `id` and a
// time `t`, lands in a ring buffer of the last RING_SIZE events (replay after a reconnect: Last-Event-ID), and goes out
// to the SSE subscribers. Events other than trades (buy, paid, register, window, fee, want) also land in SQLite (the
// last 20,000), so a replay can cross a restart. `stats` frames are not events: the SSE hub sends them on a timer.
import { logError } from './log.js';
import { isUlid, ulid } from './ulid.js';

export const TYPES = ['trade', 'fee', 'window', 'buy', 'paid', 'register', 'want', 'book'];
const TYPE_SET = new Set(TYPES);
const KEEP_ROWS = 20_000;

export class Bus {
  constructor({ db = null, size = 2_000, now = () => Date.now() } = {}) {
    this.db = db;
    this.size = size;
    this.now = now;
    this.ring = [];
    this.subs = new Set();
    this.inserts = 0;
    this.counts = Object.fromEntries(TYPES.map((t) => [t, 0]));
    if (db) {
      const rows = db.all('SELECT json FROM events ORDER BY id DESC LIMIT ?', Math.min(size, 500));
      this.ring = rows.reverse().map((r) => Object.freeze(JSON.parse(r.json)));
    }
  }

  /**
   * Stamps and publishes one event. Returns the frozen event ({ id, eid, t, type, ...data }): `eid` is the stream's
   * ULID (the SSE `id:` line, Last-Event-ID replay); `id` is the payload's own id when it has one (a trade's
   * "<signature>:<index>", the same in snapshots and in the stream), else the ULID.
   */
  push(type, data = {}) {
    if (!TYPE_SET.has(type)) throw new Error(`bad event type ${type}`);
    const t = Number.isFinite(data.t) ? data.t : this.now();
    const eid = ulid(this.now());
    const ev = Object.freeze({ ...data, id: data.id ?? eid, eid, t, type });
    this.ring.push(ev);
    if (this.ring.length > this.size + 200) this.ring.splice(0, this.ring.length - this.size);
    this.counts[type]++;
    if (this.db && type !== 'trade') {
      try {
        this.db.run('INSERT OR IGNORE INTO events (id, t, type, mint, json) VALUES (?, ?, ?, ?, ?)', ev.eid, ev.t, ev.type, ev.mint ?? null, JSON.stringify(ev));
        if (++this.inserts % 1000 === 0) this.db.run('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id DESC LIMIT -1 OFFSET ?)', KEEP_ROWS);
      } catch (e) {
        logError('bus.persist.fail', e);
      }
    }
    for (const fn of this.subs) {
      try {
        fn(ev);
      } catch (e) {
        logError('bus.sub.fail', e);
      }
    }
    return ev;
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** Events after `id`, oldest first (SSE replay), at most `max`: the ring, else the stored non-trade events. */
  after(id, max = 500) {
    if (!isUlid(id)) return [];
    const oldest = this.ring[0]?.eid;
    if (oldest && id >= oldest) {
      const out = [];
      for (const e of this.ring) if (e.eid > id) out.push(e);
      return out.slice(-max);
    }
    if (!this.db) return this.ring.slice(-max);
    return this.db
      .all('SELECT json FROM events WHERE id > ? ORDER BY id DESC LIMIT ?', id, max)
      .reverse()
      .map((r) => JSON.parse(r.json));
  }

  /** The newest `limit` events (of `types`, for `mints`), oldest first. */
  recent({ limit = 100, types = null, mints = null } = {}) {
    const out = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.ring[i];
      if (types && !types.has(e.type)) continue;
      if (mints && !mints.has(e.mint)) continue;
      out.push(e);
    }
    return out.reverse();
  }

  get last() {
    return this.ring[this.ring.length - 1] ?? null;
  }
}
