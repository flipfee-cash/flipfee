// HTTP API (node:http, JSON, DESIGN §2.2). CORS for ALLOWED_ORIGIN (and any localhost origin outside production).
// Bearer sessions from /api/auth/verify. Errors: { code, error } with a status; anything unexpected is a logged 500.
// Amounts: { lamports: "<integer string>", sol: <number> }. Times: ms since epoch.
//
//   GET  /api/board        { at, v, stats, hero, live: [Row + flipfee + thisHour + recent], hot: [Row + recent] }
//   GET  /api/coin/:mint   { coin: Row + detail, trades: [Trade ×≤100, newest first], timeline: { now, from, segments } }
//   GET  /api/dev/:wallet  { wallet, coins: [Row + { eligibility: { kind, admin, graduated, quoteMint, source, … },
//                          suggested }] }   kind: ready-new · ready · almost · locked · flipfee · usdc · not-admin ·
//                          unsupported · not-found (the client's eligibility; the chain fallback says the same)
//   GET  /api/me/:wallet   { wallet, hours: [Win + { mint, symbol, name, image, hours, state, live }], coins: [Row],
//                          totals: { spent, received, devSales, devFees }, wants: [mint] }
//   GET  /api/stream       SSE named events trade · fee · window · buy · paid · register · want (`id:` = stream ULID,
//                          Last-Event-ID / ?after= replays the gap), stats every 5 s, ping every 15 s;
//                          ?types=a,b · ?mints=x,y. The board's stream thins trades of coins off flipfee (25/s).
//   POST /api/auth/nonce {address} · POST /api/auth/verify {message|signedMessage, signature} · GET /api/auth/me ·
//   POST /api/auth/logout
//   POST /api/want {mint}  (session) → { mint, count, wanted, added }
//   GET  /api/market?q=    { q, coins: [Row + book: { bids, asks (3 levels), bestBid, bestAsk, spread, orders }] }
//   GET  /api/book/:mint   { mint, bids, asks: [Amount + { hours, orders, house, mine }], bestBid, bestAsk, spread,
//                          mid, orders, mine: [Order] }  ·  POST /api/orders {mint, side: bid|ask, price (SOL/hour),
//                          hours} (session) → { order, book }  ·  DELETE /api/orders/:id  ·  GET /api/orders/mine
//   GET  /health (= /api/health): components, tracking, RPC load, index, keeper
//
// Row: { mint, symbol, name, image, createdAt, ageSec, mcapUsd, priceSol, priceUsd, graduated, venue: curve|amm,
//   quote: sol|other, creator, dev, admin, sharing, canJoin, feeBps,
//   fees: { m1, m10, h1, h6, h24: Amount + { exact, trades, buys, sells, vol, coverSec?, est? } },
//   trades1h, buys1h, sells1h, volume1h, hourly: [[hourStartMs, sol, cover]], tracked, trackedSince, lastTradeAt,
//   socials, hidden, links, wants, flipfee: FF | null, thisHour: { …Amount, since, until, to, kind: holder|dev } | null }
//   `exact`: we followed every trade of the window; else `coverSec` says how much of it we saw and `est` (h1/h6/h24)
//   is pump.fun's / DexScreener's volume × the coin's creator-fee rate.
// FF: { owner, address, vault, price, maxAhead, paused, registeredAt, windows: [Win + live], past: [Win], live,
//   nextStart, openUntil, hoursOpen, hoursSold, sales, feesIn, paidOut, ownerOwed, ownerPaid, holderPaid, lastSync }
// Win: { holder, start, end, earned, owed, paid, cost?, sig? }
// Trade: { id: "<sig>:<index>", mint, sig, ix, t, side: buy|sell, sol, lamports, fee: Amount, wallet, venue, to? }
import { createServer } from 'node:http';
import { PublicKey } from '@solana/web3.js';
import { httpError } from './errors.js';
import { logError } from './log.js';
import { isUlid } from './ulid.js';
import { isAddress } from './auth.js';
import { TYPES } from './bus.js';

