import { useEffect } from 'react';
import { copy } from '../copy.ts';
import { leaveTo, setMenu, toast, ui } from '../state/ui.ts';
import { short, solBal } from '../lib/format.ts';
import { go } from '../lib/router.ts';
import { sound, soundState } from '../lib/sound.ts';
import { writeClipboard } from '../lib/clipboard.ts';
import { chain } from '../chain/config.ts';
import { IconCheck, IconClose, IconCopy, IconSound, IconSoundOff, PhantomGlyph } from '../shell/Icons.tsx';
import { disconnect, isRejection, refreshBalance, wallet } from './wallet.ts';
import { ensureSession, session, signOut } from './session.ts';

/** The wallet menu: address, SOL balance, Sign-In With Solana, my pages, sound, disconnect. */
export function WalletMenu() {
  const open = ui.use((s) => s.menu);
  const account = wallet.use((s) => s.account);
  const balance = wallet.use((s) => s.balance);
  const sess = session.use((s) => s.s);
  const busy = session.use((s) => s.busy);
  const soundOn = soundState.use((s) => s.on);
  const net = chain.use((s) => s.cluster);

  useEffect(() => {
    if (!open) return;
    void refreshBalance();
    const on = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open]);

  if (!open || !account) return null;
  const signed = !!sess && sess.address === account && sess.exp > Date.now();
  const goTo = (p: string) => leaveTo(p, go);
  return (
    <div className="menu-scrim" onClick={() => setMenu(false)}>
      <div className="menu" role="dialog" aria-label={copy.wallet.you} data-testid="wallet-menu" onClick={(e) => e.stopPropagation()}>
        <header className="menu-h">
          <h2 className="lbl">{copy.wallet.you}</h2>
          <button type="button" className="icon-btn" aria-label={copy.a11y.close} onClick={() => setMenu(false)}>
            <IconClose size={18} />
          </button>
        </header>
        <button
          type="button"
          className="menu-addr"
          onClick={() => void writeClipboard(account).then((ok) => ok && toast({ kind: 'ok', title: copy.wallet.copied }, 1500))}
          aria-label={copy.wallet.copy}
          data-testid="menu-address"
        >
          <PhantomGlyph size={28} />
          <span className="mono">{short(account, 6)}</span>
          <IconCopy size={16} />
        </button>
        <div className="menu-bal">
          <span className="lbl">{copy.wallet.balance}</span>
          <b className="mono" data-testid="menu-balance">
            {balance === null ? '—' : solBal(balance)} <i>{copy.ticker.sol}</i>
          </b>
          {net !== 'mainnet-beta' && <span className="net-tag">{copy.wallet.nets[net] ?? net}</span>}
        </div>
        <div className="menu-row">
          <span className="lbl">{copy.wallet.signIn}</span>
          {signed ? (
            <>
              <b className="ok-t" data-testid="signed-in">
                <IconCheck size={14} />
                {copy.wallet.signedIn}
              </b>
              <button type="button" className="btn btn-line btn-sm" onClick={signOut}>
                {copy.wallet.signOut}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-ink btn-sm"
              data-testid="sign-in"
              disabled={busy}
              onClick={() =>
                void ensureSession().then(
                  () => toast({ kind: 'ok', title: copy.toast.signedIn }, 1800),
                  (e) => toast({ kind: 'warn', title: isRejection(e) ? copy.err.rejected : copy.err.wallet }),
                )
              }
            >
              {busy && <span className="spin" aria-hidden="true" />}
              {copy.wallet.signIn}
            </button>
          )}
        </div>
        {!signed && <p className="menu-note">{copy.wallet.signWhy}</p>}
        <div className="menu-list">
          <button type="button" className="menu-item" onClick={() => goTo('/me')}>
            <span>{copy.wallet.myHours}</span>
          </button>
          <button type="button" className="menu-item" onClick={() => goTo('/dev')}>
            <span>{copy.wallet.myCoins}</span>
          </button>
          <button type="button" className="menu-item" aria-pressed={soundOn} onClick={() => sound.set(!soundOn)} data-testid="menu-sound">
            {soundOn ? <IconSound size={18} /> : <IconSoundOff size={18} />}
            <span>{copy.wallet.sound}</span>
            <span className="menu-state">{soundOn ? copy.wallet.on : copy.wallet.off}</span>
          </button>
          <button
            type="button"
            className="menu-item"
            data-testid="disconnect"
            onClick={() => {
              void disconnect();
              setMenu(false);
              toast({ kind: 'ok', title: copy.toast.disconnected }, 1600);
            }}
          >
            <IconClose size={18} />
            <span>{copy.wallet.disconnect}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
