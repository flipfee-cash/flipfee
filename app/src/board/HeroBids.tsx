// Under the hero's money map (owner, 2026-10-28: "show the bids on the hottest coin and offer: enter the fees
// market"): the hottest coin's bids as dithered depth bars (price per hour, hours waiting at it), live with the book,
// and one call to /market.
import { copy } from '../copy.ts';
import type { Level } from '../api/types.ts';
import { board } from '../state/board.ts';
import { coinPath, linkProps } from '../lib/router.ts';
import { solFlap, solPlain, tick } from '../lib/format.ts';
import { CoinImg } from '../shell/CoinImg.tsx';
import { useBook } from '../market/book.ts';

const ROWS = 4;

/** The hottest coin that could join: live coins first, then hot coins by recent fees. */
function useHottest(): string | null {
  return board.use((s) => {
    if (s.live.length) return s.live[0];
    let best: string | null = null;
    let top = -1;
    for (const m of s.hot) {
      const c = s.coins[m];
      if (!c || c.canJoin === false) continue;
      const score = c.fees.m10 * 6 + c.fees.h1;
      if (score > top) {
        top = score;
        best = m;
      }
    }
    return best;
  });
}

function Side({ side, levels, max }: { side: 'bid' | 'ask'; levels: Level[]; max: number }) {
  return (
    <ol className={'hb-side is-' + side} aria-label={side === 'bid' ? copy.market.bid : copy.market.ask}>
      {levels.length ? (
        levels.map((l, i) => (
          <li key={l.price} className={'hb-row' + (i === 0 ? ' is-best' : '')}>
            <span className="hb-p mono">{solPlain(l.price)}</span>
            <span className="hb-track">
              <i style={{ width: Math.max(6, (100 * l.hours) / max) + '%' }} />
            </span>
            <span className="hb-h mono">
              {l.hours}
              {copy.market.h}
            </span>
          </li>
        ))
      ) : (
        <li className="hb-none dim">{side === 'bid' ? copy.market.noBids : copy.market.noAsks}</li>
      )}
    </ol>
  );
}

function Bids({ mint }: { mint: string }) {
  const coin = board.use((s) => s.coins[mint]);
  const { book, ready } = useBook(mint);
  if (!coin) return null;
  const bids = book.bids.slice(0, ROWS);
  const asks = book.asks.slice(0, ROWS);
  const max = Math.max(1, ...bids.map((l) => l.hours), ...asks.map((l) => l.hours));
  return (
    <div className="hb" data-testid="hero-bids">
      <div className="hb-top">
        <a className="hb-tk" {...linkProps(coinPath(mint))}>
          <CoinImg src={coin.image} symbol={coin.symbol} size={26} />
          <b>{tick(coin.symbol)}</b>
        </a>
        <span className="lbl">{copy.market.bookTitle}</span>
        {book.bestBid !== null && (
          <span className="hb-best mono">
            <span className="lbl">{copy.flow.bestBid}</span> <b>{solFlap(book.bestBid, 3)}</b> {copy.flow.perH}
          </span>
        )}
        <a className="btn btn-cash btn-sm hb-cta" data-testid="hero-market" {...linkProps('/market')}>
          {copy.flow.enter}
        </a>
      </div>
      {ready ? (
        <div className="hb-book">
          <div className="hb-col">
            <p className="hb-colh lbl">{copy.market.bid}</p>
            <Side side="bid" levels={bids} max={max} />
          </div>
          <div className="hb-col">
            <p className="hb-colh lbl">{copy.market.ask}</p>
            <Side side="ask" levels={asks} max={max} />
          </div>
        </div>
      ) : (
        <span className="sk hb-sk" />
      )}
    </div>
  );
}

export function HeroBids() {
  const mint = useHottest();
  if (!mint) {
    return (
      <div className="hb is-bare">
        <a className="btn btn-cash btn-sm" data-testid="hero-market" {...linkProps('/market')}>
          {copy.flow.enter}
        </a>
      </div>
    );
  }
  return <Bids mint={mint} />;
}
