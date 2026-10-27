// The buy sheet (DESIGN.md §1.3, §1.6 buy panel, §1.7 risk line). From a row's "Buy 1h" it opens and asks Phantom at
// once (one tap); from the coin page or the hero it waits for the button. It shows the hours, the total, when they
// start, what the last 6 hours paid (a fact, never a promise) and "flipfee is new. Start small."
import { useEffect, useRef, useState } from 'react';
import { copy, fill } from '../copy.ts';
import { board, hoursOpen, nextStart } from '../state/board.ts';
import { closeSheet, leaveTo, ui } from '../state/ui.ts';
import type { Sheet as SheetT } from '../state/ui.ts';
import { Sheet } from '../shell/Sheet.tsx';
import { CoinImg } from '../shell/CoinImg.tsx';
import { Flap } from '../flap/Flap.tsx';
import { useNow, serverNow } from '../lib/clock.tsx';
import { hhmm, left, solFlap, solPlain, tick, nm } from '../lib/format.ts';
import { go } from '../lib/router.ts';
import { explorer } from '../chain/config.ts';
import { TxError, preloadKit, runTx } from '../chain/tx.ts';
import type { TxStep } from '../chain/tx.ts';
import { connectWallet } from '../wallet/connectFlow.ts';
import { wallet } from '../wallet/wallet.ts';
import { loadBoard } from '../api/live.ts';
import { sound } from '../lib/sound.ts';
import { IconCheck, IconExternal } from '../shell/Icons.tsx';
import { errCopy } from './errors.ts';

const CHIPS = [1, 3, 6, 12];
const STEPS: TxStep[] = ['build', 'sign', 'send', 'confirm'];

type Phase = { k: 'idle' } | { k: 'run'; step: TxStep } | { k: 'done'; sig: string; start: number; hours: number } | { k: 'err'; msg: string; sig?: string };

export function BuySheet() {
  const sheet = ui.use((s) => s.sheet);
  const open = sheet?.kind === 'buy';
  return (
    <Sheet open={open} onClose={closeSheet} label={copy.buy.title} testid="buy-sheet" size="sm">
      {open && <BuyBody key={sheet.mint + ':' + sheet.go} sheet={sheet} />}
    </Sheet>
  );
}

