// "Buy 1h · 0.30 SOL": one tap → Phantom (DESIGN.md §1.3). The buy sheet opens with the facts and the risk line while
// Phantom asks; the hour starts (or queues) when the transaction lands.
import { memo } from 'react';
import { copy, fill } from '../copy.ts';
import type { Coin } from '../api/types.ts';
import { solPlain } from '../lib/format.ts';
import { linkProps } from '../lib/router.ts';
import { openSheet } from '../state/ui.ts';
import { sound } from '../lib/sound.ts';

export const BuyButton = memo(function BuyButton({ coin, hoursLeft, me, size = 'md', hours = 1 }: { coin: Coin; hoursLeft: number; me: string | null; size?: 'md' | 'lg'; hours?: number }) {
  const f = coin.ff;
  if (!f) return null;
  const cls = 'btn buy-btn' + (size === 'lg' ? ' btn-lg' : '');
  if (me && f.owner === me) {
    return (
      <a className={cls + ' btn-tile is-amber'} data-testid="buy-yours" {...linkProps('/dev')}>
        {copy.live.yours}
      </a>
    );
  }
  if (f.paused) {
    return (
      <button type="button" className={cls + ' btn-cash'} disabled data-testid="buy-paused">
        {copy.live.paused}
      </button>
    );
  }
  if (hoursLeft < hours) {
    return (
      <button type="button" className={cls + ' btn-cash'} disabled data-testid="buy-soldout">
        {copy.live.soldOut}
      </button>
    );
  }
  const label = fill(copy.live.buy1, { sol: solPlain(f.price * hours) });
  return (
    <button
      type="button"
      className={cls + ' btn-cash'}
      data-testid="buy-1h"
      data-mint={coin.mint}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        sound.tap();
        openSheet({ kind: 'buy', mint: coin.mint, hours, go: true });
      }}
    >
      <span className="bb-l">{copy.live.buyShort}</span>
      <span className="bb-dot" aria-hidden="true">
        ·
      </span>
      <span className="mono bb-p">{solPlain(f.price * hours)}</span>
      <span className="bb-u">{copy.ticker.sol}</span>
    </button>
  );
});
