// The order book (src/orders.js) on a real SQLite file: levels, crossing, limits, cancel, house quotes, events.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Db } from '../src/db.js';
import { HOUSE, Orders } from '../src/orders.js';

const SOL = 1e9;
const mk = () => {
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'ff-orders-')), 'db.sqlite'));
  const events = [];
  const orders = new Orders({ db, bus: { push: (type, d) => events.push([type, d.mint]) } });
  return { db, orders, events };
};

test('levels sum by price, best first, and mark mine', () => {
  const { orders } = mk();
  orders.place('a', { mint: 'M', side: 'bid', price: 0.1 * SOL, hours: 2 });
  orders.place('b', { mint: 'M', side: 'bid', price: 0.1 * SOL, hours: 3 });
  orders.place('b', { mint: 'M', side: 'bid', price: 0.2 * SOL, hours: 1 });
  orders.place('c', { mint: 'M', side: 'ask', price: 0.5 * SOL, hours: 1 });
  orders.place('c', { mint: 'M', side: 'ask', price: 0.3 * SOL, hours: 4 });
  const b = orders.book('M', { wallet: 'a' });
  assert.deepEqual(b.bids.map((l) => [l.sol, l.hours, l.orders, l.mine]), [[0.2, 1, 1, 0], [0.1, 5, 2, 2]]);
  assert.deepEqual(b.asks.map((l) => [l.sol, l.hours]), [[0.3, 4], [0.5, 1]]);
  assert.equal(b.bestBid.sol, 0.2);
  assert.equal(b.spread.lamports, String(0.1 * SOL));
  assert.equal(b.mine.length, 1);
  assert.equal(b.orders, 5);
});

test('a crossing order is refused; bad input is refused', () => {
  const { orders } = mk();
  orders.place('a', { mint: 'M', side: 'ask', price: 0.3 * SOL, hours: 1 });
  assert.throws(() => orders.place('b', { mint: 'M', side: 'bid', price: 0.3 * SOL, hours: 1 }), { code: 'crosses' });
  orders.place('b', { mint: 'M', side: 'bid', price: 0.29 * SOL, hours: 1 });
  assert.throws(() => orders.place('c', { mint: 'M', side: 'ask', price: 0.29 * SOL, hours: 1 }), { code: 'crosses' });
  assert.throws(() => orders.place('c', { mint: 'M', side: 'up', price: SOL, hours: 1 }), { code: 'badSide' });
  assert.throws(() => orders.place('c', { mint: 'M', side: 'bid', price: 10, hours: 1 }), { code: 'badPrice' });
  assert.throws(() => orders.place('c', { mint: 'M', side: 'bid', price: 0.1 * SOL, hours: 25 }), { code: 'badHours' });
  assert.throws(() => orders.place('c', { mint: 'M', side: 'bid', price: 0.1 * SOL, hours: 1.5 }), { code: 'badHours' });
});

test('ten open orders per coin, cancel only your own', () => {
  const { orders, events } = mk();
  const ids = [];
  for (let i = 1; i <= 10; i++) ids.push(orders.place('a', { mint: 'M', side: 'bid', price: i * 0.01 * SOL, hours: 1 }).id);
  assert.throws(() => orders.place('a', { mint: 'M', side: 'bid', price: 0.5 * SOL, hours: 1 }), { code: 'tooManyOrders' });
  assert.throws(() => orders.cancel('b', ids[0]), { code: 'noOrder' });
  assert.deepEqual(orders.cancel('a', ids[0]), { id: ids[0], cancelled: true });
  assert.throws(() => orders.cancel('a', ids[0]), { code: 'noOrder' });
  assert.equal(orders.of('a').length, 9);
  assert.equal(events.at(-1)[0], 'book');
});

test('house quotes: a ladder around fair, replaced in place, never crossing a trader', () => {
  const { orders, events } = mk();
  assert.equal(orders.quote('M', SOL), true);
  let b = orders.book('M');
  assert.deepEqual(b.bids.map((l) => l.sol), [0.85, 0.7, 0.55]);
  assert.deepEqual(b.asks.map((l) => l.sol), [1.1, 1.3, 1.6]);
  assert.ok(b.bids.every((l) => l.house));
  const n = events.length;
  assert.equal(orders.quote('M', SOL), false); // same ladder: no change, no event
  assert.equal(events.length, n);
  assert.throws(() => orders.place('t', { mint: 'M', side: 'bid', price: 1.2 * SOL, hours: 1 }), { code: 'crosses' });
});

test('house quotes skip levels that would cross a trader, and clear with fair 0', () => {
  const { orders } = mk();
  orders.place('t', { mint: 'M', side: 'ask', price: 0.8 * SOL, hours: 1 });
  orders.quote('M', SOL);
  const b = orders.book('M');
  assert.deepEqual(b.bids.map((l) => l.sol), [0.7, 0.55]);
  assert.deepEqual(b.asks.map((l) => [l.sol, l.house]), [[0.8, false], [1.1, true], [1.3, true], [1.6, true]]);
  orders.quote('M', 0);
  assert.deepEqual(orders.book('M').asks.map((l) => l.house), [false]);
  assert.equal(orders.of(HOUSE).length, 0);
});

test('house quotes hold through small moves in fees and follow big ones', () => {
  const { orders } = mk();
  orders.quote('M', SOL);
  assert.equal(orders.quote('M', 1.1 * SOL), false, '10% move: same ladder');
  assert.equal(orders.book('M').bestAsk.sol, 1.1);
  assert.equal(orders.quote('M', 2 * SOL), true);
  assert.equal(orders.book('M').bestAsk.sol, 2.2);
});
