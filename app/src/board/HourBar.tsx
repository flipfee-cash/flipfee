// Who gets the fees, now and next: the next hours as one bar. A holder's window is a graphite segment (amber when it is
// yours); open time is the dev's (dashed). The caption says who holds now and the time left.
import { memo } from 'react';
import { copy, fill } from '../copy.ts';
import type { Coin } from '../api/types.ts';
import { Countdown, useNow } from '../lib/clock.tsx';
import { hrs, short } from '../lib/format.ts';
import { Tpl } from '../lib/tpl.tsx';
import { currentWindow } from '../state/board.ts';

interface Seg {
  kind: 'hold' | 'open';
  holder?: string;
  from: number;
  to: number;
  live: boolean;
}

export function segments(c: Coin, now: number, span: number): Seg[] {
  const end = now + span;
  const out: Seg[] = [];
  let at = now;
  for (const w of c.ff?.windows ?? []) {
    if (w.end <= now || w.start >= end) continue;
    const s = Math.max(w.start, now);
    if (s > at + 1000) out.push({ kind: 'open', from: at, to: s, live: at === now });
    out.push({ kind: 'hold', holder: w.holder, from: s, to: Math.min(w.end, end), live: w.start <= now });
    at = Math.min(w.end, end);
  }
  if (at < end - 1000) out.push({ kind: 'open', from: at, to: end, live: at === now });
  return out;
}

export const HourBar = memo(function HourBar({ coin, me, span = 6 * 3600e3, caption = true, ticks = false }: { coin: Coin; me: string | null; span?: number; caption?: boolean; ticks?: boolean }) {
  const now = useNow(5000);
  const segs = segments(coin, now, span);
  const cur = currentWindow(coin, now);
  const next = (coin.ff?.windows ?? []).find((w) => w.start > now);
  const who = (a: string) => (me && a === me ? copy.counter.you : short(a, 4));
  return (
    <div className="hbar-wrap" aria-label={copy.a11y.hourBar}>
      {caption && (
        <div className="hbar-cap">
          {cur ? (
            <span className={'hb-now' + (me === cur.holder ? ' is-me' : '')} data-testid="holder-now">
              <Tpl s={me === cur.holder ? copy.live.youHold : copy.live.holds} v={{ who: <b>{who(cur.holder)}</b>, t: <Countdown t={cur.end} className="mono" /> }} />
            </span>
          ) : (
            <span className="hb-now is-open" data-testid="holder-now">
              <b>{copy.live.openNow}</b>
            </span>
          )}
          {next && <span className="hb-next">{fill(copy.live.next, { who: who(next.holder) })}</span>}
        </div>
      )}
      <div className="hbar" role="presentation">
        {segs.map((s, i) => (
          <span
            key={i + ':' + s.from}
            className={'hseg hseg-' + s.kind + (s.live ? ' is-live' : '') + (s.holder && me && s.holder === me ? ' is-me' : '')}
            style={{ left: ((100 * (s.from - now)) / span).toFixed(2) + '%', width: ((100 * (s.to - s.from)) / span).toFixed(2) + '%' }}
            title={s.kind === 'hold' ? short(s.holder, 4) + ' · ' + hrs(s.to - s.from) : copy.coin.open}
          >
            {s.kind === 'hold' && s.to - s.from > span * 0.18 && <em>{who(s.holder!)}</em>}
          </span>
        ))}
        <i className="hbar-now" aria-hidden="true" />
      </div>
      {ticks && (
        <div className="hbar-ticks" aria-hidden="true">
          {Array.from({ length: Math.floor(span / 3600e3) + 1 }, (_, i) => i)
            .filter((i) => i % (span > 12 * 3600e3 ? 3 : 1) === 0)
            .map((i) => (
              <span key={i} style={{ left: ((100 * i * 3600e3) / span).toFixed(2) + '%' }}>
                {i === 0 ? copy.coin.now : '+' + i + 'h'}
              </span>
            ))}
        </div>
      )}
    </div>
  );
});
