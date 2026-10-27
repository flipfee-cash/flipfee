// Order book (owner, 2026-10-28: "bids and asks on any coin, an MVP without contracts"): a signed-in wallet posts a
// bid (it would buy hours of a coin's fees at a price per hour) or an ask (it would sell them). Orders are intents:
// nothing settles on chain yet, so an order that would cross the other side is refused instead of filled. The stream
// sends `book` with the coin's mint on every change. House quotes (wallet HOUSE, `house: true`) are flipfee's own
// ladder around the coin's last-hour fees, shown as flipfee's in the book.
import { httpError } from './errors.js';
import { ulid } from './ulid.js';

export const HOUSE = 'flipfee';
const LAMPORTS = 1_000_000_000;
export const MIN_PRICE = 100_000; // 0.0001 SOL per hour
export const MAX_PRICE = 1_000 * LAMPORTS;
export const MAX_HOURS = 24;
const MAX_OPEN_PER_COIN = 10;
const MAX_OPEN = 100;

const amount = (lamports) => ({ lamports: String(lamports), sol: lamports / LAMPORTS });

export class Orders {
  constructor({ db, bus = null, now = () => Date.now() }) {
    Object.assign(this, { db, bus, now });
    this.fair = new Map(); // mint → the fair value of the coin's current house ladder
  }

  open(mint) {
    return this.db.all("SELECT * FROM orders WHERE mint = ? AND status = 'open'", mint);
  }

