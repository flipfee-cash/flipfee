// Small example panels for pages that wait on a wallet (owner, 2026-10-26: "no empty pages"): what one bought hour
// looks like (Me) and what a dev gets over a month (Devs). Example data from sample.ts, labelled as such.
import { useMemo } from 'react';
import { copy, fill } from '../copy.ts';
import { linkProps } from '../lib/router.ts';
import { solFlap } from '../lib/format.ts';
import { Bars } from '../charts/Bars.tsx';
import { Line } from '../charts/Line.tsx';
import { exampleBacktest, exampleDev } from './sample.ts';

function minutes(): number[] {
  // one example hour: 60 minutes of payouts with a few bursts, summing to 0.41 SOL
  const raw = Array.from({ length: 60 }, (_, i) => 0.3 + Math.abs(Math.sin(i * 1.7)) * 0.6 + (i % 13 === 4 ? 2.2 : 0) + (i % 17 === 9 ? 1.4 : 0));
  const sum = raw.reduce((s, x) => s + x, 0);
  return raw.map((x) => (x / sum) * 0.41);
}

export function HourExample() {
  const mins = useMemo(minutes, []);
  const bt = useMemo(exampleBacktest, []);
  return (
    <section className="panel ex" aria-labelledby="ex-hour">
      <header className="docs-sh">
        <h2 id="ex-hour">{copy.extra.hourTitle}</h2>
        <span className="docs-ex mono">{copy.docs.example}</span>
      </header>
      <div className="ex-row">
        <b>{copy.extra.hourCoin}</b>
        <span className="ex-kv">
          <span className="lbl">{copy.extra.hourCost}</span> <b className="mono">0.30 SOL</b>
        </span>
        <span className="ex-kv">
          <span className="lbl">{copy.extra.hourPaid}</span> <b className="mono is-cash">+0.41 SOL</b>
        </span>
      </div>
      <Bars title={copy.extra.hourSub} height={90} every={10} bars={mins.map((v, i) => ({ label: ':' + String(i).padStart(2, '0'), value: v, tip: `${fill(copy.extra.minute, { m: i + 1 })} · +${solFlap(v, 4)} SOL` }))} />
      <p className="docs-sub">{copy.extra.hourSub}</p>
      <p className="ex-foot">
        {fill(copy.extra.btLine, { n: bt.winRate })}{' '}
        <a className="link" {...linkProps('/docs')}>
          {copy.extra.more}
        </a>
      </p>
    </section>
  );
}

export function DevExample() {
  const dev = useMemo(exampleDev, []);
  return (
    <section className="panel ex" aria-labelledby="ex-dev">
      <header className="docs-sh">
        <h2 id="ex-dev">{copy.extra.devTitle}</h2>
        <span className="docs-ex mono">{copy.docs.example}</span>
      </header>
      <p className="docs-sub">{copy.extra.devSub}</p>
      <Line title={copy.docs.devChart} height={130} points={dev.map((d) => ({ label: String(d.day), value: d.total, tip: `${fill(copy.docs.day, { d: d.day })} · ${solFlap(d.total, 2)} SOL` }))} />
      <p className="ex-foot">
        {copy.docs.devChart}.{' '}
        <a className="link" {...linkProps('/docs')}>
          {copy.extra.more}
        </a>
      </p>
    </section>
  );
}
