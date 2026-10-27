// Home = the board (DESIGN.md §1.6): the ticker, the two lines with their buttons and the live cash counter, then Live
// coins and Hot on pump.fun. Phone: ticker, counter, tabs Live · Hot, and a sticky bottom bar.
import { useState } from 'react';
import { copy, fill } from '../copy.ts';
import { board } from '../state/board.ts';
import { PHONE, WIDE, shallow, useMedia } from '../state/store.ts';
import { setTab, ui } from '../state/ui.ts';
import { wallet } from '../wallet/wallet.ts';
import { Ticker } from './Ticker.tsx';
import { FlowHero } from './FlowHero.tsx';
import { SectionTitle } from './SectionTitle.tsx';
import { MostWanted } from './MostWanted.tsx';
import { LiveRow } from './LiveRow.tsx';
import { HotRow } from './HotRow.tsx';

/** The hot coins section, opened and scrolled into view (the trader's next step while no coin is live). */
export function focusHot(): void {
  setTab('hot');
  window.requestAnimationFrame(() =>
    document.getElementById('hot')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }),
  );
}

/** "Buy an hour": the first live coin's Buy button (or the empty board's call to action). */
export function focusFirstLive(): void {
  setTab('live');
  window.requestAnimationFrame(() => {
    const row = document.getElementById('first-live') ?? document.getElementById('live');
    row?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    const btn = row?.querySelector<HTMLElement>('[data-testid=buy-1h]') ?? row?.querySelector<HTMLElement>('a,button');
    btn?.focus({ preventScroll: true });
    row?.classList.add('is-flash');
    window.setTimeout(() => row?.classList.remove('is-flash'), 1400);
  });
}


function SkelRows({ n }: { n: number }) {
  return (
    <div className="rows-skel" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="sk sk-row" />
      ))}
    </div>
  );
}

function LiveBoard({ me }: { me: string | null }) {
  const live = board.use((s) => s.live, shallow);
  const ready = board.use((s) => s.ready);
  const failed = board.use((s) => s.failed);
  return (
    <section className="bsec" id="live" aria-labelledby="live-h" data-testid="live-board" data-count={live.length}>
      <header className="bsec-h">
        <SectionTitle id="live-h" text={live.length || !ready ? copy.sections.live : copy.sections.wanted} />
      </header>
      {live.length > 0 && (
        <div className="lrow lrow-head" aria-hidden="true">
          <span>{copy.live.colCoin}</span>
          <span>{copy.live.colLast}</span>
          <span>{copy.live.colNow}</span>
          <span>{copy.live.colTrades}</span>
          <span>{copy.live.colHour}</span>
          <span>{copy.live.colPrice}</span>
          <span />
        </div>
      )}
      {failed && <ServerDown />}
      {!ready ? <SkelRows n={3} /> : live.length ? live.map((m, i) => <LiveRow key={m} mint={m} me={me} first={i === 0} />) : failed ? null : <MostWanted />}
    </section>
  );
}

function ServerDown() {
  return (
    <div className="live-empty is-down" data-testid="board-down">
      <div className="le-txt">
        <h3>{copy.err.server}</h3>
      </div>
    </div>
  );
}

function HotBoard({ me }: { me: string | null }) {
  // a coin whose fee split is already taken can never join: it has no action here, so it stays off the list
  const hot = board.use((s) => s.hot.filter((m) => s.coins[m]?.canJoin !== false), shallow);
  const ready = board.use((s) => s.ready);
  const [all, setAll] = useState(false);
  const list = all ? hot : hot.slice(0, 12);
  return (
    <section className="bsec bsec-hot" id="hot" aria-labelledby="hot-h" data-testid="hot-board" data-count={hot.length}>
      <header className="bsec-h">
        <SectionTitle id="hot-h" text={copy.sections.hot} />
      </header>
      {hot.length > 0 && (
        <div className="hrow hrow-head" aria-hidden="true">
          <span>{copy.live.colCoin}</span>
          <span>{copy.hot.colFees}</span>
          <span>{copy.hot.colTrades}</span>
          <span>{copy.live.colTrades}</span>
          <span />
        </div>
      )}
      {!ready ? <SkelRows n={5} /> : hot.length ? list.map((m) => <HotRow key={m} mint={m} me={me} />) : <p className="bsec-empty">{copy.hot.empty}</p>}
      {!all && hot.length > list.length && (
        <button type="button" className="btn btn-line show-more" onClick={() => setAll(true)}>
          {copy.hot.more}
        </button>
      )}
    </section>
  );
}

function Tabs() {
  const tab = ui.use((s) => s.tab);
  return (
    <div className="tabs" role="tablist" aria-label={copy.tabs.label}>
      {(['live', 'hot'] as const).map((t) => (
        <button key={t} type="button" role="tab" aria-selected={tab === t} className={'tab' + (tab === t ? ' is-on' : '')} onClick={() => setTab(t)} data-tab={t}>
          {copy.tabs[t]}
        </button>
      ))}
    </div>
  );
}

export function Board() {
  const me = wallet.use((s) => s.account);
  const phone = useMedia(PHONE);
  const wide = useMedia(WIDE);
  const tab = ui.use((s) => s.tab);
  // no live coin yet: one page that leads with Hot coins and the dev call (tabs come with the first live coin)
  const tabs = board.use((s) => s.ready && s.live.length > 0);
  return (
    <div className={'board' + (wide ? ' is-wide' : '')} data-testid="board">
      <Ticker />
      <FlowHero />
      {phone && tabs && <Tabs />}
      {(!phone || !tabs || tab === 'live') && <LiveBoard me={me} />}
      {(!phone || !tabs || tab === 'hot') && <HotBoard me={me} />}
    </div>
  );
}

export const boardTitle = (n: number) => fill(copy.title, { n });