function BuyBody({ sheet }: { sheet: Extract<SheetT, { kind: 'buy' }> }) {
  const coin = board.use((s) => s.coins[sheet.mint]);
  const me = wallet.use((s) => s.account);
  const now = useNow(1000);
  const [hours, setHours] = useState(sheet.hours);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const started = useRef(false);

  useEffect(() => preloadKit(), []);

  const f = coin?.ff;
  const open = coin ? hoursOpen(coin, now) : 0;
  const h = Math.min(hours, Math.max(1, open));
  const total = (f?.price ?? 0) * h;
  const startAt = coin ? nextStart(coin, now) : now;
  const avg6 = coin ? coin.fees.h6 / 6 : 0;

  const buy = async () => {
    if (!coin || !f || phase.k === 'run') return;
    const a = me ?? (await connectWallet());
    if (!a) return;
    if (a === f.owner) {
      setPhase({ k: 'err', msg: copy.buy.yours });
      return;
    }
    const want = Math.min(hours, hoursOpen(coin));
    if (want < 1) {
      setPhase({ k: 'err', msg: copy.buy.soldOut });
      return;
    }
    sound.tap();
    setPhase({ k: 'run', step: 'build' });
    const startGuess = nextStart(coin);
    try {
      const sig = await runTx(
        (k) => k.buy({ buyer: a, mint: coin.mint, hours: want, maxPrice: BigInt(f.priceLamports || Math.round(f.price * 1e9)), graduated: coin.graduated, owner: f.owner }),
        (step) => setPhase({ k: 'run', step }),
        (e) => e.type === 'buy' && e.mint === coin.mint && e.buyer === a,
      );
      const mine = board.get().coins[coin.mint]?.ff?.windows.filter((w) => w.holder === a).sort((x, y) => y.start - x.start)[0];
      setPhase({ k: 'done', sig, start: mine?.start ?? startGuess, hours: want });
      sound.kaching();
      void loadBoard();
    } catch (e) {
      const te = e instanceof TxError ? e : new TxError('generic', String(e));
      setPhase({ k: 'err', msg: errCopy(te.code, total), sig: te.sig });
      if (te.code !== 'rejected') console.warn('[flipfee] buy failed', te.code, te.message, te.logs.slice(-6));
    }
  };

  // one tap from a row: ask Phantom right away
  useEffect(() => {
    if (!sheet.go || started.current || !coin) return;
    started.current = true;
    void buy();
  }, [coin]);

  if (!coin || !f) {
    return <p className="sheet-note">{copy.coin.loading}</p>;
  }

  if (phase.k === 'done') {
    const later = phase.start > serverNow() + 30000;
    return (
      <div className="buy-done" data-testid="buy-done">
        <div className="bd-stamp" aria-hidden="true">
          <Flap text={hhmm(phase.start)} size="lg" tone="cash" intro />
          <span className="bd-arrow">→</span>
          <Flap text={hhmm(phase.start + phase.hours * 3600e3)} size="lg" tone="cash" intro />
        </div>
        <h2>{later ? fill(copy.buy.doneLater, { t: left(phase.start - serverNow()) }) : phase.hours > 1 ? fill(copy.buy.doneNowN, { h: phase.hours }) : copy.buy.doneNow}</h2>
        <p className="dim">{copy.buy.doneSub}</p>
        <div className="sheet-actions">
          <button
            type="button"
            className="btn btn-cash btn-lg btn-block"
            onClick={() => leaveTo('/me', go)}
          >
            {copy.buy.me}
          </button>
          <a className="btn btn-line btn-block" href={explorer('tx', phase.sig)} target="_blank" rel="noopener noreferrer">
            {copy.buy.view}
            <IconExternal size={15} />
          </a>
        </div>
      </div>
    );
  }

  const running = phase.k === 'run';
  return (
    <div className="buy" data-testid="buy-body" data-mint={coin.mint}>
      <header className="sheet-coin">
        <CoinImg src={coin.image} symbol={coin.symbol} size={44} />
        <div>
          <h2>
            {copy.buy.title} · {tick(coin.symbol)}
          </h2>
          <p className="dim">{nm(coin.name)}</p>
        </div>
      </header>

      <div className="buy-hours" role="radiogroup" aria-label={copy.buy.hours}>
        {CHIPS.map((n) => (
          <button key={n} type="button" role="radio" aria-checked={h === n} className={'hchip' + (h === n ? ' is-on' : '')} disabled={n > open || running} onClick={() => setHours(n)} data-testid={'hours-' + n}>
            <Flap text={n + 'h'} size="sm" tone={h === n ? 'cash' : 'ink'} />
          </button>
        ))}
      </div>

      <dl className="buy-facts">
        <div>
          <dt className="lbl">{copy.buy.total}</dt>
          <dd>
            <Flap text={solFlap(total, 4)} size="md" tone="cash" testid="buy-total" />
            <span className="tk-u">{copy.ticker.sol}</span>
          </dd>
        </div>
        <div>
          <dt className="lbl">{copy.live.colHour}</dt>
          <dd className="buy-start" data-testid="buy-start">
            {startAt <= now + 15000 ? copy.buy.startsNow : fill(copy.buy.startsIn, { t: left(startAt - now) })}
          </dd>
        </div>
      </dl>
      <p className="buy-est" data-testid="buy-estimate">
        {avg6 > 0 ? fill(copy.buy.estimate, { sol: solPlain(avg6) }) : fill(copy.buy.estimateHour, { sol: solPlain(coin.fees.h1) })}
      </p>
      {f.paused ? (
        <p className="buy-warn">{copy.buy.paused}</p>
      ) : open < 1 ? (
        <p className="buy-warn">{copy.buy.soldOut}</p>
      ) : open < 12 ? (
        <p className="buy-note dim">{fill(copy.buy.maxHours, { h: open })}</p>
      ) : null}

      {phase.k === 'run' && (
        <ol className="tx-steps" data-testid="tx-steps" data-step={phase.step}>
          {STEPS.map((s) => {
            const i = STEPS.indexOf(s);
            const cur = STEPS.indexOf(phase.step);
            return (
              <li key={s} className={i < cur ? 'is-done' : i === cur ? 'is-now' : ''}>
                {i < cur ? <IconCheck size={14} /> : i === cur ? <span className="spin" aria-hidden="true" /> : <i aria-hidden="true" />}
                {copy.buy.steps[s as Exclude<TxStep, 'done'>]}
              </li>
            );
          })}
        </ol>
      )}
      {phase.k === 'err' && (
        <p className="tx-err" role="alert" data-testid="tx-error">
          {phase.msg}
        </p>
      )}

      <p className="risk">{copy.buy.risk}</p>
      <button type="button" className="btn btn-cash btn-lg btn-block" disabled={running || f.paused || open < 1} onClick={() => void buy()} data-testid="buy-go">
        {running ? <span className="spin" aria-hidden="true" /> : null}
        {phase.k === 'err' ? copy.buy.again : fill(copy.buy.cta, { h, sol: solPlain(total) })}
      </button>
      <p className="buy-note dim">{copy.buy.payNote}</p>
    </div>
  );
}
