// Phantom only: the provider Phantom injects as window.phantom.solana (the
// browser extension, and Phantom's own in-app browser on phones). No other wallet code ships. The store holds what
// the UI reads.
import { createStore } from '../state/store.ts';
import { getBalanceSol } from '../chain/rpc.ts';

interface Key {
  toBase58(): string;
}

/** What flipfee calls on Phantom's provider. */
export interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: Key | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: Key }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array }>;
  signIn?(input: SignInInput): Promise<{ address: Key; signedMessage: Uint8Array; signature: Uint8Array }>;
  /** Phantom signs and sends through its own RPC (the path Phantom asks dapps to use). */
  signAndSendTransaction?(tx: unknown, opts?: { skipPreflight?: boolean; preflightCommitment?: string; maxRetries?: number }): Promise<{ signature: string | Uint8Array; publicKey?: Key }>;
  signTransaction?<T>(tx: T): Promise<T>;
  request?(a: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: 'connect' | 'disconnect' | 'accountChanged', fn: (arg?: Key | null) => void): void;
}

/** Sign-In With Solana fields (the server sends them with its message). */
export interface SignInInput {
  domain?: string;
  address?: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  [k: string]: unknown;
}

interface WState {
  /** Phantom is in this browser. */
  present: boolean;
  account: string | null;
  connecting: boolean;
  /** SOL on the build's cluster */
  balance: number | null;
  /** Detection finished (Phantom injects at load; a short wait before saying it is missing). */
  ready: boolean;
}

export const wallet = createStore<WState>({ present: false, account: null, connecting: false, balance: null, ready: false });

const KEY = 'flipfee.phantom';
let started = false;

export function provider(): PhantomProvider | null {
  const p = (window as Window & { phantom?: { solana?: PhantomProvider } }).phantom?.solana;
  return p && p.isPhantom ? p : null;
}

export const hasPhantom = (): boolean => !!provider();

function setAccount(a: string | null): void {
  wallet.set({ account: a, connecting: false, balance: a && a === wallet.get().account ? wallet.get().balance : null });
  if (a) void refreshBalance();
}

function listen(p: PhantomProvider): void {
  p.on?.('accountChanged', (k) => {
    // Phantom sends null when the user switches to an account this site has not connected yet
    if (k) setAccount(k.toBase58());
    else void p.connect({ onlyIfTrusted: true }).then((r) => setAccount(r.publicKey.toBase58()), () => setAccount(null));
  });
  p.on?.('disconnect', () => setAccount(null));
}

export function startWallets(): void {
  if (started) return;
  started = true;
  let tries = 0;
  const find = () => {
    const p = provider();
    if (p) {
      wallet.set({ present: true, ready: true });
      listen(p);
      // a wallet that said yes before comes back without a prompt
      let trusted = false;
      try {
        trusted = localStorage.getItem(KEY) === '1';
      } catch {
        trusted = false;
      }
      if (trusted) {
        void p.connect({ onlyIfTrusted: true }).then(
          (r) => setAccount(r.publicKey.toBase58()),
          () => undefined,
        );
      }
      return;
    }
    if (++tries < 12) window.setTimeout(find, 100);
    else wallet.set({ ready: true });
  };
  find();
  window.setInterval(() => {
    if (wallet.get().account && document.visibilityState === 'visible') void refreshBalance();
  }, 20000);
}

export async function connect(): Promise<string> {
  const p = provider();
  if (!p) throw new Error('no phantom');
  wallet.set({ connecting: true });
  try {
    const r = await p.connect();
    const a = r.publicKey.toBase58();
    setAccount(a);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // storage is optional
    }
    return a;
  } finally {
    wallet.set({ connecting: false });
  }
}

export async function disconnect(): Promise<void> {
  setAccount(null);
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage is optional
  }
  try {
    await provider()?.disconnect();
  } catch {
    // Phantom may be gone already
  }
}

export async function refreshBalance(): Promise<void> {
  const a = wallet.get().account;
  if (!a) return;
  try {
    const b = await getBalanceSol(a);
    if (wallet.get().account === a) wallet.set({ balance: b });
  } catch {
    // the RPC may be slow: keep the last balance
  }
}

export const account = (): string | null => wallet.get().account;

export function canSignIn(): boolean {
  return typeof provider()?.signIn === 'function';
}

/** Signs raw bytes (the Sign-In With Solana text). */
export async function signMessage(message: Uint8Array): Promise<Uint8Array> {
  const p = provider();
  if (!p) throw new Error('no phantom');
  const { signature } = await p.signMessage(message, 'utf8');
  return signature;
}

/** Phantom's own sign-in screen: returns the exact message it signed and the signature. */
export async function signIn(input: SignInInput): Promise<{ message: Uint8Array; signature: Uint8Array; address: string }> {
  const p = provider();
  if (!p?.signIn) throw new Error('no sign-in');
  const out = await p.signIn(input);
  return { message: out.signedMessage, signature: out.signature, address: out.address.toBase58() };
}

/** A user said no in Phantom (4001, "User rejected the request"). */
export function isRejection(e: unknown): boolean {
  const x = e as { code?: number; message?: string; name?: string } | null;
  if (!x) return false;
  if (x.code === 4001) return true;
  return /reject|denied|declin|cancel|closed/i.test(String(x.message ?? '') + ' ' + String(x.name ?? ''));
}
