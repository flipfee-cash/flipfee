// The home hero as a live money map: a typed line names a hot
// coin; its real trades stream in on the left, each paying a creator fee; the wires run into the coin's flipfee vault
// (the dithered coin) and out to the two who get paid: the buyer of the hour, and the dev for every other hour.
// The typed coin changes every few seconds and the whole map follows it. Reduced motion: no typing, no running wires.
import { useEffect, useMemo, useState } from 'react';
import { copy } from '../copy.ts';
import { board } from '../state/board.ts';
import { REDUCED, shallow } from '../state/store.ts';
import { onTrade, recentTrades } from '../state/trades.ts';
import type { Trade } from '../api/types.ts';
import { coinPath, linkProps } from '../lib/router.ts';
import { solFlap, tick } from '../lib/format.ts';
import { Tpl } from '../lib/tpl.tsx';
import { CoinImg } from '../shell/CoinImg.tsx';
import { Flap } from '../flap/Flap.tsx';
import { HeaderField } from '../shell/HeaderField.tsx';
import { VaultScene } from '../dither/VaultScene.tsx';
import { focusFirstLive, focusHot } from './Board.tsx';

const CYCLE_MS = 7000;
const ROWS = 5;

const still = () => typeof window !== 'undefined' && window.matchMedia(REDUCED).matches;

/** The coins the line cycles through: live coins first, then the busiest hot ones. */
function useCycle(): string | null {
  const pool = board.use((s) => {
    const score = (m: string) => {
      const c = s.coins[m];
      return c ? c.fees.m10 * 6 + c.fees.h1 : 0;
    };
    const hot = s.hot.filter((m) => s.coins[m]?.canJoin !== false).sort((a, b) => score(b) - score(a));
    return [...s.live, ...hot].slice(0, 6);
  }, shallow);
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setI((x) => x + 1), still() ? CYCLE_MS * 2 : CYCLE_MS);
    return () => window.clearInterval(t);
  }, []);
  return pool.length ? pool[i % pool.length] : null;
}

/** The ticker, typed in letter by letter. */
function Typed({ text }: { text: string }) {
  const [n, setN] = useState(text.length);
  useEffect(() => {
    if (still()) {
      setN(text.length);
      return;
    }
    setN(0);
    let k = 0;
    const t = window.setInterval(() => {
      k++;
      setN(k);
      if (k >= text.length) window.clearInterval(t);
    }, 55);
    return () => window.clearInterval(t);
  }, [text]);
  return (
    <b className="fh-tk">
      {text.slice(0, n)}
      <i className="fh-caret" aria-hidden="true" />
    </b>
  );
}

/** The coin's latest trades, newest first, live. */
function useTrades(mint: string | null): Trade[] {
  const [list, setList] = useState<Trade[]>([]);
  useEffect(() => {
    if (!mint) return;
    // dust trades (under 0.001 SOL) carry ~0 fee and only add noise
    const real = (t: Trade) => t.sol >= 0.001;
    setList([...recentTrades(mint)].filter(real).sort((a, b) => b.t - a.t).slice(0, ROWS));
    return onTrade(mint, (t) => {
      if (real(t)) setList((l) => [t, ...l].slice(0, ROWS));
    });
  }, [mint]);
  return list;
}

