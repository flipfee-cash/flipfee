import { Buffer } from 'buffer';
import { type AccountMeta, PublicKey, TransactionInstruction } from '@solana/web3.js';

import { type Address, type U64Like, Writer, toPublicKey } from './codec.js';
import { FLIPFEE_PROGRAM_ID, SYSTEM_PROGRAM_ID } from './constants.js';
import { IX_DISCRIMINATORS } from './generated.js';
import {
  findBondingCurvePda,
  findCanonicalPoolPda,
  findCoinPda,
  findConfigPda,
  findProgramDataAddress,
  findPumpCreatorVaultPda,
  findSharingConfigPda,
  findVaultPda,
  getAmmCreatorVaultAta,
} from './pda.js';

/** Every builder takes an optional `programId` (default: FLIPFEE_PROGRAM_ID). */
interface WithProgram {
  programId?: Address;
}

function data(name: keyof typeof IX_DISCRIMINATORS, size: number, fill?: (w: Writer) => void): Buffer {
  const w = new Writer(8 + size).bytes(IX_DISCRIMINATORS[name], 8);
  fill?.(w);
  return Buffer.from(w.done());
}

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });
const signer = (a: Address, writable = false) => meta(toPublicKey(a), true, writable);
const writable = (a: Address) => meta(toPublicKey(a), false, true);
const readonly = (a: Address) => meta(toPublicKey(a), false, false);

function ix(programId: Address | undefined, keys: AccountMeta[], body: Buffer): TransactionInstruction {
  return new TransactionInstruction({ programId: toPublicKey(programId ?? FLIPFEE_PROGRAM_ID), keys, data: body });
}

/** One-time setup, signed by the program's upgrade authority (who becomes the admin). */
export function initializeIx(a: { authority: Address; treasury: Address; feeBps: number } & WithProgram): TransactionInstruction {
  const program = toPublicKey(a.programId ?? FLIPFEE_PROGRAM_ID);
  return ix(
    program,
    [
      signer(a.authority, true),
      writable(findConfigPda(program)[0]),
      readonly(a.treasury),
      readonly(program),
      readonly(findProgramDataAddress(program)),
      readonly(SYSTEM_PROGRAM_ID),
    ],
    data('initialize', 2, (w) => w.u16(a.feeBps)),
  );
}

/** Admin: treasury (system-owned, rent-exempt), fee on hour sales (≤ 1000 bps), pause of register/buy. */
export function setConfigIx(a: { admin: Address; treasury: Address; feeBps: number; paused: boolean } & WithProgram): TransactionInstruction {
  return ix(
    a.programId,
    [signer(a.admin), writable(findConfigPda(a.programId)[0]), readonly(a.treasury)],
    data('set_config', 3, (w) => w.u16(a.feeBps).bool(a.paused)),
  );
}

/** Admin: hand the admin role to `newAdmin`. */
export function setAdminIx(a: { admin: Address; newAdmin: Address } & WithProgram): TransactionInstruction {
  return ix(a.programId, [signer(a.admin), writable(findConfigPda(a.programId)[0])], data('set_admin', 32, (w) => w.pubkey(a.newAdmin)));
}

/**
 * The dev joins a coin whose final pump split sends 100% to the vault. `owner` must be the sharing config's admin
 * (the key that set the split). Pays the Coin account rent and, if needed, the vault's rent.
 */
export function registerIx(a: { owner: Address; mint: Address; price: U64Like; maxAhead: number } & WithProgram): TransactionInstruction {
  return ix(
    a.programId,
    [
      signer(a.owner, true),
      readonly(findConfigPda(a.programId)[0]),
      writable(findCoinPda(a.mint, a.programId)[0]),
      writable(findVaultPda(a.mint, a.programId)[0]),
      readonly(a.mint),
      readonly(findSharingConfigPda(a.mint)[0]),
      readonly(findBondingCurvePda(a.mint)[0]),
      readonly(findCanonicalPoolPda(a.mint)[0]),
      readonly(SYSTEM_PROGRAM_ID),
    ],
    data('register', 12, (w) => w.u64(a.price).u32(a.maxAhead)),
  );
}

/** Owner: price per hour (lamports), hours ahead (seconds), pause of sales. */
export function setTermsIx(a: { owner: Address; mint: Address; price: U64Like; maxAhead: number; paused: boolean } & WithProgram): TransactionInstruction {
  return ix(
    a.programId,
    [signer(a.owner), writable(findCoinPda(a.mint, a.programId)[0])],
    data('set_terms', 13, (w) => w.u64(a.price).u32(a.maxAhead).bool(a.paused)),
  );
}

/** Owner: hand the coin to `newOwner`, who signs too (it accepts the coin). The old owner is paid what it is owed
 * first. */
export function transferOwnerIx(a: { owner: Address; mint: Address; newOwner: Address } & WithProgram): TransactionInstruction {
  return ix(
    a.programId,
    [
      signer(a.owner, true),
      writable(findCoinPda(a.mint, a.programId)[0]),
      writable(findVaultPda(a.mint, a.programId)[0]),
      signer(a.newOwner),
      readonly(SYSTEM_PROGRAM_ID),
    ],
    data('transfer_owner', 0),
  );
}

/**
 * Buyer: `hours` (1..=12) hours at the coin's price, at most `maxPrice` per hour, starting no later than `maxStart`
 * (unix seconds). `owner` = `coin.owner`, `treasury` = `config.treasury` (the program checks both). pump must hold no
 * fees of the coin when it runs: put the sweep and distribute before it in the same transaction (see `buyTx`).
 */
export function buyIx(
  a: { buyer: Address; mint: Address; owner: Address; treasury: Address; hours: number; maxPrice: U64Like; maxStart: number | bigint } & WithProgram,
): TransactionInstruction {
  const sc = findSharingConfigPda(a.mint)[0];
  return ix(
    a.programId,
    [
      signer(a.buyer, true),
      readonly(findConfigPda(a.programId)[0]),
      writable(findCoinPda(a.mint, a.programId)[0]),
      readonly(findVaultPda(a.mint, a.programId)[0]),
      writable(a.owner),
      writable(a.treasury),
      readonly(sc),
      readonly(findBondingCurvePda(a.mint)[0]),
      readonly(findCanonicalPoolPda(a.mint)[0]),
      readonly(findPumpCreatorVaultPda(sc)[0]),
      readonly(getAmmCreatorVaultAta(sc)),
      readonly(SYSTEM_PROGRAM_ID),
    ],
    data('buy', 17, (w) => w.u8(a.hours).u64(a.maxPrice).i64(a.maxStart)),
  );
}

/** Anyone: sync the vault and pay `recipients` (the owner and/or hour buyers; others are ignored). Up to 15
 * recipients per crank keep its logs (events) under mainnet's 10,000-byte log limit. */
export function crankIx(a: { mint: Address; recipients: Address[] } & WithProgram): TransactionInstruction {
  return ix(
    a.programId,
    [
      writable(findCoinPda(a.mint, a.programId)[0]),
      writable(findVaultPda(a.mint, a.programId)[0]),
      readonly(SYSTEM_PROGRAM_ID),
      ...a.recipients.map(writable),
    ],
    data('crank', 0),
  );
}
