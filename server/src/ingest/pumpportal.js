// PumpPortal data feed (wss://pumpportal.fun/api/data): one connection for the whole server, as
// PumpPortal asks. subscribeNewToken (launches: the creator of a new coin at once) and subscribeMigration
// (graduations: a tracked curve moves to its PumpSwap pool). PUMPPORTAL_API_KEY is passed when set. flipfee takes its
// trades from the program logs (curvelogs.js), never from here: PumpPortal's trade messages carry no creator fee.
// Every reconnect subscribes again.
import { log } from '../log.js';
import { WsClient } from './ws.js';

const n = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);

export function normCreate(d, t = Date.now()) {
  if (!d?.mint) return null;
  return {
    mint: d.mint,
    sig: d.signature ?? null,
    creator: d.traderPublicKey ?? null,
    devBuySol: n(d.solAmount) ?? 0,
    devTokens: n(d.initialBuy) ?? 0,
    curveKey: d.bondingCurveKey ?? null,
    vSol: n(d.vSolInBondingCurve),
    vTokens: n(d.vTokensInBondingCurve),
    mcapSol: n(d.marketCapSol),
    name: d.name ?? '',
    symbol: d.symbol ?? '',
    uri: d.uri ?? null,
    pool: d.pool ?? 'pump',
    mayhem: !!d.is_mayhem_mode,
    t,
  };
}

export function normTrade(d, t = Date.now()) {
  if (!d?.mint || (d.txType !== 'buy' && d.txType !== 'sell')) return null;
  return {
    mint: d.mint,
    sig: d.signature ?? null,
    wallet: d.traderPublicKey ?? null,
    isBuy: d.txType === 'buy',
    sol: n(d.solAmount) ?? 0,
    tokens: n(d.tokenAmount) ?? 0,
    vSol: n(d.vSolInBondingCurve),
    vTokens: n(d.vTokensInBondingCurve),
    pool: d.pool ?? null,
    t,
    src: 'pumpportal',
  };
}

export class PumpPortal {
  constructor({ url = 'wss://pumpportal.fun/api/data', apiKey = '', WebSocketImpl, onCreate, onMigrate, onTrade, stallMs = 60_000 }) {
    this.apiKey = apiKey;
    this.onCreate = onCreate;
    this.onMigrate = onMigrate;
    this.onTrade = onTrade;
    this.keys = new Set(); // trade subscriptions we want
    this.subscribed = new Set(); // trade subscriptions sent on this connection
    this.counts = { creates: 0, migrations: 0, trades: 0 };
    this.notes = new Map(); // PumpPortal's info messages, once each
    this.tradesRefused = false;
    const full = apiKey ? `${url}${url.includes('?') ? '&' : '?'}api-key=${encodeURIComponent(apiKey)}` : url;
    this.ws = new WsClient({ name: 'pumpportal', url: full, WebSocketImpl, stallMs, sendPerSec: 10, onOpen: () => this.opened(), onMessage: (d) => this.message(d) });
  }

  get tradesOn() {
    return !!this.apiKey && !this.tradesRefused;
  }

  start() {
    this.ws.start();
  }

  stop() {
    this.ws.stop();
  }

  opened() {
    this.subscribed.clear();
    this.ws.send({ method: 'subscribeNewToken' });
    this.ws.send({ method: 'subscribeMigration' });
    if (this.tradesOn && this.keys.size) this.sendTrades([...this.keys], true);
  }

  sendTrades(keys, on) {
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      this.ws.send({ method: on ? 'subscribeTokenTrade' : 'unsubscribeTokenTrade', keys: chunk });
      for (const k of chunk) (on ? this.subscribed.add(k) : this.subscribed.delete(k));
    }
  }

  /** The mints whose trades we want (only used with an API key). */
  setTradeKeys(keys) {
    this.keys = new Set(keys);
    if (!this.tradesOn || !this.ws.open) return;
    const add = [...this.keys].filter((k) => !this.subscribed.has(k));
    const drop = [...this.subscribed].filter((k) => !this.keys.has(k));
    if (add.length) this.sendTrades(add, true);
    if (drop.length) this.sendTrades(drop, false);
  }

  message(d) {
    if (d?.txType === 'create') {
      const c = normCreate(d);
      if (c) {
        this.counts.creates++;
        this.onCreate?.(c);
      }
      return;
    }
    if (d?.txType === 'migrate' || d?.txType === 'migration') {
      if (d.mint) {
        this.counts.migrations++;
        this.onMigrate?.({ mint: d.mint, pool: d.pool ?? null, sig: d.signature ?? null, t: Date.now() });
      }
      return;
    }
    if (d?.txType === 'buy' || d?.txType === 'sell') {
      const tr = normTrade(d);
      if (tr) {
        this.counts.trades++;
        this.onTrade?.(tr);
      }
      return;
    }
    if (typeof d?.message === 'string' || d?.errors) {
      const text = String(d.message ?? JSON.stringify(d.errors)).slice(0, 160);
      if (/api key/i.test(text) && /TokenTrade/i.test(text)) this.tradesRefused = true;
      if (!this.notes.has(text)) {
        this.notes.set(text, Date.now());
        log('pumpportal.note', { text });
      }
    }
  }

  status() {
    return {
      ...this.ws.status(),
      ...this.counts,
      trades: this.tradesOn ? { on: true, keys: this.keys.size, subscribed: this.subscribed.size, received: this.counts.trades } : { on: false, reason: this.apiKey ? 'refused' : 'no PUMPPORTAL_API_KEY' },
      notes: [...this.notes.keys()].slice(-3),
    };
  }
}
