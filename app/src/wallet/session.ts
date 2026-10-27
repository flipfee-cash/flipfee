// Sign-In With Solana (copied from peek-sol): POST /api/auth/nonce → the wallet signs the server's message → POST /api/auth/verify → a bearer
// token for 24 h. One signature a day per wallet; the token lives in localStorage under the wallet address.
import { createStore } from '../state/store.ts';
import { ApiError, post, setAuth } from '../api/http.ts';
import { account, canSignIn, isRejection, signIn, signMessage, wallet } from './wallet.ts';
import type { SignInInput } from './wallet.ts';
import { b58encode } from '../lib/base58.ts';
import { bytesToB64 } from '../lib/bytes.ts';

interface Session {
  address: string;
  token: string;
  exp: number;
}

const KEY = 'flipfee.session';

function load(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null') as Session | null;
    return s && typeof s.token === 'string' && s.exp > Date.now() + 60000 ? s : null;
  } catch {
    return null;
  }
}

export const session = createStore<{ s: Session | null; busy: boolean }>({ s: load(), busy: false });

function save(s: Session | null): void {
  session.set({ s });
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // storage is optional
  }
}

/** The token, only when it belongs to the connected wallet. */
export function token(): string | null {
  const s = session.get().s;
  const a = account();
  if (!s || !a || s.address !== a || s.exp < Date.now() + 30000) return null;
  return s.token;
}

export const signedIn = (): boolean => !!token();

export function signOut(): void {
  save(null);
}

setAuth(token, () => save(null));

// a different wallet: its own session (or none)
wallet.subscribe(() => {
  const s = session.get().s;
  const a = wallet.get().account;
  if (s && a && s.address !== a) save(null);
});

interface NonceRes {
  nonce?: string;
  message?: string;
  /** The same fields as a Wallet Standard SolanaSignInInput (for wallets with their own sign-in screen). */
  input?: SignInInput;
  [k: string]: unknown;
}

interface VerifyRes {
  token?: string;
  expiresAt?: number;
  exp?: number;
  [k: string]: unknown;
}

let inflight: Promise<string> | null = null;

/** Signs in (one wallet signature) unless a session is already there. Resolves to the token. */
export function ensureSession(): Promise<string> {
  const t = token();
  if (t) return Promise.resolve(t);
  if (inflight) return inflight;
  inflight = (async () => {
    const address = account();
    if (!address) throw new ApiError(401, 'wallet', 'connect a wallet');
    session.set({ busy: true });
    try {
      const n = await post<NonceRes>('/auth/nonce', { address });
      if (!n || typeof n.message !== 'string' || !n.message) throw new ApiError(500, 'server', 'no message');
      let v: VerifyRes | null = null;
      // the wallet's own sign-in screen when it has one (Phantom, Solflare, Backpack): it signs the same SIWS text
      if (canSignIn() && n.input && n.input.address === address) {
        try {
          const out = await signIn(n.input);
          v = await post<VerifyRes>('/auth/verify', { address, signedMessage: bytesToB64(out.message), signature: b58encode(out.signature) });
        } catch (e) {
          if (isRejection(e)) throw e;
          v = null; // a wallet that words the message its own way: sign the server's text instead
        }
      }
      if (!v) {
        const fresh = v === null && canSignIn() ? await post<NonceRes>('/auth/nonce', { address }) : n;
        const sig = await signMessage(new TextEncoder().encode(fresh.message!));
        v = await post<VerifyRes>('/auth/verify', { address, nonce: fresh.nonce, message: fresh.message, signature: b58encode(sig) });
      }
      if (!v || typeof v.token !== 'string') throw new ApiError(500, 'server', 'no token');
      const exp = Number(v.expiresAt ?? v.exp) || Date.now() + 23.5 * 3600e3;
      save({ address, token: v.token, exp: exp < 1e12 ? exp * 1000 : exp });
      return v.token;
    } finally {
      session.set({ busy: false });
      inflight = null;
    }
  })();
  return inflight;
}
