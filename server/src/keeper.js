// Hosts the program builder's keeper (flipfee/program/keeper) when KEEPER=1: every interval it sweeps AMM creator
// fees, distributes the pump vault to the flipfee vault and cranks each registered coin (DESIGN §2.1). The keeper
// signs with KEEPER_KEYPAIR_FILE (a Solana CLI keypair JSON; the key never reaches a log). Off by default.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { readKeypairFile } from './keys.js';

/** The keeper module: its package entry, else dist/index.js, else index.js / index.mjs / src/index.js. */
export async function importKeeper(dir) {
  const files = [];
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const main = pkg.exports?.['.']?.import ?? pkg.exports?.['.']?.default ?? pkg.module ?? pkg.main;
    if (typeof main === 'string') files.push(join(dir, main));
  } catch {
    // no package.json
  }
  files.push(join(dir, 'dist', 'index.js'), join(dir, 'index.js'), join(dir, 'index.mjs'), join(dir, 'src', 'index.js'));
  for (const f of files) if (existsSync(f)) return { file: f, mod: await import(pathToFileURL(f).href) };
  throw new Error(`no keeper module under ${dir}`);
}

export async function startKeeper({ cfg, rpc, adapter, log }) {
  if (!cfg.keeperKeypairFile) throw new Error('KEEPER=1 needs KEEPER_KEYPAIR_FILE');
  if (!existsSync(cfg.keeperKeypairFile)) throw new Error('KEEPER_KEYPAIR_FILE points to a missing file');
  const keypair = readKeypairFile(cfg.keeperKeypairFile);
  let found = null;
  let lastErr = null;
  for (const dir of Array.isArray(cfg.keeperPath) ? cfg.keeperPath : [cfg.keeperPath]) {
    try {
      found = await importKeeper(dir);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!found) throw lastErr ?? new Error('no keeper module');
  const { file, mod } = found;
  // program/keeper's createKeeper({ connection, payer, programId, intervalMs, microLamports, log }) → { start, stop, tick }
  const lines = { n: 0, last: null, lastAt: 0, errors: 0 };
  const opts = {
    connection: rpc.connection(),
    payer: keypair,
    programId: adapter.programId,
    intervalMs: cfg.keeperIntervalMs,
    microLamports: cfg.keeperPriorityMicroLamports,
    log: (line) => {
      lines.n++;
      lines.last = String(line).slice(0, 300);
      lines.lastAt = Date.now();
      if (/fail/i.test(lines.last)) lines.errors++;
      log(`keeper ${lines.last}`);
    },
  };
  if (typeof mod.createKeeper !== 'function') throw new Error(`the keeper module ${file} exports no createKeeper`);
  const k = mod.createKeeper(opts);
  k.start();
  const startedAt = Date.now();
  log('keeper.host', { module: file, signer: keypair.publicKey.toBase58(), intervalMs: cfg.keeperIntervalMs, program: adapter.programId });
  return {
    keeper: k,
    status: () => ({ on: true, module: file, signer: keypair.publicKey.toBase58(), startedAt, intervalMs: cfg.keeperIntervalMs, lines: lines.n, errors: lines.errors, last: lines.last, lastAt: lines.lastAt || null }),
    stop: () => k.stop(),
  };
}

export { Keypair };
