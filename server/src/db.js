// SQLite (node:sqlite) storage: sign-in nonces and sessions, wants, per-minute creator-fee buckets and tracking
// coverage of the coins we follow, their recent trades (restarts keep the last hour exact), coin records, the
// flipfee program's events (buys, payouts, syncs) and the stream's event log (replay after a reconnect).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY, address TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires_at INTEGER NOT NULL);
-- the stream's non-trade events (buy, paid, register, window, fee, want), for replay after a reconnect
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, t INTEGER NOT NULL, type TEXT NOT NULL, mint TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_mint ON events (mint, id);
-- one row per wallet per coin
CREATE TABLE IF NOT EXISTS wants (mint TEXT NOT NULL, wallet TEXT NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (mint, wallet));
CREATE INDEX IF NOT EXISTS wants_wallet ON wants (wallet, t);
-- exact creator fees per coin and minute (m = unix minute), from the trade events we decoded
CREATE TABLE IF NOT EXISTS buckets (
  mint TEXT NOT NULL, m INTEGER NOT NULL, fee INTEGER NOT NULL DEFAULT 0, trades INTEGER NOT NULL DEFAULT 0,
  buys INTEGER NOT NULL DEFAULT 0, vol INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (mint, m)
);
CREATE INDEX IF NOT EXISTS buckets_m ON buckets (m);
-- when we followed a coin's trades (ms, [start, end)); end NULL while it runs
CREATE TABLE IF NOT EXISTS coverage (mint TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER, PRIMARY KEY (mint, start));
-- every trade of the last 65 minutes, lean (a restart keeps the 1m/10m/1h windows exact)
CREATE TABLE IF NOT EXISTS trades (mint TEXT NOT NULL, t INTEGER NOT NULL, buy INTEGER NOT NULL, lamports INTEGER NOT NULL, fee INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS trades_t ON trades (t);
-- the last 100 trades per coin, any age (the coin page)
CREATE TABLE IF NOT EXISTS recent (
  sig TEXT NOT NULL, ix INTEGER NOT NULL, mint TEXT NOT NULL, t INTEGER NOT NULL, buy INTEGER NOT NULL,
  lamports INTEGER NOT NULL, fee INTEGER NOT NULL, wallet TEXT, venue TEXT, PRIMARY KEY (sig, ix)
);
CREATE INDEX IF NOT EXISTS recent_mint ON recent (mint, t);
-- coin records (pump.fun API / chain) of coins we showed, so a restart paints names and images at once
CREATE TABLE IF NOT EXISTS coins (mint TEXT PRIMARY KEY, json TEXT NOT NULL, t INTEGER NOT NULL);
-- flipfee program events, one row per (signature, event index)
-- kind: paid → holder | owner; hours and owner_lamports (the dev's part of a sale): buy
CREATE TABLE IF NOT EXISTS chain_events (
  sig TEXT NOT NULL, ix INTEGER NOT NULL, slot INTEGER, t INTEGER NOT NULL, type TEXT NOT NULL, kind TEXT, mint TEXT,
  wallet TEXT, lamports INTEGER NOT NULL DEFAULT 0, hours INTEGER NOT NULL DEFAULT 0,
  owner_lamports INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL, PRIMARY KEY (sig, ix)
);
CREATE INDEX IF NOT EXISTS chain_events_t ON chain_events (type, t);
CREATE INDEX IF NOT EXISTS chain_events_wallet ON chain_events (wallet, type);
CREATE INDEX IF NOT EXISTS chain_events_mint ON chain_events (mint, type, t);
-- every window ever seen on chain (the Coin account prunes ended, paid windows): the timeline's past and Me
CREATE TABLE IF NOT EXISTS windows (
  mint TEXT NOT NULL, holder TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
  earned INTEGER NOT NULL DEFAULT 0, owed INTEGER NOT NULL DEFAULT 0, cost INTEGER, sig TEXT, seen INTEGER NOT NULL,
  PRIMARY KEY (mint, start)
);
CREATE INDEX IF NOT EXISTS windows_holder ON windows (holder, start);
`;

export class Db {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;');
    // an early build kept full rows in `trades`: it is only the last hour, so it is rebuilt lean
    const old = this.db.prepare("SELECT name FROM pragma_table_info('trades') WHERE name = 'sig'").get();
    if (old) this.db.exec('DROP TABLE trades');
    this.db.exec(SCHEMA);
    this.stmts = new Map();
  }

  close() {
    this.db.close();
  }

  q(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  run(sql, ...args) {
    return this.q(sql).run(...args);
  }

  get(sql, ...args) {
    return this.q(sql).get(...args);
  }

  all(sql, ...args) {
    return this.q(sql).all(...args);
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getMeta(k, d = null) {
    const r = this.get('SELECT v FROM meta WHERE k = ?', k);
    return r ? r.v : d;
  }

  setMeta(k, v) {
    this.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
  }

  /** UTC day start (ms) of `t`. */
  static dayStart(t = Date.now()) {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
}
