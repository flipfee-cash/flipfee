// One live coin on the board (DESIGN.md §1.6): image · $TICKER · name · paid last hour · this hour (live) · trade dots ·
// who gets the fees (the hour bar) · price per hour · Buy 1h. A trade flies a fee chip from its dot into the holder or
// dev chip; a sale stamps "cash" on the row.
import { memo, useEffect, useRef, useState } from 'react';
import { copy, fill } from '../copy.ts';
import { Flap } from '../flap/Flap.tsx';
import { board, hoursOpen, onCash } from '../state/board.ts';
import { onTrade } from '../state/trades.ts';
import { useNow } from '../lib/clock.tsx';
import { short, solFlap, solPlain, tick, nm } from '../lib/format.ts';
import { coinPath, go, linkProps } from '../lib/router.ts';
import { Tpl } from '../lib/tpl.tsx';
import { CoinImg } from '../shell/CoinImg.tsx';
import { TradeDots } from './TradeDots.tsx';
import type { DotsApi } from './TradeDots.tsx';
import { HourBar } from './HourBar.tsx';
import { BuyButton } from './BuyButton.tsx';
import { flyChip, pulse } from './chips.ts';

function useVisible<T extends Element>(): [React.RefObject<T | null>, React.RefObject<boolean>] {
  const ref = useRef<T>(null);
  const vis = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => (vis.current = es[0]?.isIntersecting ?? false), { rootMargin: '40px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, vis];
}

export const LiveRow = memo(function LiveRow({ mint, me, first }: { mint: string; me: string | null; first?: boolean }) {
  const coin = board.use((s) => s.coins[mint]);
  const now = useNow(5000);
  const [row, visible] = useVisible<HTMLDivElement>();
  const dots = useRef<DotsApi | null>(null);
  const toChip = useRef<HTMLSpanElement>(null);
  const lastChip = useRef(0);
  const [stamp, setStamp] = useState<{ id: number; text: string } | null>(null);

  useEffect(
    () =>
      onTrade(mint, (t) => {
        if (!(t.fee > 0) || !visible.current) return;
        const n = performance.now();
        if (n - lastChip.current < 700) return;
        lastChip.current = n;
        const from = dots.current?.last();
        if (!from || !toChip.current) return;
        const target = toChip.current;
        void flyChip('+' + solFlap(t.fee, 4), from, target, 'cash', 680).then((ok) => ok && pulse(target));
      }),
    [mint, visible],
  );

  useEffect(
    () =>
      onCash((e) => {
        if (e.mint !== mint) return;
        if (e.kind === 'sale') {
          setStamp({ id: Date.now(), text: fill(copy.live.sale, { sol: solPlain(e.amount * 0.95) }) });
        } else if (e.kind === 'paid') {
          pulse(toChip.current, 'is-paid');
        }
      }),
    [mint],
  );
  useEffect(() => {
    if (!stamp) return;
    const t = window.setTimeout(() => setStamp(null), 2600);
    return () => window.clearTimeout(t);
  }, [stamp]);

  if (!coin?.ff) return null;
  const th = coin.thisHour;
  const toMe = !!(me && th && th.to === me);
  const who = th?.kind === 'holder' ? (toMe ? copy.counter.you : short(th.to, 4)) : copy.live.dev;
  const open = hoursOpen(coin, now);
  return (
    <div
      ref={row}
      className={'lrow' + (toMe ? ' is-me' : '') + (coin.ff.owner === me ? ' is-mine' : '')}
      data-testid="live-row"
      data-mint={mint}
      id={first ? 'first-live' : undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,button')) return;
        go(coinPath(mint));
      }}
    >
      <a className="lr-coin" {...linkProps(coinPath(mint))}>
        <CoinImg src={coin.image} symbol={coin.symbol} size={38} vt="coin-pic" />
        <span className="lr-names">
          <b data-vt="coin-tk">{tick(coin.symbol)}</b>
          <span>{nm(coin.name)}</span>
        </span>
      </a>
      <div className="lr-last cell">
        <span className="lbl cell-l">{copy.live.colLast}</span>
        <span className="cell-v">
          <Flap text={(coin.fees.est.h1 ? '~' : '') + solFlap(coin.fees.h1, 3)} size="sm" pad={5} label={copy.live.colLast + ': ' + (coin.fees.est.h1 ? copy.coin.estShort + ' ' : '') + solFlap(coin.fees.h1, 3) + ' SOL'} />
        </span>
      </div>
      <div className="lr-now cell">
        <span className="lbl cell-l">{copy.live.colNow}</span>
        <span className="cell-v">
          <Flap text={'+' + solFlap(th?.sol ?? 0, 4)} size="sm" pad={7} tone="cash" testid="row-this-hour" label={copy.live.colNow + ': ' + solFlap(th?.sol ?? 0, 4) + ' SOL'} />
        </span>
        <span ref={toChip} className={'to-chip to-chip-sm' + (toMe ? ' is-me' : '') + (th?.kind !== 'holder' ? ' is-dev' : '')}>
          <Tpl s={copy.counter.to} v={{ who: <b>{who}</b> }} />
        </span>
      </div>
      <div className="lr-dots">
        <TradeDots mint={mint} api={dots} />
      </div>
      <div className="lr-hour">
        <HourBar coin={coin} me={me} />
      </div>
      <div className="lr-price cell">
        <span className="lbl cell-l">{copy.live.colPrice}</span>
        <span className="cell-v">
          <Flap text={solFlap(coin.ff.price, 3)} size="sm" pad={5} label={copy.live.colPrice + ': ' + solFlap(coin.ff.price, 3) + ' SOL'} />
        </span>
      </div>
      <div className="lr-buy">
        <BuyButton coin={coin} hoursLeft={open} me={me} />
      </div>
      {stamp && (
        <span key={stamp.id} className="cash-stamp" aria-hidden="true">
          <b>{copy.live.cash}</b>
          <span>{stamp.text}</span>
        </span>
      )}
    </div>
  );
});
