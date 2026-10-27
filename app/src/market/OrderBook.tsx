// The order panel on a coin page (owner, 2026-10-28): the coin's book, a form for a bid or an ask (price per hour ×
// hours = total, like Polymarket's limit order), and the viewer's own orders with Cancel. Tapping a level puts its
// price in the form on the other side (tap an ask → bid just under it).
import { useEffect, useState } from 'react';
import type { Coin } from '../api/types.ts';
import { copy, fill } from '../copy.ts';
import { solPlain, tick } from '../lib/format.ts';
import { Ladder } from './Ladder.tsx';
import { cancelOrder, placeOrder, useBook } from './book.ts';

const TICK = 0.0001;
const round = (x: number) => Math.round(x / TICK) * TICK;

export function OrderBook({ coin }: { coin: Coin }) {
  const { book, ready, reload } = useBook(coin.mint);
  const [side, setSide] = useState<'bid' | 'ask'>('bid');
  const [price, setPrice] = useState('');
  const [hours, setHours] = useState(1);
  const [busy, setBusy] = useState(false);
  const fair = coin.fees.h1 || 0;

  // a first price that rests in the book: a tick under the best ask (bid) or over the best bid (ask)
  useEffect(() => {
    if (!ready || price) return;
    const p = side === 'bid' ? (book.bestAsk !== null ? book.bestAsk - TICK : fair * 0.8) : book.bestBid !== null ? book.bestBid + TICK : fair * 1.2;
    if (p > 0) setPrice(solPlain(round(p)));
  }, [ready, side]); // eslint-disable-line react-hooks/exhaustive-deps

  const p = Number(price);
  const valid = Number.isFinite(p) && p >= TICK && p <= 1000;
  const crosses = valid && (side === 'bid' ? book.bestAsk !== null && p >= book.bestAsk : book.bestBid !== null && p <= book.bestBid);
  const total = valid ? p * hours : 0;

  const pick = (s: 'bid' | 'ask', at: number) => {
    const next = s === 'ask' ? 'bid' : 'ask';
    setSide(next);
    setPrice(solPlain(round(next === 'bid' ? at - TICK : at + TICK)));
  };
  const submit = async () => {
    if (!valid || crosses || busy) return;
    setBusy(true);
    const ok = await placeOrder({ mint: coin.mint, symbol: coin.symbol, side, price: round(p), hours });
    setBusy(false);
    if (ok) reload();
  };

  return (
    <section className="panel obook" data-testid="order-book" aria-labelledby="obook-h">
      <header className="panel-h">
        <h2 id="obook-h">{copy.market.bookTitle}</h2>
        <p className="dim">{fill(copy.market.bookSub, { sol: solPlain(fair) })}</p>
      </header>
      {ready ? <Ladder book={book} onPick={pick} /> : <span className="sk" style={{ height: 220 }} />}

      <div className="ob-form">
        <div className="ob-sides" role="tablist" aria-label={copy.market.sideLabel}>
          {(['bid', 'ask'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={side === s}
              className={'ob-side is-' + s + (side === s ? ' is-on' : '')}
              onClick={() => {
                setSide(s);
                setPrice('');
              }}
              data-testid={'side-' + s}
            >
              {s === 'bid' ? copy.market.bidTab : copy.market.askTab}
            </button>
          ))}
        </div>
        <label className="ob-field">
          <span className="lbl">{copy.market.price}</span>
          <span className="ob-input">
            <button type="button" className="ob-step" onClick={() => setPrice(solPlain(Math.max(TICK, round((valid ? p : 0) - TICK))))} aria-label={copy.market.less}>
              −
            </button>
            <input className="mono" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))} data-testid="ob-price" />
            <button type="button" className="ob-step" onClick={() => setPrice(solPlain(round((valid ? p : 0) + TICK)))} aria-label={copy.market.more}>
              +
            </button>
            <em className="ob-u mono">SOL</em>
          </span>
        </label>
        <div className="ob-field">
          <span className="lbl">{copy.market.hours}</span>
          <span className="ob-hours">
            {[1, 2, 4, 6, 12].map((h) => (
              <button key={h} type="button" className={'ob-h' + (hours === h ? ' is-on' : '')} aria-pressed={hours === h} onClick={() => setHours(h)}>
                {h}
                {copy.market.h}
              </button>
            ))}
          </span>
        </div>
        <p className="ob-total">
          <span className="lbl">{copy.market.total}</span>
          <b className="mono">{solPlain(total)} SOL</b>
        </p>
        {crosses && <p className="ob-warn">{side === 'bid' ? copy.market.crossBid : copy.market.crossAsk}</p>}
        <button type="button" className={'btn btn-lg ob-go ' + (side === 'bid' ? 'btn-cash' : 'btn-ink')} disabled={!valid || crosses || busy} onClick={() => void submit()} data-testid="ob-place">
          {busy && <span className="spin" aria-hidden="true" />}
          {fill(side === 'bid' ? copy.market.placeBid : copy.market.placeAsk, { ticker: tick(coin.symbol) })}
        </button>
        <p className="ob-note dim">{copy.market.note}</p>
      </div>

      {book.mine.length > 0 && (
        <div className="ob-mine" data-testid="my-orders">
          <h3 className="lbl">{copy.market.yours}</h3>
          {book.mine.map((o) => (
            <div key={o.id} className={'ob-o is-' + o.side}>
              <span className="ob-o-s">{o.side === 'bid' ? copy.market.bid : copy.market.ask}</span>
              <span className="mono">
                {solPlain(o.price)} SOL × {o.hours}
                {copy.market.h}
              </span>
              <button type="button" className="ob-x" onClick={() => void cancelOrder(o.id).then((ok) => ok && reload())}>
                {copy.market.cancel}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
