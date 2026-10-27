// One tap (copied from peek-sol): with Phantom in the browser, Connect asks Phantom right away; without it, a sheet
// offers the one way in (Phantom's app on a phone, the extension on a desktop).
import { copy } from '../copy.ts';
import { setPhantomSheet, toast } from '../state/ui.ts';
import { connect, errText, hasPhantom, isRejection, wallet } from './wallet.ts';

export async function connectWallet(): Promise<string | null> {
  const a = wallet.get().account;
  if (a) return a;
  if (!hasPhantom()) {
    setPhantomSheet(true);
    return null;
  }
  try {
    const addr = await connect();
    toast({ kind: 'ok', title: copy.toast.connected }, 1800);
    return addr;
  } catch (e) {
    if (!isRejection(e)) console.warn('[flipfee] connect', errText(e));
    toast({ kind: 'warn', title: isRejection(e) ? copy.err.rejected : copy.err.wallet }, 6000);
    return null;
  }
}
