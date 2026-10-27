// /docs: how flipfee works, in pictures and numbers: where the SOL goes, one example day, a
// backtest of buying at the suggested price, what a dev gets, and the rules. Every chart uses the example data in
// sample.ts and says so.
import { useMemo } from 'react';
import { copy, fill } from '../copy.ts';
import { linkProps } from '../lib/router.ts';
import { solFlap } from '../lib/format.ts';
import { Tpl } from '../lib/tpl.tsx';
import { DitherCoin } from '../dither/DitherCoin.tsx';
import { Bars } from '../charts/Bars.tsx';
import { Line } from '../charts/Line.tsx';
import { exampleBacktest, exampleDay, exampleDev } from './sample.ts';

const pct = (x: number) => (x > 0 ? '+' : '') + x + '%';

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'cash' }) {
  return (
    <div className="dstat">
      <span className="lbl">{label}</span>
      <b className={'dstat-v' + (tone ? ' is-cash' : '')}>{value}</b>
    </div>
  );
}

export function DocsPage() {
  const day = useMemo(exampleDay, []);
  const bt = useMemo(exampleBacktest, []);
  const dev = useMemo(exampleDev, []);
  return (
    <div className="page docs" data-testid="docs">
      <header className="docs-h">
        <DitherCoin n={72} size={144} mode="spin" vtName="vault" />
        <div>
          <h1>{copy.docs.title}</h1>
          <p>{copy.docs.line}</p>
        </div>
      </header>

      <section className="docs-sec" aria-labelledby="d-path">
        <h2 id="d-path">{copy.docs.pathTitle}</h2>
        <ol className="docs-steps">
          {copy.docs.steps.map(([t, d], i) => (
            <li key={t}>
              <span className="docs-n mono">{i + 1}</span>
              <b>{t}</b>
              <p>
                <Tpl s={d} v={{}} />
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section className="docs-sec" aria-labelledby="d-day">
        <header className="docs-sh">
          <h2 id="d-day">{copy.docs.dayTitle}</h2>
          <span className="docs-ex mono">{copy.docs.example}</span>
        </header>
        <p className="docs-sub">{copy.docs.daySub}</p>
        <div className="docs-stats">
          <Stat label={copy.docs.dayBuyers} value={solFlap(day.toBuyers, 2) + ' SOL'} tone="cash" />
          <Stat label={copy.docs.dayDev} value={solFlap(day.toDev, 2) + ' SOL'} />
        </div>
        <Bars
          title={copy.docs.dayTitle}
          legend={[copy.docs.sold, copy.docs.open]}
          every={3}
          bars={day.bars.map((b) => ({ label: fill(copy.docs.hour, { h: String(b.hour).padStart(2, '0') }), value: b.fees, solid: b.sold, tip: `${String(b.hour).padStart(2, '0')}:00 · ${solFlap(b.fees, 3)} SOL · ${b.sold ? copy.docs.sold : copy.docs.open}` }))}
        />
      </section>

      <section className="docs-sec" aria-labelledby="d-bt">
        <header className="docs-sh">
          <h2 id="d-bt">{copy.docs.btTitle}</h2>
          <span className="docs-ex mono">{copy.docs.example}</span>
        </header>
        <p className="docs-sub">{copy.docs.btSub}</p>
        <div className="docs-stats">
          <Stat label={copy.docs.btHours} value={String(bt.hours)} />
          <Stat label={copy.docs.btWin} value={bt.winRate + '%'} tone="cash" />
          <Stat label={copy.docs.btMedian} value={pct(bt.median)} />
          <Stat label={copy.docs.btBest} value={pct(bt.best)} />
          <Stat label={copy.docs.btWorst} value={pct(bt.worst)} />
        </div>
        <div className="docs-two">
          <div>
            <h3 className="lbl">{copy.docs.btDist}</h3>
            <Bars title={copy.docs.btDist} bars={bt.buckets.map((b) => ({ label: b.label, value: b.n, solid: b.up, tip: `${b.label} · ${b.n} ${copy.docs.btHours.toLowerCase()}` }))} every={2} />
          </div>
          <div>
            <h3 className="lbl">{copy.docs.btCurve}</h3>
            <Line title={copy.docs.btCurve} points={bt.curve.map((c) => ({ label: String(c.day), value: c.net, tip: `${fill(copy.docs.day, { d: c.day })} · ${c.net >= 0 ? '+' : ''}${solFlap(c.net, 3)} SOL` }))} />
            <p className="docs-sub">{copy.docs.btCurveSub}</p>
          </div>
        </div>
        <p className="docs-note">{copy.docs.btNote}</p>
      </section>

      <section className="docs-sec" aria-labelledby="d-dev">
        <header className="docs-sh">
          <h2 id="d-dev">{copy.docs.devTitle}</h2>
          <span className="docs-ex mono">{copy.docs.example}</span>
        </header>
        <p className="docs-sub">{copy.docs.devLine}</p>
        <h3 className="lbl">{copy.docs.devChart}</h3>
        <Line title={copy.docs.devChart} points={dev.map((d) => ({ label: String(d.day), value: d.total, tip: `${fill(copy.docs.day, { d: d.day })} · ${solFlap(d.total, 2)} SOL` }))} />
        <p className="docs-sub">{copy.docs.devChartSub}</p>
      </section>

      <section className="docs-sec" aria-labelledby="d-rules">
        <h2 id="d-rules">{copy.docs.rulesTitle}</h2>
        <dl className="docs-rules">
          {copy.docs.rules.map(([k, v]) => (
            <div key={k}>
              <dt className="lbl">{k}</dt>
              <dd>
                <Tpl s={v} v={{}} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="docs-note">{copy.docs.risk}</p>
        <a className="btn btn-cash btn-lg" {...linkProps('/')}>
          {copy.docs.toBoard}
        </a>
      </section>
    </div>
  );
}
