// The live cash counter (DESIGN.md §1.6 hero, right): the busiest live coin's hour in big flip tiles. Each trade drops
// a "+0.0021 SOL" chip from its dot into the total, and the total flips when the chip lands. With no live coin yet it
// shows the busiest hot coin's creator fees going to its dev, with the dev call to action.
import { useEffect, useReducer, useRef } from 'react';
import { copy, fill } from '../copy.ts';
import { Flap } from '../flap/Flap.tsx';
import { board, currentWindow, hoursOpen, onCash } from '../state/board.ts';
import type { Coin } from '../api/types.ts';
import { onTrade } from '../state/trades.ts';
import { Countdown, useNow } from '../lib/clock.tsx';
import { hhmm, nm, short, solFlap, tick } from '../lib/format.ts';
import { coinPath, linkProps } from '../lib/router.ts';
import { Tpl } from '../lib/tpl.tsx';
import { wallet } from '../wallet/wallet.ts';
import { CoinImg } from '../shell/CoinImg.tsx';
import { TradeDots } from './TradeDots.tsx';
import type { DotsApi } from './TradeDots.tsx';
import { flyChip, pulse } from './chips.ts';
import { BuyButton } from './BuyButton.tsx';
import { DitherCoin } from '../dither/DitherCoin.tsx';

let heroMint: string | null = null;

/**
 * The busiest coin: the server's pick (the live coin whose hour paid most) when it sends one, else the busiest by recent
 * fees; sticky, so it changes only when another coin is clearly busier or this one leaves the board.
 */
export function pickHero(coins: Record<string, Coin>, live: string[], hot: string[], server: string | null): { mint: string; live: boolean } | null {
  if (server && live.includes(server)) {
    heroMint = server;
    return { mint: server, live: true };
  }
  const pool = live.length ? live : hot;
  if (!pool.length) return null;
  const score = (m: string) => {
    const c = coins[m];
    return c ? c.fees.m10 * 6 + c.fees.h1 : 0;
  };
  let best = pool[0];
  for (const m of pool) if (score(m) > score(best)) best = m;
  if (heroMint && pool.includes(heroMint) && score(best) < score(heroMint) * 1.3) best = heroMint;
  heroMint = best;
  return { mint: best, live: live.length > 0 };
}

export function CashCounter() {
  const pick = board.use(
    (s) => pickHero(s.coins, s.live, s.hot, s.hero),
    (a, b) => a?.mint === b?.mint && a?.live === b?.live,
  );
  const ready = board.use((s) => s.ready);
  if (!pick) {
    return (
      <section className="counter is-wait" aria-label={copy.counter.label} aria-busy={!ready}>
        <span className="sk" style={{ width: '40%', height: 14 }} />
        <span className="sk" style={{ width: '86%', height: 74, marginTop: 18 }} />
        <span className="sk" style={{ width: '60%', height: 14, marginTop: 18 }} />
      </section>
    );
  }
  return <Counter key={pick.mint} mint={pick.mint} live={pick.live} />;
}

