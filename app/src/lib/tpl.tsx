// Copy with live parts: `<Tpl s="{who} · {t} left" v={{ who: <b>7xQ…f2</b>, t: <Countdown t={end} /> }} />` keeps
// the sentence whole in copy.ts and drops elements into its {placeholders}.
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { copy } from '../copy.ts';

export function Tpl({ s, v }: { s: string; v: Record<string, ReactNode> }) {
  const parts = s.split(/(\{\w+\})/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\{(\w+)\}$/.exec(p);
        if (!m) return p ? <Fragment key={i}>{p}</Fragment> : null;
        const k = m[1];
        return <Fragment key={i}>{k in v ? v[k] : k === 'pf' ? copy.pf : p}</Fragment>;
      })}
    </>
  );
}
