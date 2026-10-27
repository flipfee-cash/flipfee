// The dev page /dev (DESIGN.md §1.4, §2.4): connect Phantom → "Your coins" (the pump.fun coins this wallet made, with
// fees, wants and eligibility) → Connect a coin in one transaction → the dashboard (hours sold, SOL received, fees to
// you, the queue, price, hours ahead, pause). /dev/<mint> opens the connect sheet for that coin.
import { DevExample } from '../docs/Examples.tsx';
import { useCallback, useEffect, useState } from 'react';
import { copy, fill } from '../copy.ts';
import { get, ApiError } from '../api/http.ts';
import { devReply } from '../api/norm.ts';
import type { DevCoin } from '../api/types.ts';
import { board, putCoin } from '../state/board.ts';
import { createStore } from '../state/store.ts';
import { closeSheet, leaveTo, openSheet, toast, ui } from '../state/ui.ts';
import { wallet } from '../wallet/wallet.ts';
import { connectWallet } from '../wallet/connectFlow.ts';
import { Flap } from '../flap/Flap.tsx';
import { CoinImg } from '../shell/CoinImg.tsx';
import { PhantomGlyph } from '../shell/Icons.tsx';
import { coinPath, go, linkProps } from '../lib/router.ts';
import { nm, solFlap, tick } from '../lib/format.ts';
import { Tpl } from '../lib/tpl.tsx';
import { onStream } from '../api/live.ts';
import { shareCoin } from '../board/actions.ts';
import { Dashboard } from './Dashboard.tsx';
import { ConnectSheetBody } from './ConnectSheet.tsx';
import { Sheet } from '../shell/Sheet.tsx';

/** The dev list, kept here so the connect sheet reads the same coin. */
export const devData = createStore<{ wallet: string | null; coins: DevCoin[]; state: 'idle' | 'wait' | 'ok' | 'err' }>({ wallet: null, coins: [], state: 'idle' });

export async function loadDev(a: string): Promise<void> {
  if (devData.get().wallet !== a) devData.set({ wallet: a, coins: [], state: 'wait' });
  try {
    const r = devReply(await get<unknown>('/dev/' + a, { timeoutMs: 25000 }), a);
    if (wallet.get().account !== a) return;
    for (const c of r.coins) if (c.ff) putCoin(c);
    devData.set({ wallet: a, coins: r.coins, state: 'ok' });
  } catch (e) {
    if (devData.get().wallet === a && devData.get().state !== 'ok') devData.set({ state: 'err' });
    if (e instanceof ApiError && e.status === 429) toast({ kind: 'warn', title: copy.err.server });
  }
}

