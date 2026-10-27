// Live coins while no coin is live: the hot coins most
// wanted to go live, ranked by wants and then by recent fees, under a dither scanner that sweeps the list; each row
// lights up as the band passes it. Reduced motion: the list without the sweep.
import { copy, fill } from '../copy.ts';
import { board } from '../state/board.ts';
import { shallow } from '../state/store.ts';
import { coinPath, linkProps } from '../lib/router.ts';
import { nm, solFlap, tick } from '../lib/format.ts';
import { CoinImg } from '../shell/CoinImg.tsx';
import { Flap } from '../flap/Flap.tsx';
import { wantCoin, wants } from './actions.ts';

const N = 5;
const SWEEP_S = 5;

export function MostWanted() {
  const list = board.use((s) => {
    const score = (m: string) => {
      const c = s.coins[m];
      return c ? c.fees.m10 * 6 + c.fees.h1 : 0;
    };
    return s.hot
      .filter((m) => s.coins[m] && s.coins[m].canJoin !== false)
      .sort((a, b) => (s.coins[b].wants - s.coins[a].wants) || score(b) - score(a))
      .slice(0, N);
  }, shallow);
  const coins = board.use((s) => s.coins);
  const mine = wants.use((s) => s.mine, shallow);
  if (!list.length) return <p className="live-empty">{copy.live.emptyTitle}</p>;
  const max = Math.max(...list.map((m) => coins[m]?.fees.h1 ?? 0), 1e-9);
  return (
    <div className="mw" data-testid="most-wanted" style={{ '--sweep': SWEEP_S + 's' } as React.CSSProperties}>
      <ol className="mw-list">
        {list.map((m, i) => {
          const c = coins[m];
          if (!c) return null;
          const wanted = mine.includes(m);
          return (
            <li key={m} className="mw-row">
              <span className="mw-rank">
                <Flap text={String(i + 1)} size="md" tone={i === 0 ? 'cash' : 'ink'} label={fill(copy.wanted.rank, { n: i + 1 })} />
              </span>
              <a className="mw-coin" {...linkProps(coinPath(m))}>
                <CoinImg src={c.image} symbol={c.symbol} size={36} vt="coin-pic" />
                <span>
                  <b data-vt="coin-tk">{tick(c.symbol)}</b>
                  <small>{nm(c.name)}</small>
                </span>
              </a>
              <span className="mw-fees" title={fill(copy.wanted.fees, { sol: solFlap(c.fees.h1, 3) })}>
                <i style={{ width: Math.max(4, (c.fees.h1 / max) * 100) + '%' }} />
                <span className="mono">{(c.fees.est.h1 ? '~' : '') + solFlap(c.fees.h1, 3)} SOL</span>
              </span>
              <span className="mw-wants mono">{c.wants > 0 ? fill(copy.wanted.wants, { n: c.wants }) : ''}</span>
              <button type="button" className="btn btn-tile" aria-pressed={wanted} onClick={() => void wantCoin(c)}>
                {wanted ? copy.hot.wanted : copy.hot.want}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
