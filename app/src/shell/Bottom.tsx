import { Wordmark } from '../flap/Wordmark.tsx';
import { copy } from '../copy.ts';
import { linkProps } from '../lib/router.ts';
import { Tpl } from '../lib/tpl.tsx';
import { focusFirstLive, focusHot } from '../board/Board.tsx';
import { board } from '../state/board.ts';

/** Phone: the two actions stay under the thumb (DESIGN.md §1.6); "Buy an hour" only while a coin is live. */
export function BottomBar() {
  const hasLive = board.use((s) => s.live.length > 0);
  return (
    <nav className="bbar" aria-label={copy.nav.label} data-testid="bottom-bar">
      {hasLive ? (
        <button type="button" className="btn btn-cash" onClick={focusFirstLive} data-testid="bar-buy">
          {copy.bar.buy}
        </button>
      ) : (
        <button type="button" className="btn btn-cash" onClick={focusHot} data-testid="bar-hot">
          {copy.live.emptyHot}
        </button>
      )}
      <a className="btn btn-line" data-testid="bar-flip" {...linkProps('/dev')}>
        {copy.live.emptyCta}
      </a>
    </nav>
  );
}

const PROGRAM = 'D6sPTL4KkP6bc1QpC33h8f5MKEALJtRmB89f8H4CbpjW';

export function Footer() {
  const cols: [string, [string, string, boolean][]][] = [
    [copy.foot.product, [['/', copy.nav.board, false], ['/dev', copy.nav.dev, false], ['/me', copy.nav.me, false], ['/docs', copy.nav.docs, false]]],
    [copy.foot.legal, [['/terms', copy.legal.terms, false], ['/privacy', copy.legal.privacy, false]]],
    [copy.foot.links, [['https://x.com/flipfeecash', 'X @flipfeecash', true], ['https://pump.fun', copy.pf, true], ['https://solscan.io/account/' + PROGRAM, copy.foot.solscan, true], ['https://phantom.app', 'Phantom', true]]],
  ];
  return (
    <footer className="foot">
      <div className="foot-in">
        <div className="foot-brand">
          <Wordmark size="sm" />
          <p className="foot-line">{copy.footer.line}</p>
          <p className="dim">
            <Tpl s={copy.footer.sub} v={{}} /> {copy.footer.built}
          </p>
        </div>
        <nav className="foot-cols" aria-label={copy.nav.label}>
          {cols.map(([h, links]) => (
            <div key={h} className="foot-col">
              <span className="lbl">{h}</span>
              {links.map(([href, label, ext]) =>
                ext ? (
                  <a key={href} href={href} target="_blank" rel="noopener noreferrer">
                    {label} ↗
                  </a>
                ) : (
                  <a key={href} {...linkProps(href)}>
                    {label}
                  </a>
                ),
              )}
            </div>
          ))}
        </nav>
      </div>
    </footer>
  );
}
