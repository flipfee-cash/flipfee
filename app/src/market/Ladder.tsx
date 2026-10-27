// A coin's book as a ladder (owner, 2026-10-28: "like Polymarket, in our style"): asks on top (best ask lowest),
// the spread in the middle, bids under it (best bid highest). Each level shows its price per hour, the hours waiting
// at it and a dithered depth bar; the viewer’s own levels carry a dot.
import type { Book, Level } from '../api/types.ts';
import { copy } from '../copy.ts';
import { solPlain } from '../lib/format.ts';

export function Ladder({ book, rows = 6, compact = false, onPick }: { book: Book; rows?: number; compact?: boolean; onPick?: (side: 'bid' | 'ask', price: number) => void }) {
  const asks = book.asks.slice(0, rows).reverse();
  const bids = book.bids.slice(0, rows);
  const max = Math.max(1, ...asks.map((l) => l.hours), ...bids.map((l) => l.hours));
  const line = (side: 'bid' | 'ask', l: Level) => {
    const body = (
      <>
        <i className="lad-bar" style={{ width: Math.max(4, (100 * l.hours) / max) + '%' }} aria-hidden="true" />
        <span className="lad-p mono">{solPlain(l.price)}</span>
        <span className="lad-h mono">
          {l.hours}
          {copy.market.h}
        </span>
        {!compact && (
          <span className="lad-tag">
            {l.mine > 0 && <i className="lad-mine" title={copy.market.yours} />}
          </span>
        )}
      </>
    );
    const cls = 'lad-row is-' + side;
    return onPick ? (
      <button key={side + l.price} type="button" className={cls} onClick={() => onPick(side, l.price)} aria-label={(side === 'bid' ? copy.market.bid : copy.market.ask) + ' ' + solPlain(l.price) + ' SOL, ' + l.hours + ' ' + copy.market.hoursWord}>
        {body}
      </button>
    ) : (
      <div key={side + l.price} className={cls}>
        {body}
      </div>
    );
  };
  return (
    <div className={'ladder' + (compact ? ' is-compact' : '')}>
      {!compact && (
        <div className="lad-head lbl" aria-hidden="true">
          <span>{copy.market.priceCol}</span>
          <span>{copy.market.hoursCol}</span>
          <span />
        </div>
      )}
      <div className="lad-side is-ask">{asks.length ? asks.map((l) => line('ask', l)) : <p className="lad-none dim">{copy.market.noAsks}</p>}</div>
      <div className="lad-mid mono">
        {book.spread !== null ? (
          <>
            <span className="lbl">{copy.market.spread}</span> {solPlain(book.spread)} SOL
          </>
        ) : (
          <span className="lbl">{copy.market.perHour}</span>
        )}
      </div>
      <div className="lad-side is-bid">{bids.length ? bids.map((l) => line('bid', l)) : <p className="lad-none dim">{copy.market.noBids}</p>}</div>
    </div>
  );
}