  /** Price levels, best first: bids high → low, asks low → high. */
  levels(rows, side, wallet = null) {
    const map = new Map();
    for (const r of rows) {
      if (r.side !== side) continue;
      const l = map.get(r.price) ?? { price: r.price, hours: 0, orders: 0, house: false, mine: 0 };
      l.hours += r.hours;
      l.orders += 1;
      if (r.house) l.house = true;
      if (wallet && r.wallet === wallet) l.mine += r.hours;
      map.set(r.price, l);
    }
    const list = [...map.values()].sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price));
    return list.map((l) => ({ ...amount(l.price), hours: l.hours, orders: l.orders, house: l.house, mine: l.mine }));
  }

  /** { mint, bids, asks, bestBid, bestAsk, spread, mid, orders, mine } — `mine` only for the signed-in wallet. */
  book(mint, { wallet = null, depth = 12 } = {}) {
    const rows = this.open(mint);
    const bids = this.levels(rows, 'bid', wallet).slice(0, depth);
    const asks = this.levels(rows, 'ask', wallet).slice(0, depth);
    const bb = bids[0] ? Number(bids[0].lamports) : null;
    const ba = asks[0] ? Number(asks[0].lamports) : null;
    return {
      mint,
      bids,
      asks,
      bestBid: bb === null ? null : amount(bb),
      bestAsk: ba === null ? null : amount(ba),
      spread: bb !== null && ba !== null ? amount(ba - bb) : null,
      mid: bb !== null && ba !== null ? amount(Math.round((ba + bb) / 2)) : null,
      orders: rows.length,
      mine: wallet ? rows.filter((r) => r.wallet === wallet).map((r) => this.out(r)) : [],
    };
  }

  /** The mints with open orders and how many, most first. */
  active(limit = 60) {
    return this.db.all("SELECT mint, COUNT(*) AS n FROM orders WHERE status = 'open' GROUP BY mint ORDER BY n DESC LIMIT ?", limit);
  }

  out(r) {
    return { id: r.id, mint: r.mint, side: r.side, price: amount(r.price), hours: r.hours, t: r.t, house: !!r.house };
  }

  /** A wallet's open orders, newest first. */
  of(wallet) {
    return this.db.all("SELECT * FROM orders WHERE wallet = ? AND status = 'open' ORDER BY t DESC LIMIT 200", wallet).map((r) => this.out(r));
  }

  /** Places an order. `price` in lamports per hour. Refuses one that would cross the other side. */
  place(wallet, { mint, side, price, hours }) {
    if (side !== 'bid' && side !== 'ask') throw httpError(400, 'badSide');
    if (!Number.isSafeInteger(price) || price < MIN_PRICE || price > MAX_PRICE) throw httpError(400, 'badPrice');
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) throw httpError(400, 'badHours');
    const mineHere = this.db.get("SELECT COUNT(*) AS n FROM orders WHERE wallet = ? AND mint = ? AND status = 'open'", wallet, mint).n;
    const mineAll = this.db.get("SELECT COUNT(*) AS n FROM orders WHERE wallet = ? AND status = 'open'", wallet).n;
    if (mineHere >= MAX_OPEN_PER_COIN || mineAll >= MAX_OPEN) throw httpError(429, 'tooManyOrders');
    const other = side === 'bid' ? 'ask' : 'bid';
    const best = this.db.get(
      `SELECT ${side === 'bid' ? 'MIN' : 'MAX'}(price) AS p FROM orders WHERE mint = ? AND side = ? AND status = 'open'`,
      mint,
      other,
    ).p;
    if (best !== null && (side === 'bid' ? price >= best : price <= best)) throw httpError(409, 'crosses');
    const r = { id: ulid(), mint, wallet, side, price, hours, t: this.now(), status: 'open', house: 0 };
    this.db.run('INSERT INTO orders (id, mint, wallet, side, price, hours, t, status, house) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', r.id, mint, wallet, side, price, hours, r.t, r.status, 0);
    this.changed(mint);
    return this.out(r);
  }

  cancel(wallet, id) {
    const r = this.db.get("SELECT * FROM orders WHERE id = ? AND status = 'open'", id);
    if (!r || r.wallet !== wallet) throw httpError(404, 'noOrder');
    this.db.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", id);
    this.changed(r.mint);
    return { id, cancelled: true };
  }

  /**
   * flipfee's own ladder for one coin around `fair` (lamports the coin's fees paid in the last hour): three bids
   * under it and three asks over it. Replaces the coin's previous house orders; never crosses a trader's order.
   */
  quote(mint, fair) {
    // a small move in the coin's fees keeps the ladder (no churn every minute)
    const was = this.fair.get(mint);
    if (fair > 0 && was && Math.abs(fair - was) / was < 0.15) return false;
    const rows = this.open(mint).filter((r) => !r.house);
    const userBid = Math.max(0, ...rows.filter((r) => r.side === 'bid').map((r) => r.price));
    const userAsk = Math.min(Infinity, ...rows.filter((r) => r.side === 'ask').map((r) => r.price));
    const round = (x) => Math.max(MIN_PRICE, Math.round(x / MIN_PRICE) * MIN_PRICE);
    const ladder = [];
    if (fair > 0) {
      for (const [k, h] of [[0.85, 2], [0.7, 4], [0.55, 6]]) {
        const p = round(fair * k);
        if (p < userAsk && p <= MAX_PRICE) ladder.push(['bid', p, h]);
      }
      for (const [k, h] of [[1.1, 1], [1.3, 2], [1.6, 4]]) {
        const p = round(fair * k);
        if (p > userBid && p <= MAX_PRICE) ladder.push(['ask', p, h]);
      }
    }
    const before = this.db.all("SELECT side, price, hours FROM orders WHERE mint = ? AND house = 1 AND status = 'open'", mint);
    const key = (l) => l.map((x) => x.join(':')).sort().join(',');
    this.fair.set(mint, fair);
    if (fair <= 0) this.fair.delete(mint);
    if (key(before.map((r) => [r.side, r.price, r.hours])) === key(ladder)) return false;
    this.db.run("UPDATE orders SET status = 'cancelled' WHERE mint = ? AND house = 1 AND status = 'open'", mint);
    const t = this.now();
    for (const [side, price, hours] of ladder) {
      this.db.run('INSERT INTO orders (id, mint, wallet, side, price, hours, t, status, house) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ulid(), mint, HOUSE, side, price, hours, t, 'open', 1);
    }
    this.changed(mint);
    return true;
  }

  /** Drops cancelled orders older than a day. */
  prune() {
    this.db.run("DELETE FROM orders WHERE status = 'cancelled' AND t < ?", this.now() - 86_400_000);
  }

  changed(mint) {
    this.bus?.push('book', { mint });
  }
}
