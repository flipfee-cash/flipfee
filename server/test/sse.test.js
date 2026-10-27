// SSE framing and delivery: headers that survive proxies, the padding comment, named events
// (`event: trade` … with `id:`), stats frames, `event: ping` heartbeats, Last-Event-ID replay, type and coin filters,
// and a stalled client being cut off.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { after, before, test } from 'node:test';
import { Bus } from '../src/bus.js';
import { frame, SseHub } from '../src/sse.js';

process.env.LOG_QUIET = '1';
const M1 = '4Eyierg7ZTZrDaD9LWP6K4gt2WvmREFLd54iUjmdpump';
const M2 = 'EQmifZ6svZZwawnowEY9MsrwWrzgVinYfuJHMJkDpump';

test('frame: id, event, data lines, blank line; multi-line data split per line', () => {
  assert.equal(frame('trade', { a: 1 }, '01ABC'), 'id: 01ABC\nevent: trade\ndata: {"a":1}\n\n');
  assert.equal(frame('stats', 'x\ny'), 'event: stats\ndata: x\ndata: y\n\n');
});

let server;
let port;
let bus;
let hub;
before(async () => {
  bus = new Bus({ size: 50 });
  hub = new SseHub({ bus, statsFn: () => ({ stats: { feesHour: { lamports: '5', sol: 5e-9 } } }), statsMs: 150, pingMs: 120, maxPerIp: 3 });
  server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const set = (k) => (u.searchParams.get(k) ? new Set(u.searchParams.get(k).split(',')) : null);
    const ok = hub.open(req, res, { ip: 'test', after: req.headers['last-event-id'] || u.searchParams.get('after'), types: set('types'), mints: set('mints') });
    if (!ok) {
      res.writeHead(429);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => {
  hub.close();
  server.close();
});

function collect(path, { headers = {}, until = () => false, ms = 1_500 } = {}) {
  return new Promise((resolve, reject) => {
    let text = '';
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        if (until(text)) {
          req.destroy();
          resolve({ res, text });
        }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    setTimeout(() => {
      req.destroy();
      resolve({ res: null, text });
    }, ms);
    req.end();
  });
}

test('headers flush at once and say: event stream, no transform, no proxy buffering', async () => {
  const t0 = Date.now();
  const { res, text } = await collect('/', { until: (t) => t.includes('retry: 3000\n\n') });
  assert.ok(Date.now() - t0 < 500, 'first bytes arrive at once');
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(res.headers['x-accel-buffering'], 'no');
  assert.equal(res.headers['content-encoding'], undefined);
  assert.match(text, /^: ok +\n\nretry: 3000\n\n/);
  assert.ok(text.length >= 2048);
});

test('events arrive as named events with their id; stats every few seconds; pings between', async () => {
  const p = collect('/', { until: (t) => t.includes('event: trade') && t.includes('event: ping') && (t.match(/event: stats/g) ?? []).length >= 2 });
  setTimeout(() => bus.push('trade', { mint: M1, side: 'buy', sol: 1.2, fee: { lamports: '3600000', sol: 0.0036 } }), 50);
  const { text } = await p;
  const ev = bus.last;
  assert.ok(text.includes(`id: ${ev.id}\nevent: trade\ndata: ${JSON.stringify(ev)}\n\n`));
  assert.equal(ev.type, 'trade');
  assert.ok(ev.t > 0);
  assert.match(text, /event: stats\ndata: \{"stats":\{"feesHour":\{"lamports":"5","sol":5e-9\}\}\}\n\n/);
  assert.match(text, /event: ping\ndata: \{"t":\d+\}\n\n/);
});

test('Last-Event-ID replays what the client missed; type and coin filters apply', async () => {
  const a = bus.push('trade', { mint: M1 });
  const b = bus.push('buy', { mint: M1, hours: 1 });
  const c = bus.push('trade', { mint: M2 });
  const { text } = await collect('/', { headers: { 'last-event-id': a.id }, until: (t) => t.includes(c.id) });
  assert.ok(text.indexOf(b.id) > 0 && text.indexOf(b.id) < text.indexOf(c.id), 'in order');
  assert.ok(!text.includes(`id: ${a.id}`), 'only after the given id');
  const only = await collect(`/?types=buy&after=${a.id}`, { until: (t) => t.includes(b.id), ms: 600 });
  assert.ok(only.text.includes(b.id));
  assert.ok(!only.text.includes(`id: ${c.id}`), 'the trade is filtered out');
  const coin = await collect(`/?mints=${M2}&after=${a.id}`, { until: (t) => t.includes(c.id), ms: 600 });
  assert.ok(coin.text.includes(c.id));
  assert.ok(!coin.text.includes(`id: ${b.id}`), 'another coin is filtered out');
});

test('per-IP stream limit and a client that stops reading is dropped', async () => {
  const open = [];
  for (let i = 0; i < 3; i++) open.push(collect('/', { ms: 400 }));
  await new Promise((r) => setTimeout(r, 100));
  const r = await new Promise((resolve) => request({ host: '127.0.0.1', port, path: '/' }, resolve).end());
  assert.equal(r.statusCode, 429);
  r.resume();
  await Promise.all(open);
  const small = new SseHub({ bus: new Bus(), statsFn: null, maxBuffered: 10 });
  const fakeRes = { writableEnded: false, destroyed: false, writableLength: 11, destroy() { this.destroyed = true; }, write() {} };
  small.write({ res: fakeRes }, 'x');
  assert.equal(fakeRes.destroyed, true);
  assert.equal(small.dropped, 1);
  small.close();
});

test('a trade keeps its own id ("<signature>:<index>", as in snapshots); the SSE id line is the stream ULID', async () => {
  await new Promise((r) => setTimeout(r, 300)); // the per-IP test's streams close first
  const p = collect('/', { until: (t) => t.includes('"id":"sigX:2"') });
  setTimeout(() => bus.push('trade', { id: 'sigX:2', mint: M1, side: 'sell' }), 150);
  const { text } = await p;
  const ev = bus.last;
  assert.equal(ev.id, 'sigX:2');
  assert.match(ev.eid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(text.includes(`id: ${ev.eid}\nevent: trade\n`));
  assert.deepEqual(bus.after(ev.eid), []);
});

test('the board stream thins trades of coins off flipfee; flipfee coins and coin pages get every trade', () => {
  const b = new Bus();
  const prio = new Set([M1]);
  const hub = new SseHub({ bus: b, statsFn: null, tradesPerSec: 2, priority: () => prio });
  const got = { board: [], page: [] };
  const fake = (list) => ({ writableEnded: false, destroyed: false, writableLength: 0, write: (t) => list.push(t), destroy() {}, end() {} });
  hub.clients.add({ res: fake(got.board), types: null, mints: null, tokens: 4, refill: Date.now() });
  hub.clients.add({ res: fake(got.page), types: null, mints: new Set([M2]), tokens: 4, refill: Date.now() });
  for (let i = 0; i < 10; i++) b.push('trade', { id: `h${i}:0`, mint: M2 });
  for (let i = 0; i < 5; i++) b.push('trade', { id: `f${i}:0`, mint: M1 });
  b.push('paid', { mint: M2 });
  const n = (list, p) => list.filter((t) => t.includes(`"id":"${p}`)).length;
  assert.equal(n(got.board, 'h'), 4, 'a burst of 2 × 2 per second, then the rest waits');
  assert.equal(n(got.board, 'f'), 5, 'every trade of a flipfee coin');
  assert.ok(got.board.some((t) => t.startsWith('id:') && t.includes('event: paid')), 'other events always go out');
  assert.equal(n(got.page, 'h'), 10, 'a coin page asked for that coin: no thinning');
  assert.equal(hub.status().thinnedTrades, 6);
  hub.close();
});

test('the bus keeps non-trade events in SQLite for replays across a restart', async () => {
  const { Db } = await import('../src/db.js');
  const db = new Db(':memory:');
  const b1 = new Bus({ db });
  const x = b1.push('trade', { mint: M1 });
  const y = b1.push('paid', { mint: M1, kind: 'holder' });
  const b2 = new Bus({ db });
  assert.deepEqual(b2.after(x.eid).map((e) => e.id), [y.id], 'trades live in memory only');
  assert.throws(() => b1.push('nope', {}), /bad event type/);
});