const MAX_BODY = 16 * 1024;
const STREAM_TYPES = new Set([...TYPES, 'stats']);

/** A base58 32-byte public key (a mint) or null. */
export function validMint(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return null;
  try {
    return new PublicKey(s).toBase58() === s ? s : null;
  } catch {
    return null;
  }
}

/** A small sliding-window limiter per client and route. */
export class Limiter {
  constructor() {
    this.hits = new Map();
  }

  take(key, max, windowMs = 60_000) {
    const t = Date.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (list.length >= max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) this.hits.clear();
    return true;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(httpError(413, 'tooLarge'));
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(httpError(400, 'badJson'));
      }
    });
    req.on('error', reject);
  });
}

/** The site's origin as the proxy saw it (a same-origin GET has no Origin header). */
export function forwardedOrigin(req) {
  const first = (v) => String(v ?? '').split(',')[0].trim();
  const host = first(req.headers['x-forwarded-host']) || first(req.headers.host);
  const proto = (first(req.headers['x-forwarded-proto']) || 'http').toLowerCase();
  if (!host || (proto !== 'http' && proto !== 'https')) return '';
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return '';
  }
}

/** The client IP: the last X-Forwarded-For hop behind a trusted proxy (TRUST_PROXY=1), else the socket address. */
export function clientIp(req, trustProxy) {
  const fwd = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim() : '';
  const ip = fwd || req.socket?.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

const parseSet = (s, ok) => {
  if (!s) return null;
  const set = new Set(String(s).split(',').map((x) => x.trim()).filter(ok));
  return set.size ? set : null;
};

/** `app`: { cfg, auth, views, wants, sse, health(), store } */
export function makeHandler(app, limiter = new Limiter()) {
  const { cfg, auth } = app;

  return async function handle(req, res) {
    const origin = String(req.headers.origin ?? '').replace(/\/$/, '');
    const cors = {};
    if (origin && auth.allowed(origin)) {
      cors['access-control-allow-origin'] = origin;
      cors['access-control-allow-headers'] = 'authorization, content-type, last-event-id';
      cors['access-control-allow-methods'] = 'GET, POST, DELETE, OPTIONS';
      cors['access-control-max-age'] = '600';
      cors.vary = 'Origin';
    }
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors };
    const send = (status, body, extra = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, { ...headers, ...extra });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(cors['access-control-allow-origin'] ? 204 : 403, headers);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const q = (k) => url.searchParams.get(k);
    const ip = clientIp(req, cfg.trustProxy);
    const limit = (name, max, key = ip) => {
      if (!limiter.take(`${name}:${key}`, max)) throw httpError(429, 'slow');
    };
    const me = () => auth.session(req.headers.authorization);
    const needMe = () => {
      const a = me();
      if (!a) throw httpError(401, 'signIn');
      return a;
    };
    const walletParam = (raw) => {
      const w = decodeURIComponent(raw);
      if (!isAddress(w)) throw httpError(400, 'badAddress');
      return w;
    };

    try {
      let m;
      if (req.method === 'GET' && (path === '/api/health' || path === '/health')) {
        const h = app.health();
        return send(h.ok ? 200 : 503, h);
      }
      if (req.method === 'GET' && path === '/api/stream') {
        limit('stream', 30);
        const after = req.headers['last-event-id'] || q('after');
        const ok = app.sse.open(req, res, {
          ip,
          headers: cors,
          after: isUlid(after) ? after : null,
          types: parseSet(q('types'), (x) => STREAM_TYPES.has(x)),
          mints: parseSet(q('mints'), (x) => !!validMint(x)),
        });
        if (!ok) return send(429, { code: 'slow', error: 'Too many streams.' });
        return undefined;
      }
      if (req.method === 'GET' && path === '/api/board') {
        limit('board', 240);
        return send(200, app.views.board());
      }
      if (req.method === 'GET' && path === '/api/stats') {
        limit('stats', 240);
        return send(200, app.views.stats());
      }
      if (req.method === 'GET' && (m = /^\/api\/coin\/([^/]+)$/.exec(path))) {
        limit('coin', 120);
        const mint = validMint(decodeURIComponent(m[1]));
        if (!mint) throw httpError(400, 'badMint');
        // a coin we do not hold costs pump.fun requests: fewer of those per client
        if (!app.store.get(mint)) limit('coinNew', 20);
        return send(200, await app.views.coin(mint));
      }
      if (req.method === 'GET' && (m = /^\/api\/dev\/([^/]+)$/.exec(path))) {
        limit('dev', 10);
        return send(200, await app.views.dev(walletParam(m[1])));
      }
      if (req.method === 'GET' && (m = /^\/api\/me\/([^/]+)$/.exec(path))) {
        limit('me', 120);
        return send(200, app.views.me(walletParam(m[1])));
      }
      if (req.method === 'POST' && path === '/api/want') {
        const a = needMe();
        limit('want', 30, a);
        const b = await readBody(req);
        const mint = validMint(b?.mint);
        if (!mint) throw httpError(400, 'badMint');
        await app.checkWantable(mint);
        return send(200, app.wants.add(a, mint));
      }

      // ── Order book (orders.js): intents, no settlement yet
      if (req.method === 'GET' && path === '/api/market') {
        limit('market', 120);
        return send(200, await app.market(q('q') ?? ''));
      }
      if (req.method === 'GET' && (m = /^\/api\/book\/([^/]+)$/.exec(path))) {
        limit('book', 240);
        const mint = validMint(decodeURIComponent(m[1]));
        if (!mint) throw httpError(400, 'badMint');
        return send(200, app.orders.book(mint, { wallet: me() }));
      }
      if (req.method === 'POST' && path === '/api/orders') {
        const a = needMe();
        limit('order', 30, a);
        const b = await readBody(req);
        const mint = validMint(b?.mint);
        if (!mint) throw httpError(400, 'badMint');
        await app.checkWantable(mint);
        const sol = Number(b?.price);
        const price = Number.isFinite(sol) ? Math.round(sol * 1e9) : NaN;
        const o = app.orders.place(a, { mint, side: b?.side, price, hours: Number(b?.hours) });
        return send(200, { order: o, book: app.orders.book(mint, { wallet: a }) });
      }
      if (req.method === 'DELETE' && (m = /^\/api\/orders\/([^/]+)$/.exec(path))) {
        const a = needMe();
        limit('order', 30, a);
        const r = app.orders.cancel(a, decodeURIComponent(m[1]));
        return send(200, r);
      }
      if (req.method === 'GET' && path === '/api/orders/mine') {
        const a = needMe();
        return send(200, { orders: app.orders.of(a) });
      }

      // ── Sign-In With Solana
      if ((req.method === 'POST' || req.method === 'GET') && path === '/api/auth/nonce') {
        limit('nonce', 30);
        const b = req.method === 'POST' ? await readBody(req) : { address: q('address') };
        return send(200, auth.challenge(String(b?.address ?? ''), origin, forwardedOrigin(req)));
      }
      if (req.method === 'POST' && path === '/api/auth/verify') {
        limit('verify', 30);
        return send(200, auth.verify(await readBody(req)));
      }
      if (req.method === 'GET' && path === '/api/auth/me') {
        const a = me();
        return a ? send(200, { address: a }) : send(401, { code: 'signIn', error: 'Sign in first.' });
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        auth.logout(req.headers.authorization);
        return send(200, { ok: true });
      }
      return send(404, { code: 'notFound', error: 'This page is missing.' });
    } catch (e) {
      if (e?.expose) return send(e.status, { code: e.code, error: e.message });
      logError('http.fail', e, { path });
      return send(500, { code: 'server', error: 'Server error. Try again.' });
    }
  };
}

export function listen(handler, port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => void handler(req, res));
    // these bound receiving a request (slow clients), never a response: SSE streams stay open
    server.requestTimeout = 30_000;
    server.headersTimeout = 20_000;
    server.keepAliveTimeout = 65_000;
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
