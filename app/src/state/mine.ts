// Cash that lands in the connected wallet, anywhere in the app: a payout from an hour you hold or from your coin's
// open time, or a sale of your coin's hours. The register "ka-ching" (when sound is on) and a green toast.
import { copy, fill } from '../copy.ts';
import { board, onCash } from './board.ts';
import { toast } from './ui.ts';
import { wallet } from '../wallet/wallet.ts';
import { sound } from '../lib/sound.ts';
import { solFlap, tick } from '../lib/format.ts';

let started = false;

export function startMine(): void {
  if (started) return;
  started = true;
  onCash((e) => {
    const me = wallet.get().account;
    if (!me || e.to !== me) return;
    const c = board.get().coins[e.mint];
    const ticker = c ? tick(c.symbol) : '';
    if (e.kind === 'paid') {
      sound.kaching();
      toast({ kind: 'cash', title: fill(copy.toast.landed, { sol: solFlap(e.amount, 4) }), detail: fill(copy.toast.landedSub, { ticker }) }, 3200);
    } else if (e.kind === 'sale') {
      sound.kaching();
      toast({ kind: 'cash', title: fill(copy.toast.sale, { sol: solFlap(e.amount * 0.95, 3), h: e.hours ?? 1 }), detail: fill(copy.toast.saleSub, { ticker }) }, 3600);
    }
  });
}
