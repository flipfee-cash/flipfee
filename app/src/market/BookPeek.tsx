// A coin's book on hover (owner, 2026-10-28: "an order book preview on hover in most wanted and hottest coins"): a
// row that is hovered for a moment shows a small card with the coin's ladder; it loads the book only while shown.
// Mouse only: touch screens tap through to the coin page, where the full book is.
import { useEffect, useRef, useState } from 'react';
import { copy } from '../copy.ts';
import { solPlain, tick } from '../lib/format.ts';
import { Ladder } from './Ladder.tsx';
import { useBook } from './book.ts';

const DELAY_MS = 160;
const canHover = () => typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/** Hover handlers for a row and whether its peek shows. */
export function usePeek(): { open: boolean; bind: { onMouseEnter: () => void; onMouseLeave: () => void } } {
  const [open, setOpen] = useState(false);
  const t = useRef(0);
  useEffect(() => () => window.clearTimeout(t.current), []);
  return {
    open,
    bind: {
      onMouseEnter: () => {
        if (!canHover()) return;
        window.clearTimeout(t.current);
        t.current = window.setTimeout(() => setOpen(true), DELAY_MS);
      },
      onMouseLeave: () => {
        window.clearTimeout(t.current);
        setOpen(false);
      },
    },
  };
}

export function BookPeek({ mint, symbol }: { mint: string; symbol: string }) {
  const { book, ready } = useBook(mint);
  return (
    <div className="bpeek" role="tooltip" data-testid="book-peek">
      <p className="bpeek-h">
        <span className="lbl">{copy.market.peek}</span>
        <b>{tick(symbol)}</b>
        {book.mid !== null && <span className="mono dim">{solPlain(book.mid)} SOL</span>}
      </p>
      {ready ? <Ladder book={book} rows={3} compact /> : <span className="sk" style={{ height: 120 }} />}
    </div>
  );
}
