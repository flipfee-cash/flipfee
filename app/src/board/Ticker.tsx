// The top ticker (DESIGN.md §1.6): five exact numbers in flip tiles. Each label says what the number covers.
import { memo } from 'react';
import { copy } from '../copy.ts';
import { Flap } from '../flap/Flap.tsx';
import { board } from '../state/board.ts';
import { solFlap } from '../lib/format.ts';

/** Decimals by size, so small totals still show (0.0004) and big ones stay short (312.4). */
const dp = (x: number) => (x >= 100 ? 1 : x >= 1 ? 2 : 4);

function Cell({ label, text, unit, pad, tone = 'ink', testid, stat }: { label: string; text: string; unit?: string; pad: number; tone?: 'ink' | 'cash'; testid: string; stat: string }) {
  return (
    <div className="tk-cell" data-stat={stat}>
      <span className="lbl tk-l">{label}</span>
      <span className="tk-v">
        <Flap text={text} size="md" pad={pad} tone={tone} intro testid={testid} label={label + ': ' + text + (unit ? ' ' + unit : '')} />
        {unit && <span className="tk-u">{unit}</span>}
      </span>
    </div>
  );
}

export const Ticker = memo(function Ticker() {
  const s = board.use((x) => x.stats);
  // flipfee's own numbers only (market totals and the SOL price help no decision); nothing until one is above zero
  if (!s || !(s.hoursSoldToday > 0 || s.paidBuyersToday > 0 || s.paidDevsToday > 0)) return null;
  return (
    <section className="ticker" aria-label={copy.ticker.label} data-testid="ticker">
      {/* the "today" numbers show once they are above zero: a row of zeros reads as a dead board */}
      {s.hoursSoldToday > 0 && <Cell stat="hoursToday" label={copy.ticker.hoursToday} text={String(Math.round(s.hoursSoldToday))} pad={3} testid="tk-hours" />}
      {s.paidBuyersToday > 0 && <Cell stat="buyersToday" label={copy.ticker.buyersToday} text={solFlap(s.paidBuyersToday, dp(s.paidBuyersToday))} unit={copy.ticker.sol} pad={5} tone="cash" testid="tk-buyers" />}
      {s.paidDevsToday > 0 && <Cell stat="devsToday" label={copy.ticker.devsToday} text={solFlap(s.paidDevsToday, dp(s.paidDevsToday))} unit={copy.ticker.sol} pad={5} tone="cash" testid="tk-devs" />}
    </section>
  );
});
