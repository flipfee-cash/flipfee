// Read-only mainnet run: starts the server against the public mainnet RPC (no keys, no transactions) for MINUTES
// (default 10), samples GET /health and GET /api/board every 30 s, and prints what it saw: tracked coins, the RPC
// load (HTTP requests per minute by method; the trade WebSocket's subscriptions, messages and KB per second), trades,
// the board's rows and how many of their fee windows are exact yet. OUT_DIR=<dir> keeps the last health and board JSON.
//   MINUTES=10 npm run test:mainnet
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { startServer } from '../../src/main.js';

const minutes = Number(process.env.MINUTES || 10);
const db = join(tmpdir(), `flipfee-mainnet-${process.pid}.sqlite`);
const cfg = loadConfig({ ...process.env, SOLANA_CLUSTER: 'mainnet-beta', PORT: process.env.PORT || '5395', DB_PATH: db, KEEPER: '0' });
const app = await startServer(cfg);
const base = `http://127.0.0.1:${app.server.address().port}`;
const get = async (p) => (await fetch(base + p)).json();
const t0 = Date.now();
const samples = [];

// one board client on the stream for the whole run: what a browser receives (events per type, bytes per second)
const stream = { bytes: 0, byType: {}, from: Date.now() };
const ac = new AbortController();
void (async () => {
  try {
    const r = await fetch(`${base}/api/stream`, { signal: ac.signal });
    const reader = r.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      stream.bytes += value.length;
      for (const m of new TextDecoder().decode(value).matchAll(/^event: (\w+)$/gm)) stream.byType[m[1]] = (stream.byType[m[1]] ?? 0) + 1;
    }
  } catch {
    // stopped
  }
})();

const summary = (h, b) => {
  const rows = [...b.live, ...b.hot];
  const exact = (k) => rows.filter((r) => r.fees[k].exact).length;
  const tws = h.rpcLoad.tradesWs ?? {};
  return {
    min: Math.round((Date.now() - t0) / 6_000) / 10,
    tracked: h.tracking.tracked,
    pools: h.tracking.pools,
    curves: h.tracking.curves,
    subs: tws.subscriptions,
    wsMsgPerSec: tws.msgPerSec,
    wsKBps: tws.kbPerSec,
    tradesPerMin: tws.tradesPerMin,
    httpPerMin: h.rpcLoad.http.last1m.perMin,
    hot: b.hot.length,
    live: b.live.length,
    exactM10: exact('m10'),
    exactH1: exact('h1'),
    feesHourSol: b.stats.feesHour.sol,
    solUsd: b.stats.solUsd,
  };
};

const tick = async () => {
  const [h, b] = await Promise.all([get('/health'), get('/api/board')]);
  const s = summary(h, b);
  samples.push(s);
  console.log(JSON.stringify(s));
  return { h, b };
};

let last = null;
for (let i = 1; Date.now() - t0 < minutes * 60_000; i++) {
  await new Promise((r) => setTimeout(r, Math.min(30_000, t0 + minutes * 60_000 - Date.now())));
  last = await tick();
}
if (!last) last = await tick();
const { h, b } = last;
const http = h.rpcLoad.http;
console.log('\n── RPC load over the run');
console.log(`HTTP requests: ${http.requests} in ${minutes} min (${Math.round((http.requests / minutes) * 10) / 10}/min), errors ${http.errors}, 429s ${http.rateLimited}`);
console.log('by method (total):', JSON.stringify(http.total));
console.log('last 10 min per minute:', JSON.stringify(http.last10m));
console.log('trades WebSocket:', JSON.stringify(h.rpcLoad.tradesWs));
console.log('index WebSocket:', JSON.stringify(h.rpcLoad.indexWs));
const secs = (Date.now() - stream.from) / 1000;
console.log(`one board stream client: ${Math.round(stream.bytes / secs / 102.4) / 10} KB/s, events/s ${JSON.stringify(Object.fromEntries(Object.entries(stream.byType).map(([k, v]) => [k, Math.round((v / secs) * 10) / 10])))}, thinned trades ${h.sse.thinnedTrades ?? 0}`);
console.log('sources:', JSON.stringify(Object.fromEntries(Object.entries(h.sources).map(([k, v]) => [k, v.api ? { api: v.api.requests, swap: v.swap.requests, errors: v.api.errors + v.swap.errors } : { requests: v.requests, errors: v.errors }]))));
console.log('\n── board');
console.log(`hot ${b.hot.length} · live ${b.live.length} · stats ${JSON.stringify(b.stats)}`);
console.log(`hot rows by canJoin: ${JSON.stringify(b.hot.reduce((m, r) => ((m[String(r.canJoin)] = (m[String(r.canJoin)] ?? 0) + 1), m), {}))}`);
for (const r of b.hot.slice(0, 10)) {
  const f = r.fees.h1;
  console.log(`${r.symbol.padEnd(12).slice(0, 12)} ${r.venue.padEnd(5)} ${String(r.feeBps).padStart(3)}bps h1 ${f.sol.toFixed(4)} SOL ${f.exact ? 'exact' : `partial ${f.coverSec}s, est ${f.est?.sol?.toFixed(3) ?? '-'}`} · m10 ${r.fees.m10.sol.toFixed(4)} ${r.fees.m10.exact ? 'exact' : 'partial'} · trades1h ${r.trades1h} · mcap $${r.mcapUsd}`);
}
if (process.env.OUT_DIR) {
  mkdirSync(process.env.OUT_DIR, { recursive: true });
  writeFileSync(join(process.env.OUT_DIR, 'health.json'), JSON.stringify(h, null, 1));
  writeFileSync(join(process.env.OUT_DIR, 'board.json'), JSON.stringify(b, null, 1));
  writeFileSync(join(process.env.OUT_DIR, 'samples.json'), JSON.stringify(samples, null, 1));
  const coin = b.hot[0] ? await get(`/api/coin/${b.hot[0].mint}`) : null;
  if (coin) writeFileSync(join(process.env.OUT_DIR, 'coin.json'), JSON.stringify(coin, null, 1));
}
ac.abort();
await app.stop();
process.exit(0);
