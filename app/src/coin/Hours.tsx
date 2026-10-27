// The hour timeline (DESIGN.md §1.6): a strip from 6 hours ago to 24 hours ahead (past hours greyed with what they
// paid, the live hour filling, sold hours with the holder, open hours with the price), and below it a departures board:
// one line per stretch, its time in flip tiles.
import { memo } from 'react';
import { copy, fill } from '../copy.ts';
import type { Coin, Timeline } from '../api/types.ts';
import { Flap } from '../flap/Flap.tsx';
import { Countdown, useNow } from '../lib/clock.tsx';
import { hhmm, hrs, short, solFlap, solPlain } from '../lib/format.ts';
import { Tpl } from '../lib/tpl.tsx';
import { currentWindow, hoursOpen, nextStart } from '../state/board.ts';
import { openSheet } from '../state/ui.ts';

const H = 3600e3;

/** "+1d" when a stretch ends on a later day than it starts. */
function dayMark(a: number, b: number): string {
  const da = new Date(a);
  const db = new Date(b);
  const days = Math.round((Date.UTC(db.getFullYear(), db.getMonth(), db.getDate()) - Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())) / 86400e3);
  return days > 0 ? ' +' + days + 'd' : '';
}
const BACK = 6 * H;
const AHEAD = 24 * H;

interface Dep {
  key: string;
  start: number;
  end: number;
  kind: 'holder' | 'dev' | 'open';
  state: 'past' | 'live' | 'sold' | 'open';
  holder?: string;
  sol?: number;
}

function departures(c: Coin, tl: Timeline | null, now: number): Dep[] {
  const f = c.ff!;
  const out: Dep[] = [];
  // past: the server's stretches (exact fees per stretch), else ended windows
  const past = tl ? tl.segments.filter((s) => s.state === 'past' && s.end <= now) : [];
  if (past.length) {
    for (const s of past.slice(-4)) out.push({ key: 'p' + s.start, start: s.start, end: s.end, kind: s.kind === 'holder' ? 'holder' : 'dev', state: 'past', holder: s.holder, sol: s.kind === 'holder' ? (s.earned ?? s.fees ?? 0) : (s.fees ?? 0) });
  } else {
    for (const w of [...f.past].sort((a, b) => a.start - b.start).slice(-4)) out.push({ key: 'p' + w.start, start: w.start, end: w.end, kind: 'holder', state: 'past', holder: w.holder, sol: w.earned });
  }
  const live = currentWindow(c, now);
  if (live) out.push({ key: 'l' + live.start, start: live.start, end: live.end, kind: 'holder', state: 'live', holder: live.holder, sol: c.thisHour?.sol ?? live.earned });
  else out.push({ key: 'ld', start: c.thisHour?.since ?? now, end: f.windows.find((w) => w.start > now)?.start ?? 0, kind: 'dev', state: 'live', sol: c.thisHour?.sol ?? 0 });
  for (const w of f.windows) if (w.start > now) out.push({ key: 's' + w.start, start: w.start, end: w.end, kind: 'holder', state: 'sold', holder: w.holder });
  const open = nextStart(c, now);
  const until = now + f.maxAhead * 1000;
  if (until - open >= H - 1000) out.push({ key: 'o', start: open, end: until, kind: 'open', state: 'open' });
  return out;
}

