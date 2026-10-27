// Keys come from files only. Nothing here logs, prints or stores a secret; the keeper key is
// read once into a Keypair and only its public key leaves this module in logs.
import { readFileSync, statSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/** A Solana keypair from a file: the CLI's JSON array of 64 numbers, or a base58 secret key. */
export function readKeypairFile(file) {
  const raw = readFileSync(file, 'utf8').trim();
  let bytes;
  if (raw.startsWith('[')) bytes = Uint8Array.from(JSON.parse(raw));
  else bytes = bs58.decode(raw);
  if (bytes.length !== 64) throw new Error('the keypair file must hold a 64-byte secret key');
  return Keypair.fromSecretKey(bytes);
}

/** True when group or others may read the file (the start log warns about it). */
export function fileIsOpen(file) {
  try {
    return process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}
