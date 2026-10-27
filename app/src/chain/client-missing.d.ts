// Types for `flipfee-client` when ../program/client/dist is not built (tsconfig `paths` falls back here). The kit
// is never loaded then (__FF_CLIENT__ is false); these lines only keep the type check whole.
declare module 'flipfee-client' {
  import type { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
  type Address = PublicKey | string;
  export const FLIPFEE_PROGRAM_ID: PublicKey;
  export const COMPUTE_UNITS: { set_terms: number };
  export class NotEligibleError extends Error {
    eligibility: { kind: string; reason?: string };
  }
  export function buyTx(conn: Connection, a: { buyer: Address; mint: Address; hours: number; maxPrice?: bigint; microLamports?: number; programId?: Address }): Promise<{ tx: Transaction; start: number; end: number }>;
  export function connectCoinTx(conn: Connection, a: { wallet: Address; mint: Address; price: bigint; maxAhead?: number; microLamports?: number; programId?: Address }): Promise<{ tx: Transaction; kind: string }>;
  export function setTermsIx(a: { owner: Address; mint: Address; price: bigint; maxAhead: number; paused: boolean; programId?: Address }): TransactionInstruction;
  export function buildTx(conn: Connection, feePayer: Address, ixs: TransactionInstruction[], units: number, opts?: { microLamports?: number }): Promise<Transaction>;
  export function eligibility(conn: Connection, mint: Address, wallet?: Address | null, opts?: { programId?: Address }): Promise<{ kind: string; graduated: boolean; reason?: string }>;
  export function parseFlipfeeError(err: unknown, programId?: string): { code: number; name: string; msg: string; source: string } | null;
}
