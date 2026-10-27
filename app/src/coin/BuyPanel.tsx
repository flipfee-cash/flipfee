// The coin page's buy panel (DESIGN.md §1.6): hour chips, the total, when the hours start, what the last 6 hours paid
// on average (a fact, never a promise) and the risk line. Buy opens the sheet and asks Phantom at once.
import { memo, useState } from 'react';
import { copy, fill } from '../copy.ts';
import type { Coin } from '../api/types.ts';
import { Flap } from '../flap/Flap.tsx';
import { useNow } from '../lib/clock.tsx';
import { left, solFlap, solPlain } from '../lib/format.ts';
import { linkProps } from '../lib/router.ts';
import { hoursOpen, nextStart } from '../state/board.ts';
import { openSheet } from '../state/ui.ts';
import { preloadKit } from '../chain/tx.ts';
import { sound } from '../lib/sound.ts';

const CHIPS = [1, 3, 6, 12];

export const BuyPanel = memo(function BuyPanel({ coin, me, mine }: { coin: Coin; me: string | null; mine: boolean }) {
  const now = useNow(1000);
  const [hours, setHours] = useState(1);
  const f = coin.ff!;
  const open = hoursOpen(coin, now);
  const h = Math.max(1, Math.min(hours, open || 1));
  const start = nextStart(coin, now);
  const avg6 = coin.fees.h6 / 6;
  void me;
  if (mine) {
    return (
      <section className="panel buy-panel is-mine" data-testid="buy-panel">
        <h2>{copy.coin.yourCoin}</h2>
        <a className="btn btn-amber btn-lg btn-block" {...linkProps('/dev')}>
          {copy.coin.manage}
        </a>
      </section>
    );
  }
  return (
    <section className="panel buy-panel" data-testid="buy-panel" onPointerEnter={preloadKit}>
      <header className="bp-h">
        <h2 className="lbl">{copy.buy.title}</h2>
        <span className="bp-price">
          <Flap text={solFlap(f.price, 3)} size="sm" />
          <span className="tk-u">{copy.buy.perHour}</span>
        </span>
      </header>
      <div className="buy-hours" role="radiogroup" aria-label={copy.buy.hours}>
        {CHIPS.map((n) => (
          <button key={n} type="button" role="radio" aria-checked={h === n} className={'hchip' + (h === n ? ' is-on' : '')} disabled={n > open} onClick={() => setHours(n)} data-testid={'panel-hours-' + n}>
            <Flap text={n + 'h'} size="sm" tone={h === n ? 'cash' : 'ink'} />
          </button>
        ))}
      </div>
      <div className="bp-total">
        <span className="lbl">{copy.buy.total}</span>
        <span className="bp-total-v">
          <Flap text={solFlap(f.price * h, 4)} size="md" tone="cash" testid="panel-total" />
          <span className="tk-u">{copy.ticker.sol}</span>
        </span>
      </div>
      <p className="bp-start">{start <= now + 15000 ? copy.buy.startsNow : fill(copy.buy.startsIn, { t: left(start - now) })}</p>
      <p className="buy-est">{avg6 > 0 ? fill(copy.buy.estimate, { sol: solPlain(avg6) }) : fill(copy.buy.estimateHour, { sol: solPlain(coin.fees.h1) })}</p>
      {f.paused ? <p className="buy-warn">{copy.buy.paused}</p> : open < 1 ? <p className="buy-warn">{copy.buy.soldOut}</p> : null}
      <p className="risk">{copy.buy.risk}</p>
      <button
        type="button"
        className="btn btn-cash btn-lg btn-block"
        disabled={f.paused || open < 1}
        onClick={() => {
          sound.tap();
          openSheet({ kind: 'buy', mint: coin.mint, hours: h, go: true });
        }}
        data-testid="panel-buy"
      >
        {fill(copy.buy.cta, { h, sol: solPlain(f.price * h) })}
      </button>
    </section>
  );
});
