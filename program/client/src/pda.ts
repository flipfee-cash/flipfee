import { PublicKey } from '@solana/web3.js';

import { type Address, toPublicKey } from './codec.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BPF_LOADER_UPGRADEABLE_ID,
  COIN_SEED,
  CONFIG_SEED,
  FLIPFEE_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEES_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  VAULT_SEED,
  WSOL_MINT,
} from './constants.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const find = (seeds: Uint8Array[], program: PublicKey): [PublicKey, number] => PublicKey.findProgramAddressSync(seeds, program);
const k = (a: Address): Uint8Array => toPublicKey(a).toBytes();

// ── flipfee ──

/** `Config` PDA: `["config"]`. */
export function findConfigPda(programId: Address = FLIPFEE_PROGRAM_ID): [PublicKey, number] {
  return find([CONFIG_SEED], toPublicKey(programId));
}

/** `Coin` PDA: `["coin", mint]`. */
export function findCoinPda(mint: Address, programId: Address = FLIPFEE_PROGRAM_ID): [PublicKey, number] {
  return find([COIN_SEED, k(mint)], toPublicKey(programId));
}

/** Vault PDA: `["vault", mint]`, a system account with no data; the coin's 100% pump.fun shareholder. */
export function findVaultPda(mint: Address, programId: Address = FLIPFEE_PROGRAM_ID): [PublicKey, number] {
  return find([VAULT_SEED, k(mint)], toPublicKey(programId));
}

/** The program's ProgramData account (upgradeable loader), needed by `initialize`. */
export function findProgramDataAddress(programId: Address = FLIPFEE_PROGRAM_ID): PublicKey {
  return find([k(programId)], BPF_LOADER_UPGRADEABLE_ID)[0];
}

// ── pump.fun ──

export function getAta(owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM_ID): PublicKey {
  return find([k(owner), k(tokenProgram), k(mint)], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

export function findPumpGlobalPda(): [PublicKey, number] {
  return find([utf8('global')], PUMP_PROGRAM_ID);
}

/** pump `["bonding-curve", mint]`. */
export function findBondingCurvePda(mint: Address): [PublicKey, number] {
  return find([utf8('bonding-curve'), k(mint)], PUMP_PROGRAM_ID);
}

/** Pump Fees `["sharing-config", mint]`. */
export function findSharingConfigPda(mint: Address): [PublicKey, number] {
  return find([utf8('sharing-config'), k(mint)], PUMP_FEES_PROGRAM_ID);
}

/** pump `["creator-vault", creator]`: where the curve's creator fees accrue (creator = the sharing config after
 * fee sharing is set up). */
export function findPumpCreatorVaultPda(creator: Address): [PublicKey, number] {
  return find([utf8('creator-vault'), k(creator)], PUMP_PROGRAM_ID);
}

/** `["__event_authority"]` of an Anchor program with `#[event_cpi]`. */
export function findEventAuthorityPda(program: Address): [PublicKey, number] {
  return find([utf8('__event_authority')], toPublicKey(program));
}

/** Pump Fees `["fee_config", program]`. */
export function findFeeConfigPda(forProgram: Address): [PublicKey, number] {
  return find([utf8('fee_config'), k(forProgram)], PUMP_FEES_PROGRAM_ID);
}

/** pump `["pool-authority", mint]`: the creator of a graduated coin's canonical PumpSwap pool. */
export function findPoolAuthorityPda(mint: Address): [PublicKey, number] {
  return find([utf8('pool-authority'), k(mint)], PUMP_PROGRAM_ID);
}

/** PumpSwap canonical pool `["pool", 0u16, pool_authority, mint, quote_mint]`. */
export function findCanonicalPoolPda(mint: Address, quoteMint: Address = WSOL_MINT): [PublicKey, number] {
  const index = new Uint8Array(2);
  return find([utf8('pool'), index, findPoolAuthorityPda(mint)[0].toBytes(), k(mint), k(quoteMint)], PUMP_AMM_PROGRAM_ID);
}

/** PumpSwap `["creator_vault", coin_creator]`: authority of the WSOL account where AMM creator fees accrue. */
export function findAmmCreatorVaultAuthorityPda(coinCreator: Address): [PublicKey, number] {
  return find([utf8('creator_vault'), k(coinCreator)], PUMP_AMM_PROGRAM_ID);
}

/** The WSOL account holding a graduated coin's unswept AMM creator fees. */
export function getAmmCreatorVaultAta(coinCreator: Address): PublicKey {
  return getAta(findAmmCreatorVaultAuthorityPda(coinCreator)[0], WSOL_MINT, TOKEN_PROGRAM_ID);
}
