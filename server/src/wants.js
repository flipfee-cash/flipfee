// Wants (DESIGN §1.3): a signed-in wallet taps Want on a coin that is not on flipfee yet; one per wallet per coin.
// Counts per coin feed the Hot rows and the dev page ("12 traders want your fees"); the stream sends `want` with the
// new count (no wallet: who wanted stays private).
import { httpError } from './errors.js';

export class Wants {
  constructor({ db, bus = null, now = () => Date.now() }) {
    Object.assign(this, { db, bus, now });
    this.cache = new Map(); // mint → count
    for (const r of db.all('SELECT mint, COUNT(*) AS n FROM wants GROUP BY mint')) this.cache.set(r.mint, r.n);
  }

  count(mint) {
    return this.cache.get(mint) ?? 0;
  }

  /** Adds the wallet's want (idempotent). Returns { mint, count, wanted: true, added }. */
  add(wallet, mint) {
    const perHour = this.db.get('SELECT COUNT(*) AS n FROM wants WHERE wallet = ? AND t > ?', wallet, this.now() - 3_600_000).n;
    if (perHour >= 60) throw httpError(429, 'slow');
    const r = this.db.run('INSERT OR IGNORE INTO wants (mint, wallet, t) VALUES (?, ?, ?)', mint, wallet, this.now());
    const added = r.changes > 0;
    const count = this.db.get('SELECT COUNT(*) AS n FROM wants WHERE mint = ?', mint).n;
    this.cache.set(mint, count);
    if (added) this.bus?.push('want', { mint, count });
    return { mint, count, wanted: true, added };
  }

  /** The coins a wallet wants, newest first. */
  of(wallet) {
    return this.db.all('SELECT mint FROM wants WHERE wallet = ? ORDER BY t DESC LIMIT 500', wallet).map((r) => r.mint);
  }

  has(wallet, mint) {
    return !!this.db.get('SELECT 1 AS x FROM wants WHERE wallet = ? AND mint = ?', wallet, mint);
  }
}
