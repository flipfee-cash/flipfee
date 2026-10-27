// The coin page /c/<mint> (DESIGN.md §1.6): header (image, ticker, name, market cap, age, CA, links), the hour
// timeline, the trade stream, stats and the buy panel. A coin off flipfee shows its fees and Want · Share.
import { useEffect, useState } from 'react';
import { copy, fill } from '../copy.ts';
import { get, ApiError } from '../api/http.ts';
import { coinPage } from '../api/norm.ts';
import type { Timeline } from '../api/types.ts';
import { board, putCoin } from '../state/board.ts';
import { addTrades } from '../state/trades.ts';
import { wallet } from '../wallet/wallet.ts';
import { Flap } from '../flap/Flap.tsx';
import { CoinImg } from '../shell/CoinImg.tsx';
import { IconArrowLeft, IconCopy, IconExternal, IconShare } from '../shell/Icons.tsx';
import { ago, count, nm, short, solFlap, tick, usdK } from '../lib/format.ts';
import { linkProps } from '../lib/router.ts';
import { writeClipboard } from '../lib/clipboard.ts';
import { toast } from '../state/ui.ts';
import { useNow } from '../lib/clock.tsx';
import { TradeDots } from '../board/TradeDots.tsx';
import { shareCoin, wantCoin, wants } from '../board/actions.ts';
import { Hours } from './Hours.tsx';
import { TradeStream } from './TradeStream.tsx';
import { BuyPanel } from './BuyPanel.tsx';

type Load = { k: 'wait' } | { k: 'ok'; timeline: Timeline | null; at: number } | { k: 'err'; missing: boolean };

