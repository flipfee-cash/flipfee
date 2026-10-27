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

function LiveDot() {
  const conn = board.use((s) => s.conn);
  const cached = board.use((s) => s.cached);
  const label = cached ? copy.conn.cached : copy.conn[conn];
  return (
    <span className={'live-dot is-' + conn} data-testid="conn" data-conn={conn} title={label}>
      <i aria-hidden="true" />
    </span>
  );
}

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
  const nav: [string, string, boolean][] = [
    ['/', copy.nav.board, route.name === 'board' || route.name === 'coin'],
    ['/dev', copy.nav.dev, route.name === 'dev'],
    ['/me', copy.nav.me, route.name === 'me'],
    ['/docs', copy.nav.docs, route.name === 'docs'],
  ];
  return (
    <header className="top" data-testid="top">
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
          <LiveDot />
          <a className="icon-btn top-x" href="https://x.com/flipfeecash" target="_blank" rel="noopener noreferrer" aria-label="flipfee on X" title="flipfee on X">
            <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
            </svg>
          </a>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
