// Transactions (DESIGN.md §2.3): build with the program client → simulate on our RPC → Phantom signs and sends →
// confirm by the stream (`buy` / `register` / `window`) or the signature status, whichever comes first. Errors come
// back as one plain code each; the sheets turn them into copy. The kit (web3.js + the flipfee client) loads on the
// first transaction, so the board never downloads it.
import type { StreamEvent } from '../api/types.ts';
import { RpcError, sigStatus, simulateB64 } from './rpc.ts';
import { isRejection, provider, refreshBalance } from '../wallet/wallet.ts';
import { onStream } from '../api/live.ts';
import { applyServerChain } from './config.ts';

declare const __FF_FIXTURE__: boolean;
declare const __FF_CLIENT__: boolean;

export type TxStep = 'build' | 'sign' | 'send' | 'confirm' | 'done';
export type TxCode = 'rejected' | 'funds' | 'price' | 'sold' | 'paused' | 'ahead' | 'elig' | 'network' | 'chain' | 'setup' | 'timeout' | 'generic';

export class TxError extends Error {
  code: TxCode;
  logs: string[];
  sig?: string;
  constructor(code: TxCode, message: string = code, logs: string[] = [], sig?: string) {
    super(message);
    this.code = code;
    this.logs = logs;
    this.sig = sig;
  }
}

/** A built transaction: web3.js object for Phantom, bytes for our simulation. */
export interface Built {
  tx: unknown;
  /** serialized without signatures (base64), for simulateTransaction */
  b64(): string;
  /** what the transaction does, for logs and tests */
  what: string;
}

export interface BuyInput {
  buyer: string;
  mint: string;
  hours: number;
  /** lamports per hour the buyer accepts (the price they saw) */
  maxPrice: bigint;
  /** the coin's facts the client needs (graduated → AMM sweep first; the owner gets 95%) */
  graduated: boolean;
  owner: string;
}

export interface ConnectInput {
  dev: string;
  mint: string;
  price: bigint;
  maxAhead: number;
  kind: 'ready-new' | 'ready' | 'almost';
  graduated: boolean;
}

export interface TermsInput {
  owner: string;
  mint: string;
  price: bigint;
  maxAhead: number;
  paused: boolean;
}

export interface Kit {
  buy(i: BuyInput): Promise<Built>;
  connect(i: ConnectInput): Promise<Built>;
  terms(i: TermsInput): Promise<Built>;
  /** a fresh eligibility read from chain (the dev page shows the server's; Connect checks again) */
  eligibility?(mint: string, wallet: string): Promise<{ kind: string; admin?: string; graduated?: boolean } | null>;
  /** the program's own error decoder (names → codes), when the kit has one */
  errorCode?(err: unknown, logs: string[]): TxCode | null;
  /** true once the flipfee program is on chain (sales and coin connects wait for it) */
  live?(): Promise<boolean>;
}

let kitNow: Kit | null = null;
/** Simulation or send failure → one code: the kit's decoder first, then the log patterns. */
function codeWith(err: unknown, logs: string[] = []): TxCode {
  if (isRejection(err)) return 'rejected';
  return kitNow?.errorCode?.(err, logs) ?? codeOf(err, logs);
}

let kitP: Promise<Kit> | null = null;

/** The server names the program it indexes (GET /api/health): the app's transactions go to the same one. */
async function serverChain(): Promise<void> {
  try {
    const ac = new AbortController();
    const t = window.setTimeout(() => ac.abort(), 3000);
    const r = await fetch('/api/health', { signal: ac.signal, headers: { accept: 'application/json' } }).finally(() => window.clearTimeout(t));
    applyServerChain((await r.json()) as { programId?: unknown; rpc?: unknown; cluster?: unknown });
  } catch {
    // the client's own program id stands
  }
}

export function loadKit(): Promise<Kit> {
  if (kitP) return kitP;
  if (__FF_FIXTURE__) kitP = import('./kitFixture.ts').then((m) => m.createKit());
  else if (__FF_CLIENT__) kitP = serverChain().then(() => import('./kit.ts')).then((m) => m.createKit());
  else kitP = Promise.reject(new TxError('setup', 'the flipfee program client is not in this build'));
  kitP.then(
    (k) => (kitNow = k),
    () => {
      kitP = null;
    },
  );
  return kitP;
}

/** Warm the kit while the user looks at a buy or connect sheet. */
export function preloadKit(): void {
  void loadKit().catch(() => undefined);
}

const ANCHOR = /Error Code: (\w+)/;

