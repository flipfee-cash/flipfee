// DEV ONLY (fixture mode): transactions as memos that name the action, for the fixture's RPC at /fx/rpc to apply
// (dev/fixturePlugin.ts). The whole wallet path is real: simulate → Phantom (the test wallet) signs and sends →
// confirm. A production build never includes this file (__FF_FIXTURE__ is false there).
import { Buffer } from 'buffer';
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { Built, Kit } from './tx.ts';
import { rpc } from './rpc.ts';
import { bytesToB64 } from '../lib/bytes.ts';

const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

async function memoTx(payer: string, memo: Record<string, unknown>): Promise<Built> {
  const { value } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const key = new PublicKey(payer);
  const ix = new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: key, isSigner: true, isWritable: true }], data: Buffer.from(JSON.stringify(memo), 'utf8') });
  const msg = new TransactionMessage({ payerKey: key, recentBlockhash: value.blockhash, instructions: [ix] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  return { tx, b64: () => bytesToB64(tx.serialize()), what: String(memo.ff) };
}

export function createKit(): Kit {
  return {
    buy: (i) => memoTx(i.buyer, { ff: 'buy', mint: i.mint, hours: i.hours, maxPrice: Number(i.maxPrice) / 1e9 }),
    connect: (i) => memoTx(i.dev, { ff: 'connect', mint: i.mint, price: Number(i.price) / 1e9, maxAhead: i.maxAhead }),
    terms: (i) => memoTx(i.owner, { ff: 'terms', mint: i.mint, price: Number(i.price) / 1e9, maxAhead: i.maxAhead, paused: i.paused }),
  };
}