export function FlowHero() {
  const mint = useCycle();
  const coin = board.use((s) => (mint ? s.coins[mint] : undefined));
  const live = board.use((s) => s.live.length > 0);
  const trades = useTrades(mint);
  const tk = coin ? tick(coin.symbol) : '';
  const est = coin?.fees.est.h1 ? '~' : '';
  const wires = useMemo(
    () =>
      Array.from({ length: ROWS }, (_, i) => {
        const y = 22 + i * 14;
        return `M0 ${y} C 40 ${y}, 50 50, 100 50`;
      }),
    [],
  );

  return (
    <section className="fhero" aria-labelledby="fhero-h" data-testid="hero">
      <HeaderField />
      <h1 id="fhero-h" className="fh-h">
        {copy.line}
      </h1>
      <p className="fh-type" aria-live="polite">
        {copy.flow.typeA}{' '}
        {coin && (
          <a className="fh-coin" {...linkProps(coinPath(coin.mint))}>
            <CoinImg src={coin.image} symbol={coin.symbol} size={30} vt="coin-pic" />
            <span data-vt="coin-tk">
              <Typed text={tk} />
            </span>
          </a>
        )}{' '}
        {copy.flow.typeB}
      </p>

      <div className="fh-map">
        <div className="fh-col fh-col-src">
          <p className="fh-step">
            <Tpl s={copy.flow.step1} v={{}} />
          </p>
          <div className="fh-src">
          <ul className="fh-trades" aria-label={copy.a11y.trades}>
            {trades.length ? (
              trades.map((t, i) => (
                // position keys: the list is always ROWS long, so it can never grow (trades in the same second repeat)
                <li key={i} className={'fh-tr is-' + t.side}>
                  <i aria-hidden="true" />
                  <span className="mono fh-side">{t.side === 'buy' ? copy.coin.buySide : copy.coin.sellSide}</span>
                  <span className="mono">{solFlap(t.sol, 3)} SOL</span>
                  <span className="mono fh-fee">
                    +{solFlap(t.fee, 4)} {copy.flow.fee}
                  </span>
                </li>
              ))
            ) : (
              <li className="fh-wait">{copy.flow.waiting}</li>
            )}
          </ul>
          </div>
        </div>

        <svg className="fh-wires fh-in" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {wires.map((d, i) => (
            <path key={i} d={d} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>

        <div className="fh-core">
          <p className="fh-step">
            {copy.flow.step2}
          </p>
          <VaultScene mint={mint} size={320} label={copy.flow.scene} />
          <a className="fh-how" {...linkProps('/docs')} data-testid="hero-docs">
            {copy.flow.how}
          </a>
        </div>

        <svg className="fh-wires fh-out" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 50 C 45 50, 55 25, 100 25" vectorEffect="non-scaling-stroke" />
          <path d="M0 50 C 45 50, 55 75, 100 75" vectorEffect="non-scaling-stroke" className="is-dev" />
        </svg>

        <div className="fh-col fh-dst">
          <p className="fh-step">
            {copy.flow.step3}
          </p>
          <div className="fh-you">
            <span className="fh-num">
              <Flap text={est + solFlap(coin?.fees.h1 ?? 0, 3)} size="lg" tone="cash" label={copy.flow.lastHour + ': ' + (est ? copy.coin.estShort + ' ' : '') + solFlap(coin?.fees.h1 ?? 0, 3) + ' SOL'} />
              <span className="fh-u">{copy.flow.perHour}</span>
            </span>
            {/* a day as 24 cells: the bought hour pays you, every other hour pays the dev */}
            <span className="fh-day" aria-hidden="true">
              {Array.from({ length: 24 }, (_, i) => (
                <i key={i} className={i === 14 ? 'is-you' : ''} />
              ))}
            </span>
            <span className="fh-legend">
              <span>
                <i className="is-you" />
                {copy.flow.legendYou}
              </span>
              <span>
                <i />
                {copy.flow.legendDev}
              </span>
            </span>
          </div>
        </div>
      </div>

      <div className="fh-cta">
        {live ? (
          <button type="button" className="btn btn-cash btn-lg" onClick={focusFirstLive} data-testid="hero-buy">
            {copy.hero.buy}
          </button>
        ) : (
          <button type="button" className="btn btn-cash btn-lg" onClick={focusHot} data-testid="hero-hot">
            {copy.live.emptyHot}
          </button>
        )}
        <a className="btn btn-line btn-lg" data-testid="hero-flip" {...linkProps('/dev')}>
          {copy.live.emptyCta}
        </a>
      </div>
    </section>
  );
}
