// /market (owner, 2026-10-28: "a market page like Polymarket"): search any coin by ticker, name or CA; each row shows
// the coin, what its fees paid last hour, the best bid and ask, and a short book; a tap opens the coin's page with
// its full book and the order form. The list follows the stream (a changed book reloads it).
import { useEffect, useRef, useState } from 'react';
import { get } from '../api/http.ts';
import { market as normMarket } from '../api/norm.ts';
import type { Book, Coin } from '../api/types.ts';
import { copy } from '../copy.ts';
import { nm, solFlap, solPlain, tick } from '../lib/format.ts';
import { coinPath, linkProps } from '../lib/router.ts';
import { putCoin } from '../state/board.ts';
import { CoinImg } from '../shell/CoinImg.tsx';
import { SectionTitle } from '../board/SectionTitle.tsx';
import { Ladder } from './Ladder.tsx';
import { onBook } from './book.ts';

type Row = { coin: Coin; book: Book };

const readQ = () => {
  try {
    return new URLSearchParams(window.location.search).get('q') ?? '';
  } catch {
    return '';
  }
};

export function MarketPage() {
  const [q, setQ] = useState(readQ);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    document.title = copy.market.navTitle + ' · ' + copy.brand;
    return () => {
      document.title = copy.title;
    };
  }, []);

  useEffect(() => {
    const term = q.trim();
    const run = () => {
      const n = ++seq.current;
      return get<unknown>('/market' + (term ? '?q=' + encodeURIComponent(term) : ''))
        .then((r) => {
          if (n !== seq.current) return;
          const list = normMarket(r);
          for (const x of list) putCoin(x.coin);
          setRows(list);
          setFailed(false);
        })
        .catch(() => n === seq.current && setFailed(true));
    };
    const t = window.setTimeout(run, term ? 250 : 0);
    // the list follows the book: any coin's change reloads it (at most every 3 s)
    const off = onBook(null, run, 3000);
    try {
      history.replaceState(null, '', '/market' + (term ? '?q=' + encodeURIComponent(term) : ''));
    } catch {
      // the address bar is optional
    }
    return () => {
      window.clearTimeout(t);
      off();
    };
  }, [q]);

  return (
    <div className="page market" data-testid="market-page">
      <header className="mk-h">
        <SectionTitle id="market-h" text={copy.market.title} />
        <label className="mk-search">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="m20 20-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={copy.market.search} aria-label={copy.market.search} autoComplete="off" spellCheck={false} data-testid="market-search" />
        </label>
      </header>

      {rows === null ? (
        failed ? (
          <p className="bsec-empty">{copy.err.server}</p>
        ) : (
          <div aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="sk" style={{ height: 132, marginTop: 10 }} />
            ))}
          </div>
        )
      ) : rows.length === 0 ? (
        <p className="bsec-empty">{q.trim() ? copy.market.none : copy.hot.empty}</p>
      ) : (
        <div className="mk-list">
          <div className="mk-row mk-head lbl" aria-hidden="true">
            <span>{copy.live.colCoin}</span>
            <span>{copy.market.colFees}</span>
            <span>{copy.market.colBid}</span>
            <span>{copy.market.colAsk}</span>
            <span>{copy.market.colBook}</span>
          </div>
          {rows.map((r) => (
            <MarketRow key={r.coin.mint} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function MarketRow({ row: { coin, book } }: { row: Row }) {
  const est = coin.fees.est.h1 ? '~' : '';
  return (
    <a className="mk-row" {...linkProps(coinPath(coin.mint))} data-testid="market-row" data-mint={coin.mint}>
      <span className="mk-coin">
        <CoinImg src={coin.image} symbol={coin.symbol} size={44} vt="coin-pic" />
        <span className="mk-name">
          <b data-vt="coin-tk">{tick(coin.symbol)}</b>
          <span className="dim">{nm(coin.name)}</span>
        </span>
      </span>
      <span className="mk-fees mono">
        <em className="lbl mk-k">{copy.market.colFees}</em>
        {est + solFlap(coin.fees.h1, 3)} <i>SOL</i>
      </span>
      <span className="mk-best is-bid mono">
        <em className="lbl mk-k">{copy.market.colBid}</em>
        {book.bestBid !== null ? solPlain(book.bestBid) : '—'}
      </span>
      <span className="mk-best is-ask mono">
        <em className="lbl mk-k">{copy.market.colAsk}</em>
        {book.bestAsk !== null ? solPlain(book.bestAsk) : '—'}
      </span>
      <span className="mk-book">{book.orders > 0 ? <Ladder book={book} rows={3} compact /> : <span className="mk-empty dim">{copy.market.first}</span>}</span>
    </a>
  );
}
