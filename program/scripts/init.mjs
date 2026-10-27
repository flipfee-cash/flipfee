// Initializes flipfee's Config once after a deploy: `initialize(fee_bps)` signed by the program's upgrade authority
// (who becomes the admin), with the treasury that receives the fee on hour sales.
//
//   node scripts/init.mjs --rpc <url> --treasury <pubkey> [--fee-bps 500] [--keypair .keys/deployer.json] [--yes]
//
// Prints the cluster (by genesis hash), the authority's public key, the treasury and the fee, and stops unless --yes
// is given. Refuses a treasury that is not a funded system account. Never prints the keypair.
import { readFileSync } from 'node:fs';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import * as ff from '../client/dist/index.js';

const GENESIS = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
};

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const rpc = arg('rpc');
const treasuryArg = arg('treasury');
if (!rpc || !treasuryArg) {
  console.error('usage: node scripts/init.mjs --rpc <url> --treasury <pubkey> [--fee-bps 500] [--keypair .keys/deployer.json] [--yes]');
  process.exit(2);
}
const feeBps = Number(arg('fee-bps', '500'));
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(arg('keypair', '.keys/deployer.json'), 'utf8'))));
const treasury = new PublicKey(treasuryArg);
const conn = new Connection(rpc, 'confirmed');
const genesis = await conn.getGenesisHash();
const cluster = GENESIS[genesis] ?? `local or unknown (${genesis})`;

const pd = await conn.getAccountInfo(ff.findProgramDataAddress(), 'confirmed');
if (!pd) throw new Error(`program ${ff.FLIPFEE_PROGRAM_ID.toBase58()} is not deployed on this cluster`);
const upgradeAuthority = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)) : null;
const t = await conn.getAccountInfo(treasury, 'confirmed');
const rentMin = await conn.getMinimumBalanceForRentExemption(0);
console.log(`cluster:      ${cluster}`);
console.log(`program:      ${ff.FLIPFEE_PROGRAM_ID.toBase58()} (upgrade authority ${upgradeAuthority?.toBase58() ?? 'none'})`);
console.log(`authority:    ${authority.publicKey.toBase58()} (becomes the admin)`);
console.log(`treasury:     ${treasury.toBase58()} (${t ? `${t.lamports} lamports, owner ${t.owner.toBase58()}` : 'does not exist'})`);
console.log(`fee:          ${feeBps} bps`);
if (!upgradeAuthority?.equals(authority.publicKey)) throw new Error('the keypair is not the program upgrade authority');
if (!t || !t.owner.equals(ff.SYSTEM_PROGRAM_ID) || t.lamports < rentMin) {
  throw new Error(`treasury must be a system account holding at least ${rentMin} lamports`);
}
if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > ff.MAX_FEE_BPS) throw new Error('fee-bps must be 0..1000');
if (await conn.getAccountInfo(ff.findConfigPda()[0], 'confirmed')) throw new Error('already initialized');
if (!argv.includes('--yes')) {
  console.log('dry run: add --yes to send initialize');
  process.exit(0);
}
const tx = await ff.buildTx(conn, authority.publicKey, [ff.initializeIx({ authority: authority.publicKey, treasury, feeBps })], ff.COMPUTE_UNITS.initialize);
tx.sign(authority);
const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
await conn.confirmTransaction({ signature: sig, blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight }, 'confirmed');
const cfg = await ff.fetchConfig(conn);
console.log(`initialized: ${sig}`);
console.log(`config ${ff.findConfigPda()[0].toBase58()}: admin ${cfg.admin.toBase58()}, treasury ${cfg.treasury.toBase58()}, fee ${cfg.feeBps} bps`);
process.exit(0);
