// Phantom only (owner, 2026-10-06; copied from peek-sol): the provider Phantom injects as window.phantom.solana (the
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
/** The silent reconnect at load (a site Phantom trusts); Connect waits for it instead of racing it. */
let trustedP: Promise<unknown> = Promise.resolve();

export function provider(): PhantomProvider | null {
  const p = (window as Window & { phantom?: { solana?: PhantomProvider } }).phantom?.solana;
  return p && p.isPhantom ? p : null;
}

// ── Phantom's -32603 "Unexpected error" (owner, 2026-10-28: "make sure this never shows"). Phantom answers it when
// its extension is still waking up, or when a second request comes while the first is open. So: one request at a
// time, quiet retries on that answer, and Phantom's Wallet Standard door when its legacy one keeps failing.

let queue: Promise<unknown> = Promise.resolve();
/** Runs Phantom requests one at a time. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const sleep = (ms: number) => new Promise((ok) => window.setTimeout(ok, ms));

/** A failure that goes away on a second try: Phantom's internal error, a request already open, a sleeping extension. */
export function isTransient(e: unknown): boolean {
  if (isRejection(e)) return false;
  const x = e as { code?: number; message?: string } | null;
  if (x?.code === -32603 || x?.code === -32002 || x?.code === -32000) return true;
  return /unexpected|already pending|not ready|disconnected port|receiving end|extension context|timed? ?out|internal/i.test(String(x?.message ?? e ?? ''));
}

async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1 || !isTransient(e)) throw e;
      await sleep(350 * 2 ** i);
    }
  }
}

// Wallet Standard: Phantom also registers itself here; the same wallet through its newer interface.
interface StdAccount {
  address: string;
  publicKey: Uint8Array;
}
interface StdWallet {
  name: string;
  accounts: readonly StdAccount[];
  features: Record<string, unknown>;
}
const stdWallets: StdWallet[] = [];
if (typeof window !== 'undefined') {
  const register = (...ws: StdWallet[]) => {
    stdWallets.push(...ws);
    return () => undefined;
  };
  window.addEventListener('wallet-standard:register-wallet', (e) => {
    try {
      (e as CustomEvent<(api: { register: typeof register }) => void>).detail({ register });
    } catch {
      // another wallet's event
    }
  });
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register } }));
  } catch {
    // old browsers
  }
}
const stdPhantom = (): StdWallet | null => stdWallets.find((w) => /phantom/i.test(w.name)) ?? null;

async function stdConnect(): Promise<string | null> {
  const w = stdPhantom();
  const f = w?.features['standard:connect'] as { connect?: () => Promise<{ accounts: readonly StdAccount[] }> } | undefined;
  if (!w || !f?.connect) return null;
  const r = await f.connect();
  return r.accounts[0]?.address ?? w.accounts[0]?.address ?? null;
}

async function stdSignMessage(address: string, message: Uint8Array): Promise<Uint8Array | null> {
  const w = stdPhantom();
  const acc = w?.accounts.find((a) => a.address === address);
  const f = w?.features['solana:signMessage'] as { signMessage?: (i: { account: StdAccount; message: Uint8Array }) => Promise<readonly { signature: Uint8Array }[]> } | undefined;
  if (!acc || !f?.signMessage) return null;
  const [out] = await f.signMessage({ account: acc, message });
  return out?.signature ?? null;
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
        trustedP = serial(() => p.connect({ onlyIfTrusted: true })).then(
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
  if (wallet.get().account) return wallet.get().account!;
  wallet.set({ connecting: true });
  try {
    await Promise.race([trustedP.catch(() => undefined), sleep(1500)]);
    let a: string | null = p.publicKey ? p.publicKey.toBase58() : null;
    if (!a) {
      try {
        a = await serial(() => retry(() => p.connect().then((r) => r.publicKey.toBase58())));
      } catch (e) {
        if (isRejection(e)) throw e;
        console.warn('[flipfee] phantom connect', e);
        // the request may have gone through while the answer got lost; else Phantom's Wallet Standard door
        a = p.publicKey ? p.publicKey.toBase58() : await serial(() => retry(() => stdConnect(), 2)).catch((e2) => {
          if (isRejection(e2)) throw e2;
          throw e;
        });
        if (!a) throw e;
      }
    }
    setAccount(a);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // storage is optional
    }
    return a as string;
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
  try {
    return await serial(() => retry(() => p.signMessage(message, 'utf8').then((r) => r.signature), 2));
  } catch (e) {
    const a = wallet.get().account;
    if (isRejection(e) || !a) throw e;
    console.warn('[flipfee] phantom signMessage', e);
    const sig = await serial(() => stdSignMessage(a, message));
    if (!sig) throw e;
    return sig;
  }
}

/** Phantom's own sign-in screen: returns the exact message it signed and the signature. */
export async function signIn(input: SignInInput): Promise<{ message: Uint8Array; signature: Uint8Array; address: string }> {
  const p = provider();
  if (!p?.signIn) throw new Error('no sign-in');
  const out = await serial(() => p.signIn!(input));
  return { message: out.signedMessage, signature: out.signature, address: out.address.toBase58() };
}

/** A user said no in Phantom (4001, "User rejected the request"). */
export function isRejection(e: unknown): boolean {
  const x = e as { code?: number; message?: string; name?: string } | null;
  if (!x) return false;
  if (x.code === 4001) return true;
  return /reject|denied|declin|cancel|closed/i.test(String(x.message ?? '') + ' ' + String(x.name ?? ''));
}

/** Phantom's own words for a failure, short (shown under a failed toast so a report can name it). */
export function errText(e: unknown): string {
  const x = e as { code?: number; message?: string } | null;
  const t = [x?.code, x?.message ?? String(e)].filter((v) => v !== undefined && v !== '').join(' ');
  return t.length > 90 ? t.slice(0, 89) + '…' : t;
}
