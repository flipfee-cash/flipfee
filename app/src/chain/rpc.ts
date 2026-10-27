// Minimal Solana JSON-RPC over fetch (balances, account reads, simulation, signature status, send). The home page
// uses only this file; @solana/web3.js and the flipfee client load when a transaction starts.
import { rpcUrl } from './config.ts';

let nextId = 1;

export class RpcError extends Error {
  code: number;
  data: unknown;
  logs: string[];
  constructor(code: number, message: string, data?: unknown, logs: string[] = []) {
    super(message);
    this.code = code;
    this.data = data;
    this.logs = logs;
  }
}

export async function rpc<T>(method: string, params: unknown[] = [], url = rpcUrl(), timeoutMs = 15000): Promise<T> {
  const ac = new AbortController();
  const t = window.setTimeout(() => ac.abort(), timeoutMs);
  try {
    let r: Response;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: ac.signal,
      });
    } catch (e) {
      throw new RpcError(-32000, 'network', String(e));
    }
    if (r.status === 429) throw new RpcError(429, 'rate limited');
    const j = (await r.json().catch(() => ({}))) as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (j.error) throw new RpcError(j.error.code, j.error.message, j.error.data, ((j.error.data as { logs?: string[] } | undefined)?.logs ?? []) as string[]);
    return j.result as T;
  } finally {
    window.clearTimeout(t);
  }
}

export async function getBalanceSol(address: string): Promise<number> {
  const r = await rpc<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
  return r.value / 1e9;
}

export interface SimResult {
  err: unknown;
  logs: string[];
  units: number;
}

/** Simulates a serialized transaction (base64) without signatures, on a fresh blockhash. */
export async function simulateB64(txB64: string): Promise<SimResult> {
  const r = await rpc<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>('simulateTransaction', [
    txB64,
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' },
  ]);
  return { err: r.value.err, logs: r.value.logs ?? [], units: r.value.unitsConsumed ?? 0 };
}

export async function sendB64(txB64: string): Promise<string> {
  return rpc<string>('sendTransaction', [txB64, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 }]);
}

export interface SigStatus {
  err: unknown;
  confirmationStatus?: string;
}

export async function sigStatus(sig: string): Promise<SigStatus | null> {
  const r = await rpc<{ value: (SigStatus | null)[] }>('getSignatureStatuses', [[sig], { searchTransactionHistory: false }]);
  return r?.value?.[0] ?? null;
}
