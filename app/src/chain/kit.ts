// The real kit: the program builder's TS client (flipfee-client = ../program/client/dist; API in its README). Loaded
// on the first transaction. Each builder returns a legacy Transaction for Phantom and its unsigned bytes for our
// simulation. Buy brings pump's fees in first (AMM sweep for graduated coins, then distribute) inside `buyTx`.
import { Buffer } from 'buffer';
import { Connection, PublicKey } from '@solana/web3.js';
import type { Transaction } from '@solana/web3.js';
import { FLIPFEE_PROGRAM_ID, COMPUTE_UNITS, NotEligibleError, buildTx, buyTx, connectCoinTx, eligibility, parseFlipfeeError, setTermsIx } from 'flipfee-client';
import type { Built, Kit, TxCode } from './tx.ts';
import { TxError } from './tx.ts';
import { chain, rpcUrl } from './config.ts';
import { bytesToB64 } from '../lib/bytes.ts';

// the client reads base64 through globalThis.Buffer in one place
const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;

/** Priority fee per compute unit (micro-lamports); a few thousand lamports per transaction at most. */
const MICRO = Number(import.meta.env.VITE_PRIORITY_MICROLAMPORTS ?? 50_000) || 0;

const wrap = (tx: Transaction, what: string): Built => ({
  tx,
  what,
  b64: () => bytesToB64(tx.serialize({ requireAllSignatures: false, verifySignatures: false })),
});

/** The program's error names (client/README.md) → the app's plain codes. */
const BY_NAME: Record<string, TxCode> = {
  PriceAboveMax: 'price',
  Paused: 'paused',
  CoinPaused: 'paused',
  TooFarAhead: 'ahead',
  QueueFull: 'sold',
  BadHours: 'sold',
  PriceOutOfRange: 'generic',
  NotFeeAdmin: 'elig',
  SplitNotFinal: 'elig',
  SplitNotToVault: 'elig',
  SharingNotActive: 'elig',
  NotSharingConfig: 'elig',
  CurveNotRouted: 'elig',
  NotSolPaired: 'elig',
  CashbackCoin: 'elig',
};

export function createKit(): Kit {
  const conn = new Connection(rpcUrl(), { commitment: 'confirmed' });
  const programId = chain.get().programId ?? undefined;
  let liveAt = 0;
  let liveNow = false;
  return {
    async live() {
      if (liveNow || Date.now() - liveAt < 30_000) return liveNow;
      const info = await conn.getAccountInfo(programId ? new PublicKey(String(programId)) : FLIPFEE_PROGRAM_ID);
      liveAt = Date.now();
      liveNow = !!info?.executable;
      return liveNow;
    },
    async buy(i) {
      const r = await buyTx(conn, { buyer: i.buyer, mint: i.mint, hours: i.hours, maxPrice: i.maxPrice, microLamports: MICRO, programId });
      return wrap(r.tx, 'buy');
    },
    async connect(i) {
      try {
        const r = await connectCoinTx(conn, { wallet: i.dev, mint: i.mint, price: i.price, maxAhead: i.maxAhead, microLamports: MICRO, programId });
        return wrap(r.tx, 'connect:' + r.kind);
      } catch (e) {
        if (e instanceof NotEligibleError) throw new TxError('elig', e.message);
        throw e;
      }
    },
    async terms(i) {
      const tx = await buildTx(conn, i.owner, [setTermsIx({ owner: i.owner, mint: i.mint, price: i.price, maxAhead: i.maxAhead, paused: i.paused, programId })], COMPUTE_UNITS.set_terms, { microLamports: MICRO });
      return wrap(tx, 'terms');
    },
    async eligibility(mint, wallet) {
      const e = await eligibility(conn, mint, wallet, { programId });
      return { kind: e.kind, graduated: e.graduated };
    },
    errorCode(err, logs) {
      const d = parseFlipfeeError({ err, logs, transactionLogs: logs }, programId ? String(programId) : undefined) ?? parseFlipfeeError(err);
      if (!d) return null;
      if (d.source === 'system' && d.code === 1) return 'funds';
      return BY_NAME[d.name] ?? null;
    },
  };
}
