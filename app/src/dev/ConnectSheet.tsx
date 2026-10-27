// The one-time connect sheet (DESIGN.md §1.5): the price per hour (suggested from live data), hours ahead, the four
// plain lines (the last one says the step is final), the risk line, and "Connect $TICKER" → one Phantom signature.
import { useEffect, useState } from 'react';
import { copy, fill } from '../copy.ts';
import type { DevCoin } from '../api/types.ts';
import { CoinImg } from '../shell/CoinImg.tsx';
import { IconCheck } from '../shell/Icons.tsx';
import { Flap } from '../flap/Flap.tsx';
import { solPlain, tick } from '../lib/format.ts';
import { Tpl } from '../lib/tpl.tsx';
import { TxError, preloadKit, runTx } from '../chain/tx.ts';
import type { TxStep } from '../chain/tx.ts';
import { wallet } from '../wallet/wallet.ts';
import { connectWallet } from '../wallet/connectFlow.ts';
import { errCopy } from '../buy/errors.ts';
import { sound } from '../lib/sound.ts';
import { loadBoard } from '../api/live.ts';

const AHEAD = [6, 12, 24, 48];
const STEPS: TxStep[] = ['build', 'sign', 'send', 'confirm'];

/** "0.31" → 310000000n (exact, no float). Null when it is not a price. */
export function toLamports(s: string): bigint | null {
  const t = s.trim().replace(',', '.');
  if (!/^\d{0,7}(\.\d{0,9})?$/.test(t) || t === '' || t === '.') return null;
  const [i, f = ''] = t.split('.');
  return BigInt(i || '0') * 1_000_000_000n + BigInt((f + '000000000').slice(0, 9));
}

export const MIN_PRICE = 10_000_000n; // 0.01 SOL
export const MAX_PRICE = 1_000_000_000_000n; // 1000 SOL

type Phase = { k: 'idle' } | { k: 'run'; step: TxStep } | { k: 'done' } | { k: 'err'; msg: string };

export function ConnectSheetBody({ coin, onDone }: { coin: DevCoin; onDone: () => void }) {
  const me = wallet.use((s) => s.account);
  const [price, setPrice] = useState(solPlain(coin.suggested));
  const [ahead, setAhead] = useState(24);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  useEffect(() => preloadKit(), []);
  const lam = toLamports(price);
  const bad = lam === null || lam < MIN_PRICE || lam > MAX_PRICE;
  const t = tick(coin.symbol);
  const almost = coin.eligibility === 'almost';
  const suggestedFrom = coin.fees.h1 > 0 ? fill(copy.connect.suggested, { sol: solPlain(coin.suggested), paid: solPlain(coin.fees.h1) }) : fill(copy.connect.suggestedSix, { sol: solPlain(coin.suggested), paid: solPlain(coin.fees.h6) });

  const go = async () => {
    if (bad || phase.k === 'run') return;
    const a = me ?? (await connectWallet());
    if (!a) return;
    sound.tap();
    setPhase({ k: 'run', step: 'build' });
    try {
      await runTx(
        (k) => k.connect({ dev: a, mint: coin.mint, price: lam!, maxAhead: ahead * 3600, kind: almost ? 'almost' : coin.eligibility === 'ready' ? 'ready' : 'ready-new', graduated: coin.graduated }),
        (step) => setPhase({ k: 'run', step }),
        (e) => e.type === 'register' && e.mint === coin.mint,
      );
      setPhase({ k: 'done' });
      sound.kaching();
      void loadBoard();
    } catch (e) {
      const te = e instanceof TxError ? e : new TxError('generic', String(e));
      setPhase({ k: 'err', msg: errCopy(te.code) });
      if (te.code !== 'rejected') console.warn('[flipfee] connect failed', te.code, te.message, te.logs.slice(-6));
    }
  };

  if (phase.k === 'done') {
    return (
      <div className="buy-done" data-testid="connect-done">
        <Flap text={t.slice(1, 9).toUpperCase()} size="lg" tone="cash" intro />
        <h2>{fill(copy.connect.doneTitle, { ticker: t })}</h2>
        <p className="dim">{copy.connect.doneSub}</p>
        <div className="sheet-actions">
          <button
            type="button"
            className="btn btn-cash btn-lg btn-block"
            onClick={onDone}
            data-testid="connect-see"
          >
            {copy.connect.toBoard}
          </button>
        </div>
      </div>
    );
  }

  const running = phase.k === 'run';
  return (
    <div className="cx" data-testid="connect-body" data-mint={coin.mint}>
      <header className="sheet-coin">
        <CoinImg src={coin.image} symbol={coin.symbol} size={48} />
        <div>
          <h2>{fill(almost ? copy.connect.finish : copy.connect.title, { ticker: t })}</h2>
          <p className="dim">{copy.connect.sub}</p>
        </div>
      </header>

      <label className="cx-field">
        <span className="lbl">{copy.connect.price}</span>
        <span className="cx-price">
          <input inputMode="decimal" autoComplete="off" value={price} onChange={(e) => setPrice(e.target.value)} disabled={running} aria-invalid={bad} data-testid="connect-price" />
          <span>{copy.ticker.sol}</span>
        </span>
      </label>
      <button type="button" className="cx-sug" onClick={() => setPrice(solPlain(coin.suggested))} disabled={running} data-testid="connect-suggested">
        {suggestedFrom}
      </button>
      {bad && <p className="field-err">{copy.connect.priceRange}</p>}

      <div className="cx-field">
        <span className="lbl">{copy.connect.ahead}</span>
        <div className="cx-ahead" role="radiogroup" aria-label={copy.connect.ahead}>
          {AHEAD.map((h) => (
            <button key={h} type="button" role="radio" aria-checked={ahead === h} className={'hchip' + (ahead === h ? ' is-on' : '')} onClick={() => setAhead(h)} disabled={running}>
              <Flap text={fill(copy.connect.aheadN, { h })} size="xs" tone={ahead === h ? 'cash' : 'ink'} />
            </button>
          ))}
        </div>
        <span className="dim cx-hint">{copy.connect.aheadSub}</span>
      </div>

      <ul className="cx-lines" data-testid="connect-lines">
        {copy.connect.lines.map((l, i) => (
          <li key={i} className={i === copy.connect.lines.length - 1 ? 'is-final' : ''}>
            <Tpl s={l} v={{}} />
          </li>
        ))}
      </ul>

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

      <p className="risk">{copy.connect.risk}</p>
      <button type="button" className="btn btn-cash btn-lg btn-block" disabled={bad || running} onClick={() => void go()} data-testid="connect-go">
        {running && <span className="spin" aria-hidden="true" />}
        {fill(almost ? copy.connect.finish : copy.connect.cta, { ticker: t })}
      </button>
    </div>
  );
}
