import { useEffect } from 'react';
import { copy } from '../copy.ts';
import { Wordmark } from '../flap/Wordmark.tsx';
import { linkProps, router } from '../lib/router.ts';
import { short } from '../lib/format.ts';
import { board } from '../state/board.ts';
import { PHONE, useMedia } from '../state/store.ts';
import { setMenu } from '../state/ui.ts';
import { connectWallet } from '../wallet/connectFlow.ts';
import { wallet } from '../wallet/wallet.ts';

export function WalletButton() {
  const account = wallet.use((s) => s.account);
  const connecting = wallet.use((s) => s.connecting);
  const balance = wallet.use((s) => s.balance);
  const phone = useMedia(PHONE);
  if (account) {
    return (
      <button type="button" className="wallet-pill" onClick={() => setMenu(true)} aria-label={copy.a11y.menu} data-testid="wallet-pill" data-address={account}>
        <i className="wp-dot" aria-hidden="true" />
        <span className="mono">{short(account, phone ? 3 : 4)}</span>
        {!phone && balance !== null && <span className="wp-bal mono">{balance.toFixed(2)}</span>}
      </button>
    );
  }
  return (
    <button type="button" className="btn btn-cash btn-sm btn-connect" onClick={() => void connectWallet()} disabled={connecting} data-testid="connect">
      {connecting && <span className="spin" aria-hidden="true" />}
      {phone ? copy.wallet.connectShort : copy.wallet.connect}
    </button>
  );
}

/** 0 at the top of the page … 1 after 140 px of scroll: drives the floating header's shrink (a CSS variable). */
function useShrink(): void {
  useEffect(() => {
    let raf = 0;
    const set = () => {
      raf = 0;
      const k = Math.max(0, Math.min(1, window.scrollY / 140));
      document.documentElement.style.setProperty('--hdr', k.toFixed(3));
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(set);
    };
    set();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
}

export function TopBar() {
  useShrink();
  const route = router.use((s) => s.route);
  const conn = board.use((s) => s.conn);
  const nav: [string, string, boolean][] = [
    ['/', copy.nav.board, route.name === 'board' || route.name === 'coin'],
    ['/market', copy.nav.market, route.name === 'market'],
    ['/dev', copy.nav.dev, route.name === 'dev'],
    ['/me', copy.nav.me, route.name === 'me'],
    ['/docs', copy.nav.docs, route.name === 'docs'],
  ];
  return (
    <header className="top" data-testid="top" data-conn={conn}>
      <div className="top-in">
        <a className="top-brand" aria-label={copy.nav.home} {...linkProps('/')}>
          <Wordmark />
        </a>
        <nav className="top-nav" aria-label={copy.nav.label}>
          {nav.map(([p, label, on]) => (
            <a key={p} className={'top-link' + (on ? ' is-on' : '')} aria-current={on ? 'page' : undefined} {...linkProps(p)}>
              {label}
            </a>
          ))}
        </nav>
        <div className="top-right">
          <a className="icon-btn top-x" href="https://x.com/flipfeecash" target="_blank" rel="noopener noreferrer" aria-label="flipfee on X" title="flipfee on X">
            <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
            </svg>
          </a>
          <a className="icon-btn top-x" href="https://github.com/flipfee-cash/flipfee" target="_blank" rel="noopener noreferrer" aria-label={copy.foot.github} title={copy.foot.github}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
            </svg>
          </a>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
