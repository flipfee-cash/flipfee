// A hot pump.fun coin that is off flipfee (DESIGN.md §1.6): creator fees last hour, trades, want count, and Want ·
// Share (· Connect when the connected wallet controls the coin's fee split).
import { memo } from 'react';
import { copy, fill } from '../copy.ts';
import { Flap } from '../flap/Flap.tsx';
import { board } from '../state/board.ts';
import { solFlap, tick, nm } from '../lib/format.ts';
import { coinPath, go, linkProps } from '../lib/router.ts';
import { CoinImg } from '../shell/CoinImg.tsx';
import { IconShare } from '../shell/Icons.tsx';
import { TradeDots } from './TradeDots.tsx';
import { shareCoin, wantCoin, wants } from './actions.ts';

export const HotRow = memo(function HotRow({ mint, me }: { mint: string; me: string | null }) {
  const coin = board.use((s) => s.coins[mint]);
  const wanted = wants.use((s) => s.mine.includes(mint));
  if (!coin) return null;
  const admin = !!me && (coin.admin === me || coin.creator === me);
  return (
    <div
      className="hrow"
      data-testid="hot-row"
      data-mint={mint}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,button')) return;
        go(coinPath(mint));
      }}
    >
      <a className="lr-coin" {...linkProps(coinPath(mint))}>
        <CoinImg src={coin.image} symbol={coin.symbol} size={34} vt="coin-pic" />
        <span className="lr-names">
          <b data-vt="coin-tk">{tick(coin.symbol)}</b>
          <span>{nm(coin.name)}</span>
        </span>
      </a>
      <div className="hr-fees cell">
        <span className="lbl cell-l">{copy.hot.colFees}</span>
        <span className="cell-v">
          <Flap text={(coin.fees.est.h1 ? '~' : '') + solFlap(coin.fees.h1, 3)} size="sm" pad={5} tone="cash" label={copy.hot.colFees + ': ' + (coin.fees.est.h1 ? copy.coin.estShort + ' ' : '') + solFlap(coin.fees.h1, 3) + ' SOL'} />
        </span>
      </div>
      <div className="hr-trades cell">
        <span className="lbl cell-l">{copy.hot.colTrades}</span>
        <span className="cell-v">
          <Flap text={String(Math.round(coin.trades1h)) + (coin.trades1hPart ? '+' : '')} size="sm" pad={4} label={copy.hot.colTrades + ': ' + Math.round(coin.trades1h) + (coin.trades1hPart ? ' ' + copy.coin.atLeast : '')} />
        </span>
      </div>
      <div className="lr-dots">
        <TradeDots mint={mint} />
      </div>
      <div className="hr-acts">
        <button type="button" className="btn btn-tile" aria-pressed={wanted} onClick={() => void wantCoin(coin)} data-testid="want" aria-label={fill(copy.hot.wantN, { n: coin.wants })}>
          {wanted ? copy.hot.wanted : copy.hot.want}
          {coin.wants > 0 && <span className="want-c mono" data-testid="want-count">{coin.wants}</span>}
        </button>
        <button type="button" className="btn btn-tile" onClick={() => void shareCoin(coin)} data-testid="share" aria-label={copy.hot.share}>
          <IconShare size={16} />
          <span className="hr-share-t">{copy.hot.share}</span>
        </button>
        {admin && (
          <a className="btn btn-tile is-amber" data-testid="hot-connect" {...linkProps('/dev/' + mint)}>
            {copy.hot.connect}
          </a>
        )}
      </div>
    </div>
  );
});
