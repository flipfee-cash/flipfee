// A dev's live coin (DESIGN.md §1.4): hours sold, SOL from sales (your 95%), fees routed to you, the queue of sold
// hours, and the terms: price per hour, hours ahead, pause or resume sales (one set_terms transaction).
import { memo, useEffect, useState } from 'react';
import { copy, fill } from '../copy.ts';
import { board } from '../state/board.ts';
import { Flap } from '../flap/Flap.tsx';
import { CoinImg } from '../shell/CoinImg.tsx';
import { HourBar } from '../board/HourBar.tsx';
import { hhmm, hrs, short, solFlap, solPlain, tick, nm } from '../lib/format.ts';
import { coinPath, linkProps } from '../lib/router.ts';
import { useNow } from '../lib/clock.tsx';
import { toast } from '../state/ui.ts';
import { TxError, runTx } from '../chain/tx.ts';
import type { TxStep } from '../chain/tx.ts';
import { errCopy } from '../buy/errors.ts';
import { IconPause, IconPlay } from '../shell/Icons.tsx';
import { MAX_PRICE, MIN_PRICE, toLamports } from './ConnectSheet.tsx';

const AHEAD = [6, 12, 24, 48];

export const Dashboard = memo(function Dashboard({ mint, me }: { mint: string; me: string }) {
  const coin = board.use((s) => s.coins[mint]);
  const now = useNow(5000);
  const f = coin?.ff;
  const [price, setPrice] = useState(f ? solPlain(f.price) : '');
  const [ahead, setAhead] = useState(f ? Math.round(f.maxAhead / 3600) : 24);
  const [step, setStep] = useState<TxStep | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (f && step === null) {
      setPrice(solPlain(f.price));
      setAhead(Math.round(f.maxAhead / 3600));
    }
  }, [f?.price, f?.maxAhead]);
  if (!coin || !f) return null;

  const lam = toLamports(price);
  const bad = lam === null || lam < MIN_PRICE || lam > MAX_PRICE;
  const changed = !bad && (lam !== BigInt(f.priceLamports || Math.round(f.price * 1e9)) || ahead * 3600 !== f.maxAhead);
  const queue = f.windows.filter((w) => w.end > now);

  const save = async (paused: boolean) => {
    if (bad || step) return;
    setErr('');
    try {
      await runTx((k) => k.terms({ owner: me, mint, price: lam!, maxAhead: ahead * 3600, paused }), setStep, (e) => e.type === 'window' && e.mint === mint);
      toast({ kind: 'ok', title: copy.toast.saved }, 1800);
    } catch (e) {
      const te = e instanceof TxError ? e : new TxError('generic', String(e));
      setErr(errCopy(te.code));
    } finally {
      setStep(null);
    }
  };

  return (
    <section className="panel dash" data-testid="dashboard" data-mint={mint}>
      <header className="dash-h">
        <a className="lr-coin" {...linkProps(coinPath(mint))}>
          <CoinImg src={coin.image} symbol={coin.symbol} size={48} />
          <span className="lr-names">
            <b>{tick(coin.symbol)}</b>
            <span>{nm(coin.name)}</span>
          </span>
        </a>
        <span className={'elig ' + (f.paused ? 'elig-locked' : 'elig-flipfee')}>{f.paused ? copy.dev.dash.paused : copy.dev.elig.flipfee}</span>
      </header>
      <div className="dash-stats">
        <div className="stat">
          <span className="lbl">{copy.dev.dash.hoursSold}</span>
          <Flap text={String(f.hoursSold)} size="md" pad={3} intro />
        </div>
        <div className="stat">
          <span className="lbl">{copy.dev.dash.sales}</span>
          <span className="stat-v">
            <Flap text={solFlap(f.sales * 0.95, 3)} size="md" tone="cash" pad={5} intro />
            <span className="tk-u">{copy.ticker.sol}</span>
          </span>
        </div>
        <div className="stat">
          <span className="lbl">{copy.dev.dash.fees}</span>
          <span className="stat-v">
            <Flap text={solFlap(f.ownerPaid, 3)} size="md" tone="cash" pad={5} intro />
            <span className="tk-u">{copy.ticker.sol}</span>
          </span>
        </div>
        <div className="stat">
          <span className="lbl">{copy.dev.wants}</span>
          <Flap text={String(coin.wants)} size="md" pad={2} tone={coin.wants ? 'amber' : 'ink'} intro />
        </div>
      </div>
      <HourBar coin={coin} me={me} span={24 * 3600e3} ticks />
      <div className="dash-queue">
        <span className="lbl">{copy.dev.dash.queue}</span>
        {queue.length ? (
          <ol>
            {queue.map((w) => (
              <li key={w.start}>
                <span className="mono">
                  {hhmm(w.start)} → {hhmm(w.end)}
                </span>
                <span className="mono">{short(w.holder, 4)}</span>
                <span className="dim">{hrs(w.end - w.start)}</span>
                {w.cost !== undefined && <span className="mono up">+{solFlap(w.cost * 0.95, 3)} SOL</span>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="dim">{copy.dev.dash.queueEmpty}</p>
        )}
      </div>
      <div className="dash-terms">
        <label className="cx-field">
          <span className="lbl">{copy.dev.dash.price}</span>
          <span className="cx-price">
            <input inputMode="decimal" autoComplete="off" value={price} onChange={(e) => setPrice(e.target.value)} disabled={!!step} aria-invalid={bad} data-testid="dash-price" />
            <span>{copy.ticker.sol}</span>
          </span>
        </label>
        <div className="cx-field">
          <span className="lbl">{copy.dev.dash.ahead}</span>
          <div className="cx-ahead" role="radiogroup" aria-label={copy.dev.dash.ahead}>
            {AHEAD.map((h) => (
              <button key={h} type="button" role="radio" aria-checked={ahead === h} className={'hchip' + (ahead === h ? ' is-on' : '')} onClick={() => setAhead(h)} disabled={!!step}>
                <Flap text={fill(copy.connect.aheadN, { h })} size="xs" tone={ahead === h ? 'cash' : 'ink'} />
              </button>
            ))}
          </div>
        </div>
        {bad && <p className="field-err">{copy.connect.priceRange}</p>}
        {err && (
          <p className="tx-err" role="alert">
            {err}
          </p>
        )}
        <div className="dash-acts">
          <button type="button" className="btn btn-cash" disabled={!changed || !!step} onClick={() => void save(f.paused)} data-testid="dash-save">
            {step ? <span className="spin" aria-hidden="true" /> : null}
            {step ? copy.buy.steps[step === 'done' ? 'confirm' : step] : copy.dev.dash.save}
          </button>
          <button type="button" className="btn btn-line" disabled={!!step || bad} onClick={() => void save(!f.paused)} data-testid="dash-pause">
            {f.paused ? <IconPlay size={16} /> : <IconPause size={16} />}
            {f.paused ? copy.dev.dash.resume : copy.dev.dash.pause}
          </button>
        </div>
      </div>
    </section>
  );
});