/** Simulation or send failure → one code. */
export function codeOf(err: unknown, logs: string[] = []): TxCode {
  if (isRejection(err)) return 'rejected';
  const text = (logs.join('\n') + '\n' + JSON.stringify(err ?? '') + '\n' + String((err as Error)?.message ?? '')).toLowerCase();
  const anchor = ANCHOR.exec(logs.join('\n'))?.[1]?.toLowerCase() ?? '';
  if (/insufficient (lamports|funds)|insufficientfunds|"custom":1}|attempt to debit an account but found no record/.test(text)) return 'funds';
  if (/price/.test(anchor) || /pricechanged|priceabovemax|price too high|maxprice/.test(text)) return 'price';
  if (/pause/.test(anchor) || /paused/.test(text)) return 'paused';
  if (/ahead|toofar|beyond/.test(anchor) || /maxahead|too far ahead/.test(text)) return 'ahead';
  if (/full|sold|windows|toomany/.test(anchor)) return 'sold';
  if (/blockhash not found|block height exceeded|expired/.test(text)) return 'network';
  if (err instanceof RpcError && (err.code === 429 || err.code === -32000 || err.message === 'network')) return 'network';
  return 'chain';
}

function b58(bytes: Uint8Array): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const d: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let c = bytes[i];
    for (let j = 0; j < d.length; j++) {
      c += d[j] << 8;
      d[j] = c % 58;
      c = (c / 58) | 0;
    }
    while (c) {
      d.push(c % 58);
      c = (c / 58) | 0;
    }
  }
  let s = '1'.repeat(zeros);
  for (let i = d.length - 1; i >= 0; i--) s += A[d[i]];
  return s;
}

/**
 * Runs one transaction. `match` resolves the confirmation early when the stream reports the result (the server saw
 * the program event); the signature status is the fallback.
 */
export async function runTx(build: (k: Kit) => Promise<Built>, onStep: (s: TxStep) => void, match?: (e: StreamEvent) => boolean): Promise<string> {
  onStep('build');
  let kit: Kit;
  try {
    kit = await loadKit();
  } catch (e) {
    throw e instanceof TxError ? e : new TxError('setup', String(e));
  }
  if (kit.live && !(await kit.live().catch(() => true))) throw new TxError('setup', 'the flipfee program is not on chain yet');
  let built: Built;
  try {
    built = await build(kit);
  } catch (e) {
    if (e instanceof TxError) throw e;
    throw new TxError(e instanceof RpcError ? 'network' : 'chain', String((e as Error)?.message ?? e));
  }
  // simulate first: a failing transaction never reaches Phantom
  try {
    const sim = await simulateB64(built.b64());
    if (sim.err) throw new TxError(codeWith(sim.err, sim.logs), 'simulation failed: ' + JSON.stringify(sim.err), sim.logs);
  } catch (e) {
    if (e instanceof TxError) throw e;
    throw new TxError(codeWith(e, (e as RpcError)?.logs ?? []), String((e as Error)?.message ?? e));
  }

  const p = provider();
  if (!p) throw new TxError('generic', 'phantom is gone');
  onStep('sign');
  let sig = '';
  try {
    if (typeof p.signAndSendTransaction === 'function') {
      const r = await p.signAndSendTransaction(built.tx, { preflightCommitment: 'confirmed', maxRetries: 3 });
      sig = typeof r.signature === 'string' ? r.signature : b58(r.signature);
    } else if (p.request) {
      const r = (await p.request({ method: 'signAndSendTransaction', params: { message: b58(new Uint8Array(Uint8Array.from(atob(built.b64()), (c) => c.charCodeAt(0)))) } })) as { signature?: string } | null;
      sig = r?.signature ?? '';
    }
  } catch (e) {
    throw new TxError(codeWith(e, ((e as { logs?: string[] })?.logs ?? []) as string[]), String((e as Error)?.message ?? e));
  }
  if (!sig) throw new TxError('generic', 'no signature');

  onStep('confirm');
  await confirmSig(sig, match);
  onStep('done');
  void refreshBalance();
  return sig;
}

async function confirmSig(sig: string, match?: (e: StreamEvent) => boolean, timeoutMs = 75000): Promise<void> {
  let off: (() => void) | null = null;
  const viaStream = new Promise<void>((res) => {
    if (!match) return;
    off = onStream((list) => {
      if (list.some((e) => match(e))) res();
    });
  });
  const viaStatus = (async () => {
    const t0 = Date.now();
    let wait = 700;
    while (Date.now() - t0 < timeoutMs) {
      const s = await sigStatus(sig).catch(() => null);
      if (s?.err) throw new TxError(codeWith(s.err), 'failed on chain: ' + JSON.stringify(s.err), [], sig);
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(2000, wait * 1.3);
    }
    throw new TxError('timeout', 'not confirmed in time', [], sig);
  })();
  try {
    await Promise.race([viaStream, viaStatus]);
  } finally {
    (off as (() => void) | null)?.();
  }
}