export function CoinPage({ mint }: { mint: string }) {
  const coin = board.use((s) => s.coins[mint]);
  const me = wallet.use((s) => s.account);
  const wanted = wants.use((s) => s.mine.includes(mint));
  const [load, setLoad] = useState<Load>({ k: 'wait' });
  useNow(10000);

  useEffect(() => {
    let alive = true;
    const run = () =>
      get<unknown>('/coin/' + mint)
        .then((r) => {
          const p = coinPage(r);
          if (!alive) return;
          if (!p) {
            setLoad({ k: 'err', missing: true });
            return;
          }
          addTrades([...p.trades].reverse(), false);
          putCoin(p.coin);
          setLoad({ k: 'ok', timeline: p.timeline, at: Date.now() });
        })
        .catch((e) => {
          if (!alive) return;
          setLoad((l) => (l.k === 'ok' ? l : { k: 'err', missing: e instanceof ApiError && (e.status === 404 || e.status === 400) }));
        });
    void run();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void run(), 30000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [mint]);

  useEffect(() => {
    if (coin) document.title = tick(coin.symbol) + ' · ' + copy.brand;
    return () => {
      document.title = copy.title;
    };
  }, [coin?.symbol]);

  if (!coin) {
    if (load.k === 'err') {
      return (
        <div className="page coin-missing" data-testid="coin-missing">
          <a className="back" {...linkProps('/')}>
            <IconArrowLeft size={16} />
            {copy.coin.back}
          </a>
          <h1>{copy.coin.missing}</h1>
          <p className="dim">{copy.coin.missingSub}</p>
        </div>
      );
    }
    return (
      <div className="page" aria-busy="true">
        <span className="sk" style={{ height: 96, marginTop: 24 }} />
        <span className="sk" style={{ height: 280, marginTop: 16 }} />
        <p className="sr">{copy.coin.loading}</p>
      </div>
    );
  }

  const ff = coin.ff;
  const mine = !!(me && ff && ff.owner === me);
  const links: [string, string | undefined][] = [
    [copy.pf, coin.links.pumpfun ?? `https://pump.fun/coin/${mint}`],
    [copy.coin.dexscreener, coin.links.dexscreener ?? `https://dexscreener.com/solana/${mint}`],
    [copy.coin.solscan, coin.links.solscan ?? `https://solscan.io/token/${mint}`],
  ];
  const age = coin.createdAt ? Date.now() - coin.createdAt : coin.ageSec * 1000;
  const est = (on: boolean) => (on ? '~' : '');

  return (
    <div className="page coin" data-testid="coin-page" data-mint={mint} data-live={ff ? '1' : '0'}>
      <a className="back" {...linkProps('/')}>
        <IconArrowLeft size={16} />
        {copy.coin.back}
      </a>
      <header className="coin-h">
        <CoinImg src={coin.image} symbol={coin.symbol} size={72} vtName="coin-pic" />
        <div className="coin-h-t">
          <h1>
            <b style={{ viewTransitionName: 'coin-tk', fontWeight: 'inherit' }}>{tick(coin.symbol)}</b> <span>{nm(coin.name)}</span>
          </h1>
          <dl className="coin-facts">
            <div>
              <dt className="lbl">{copy.coin.mcap}</dt>
              <dd className="mono">{usdK(coin.mcapUsd)}</dd>
            </div>
            <div>
              <dt className="lbl">{copy.coin.age}</dt>
              <dd className="mono">{age > 0 ? ago(age) : '—'}</dd>
            </div>
            <div>
              <dt className="lbl">{copy.coin.ca}</dt>
              <dd>
                <button
                  type="button"
                  className="ca-btn mono"
                  onClick={() => void writeClipboard(mint).then((ok) => ok && toast({ kind: 'ok', title: copy.coin.caCopied }, 1500))}
                  aria-label={copy.coin.copyCa}
                  data-testid="copy-ca"
                >
                  {short(mint, 5)}
                  <IconCopy size={14} />
                </button>
              </dd>
            </div>
          </dl>
          <nav className="coin-links">
            {links.map(([label, href]) => (
              <a key={label} href={href} target="_blank" rel="noopener noreferrer">
                {label}
                <IconExternal size={13} />
              </a>
            ))}
          </nav>
        </div>
      </header>

      <div className={'coin-grid' + (ff ? ' is-ff' : '')}>
        <div className="coin-main">
          {ff ? (
            <Hours coin={coin} me={me} timeline={load.k === 'ok' ? load.timeline : null} />
          ) : (
            <section className="panel coin-off" data-testid="coin-off">
              <h2>
                {fill(copy.coin.offTitle)}
              </h2>
              <p className="dim">{copy.coin.offSub}</p>
              <div className="coin-off-acts">
                <button type="button" className="btn btn-ink btn-lg" aria-pressed={wanted} onClick={() => void wantCoin(coin)} data-testid="want">
                  {wanted ? copy.hot.wanted : copy.hot.want}
                  <span className="mono want-n">{coin.wants}</span>
                </button>
                <button type="button" className="btn btn-line btn-lg" onClick={() => void shareCoin(coin)} data-testid="share">
                  <IconShare size={17} />
                  {copy.hot.share}
                </button>
              </div>
              <HourlyBars hourly={coin.hourly} />
            </section>
          )}
          <section className="panel">
            <header className="panel-h">
              <h2>{copy.coin.stream}</h2>
              <p className="dim">{copy.coin.streamSub}</p>
            </header>
            <TradeDots mint={mint} span={180} className="coin-dots" />
            <TradeStream mint={mint} me={me} />
          </section>
        </div>
        <aside className="coin-side">
          {ff && <BuyPanel coin={coin} me={me} mine={mine} />}
          {!ff && (
            <section className="panel dev-cta" data-testid="coin-dev-cta">
              {coin.wants > 0 && (
                <p className="dev-cta-n">
                  <Flap text={String(coin.wants)} size="sm" tone="amber" />
                  {coin.wants === 1 ? copy.coin.wantsDev1 : copy.coin.wantsDev}
                </p>
              )}
              <a className="btn btn-line" {...linkProps('/dev/' + mint)} data-testid="coin-flip">
                {copy.counter.hotCta}
              </a>
            </section>
          )}
          <section className="panel stats" data-testid="coin-stats">
            <h2 className="lbl">{copy.coin.fees}</h2>
            <div className="stat-grid">
              <Stat label={copy.coin.h1} text={est(coin.fees.est.h1) + solFlap(coin.fees.h1, 3)} unit="SOL" tone="cash" />
              <Stat label={copy.coin.h6} text={est(coin.fees.est.h6) + solFlap(coin.fees.h6, 2)} unit="SOL" />
              <Stat label={copy.coin.h24} text={est(coin.fees.est.h24) + solFlap(coin.fees.h24, 2)} unit="SOL" />
              <Stat label={copy.coin.trades} text={count(coin.trades1h) + (coin.trades1hPart ? '+' : '')} />
              <Stat label={copy.coin.volume} text={solFlap(coin.volume1h, 1)} unit="SOL" />
              <Stat label={copy.coin.wants} text={String(coin.wants)} />
            </div>
            {(coin.fees.est.h1 || coin.fees.est.h6) && <p className="est-note dim">{copy.coin.estNote}</p>}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, text, unit, tone = 'ink' }: { label: string; text: string; unit?: string; tone?: 'ink' | 'cash' }) {
  return (
    <div className="stat">
      <span className="lbl">{label}</span>
      <span className="stat-v">
        <Flap text={text} size="sm" tone={tone} label={label + ': ' + text + (unit ? ' ' + unit : '')} />
        {unit && <span className="tk-u">{unit}</span>}
      </span>
    </div>
  );
}

/** What each of the last 12 clock hours paid in creator fees (a coin off flipfee). */
function HourlyBars({ hourly }: { hourly: [number, number][] }) {
  const list = hourly.slice(-12);
  if (!list.length) return null;
  const max = Math.max(...list.map((h) => h[1]), 1e-9);
  return (
    <div className="hourly" aria-label={copy.coin.hourly}>
      <span className="lbl">{copy.coin.hourly}</span>
      <div className="hourly-bars">
        {list.map(([t, v]) => (
          <span key={t} className="hb" title={new Date(t).getHours() + ':00 · ' + solFlap(v, 3) + ' ' + copy.ticker.sol}>
            <i style={{ height: Math.max(2, (100 * v) / max) + '%' }} />
            <em>{String(new Date(t).getHours()).padStart(2, '0')}</em>
          </span>
        ))}
      </div>
    </div>
  );
}
