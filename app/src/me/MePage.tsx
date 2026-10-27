// Me /me (DESIGN.md §1.6): my hours (live with the ticking amount, upcoming with a countdown, past with what they paid),
// my coins as a dev, and totals (spent, received).
import { HourExample } from '../docs/Examples.tsx';
import { useEffect, useState } from 'react';
import { copy, fill } from '../copy.ts';
import { get } from '../api/http.ts';
import { meReply } from '../api/norm.ts';
import type { MeReply, MyHour } from '../api/types.ts';
import { board, putCoin } from '../state/board.ts';
import { wallet } from '../wallet/wallet.ts';
import { connectWallet } from '../wallet/connectFlow.ts';
import { Flap } from '../flap/Flap.tsx';
import { CoinImg } from '../shell/CoinImg.tsx';
import { PhantomGlyph } from '../shell/Icons.tsx';
import { Countdown, useNow } from '../lib/clock.tsx';
import { hhmm, hrs, solFlap, tick } from '../lib/format.ts';
import { coinPath, linkProps } from '../lib/router.ts';
import { Tpl } from '../lib/tpl.tsx';
import { onStream } from '../api/live.ts';
import { wants } from '../board/actions.ts';

type Load = { k: 'wait' } | { k: 'ok'; me: MeReply } | { k: 'err' };

export function MePage() {
  const me = wallet.use((s) => s.account);
  const [load, setLoad] = useState<Load>({ k: 'wait' });
  const now = useNow(1000);

  useEffect(() => {
    if (!me) return;
    let alive = true;
    const run = () =>
      get<unknown>('/me/' + me)
        .then((r) => {
          if (!alive) return;
          const m = meReply(r, me);
          for (const c of m.coins) putCoin(c);
          if (m.wants.length) wants.set((s) => ({ mine: [...new Set([...s.mine, ...m.wants])] }));
          setLoad({ k: 'ok', me: m });
        })
        .catch(() => alive && setLoad((l) => (l.k === 'ok' ? l : { k: 'err' })));
    setLoad({ k: 'wait' });
    void run();
    const offS = onStream((list) => {
      if (list.some((e) => (e.type === 'buy' && e.buyer === me) || (e.type === 'paid' && e.to === me) || (e.type === 'register' && e.owner === me))) void run();
    });
    const t = window.setInterval(() => document.visibilityState === 'visible' && void run(), 45000);
    return () => {
      alive = false;
      offS();
      window.clearInterval(t);
    };
  }, [me]);

  if (!me) {
    return (
      <div className="page me" data-testid="me-page">
        <h1 className="page-title">{copy.me.title}</h1>
        <section className="panel dev-connect">
          <p>{copy.me.connect}</p>
          <button type="button" className="btn btn-ink btn-lg" onClick={() => void connectWallet()} data-testid="me-connect">
            <PhantomGlyph size={22} />
            {copy.wallet.connect}
          </button>
        </section>
        <HourExample />
      </div>
    );
  }
  if (load.k !== 'ok') {
    return (
      <div className="page me" data-testid="me-page" aria-busy={load.k === 'wait'}>
        <h1 className="page-title">{copy.me.title}</h1>
        {load.k === 'err' ? <p className="tx-err">{copy.err.server}</p> : <span className="sk" style={{ height: 220 }} />}
      </div>
    );
  }
  const m = load.me;
  const live = m.hours.filter((h) => h.start <= now && now < h.end);
  const next = m.hours.filter((h) => h.start > now).sort((a, b) => a.start - b.start);
  const past = m.hours.filter((h) => h.end <= now);
  const isDev = m.coins.length > 0 || m.devSales > 0 || m.devFees > 0;
  return (
    <div className="page me" data-testid="me-page">
      <h1 className="page-title">{copy.me.title}</h1>
      <section className="me-totals">
        <div className="stat">
          <span className="lbl">{copy.me.spent}</span>
          <span className="stat-v">
            <Flap text={solFlap(m.spent, 3)} size="lg" pad={5} intro testid="me-spent" />
            <span className="tk-u">{copy.ticker.sol}</span>
          </span>
        </div>
        <div className="stat">
          <span className="lbl">{copy.me.received}</span>
          <span className="stat-v">
            <Flap text={solFlap(m.received, 3)} size="lg" pad={5} tone="cash" intro testid="me-received" />
            <span className="tk-u">{copy.ticker.sol}</span>
          </span>
        </div>
        {isDev && (
          <>
            <div className="stat">
              <span className="lbl">{copy.me.devSales}</span>
              <span className="stat-v">
                <Flap text={solFlap(m.devSales, 3)} size="lg" pad={5} tone="cash" intro />
                <span className="tk-u">{copy.ticker.sol}</span>
              </span>
            </div>
            <div className="stat">
              <span className="lbl">{copy.me.devFees}</span>
              <span className="stat-v">
                <Flap text={solFlap(m.devFees, 3)} size="lg" pad={5} tone="cash" intro />
                <span className="tk-u">{copy.ticker.sol}</span>
              </span>
            </div>
          </>
        )}
      </section>

      {!m.hours.length ? (
        <section className="panel me-empty" data-testid="me-empty">
          <h2>{copy.me.empty}</h2>
          <p className="dim">{copy.me.emptySub}</p>
          <a className="btn btn-cash btn-lg" {...linkProps('/')}>
            {copy.me.toBoard}
          </a>
        </section>
      ) : (
        <>
          {live.length > 0 && <HourList title={copy.me.liveNow} list={live} me={me} kind="live" />}
          {next.length > 0 && <HourList title={copy.me.next} list={next} me={me} kind="next" />}
          {past.length > 0 && <HourList title={copy.me.past} list={past} me={me} kind="past" />}
        </>
      )}

      {m.coins.length > 0 && (
        <section className="panel">
          <header className="panel-h">
            <h2>{copy.me.coins}</h2>
            <p className="dim">{copy.me.coinsSub}</p>
          </header>
          {m.coins.map((c) => (
            <a key={c.mint} className="me-coin" {...linkProps('/dev')}>
              <CoinImg src={c.image} symbol={c.symbol} size={34} />
              <b>{tick(c.symbol)}</b>
              <span className="dim">{c.ff ? fill(copy.coin.perHour, { sol: solFlap(c.ff.price, 3) }) : ''}</span>
            </a>
          ))}
        </section>
      )}
    </div>
  );
}