export const Hours = memo(function Hours({ coin, me, timeline }: { coin: Coin; me: string | null; timeline: Timeline | null }) {
  const now = useNow(5000);
  const f = coin.ff!;
  const deps = departures(coin, timeline, now);
  const from = now - BACK;
  const span = BACK + AHEAD;
  const x = (t: number) => Math.max(0, Math.min(100, ((t - from) / span) * 100));
  const who = (a?: string) => (a && me && a === me ? copy.counter.you : short(a, 4));
  const open = hoursOpen(coin, now);
  // past clock hours: what each paid (the coin's hourly fees)
  const bars = coin.hourly.filter(([t]) => t + H > from && t < now);
  const maxBar = Math.max(1e-9, ...bars.map((b) => b[1]));
  const ticks: number[] = [];
  for (let t = Math.ceil(from / (3 * H)) * 3 * H; t < from + span; t += 3 * H) ticks.push(t);

  return (
    <section className="panel hours" data-testid="hours">
      <header className="panel-h">
        <h2>{copy.coin.hours}</h2>
        <p className="dim">{copy.coin.hoursSub}</p>
      </header>

      <div className="strip" aria-hidden="true">
        {bars.map(([t, v]) => (
          <span key={'b' + t} className="st-bar" style={{ left: x(t) + '%', width: x(t + H) - x(t) + '%' }}>
            <i style={{ height: Math.max(3, (v / maxBar) * 100) + '%' }} />
          </span>
        ))}
        {f.windows.map((w) => (
          <span key={'w' + w.start} className={'st-win' + (w.start <= now ? ' is-live' : '') + (me && w.holder === me ? ' is-me' : '')} style={{ left: x(Math.max(w.start, from)) + '%', width: x(w.end) - x(Math.max(w.start, from)) + '%' }}>
            {x(w.end) - x(Math.max(w.start, now)) > 7 && <em>{who(w.holder)}</em>}
          </span>
        ))}
        {(() => {
          const s = nextStart(coin, now);
          const e = now + f.maxAhead * 1000;
          return e > s ? <span className="st-open" style={{ left: x(s) + '%', width: x(e) - x(s) + '%' }} /> : null;
        })()}
        <span className="st-now" style={{ left: x(now) + '%' }}>
          <b>{copy.coin.now}</b>
        </span>
        <div className="st-ticks">
          {ticks.map((t) => (
            <span key={t} style={{ left: x(t) + '%' }}>
              {hhmm(t)}
            </span>
          ))}
        </div>
      </div>

      <ol className="deps" data-testid="departures">
        {deps.map((d) => (
          <li key={d.key} className={'dep dep-' + d.state + (d.holder && me && d.holder === me ? ' is-me' : '')} data-state={d.state}>
            <span className="dep-time">
              <Flap text={hhmm(d.start)} size="xs" tone={d.state === 'live' ? 'cash' : d.state === 'past' ? 'dim' : 'ink'} />
              <span className="dep-to">{d.end ? '→ ' + hhmm(d.end) + dayMark(d.start, d.end) : '→'}</span>
            </span>
            <span className="dep-who">
              {d.kind === 'holder' ? <b className="mono">{who(d.holder)}</b> : d.kind === 'dev' ? <b>{copy.coin.toDev}</b> : <b className="dep-open">{copy.coin.open}</b>}
              {d.state === 'sold' && <span className="dim">{hrs(d.end - d.start)}</span>}
            </span>
            <span className="dep-state lbl">{copy.coin[d.state === 'past' ? 'past' : d.state === 'live' ? 'live' : d.state === 'sold' ? 'sold' : 'open']}</span>
            <span className="dep-sol">
              {d.state === 'past' && <span className="mono dim">{fill(copy.coin.paid, { sol: solFlap(d.sol ?? 0, 4) })}</span>}
              {d.state === 'live' && (
                <span className="mono up">
                  <Tpl s={copy.coin.earned} v={{ sol: solFlap(d.sol ?? 0, 4) }} />
                  {d.end > 0 && (
                    <span className="dim">
                      {' · '}
                      <Countdown t={d.end} />
                    </span>
                  )}
                </span>
              )}
              {d.state === 'sold' && <span className="mono dim">{hhmm(d.start)}</span>}
              {d.state === 'open' && (
                <span className="dep-buy">
                  <span className="mono">{fill(copy.coin.perHour, { sol: solPlain(f.price) })}</span>
                  {!f.paused && open > 0 && !(me && me === f.owner) && (
                    <button type="button" className="btn btn-cash btn-sm" onClick={() => openSheet({ kind: 'buy', mint: coin.mint, hours: 1, go: false })} data-testid="dep-buy">
                      {fill(copy.live.buy1, { sol: solPlain(f.price) })}
                    </button>
                  )}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
});