function Pitch({ facts = true }: { facts?: boolean }) {
  return (
    <section className="dev-pitch">
      <h1>{copy.dev.title}</h1>
      <p className="dev-line">{copy.dev.line}</p>
      {facts && (
        <ul className="dev-facts">
          {copy.dev.facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DevPage({ mint }: { mint?: string }) {
  const me = wallet.use((s) => s.account);
  const data = devData.use((s) => s);

  useEffect(() => {
    if (me) void loadDev(me);
  }, [me]);

  // a coin of mine registered or changed: read the list again
  useEffect(() => {
    if (!me) return;
    return onStream((list) => {
      if (list.some((e) => (e.type === 'register' && e.owner === me) || (e.type === 'window' && devData.get().coins.some((c) => c.mint === e.mint)))) void loadDev(me);
    });
  }, [me]);

  // /dev/<mint>: open its connect sheet when the list has it
  useEffect(() => {
    if (!mint || data.state !== 'ok') return;
    const c = data.coins.find((x) => x.mint === mint);
    if (c && (c.eligibility === 'ready' || c.eligibility === 'ready-new' || c.eligibility === 'almost') && !ui.get().sheet) openSheet({ kind: 'connect', mint }, false);
  }, [mint, data.state]);

  if (!me) {
    return (
      <div className="page dev" data-testid="dev-page">
        <Pitch />
        <section className="panel dev-connect">
          <p>{copy.dev.connectWallet}</p>
          <button type="button" className="btn btn-ink btn-lg" onClick={() => void connectWallet()} data-testid="dev-connect-wallet">
            <PhantomGlyph size={22} />
            {copy.wallet.connect}
          </button>
        </section>
        <DevExample />
      </div>
    );
  }

  const mineLive = data.coins.filter((c) => c.ff && c.ff.owner === me);
  const rest = data.coins.filter((c) => !(c.ff && c.ff.owner === me));
  return (
    <div className="page dev" data-testid="dev-page">
      <Pitch facts={!mineLive.length} />
      {mineLive.map((c) => (
        <Dashboard key={c.mint} mint={c.mint} me={me} />
      ))}
      {(rest.length > 0 || !mineLive.length) && (
      <section className="panel" data-testid="dev-coins" data-state={data.state}>
        <header className="panel-h">
          <h2>{copy.dev.yours}</h2>
          <p className="dim">
            <Tpl s={copy.dev.yoursSub} v={{}} />
          </p>
        </header>
        {data.state === 'wait' && (
          <div className="rows-skel" aria-busy="true">
            <span className="sk sk-row" />
            <span className="sk sk-row" />
            <p className="sr">{copy.dev.loading}</p>
          </div>
        )}
        {data.state === 'err' && <p className="tx-err">{copy.err.server}</p>}
        {data.state === 'ok' && !rest.length && !mineLive.length && (
          <div className="dev-empty" data-testid="dev-empty">
            <p>
              <Tpl s={copy.dev.empty} v={{}} />
            </p>
            <a className="btn btn-line" href="https://pump.fun/create" target="_blank" rel="noopener noreferrer">
              <Tpl s={copy.dev.emptyCta} v={{}} />
            </a>
          </div>
        )}
        {rest.map((c) => (
          <DevRow key={c.mint} c={c} />
        ))}
      </section>
      )}
    </div>
  );
}

function DevRow({ c }: { c: DevCoin }) {
  const live = board.use((s) => s.coins[c.mint]);
  const coin = live ?? c;
  const can = c.eligibility === 'ready' || c.eligibility === 'ready-new' || c.eligibility === 'almost';
  return (
    <div className={'drow is-' + c.eligibility} data-testid="dev-row" data-mint={c.mint} data-elig={c.eligibility}>
      <a className="lr-coin" {...linkProps(coinPath(c.mint))}>
        <CoinImg src={c.image} symbol={c.symbol} size={40} />
        <span className="lr-names">
          <b>{tick(c.symbol)}</b>
          <span>{nm(c.name)}</span>
        </span>
      </a>
      <div className="cell">
        <span className="lbl">{copy.dev.fees1h}</span>
        <span className="cell-v">
          <Flap text={(coin.fees.est.h1 ? '~' : '') + solFlap(coin.fees.h1, 3)} size="sm" tone="cash" />
          <span className="tk-u">{copy.ticker.sol}</span>
        </span>
      </div>
      <div className="cell">
        <span className="lbl">{copy.dev.fees24h}</span>
        <span className="cell-v">
          <Flap text={(coin.fees.est.h24 ? '~' : '') + solFlap(coin.fees.h24, 2)} size="sm" />
          <span className="tk-u">{copy.ticker.sol}</span>
        </span>
      </div>
      <div className="cell">
        <span className="lbl">{copy.dev.wants}</span>
        <span className="cell-v">
          <Flap text={String(coin.wants)} size="sm" tone={coin.wants ? 'amber' : 'ink'} />
        </span>
      </div>
      <div className="drow-act">
        <span className={'elig elig-' + c.eligibility}>
          <Tpl s={copy.dev.elig[c.eligibility]} v={{}} />
        </span>
        {can ? (
          <button type="button" className="btn btn-cash" onClick={() => openSheet({ kind: 'connect', mint: c.mint })} data-testid="dev-connect">
            {c.eligibility === 'almost' ? copy.dev.finishBtn : fill(copy.dev.connectBtn, { ticker: tick(c.symbol) })}
          </button>
        ) : c.eligibility === 'flipfee' ? (
          <a className="btn btn-line" {...linkProps(coinPath(c.mint))}>
            {copy.dev.dash.view}
          </a>
        ) : (
          <button type="button" className="btn btn-tile" onClick={() => void shareCoin(c)}>
            {copy.hot.share}
          </button>
        )}
      </div>
      {coin.wants > 0 && can && <p className="drow-wants">{fill(coin.wants === 1 ? copy.dev.wantsLine1 : copy.dev.wantsLine, { n: coin.wants })}</p>}
    </div>
  );
}

/** The one-time connect sheet (DESIGN.md §1.5), mounted by App. */
export function ConnectCoinSheet() {
  const sheet = ui.use((s) => s.sheet);
  const open = sheet?.kind === 'connect';
  const coin = devData.use((s) => (open ? s.coins.find((c) => c.mint === sheet.mint) ?? null : null));
  const onClose = useCallback(() => {
    closeSheet();
    // a sheet the URL opened (/dev/<mint>) leaves that URL behind
    if (window.location.pathname.startsWith('/dev/')) go('/dev', true);
  }, []);
  const [, force] = useState(0);
  useEffect(() => {
    if (open && !coin && wallet.get().account) void loadDev(wallet.get().account!).then(() => force((x) => x + 1));
  }, [open, coin]);
  return (
    <Sheet open={open} onClose={onClose} label={coin ? fill(copy.connect.title, { ticker: tick(coin.symbol) }) : copy.dev.title} testid="connect-coin-sheet" size="md">
      {open && coin ? <ConnectSheetBody key={coin.mint} coin={coin} onDone={() => leaveTo(coinPath(coin.mint), go)} /> : open ? <p className="sheet-note">{copy.dev.loading}</p> : null}
    </Sheet>
  );
}