function HourList({ title, list, me, kind }: { title: string; list: MyHour[]; me: string; kind: 'live' | 'next' | 'past' }) {
  return (
    <section className={'panel me-hours me-' + kind} data-testid={'me-' + kind}>
      <h2 className="lbl">{title}</h2>
      <ol>
        {list.map((h) => (
          <MyHourRow key={h.mint + h.start} h={h} me={me} kind={kind} />
        ))}
      </ol>
    </section>
  );
}

function MyHourRow({ h, me, kind }: { h: MyHour; me: string; kind: 'live' | 'next' | 'past' }) {
  const coin = board.use((s) => s.coins[h.mint]);
  // a live hour ticks with the coin's trades (the board's "this hour" when it goes to me)
  const liveSol = kind === 'live' ? (coin?.thisHour && coin.thisHour.to === me ? coin.thisHour.sol : (h.live?.sol ?? 0)) : 0;
  return (
    <li className="mh" data-testid="my-hour">
      <a className="lr-coin" {...linkProps(coinPath(h.mint))}>
        <CoinImg src={h.image || coin?.image || ''} symbol={h.symbol || coin?.symbol || ''} size={36} />
        <span className="lr-names">
          <b>{tick(h.symbol || coin?.symbol)}</b>
          <span className="mono">
            {hhmm(h.start)} → {hhmm(h.end)} · {hrs(h.end - h.start)}
          </span>
        </span>
      </a>
      {kind === 'live' && (
        <>
          <span className="mh-v">
            <Flap text={'+' + solFlap(liveSol, 4)} size="md" tone="cash" pad={7} testid="my-live-sol" />
            <span className="tk-u">{copy.ticker.sol}</span>
          </span>
          <span className="mh-t">
            <Tpl s={copy.me.left} v={{ t: <Countdown t={h.end} className="mono" /> }} />
          </span>
        </>
      )}
      {kind === 'next' && (
        <span className="mh-t">
          <Tpl s={copy.me.startsIn} v={{ t: <Countdown t={h.start} className="mono" /> }} />
        </span>
      )}
      {kind === 'past' && <span className="mh-v mono up">{fill(copy.me.paid, { sol: solFlap(h.earned, 4) })}</span>}
      {h.cost !== undefined && <span className="mh-cost dim mono">{fill(copy.me.cost, { sol: solFlap(h.cost, 3) })}</span>}
    </li>
  );
}
