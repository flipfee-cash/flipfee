#!/usr/bin/env node
// flipfee keeper CLI.
//
//   node keeper/dist/cli.js --rpc <url> --keypair <path> [--interval 60] [--priority 0] [--mint <mint>]… [--once]
//                           [--program-id <id>] [--min-pending 10000]
//
// Env fallbacks: RPC_URL, KEEPER_KEYPAIR, KEEPER_INTERVAL, KEEPER_PRIORITY. The keypair file is a JSON array of 64
// numbers (solana-keygen format); it is read, never printed.
import { readFileSync } from 'node:fs';

import { Connection, Keypair } from '@solana/web3.js';

import { createKeeper } from './index.js';

function args(argv: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true';
    out.set(key, [...(out.get(key) ?? []), value]);
  }
  return out;
}

const a = args(process.argv.slice(2));
const one = (k: string, env?: string): string | undefined => a.get(k)?.[0] ?? (env ? process.env[env] : undefined);
const rpc = one('rpc', 'RPC_URL') ?? 'http://127.0.0.1:8899';
const keypairPath = one('keypair', 'KEEPER_KEYPAIR');
if (!keypairPath) {
  console.error('missing --keypair <path> (or KEEPER_KEYPAIR)');
  process.exit(2);
}
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8')) as number[]));
const keeper = createKeeper({
  connection: new Connection(rpc, 'confirmed'),
  payer,
  programId: one('program-id'),
  intervalMs: Number(one('interval', 'KEEPER_INTERVAL') ?? 60) * 1_000,
  microLamports: Number(one('priority', 'KEEPER_PRIORITY') ?? 0),
  mints: a.get('mint'),
  minPending: one('min-pending') ? BigInt(one('min-pending')!) : undefined,
  log: (l) => console.log(`${new Date().toISOString()} ${l}`),
});

if (a.has('once')) {
  const r = await keeper.tick();
  console.log(`${new Date().toISOString()} tick: ${r.coins} coins, ${r.acted.length} acted, ${r.skipped} skipped`);
  process.exit(r.acted.some((x) => x.error) ? 1 : 0);
} else {
  keeper.start();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      await keeper.stop();
      process.exit(0);
    });
  }
}