function Counter({ mint, live }: { mint: string; live: boolean }) {
  const coin = board.use((s) => s.coins[mint]);
  const me = wallet.use((s) => s.account);
  const now = useNow(1000);
  const dots = useRef<DotsApi | null>(null);
  const total = useRef<HTMLSpanElement>(null);
  const toChip = useRef<HTMLSpanElement>(null);
  const pending = useRef(0);
  const [, bump] = useReducer((x: number) => x + 1, 0);

  // chips: trade dot → the top of the total; the total counts the chip when it lands. One chip at a time: fees
  // that come while one flies ride on the next, so the digits stay readable on a busy coin.
  useEffect(() => {
    let flying = false;
    let held = 0;
    const send = () => {
      const from = dots.current?.last();
      const to = total.current;
      if (!from || !to || held <= 0) return;
      const fee = held;
      held = 0;
      flying = true;
      pending.current += fee;
      const r = to.getBoundingClientRect();
      const land = { x: r.left + r.width * 0.72, y: r.top - 6 };
      void flyChip('+' + solFlap(fee, 4) + ' ' + copy.ticker.sol, from, land, 'cash', 700).then(() => {
        pending.current = Math.max(0, pending.current - fee);
        flying = false;
        pulse(to);
        bump();
        if (held > 0) window.setTimeout(send, 120);
      });
    };
    return onTrade(mint, (t) => {
      if (!(t.fee > 0)) return;
      held += t.fee;
      if (!flying) send();
    });
  }, [mint]);

  // a payout to this coin's holder or dev lands on the recipient chip
  useEffect(
    () =>
      onCash((e) => {
        if (e.mint !== mint || e.kind !== 'paid') return;
        pulse(toChip.current, 'is-paid');
      }),
    [mint],
  );

  if (!coin) return null;
  const th = coin.thisHour;
  const amount = Math.max(0, (live ? (th?.sol ?? 0) : coin.fees.h1) - pending.current);
  const w = live ? currentWindow(coin, now) : null;
  const toMe = !!(me && th && th.to === me);
  const recipient = live ? (th?.kind === 'holder' ? (toMe ? copy.counter.you : short(th.to, 4)) : copy.counter.theDev) : fill(copy.counter.devOf, { ticker: tick(coin.symbol) });

  return (
    <section className={'counter' + (toMe ? ' is-me' : '')} aria-label={copy.counter.label} data-testid="counter" data-mint={mint}>
      <DitherCoin n={96} size={192} mode="spin" className="ct-art" />
      <header className="ct-h">
        <a className="ct-coin" {...linkProps(coinPath(mint))}>
          <CoinImg src={coin.image} symbol={coin.symbol} size={30} />
          <b>{tick(coin.symbol)}</b>
          <span className="ct-name">{nm(coin.name)}</span>
        </a>
      </header>
      <div className="ct-what">
        <span className="lbl">{live ? copy.counter.thisHour : copy.counter.hotTitle}</span>
        {live && th && <span className="ct-since mono">{fill(copy.counter.since, { time: hhmm(th.since) })}</span>}
      </div>
      <div className="ct-total">
        <span ref={total} className="ct-num">
          <Flap text={(live ? '+' : coin.fees.est.h1 ? '~' : '') + solFlap(amount, 4)} size="xl" pad={7} tone="cash" intro sound testid="counter-total" label={(live ? copy.counter.thisHour : copy.counter.hotTitle) + ': ' + (!live && coin.fees.est.h1 ? copy.coin.estShort + ' ' : '') + solFlap(amount, 4) + ' ' + copy.ticker.sol} />
        </span>
        <span className="ct-unit">{copy.ticker.sol}</span>
      </div>
      <div className="ct-to">
        <span ref={toChip} className={'to-chip' + (toMe ? ' is-me' : '') + (th?.kind === 'dev' || !live ? ' is-dev' : '')} data-testid="counter-to">
          <Tpl s={copy.counter.to} v={{ who: <b>{recipient}</b> }} />
        </span>
        {w ? (
          <span className="ct-left">
            <Tpl s={copy.counter.left} v={{ t: <Countdown t={w.end} className="mono" /> }} />
          </span>
        ) : live ? (
          <span className="ct-left dim">{copy.counter.open}</span>
        ) : null}
      </div>
      <TradeDots mint={mint} api={dots} span={90} className="ct-dots" />
      <footer className="ct-f">
        {live ? (
          <>
            <span className="ct-facts">
              <span className="ct-fact">
                <span className="lbl">{copy.live.colLast}</span>
                <span className="cell-v">
                  <Flap text={(coin.fees.est.h1 ? '~' : '') + solFlap(coin.fees.h1, 3)} size="sm" tone="cash" />
                  <span className="tk-u">{copy.ticker.sol}</span>
                </span>
              </span>
              <span className="ct-fact">
                <span className="lbl">{copy.live.colPrice}</span>
                <span className="cell-v">
                  <Flap text={solFlap(coin.ff?.price ?? 0, 3)} size="sm" />
                  <span className="tk-u">{copy.ticker.sol}</span>
                </span>
              </span>
            </span>
            <BuyButton coin={coin} hoursLeft={hoursOpen(coin, now)} me={me} size="lg" />
          </>
        ) : null}
      </footer>
    </section>
  );
}
