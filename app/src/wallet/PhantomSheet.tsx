import { copy } from '../copy.ts';
import { setPhantomSheet, ui } from '../state/ui.ts';
import { Sheet } from '../shell/Sheet.tsx';
import { IconExternal, PhantomGlyph } from '../shell/Icons.tsx';
import { PHANTOM_GET, isPhoneDevice, phantomBrowseLink } from './deeplink.ts';

/** Shown only when Phantom is not in this browser: open flipfee in Phantom (phone) or get the extension (desktop). */
export function PhantomSheet() {
  const open = ui.use((s) => s.phantom);
  const phone = isPhoneDevice();
  return (
    <Sheet open={open} onClose={() => setPhantomSheet(false)} label={phone ? copy.wallet.titlePhone : copy.wallet.title} testid="connect-sheet" size="sm">
      <header className="sheet-h">
        <PhantomGlyph size={44} />
        <div>
          <h2>{phone ? copy.wallet.titlePhone : copy.wallet.title}</h2>
          <p className="dim">{copy.wallet.sub}</p>
        </div>
      </header>
      <p className="sheet-note">{phone ? copy.wallet.phoneHint : copy.wallet.desktopHint}</p>
      <a className="btn btn-ink btn-lg btn-block btn-phantom" href={phone ? phantomBrowseLink() : PHANTOM_GET} target={phone ? '_self' : '_blank'} rel="noopener noreferrer" data-testid="phantom-link">
        <PhantomGlyph size={22} />
        {phone ? copy.wallet.openIn : copy.wallet.get}
        <IconExternal size={16} />
      </a>
    </Sheet>
  );
}
