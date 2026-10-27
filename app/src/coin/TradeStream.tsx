// The trade stream (DESIGN.md §1.6): each trade with buy/sell, SOL and the creator fee it paid, newest on top.
import { memo, useEffect, useState } from 'react';
import { copy } from '../copy.ts';
import type { Trade } from '../api/types.ts';
import { onTrade, recentTrades } from '../state/trades.ts';
import { Age } from '../lib/clock.tsx';
import { short, solFlap } from '../lib/format.ts';

const MAX = 40;

export const TradeStream = memo(function TradeStream({ mint, me }: { mint: string; me: string | null }) {
  const [list, setList] = useState<Trade[]>(() => recentTrades(mint).slice(-MAX).reverse());
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    setList(recentTrades(mint).slice(-MAX).reverse());
    return onTrade(mint, (t) => {
      setList((l) => [t, ...l.filter((x) => x.id !== t.id)].slice(0, MAX));
      setFresh((f) => new Set(f).add(t.id));
    });
  }, [mint]);

  // the snapshot can land after the first render
  useEffect(() => {
    const t = window.setInterval(() => {
      setList((l) => (l.length ? l : recentTrades(mint).slice(-MAX).reverse()));
      setFresh((f) => (f.size ? new Set() : f));
    }, 2500);
    return () => window.clearInterval(t);
  }, [mint]);

  if (!list.length) return <p className="stream-empty dim">{copy.coin.streamEmpty}</p>;
  return (
    <ol className="stream" data-testid="trade-stream">
      {list.map((t) => (
        <li key={t.id} className={'tr tr-' + t.side + (fresh.has(t.id) ? ' is-new' : '') + (me && t.wallet === me ? ' is-me' : '')}>
          <span className="tr-age mono">
            <Age t={t.t} />
          </span>
          <span className={'tr-side tr-side-' + t.side}>{t.side === 'buy' ? copy.coin.buySide : copy.coin.sellSide}</span>
          <span className="tr-sol mono">{solFlap(t.sol, 3)} {copy.ticker.sol}</span>
          <span className="tr-fee mono">+{solFlap(t.fee, 4)}</span>
          <span className="tr-w mono">{short(t.wallet, 4)}</span>
        </li>
      ))}
    </ol>
  );
});
