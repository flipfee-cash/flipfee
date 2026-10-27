// Want (free, one per wallet per coin, needs a sign-in) and Share (copies flipfee.cash/c/<mint> for the dev).
import { copy, fill } from '../copy.ts';
import type { Coin } from '../api/types.ts';
import { ApiError, post } from '../api/http.ts';
import { board } from '../state/board.ts';
import { createStore } from '../state/store.ts';
import { toast } from '../state/ui.ts';
import { writeClipboard } from '../lib/clipboard.ts';
import { shareUrl } from '../lib/router.ts';
import { tick } from '../lib/format.ts';
import { connectWallet } from '../wallet/connectFlow.ts';
import { ensureSession } from '../wallet/session.ts';
import { isRejection, wallet } from '../wallet/wallet.ts';
import { sound } from '../lib/sound.ts';

const KEY = 'flipfee.wants.';

function load(a: string | null): string[] {
  if (!a) return [];
  try {
    const j = JSON.parse(localStorage.getItem(KEY + a) || '[]');
    return Array.isArray(j) ? j.filter((x) => typeof x === 'string').slice(-500) : [];
  } catch {
    return [];
  }
}

/** The coins this wallet wants (kept per wallet in this browser; the server counts them). */
export const wants = createStore<{ mine: string[] }>({ mine: load(wallet.get().account) });
wallet.subscribe(() => {
  const a = wallet.get().account;
  wants.set({ mine: load(a) });
});

function remember(mint: string): void {
  const a = wallet.get().account;
  if (!a) return;
  const mine = [...new Set([...wants.get().mine, mint])];
  wants.set({ mine });
  try {
    localStorage.setItem(KEY + a, JSON.stringify(mine));
  } catch {
    // storage is optional
  }
}

export async function wantCoin(c: Coin): Promise<void> {
  if (wants.get().mine.includes(c.mint)) return;
  const a = await connectWallet();
  if (!a) return;
  try {
    await ensureSession();
  } catch (e) {
    toast({ kind: 'warn', title: isRejection(e) ? copy.err.rejected : copy.err.signIn });
    return;
  }
  sound.tap();
  try {
    const r = await post<{ count?: number; wants?: number }>('/want', { mint: c.mint }, { auth: 'need' });
    const n = Number(r?.count ?? r?.wants);
    remember(c.mint);
    const cur = board.get().coins[c.mint];
    const count = Number.isFinite(n) && n > 0 ? n : (cur?.wants ?? c.wants) + 1;
    if (cur) board.set((s) => ({ coins: { ...s.coins, [c.mint]: { ...s.coins[c.mint], wants: Math.max(count, s.coins[c.mint].wants) } } }));
    toast({ kind: 'ok', title: fill(copy.toast.wanted, { ticker: tick(c.symbol) }), detail: fill(count === 1 ? copy.toast.wantedSub1 : copy.toast.wantedSub, { n: count }) });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      remember(c.mint);
      return;
    }
    toast({ kind: 'warn', title: e instanceof ApiError && e.status === 401 ? copy.err.signIn : e instanceof ApiError && e.status === 0 ? copy.err.network : copy.err.server });
  }
}

export async function shareCoin(c: Coin): Promise<void> {
  const url = shareUrl(c.mint);
  const nav = navigator as Navigator & { share?: (d: { url: string; title?: string }) => Promise<void>; canShare?: (d: { url: string }) => boolean };
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (coarse && nav.share && (!nav.canShare || nav.canShare({ url }))) {
    try {
      await nav.share({ url, title: tick(c.symbol) + ' · ' + copy.brand });
      return;
    } catch {
      // closed the share sheet: copy instead
    }
  }
  const ok = await writeClipboard(url);
  if (ok) toast({ kind: 'ok', title: copy.toast.linkCopied, detail: fill(copy.toast.linkSub, { ticker: tick(c.symbol) }) }, 2600);
}
