import { PublicKey } from '@solana/web3.js';

import { IDL_ADDRESS } from './generated.js';

/** The flipfee program id. */
export const FLIPFEE_PROGRAM_ID = new PublicKey(IDL_ADDRESS);

// ── Solana programs and mints ──
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111');
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const DEFAULT_PUBKEY = new PublicKey(new Uint8Array(32));

// ── pump.fun ──
export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMP_FEES_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export const CONFIG_SEED = utf8('config');
export const COIN_SEED = utf8('coin');
export const VAULT_SEED = utf8('vault');

/** Account sizes in bytes (8-byte discriminator included). */
export const ACCOUNT_SIZE = { Config: 76, Coin: 2191 } as const;

/** Byte offsets inside a `Coin` account, for getProgramAccounts memcmp filters. */
export const COIN_OFFSETS = { mint: 8, owner: 40 } as const;

// ── bounds (the program enforces the same) ──
export const BPS = 10_000n;
export const HOUR = 3_600;
export const MIN_HOURS = 1;
export const MAX_HOURS = 12;
/** Price per hour, lamports: 0.01 SOL ..= 1000 SOL. */
export const MIN_PRICE = 10_000_000n;
export const MAX_PRICE = 1_000_000_000_000n;
/** How far ahead hours sell (seconds): 1 h ..= 48 h; the app's default is 24 h. */
export const MIN_MAX_AHEAD = 3_600;
export const MAX_MAX_AHEAD = 172_800;
export const DEFAULT_MAX_AHEAD = 86_400;
/** Windows a coin holds at once (live, queued, and ended ones not yet paid). */
export const MAX_WINDOWS = 32;
/** Lamports of pump fees that may still wait uncollected when `buy` runs (more: `FeesNotCollected`). */
export const PENDING_TOLERANCE = 10_000n;
export const MAX_FEE_BPS = 1_000;
export const DEFAULT_FEE_BPS = 500;
/** Rent-exempt minimum of a 0-byte account on mainnet (2026-10: 5080 lamports/byte × 128). Read the Rent sysvar for
 * exact numbers; this is for display. */
export const RENT_MIN_0 = 650_240n;

/**
 * Compute-unit limits per instruction, from the measured maxima (LiteSVM with the mainnet feature set and the
 * mainnet pump binaries, programs/flipfee/tests/cu.rs, and solana-test-validator, client/test/localnet.test.mjs) with
 * headroom: flipfee's PDA bump searches vary by mint, and pump's costs differ a little between runtimes.
 * Measured: register 22.9k–34.9k, buy 16.7k–26.3k (+2 PDA derivations once graduated), crank 5k–8.4k (74.6k: sync
 * over 32 windows + pay 15),
 * pump create_fee_sharing_config 68.8k (125k–138.6k graduated), update_fee_shares_v2 74.6k (94.6k–113.6k graduated),
 * distribute_creator_fees_v2 22.7k–33.6k, transfer_creator_fees_to_pump_v2 42.7k.
 */
export const COMPUTE_UNITS = {
  initialize: 20_000,
  set_config: 8_000,
  set_admin: 7_000,
  register: 60_000,
  set_terms: 6_000,
  transfer_owner: 20_000,
  buy: 50_000,
  /** Covers the worst case (15 recipients over 32 windows); a usual crank uses under 10k. */
  crank: 120_000,
  pump_create_fee_sharing_config: 200_000,
  pump_update_fee_shares: 160_000,
  pump_distribute_creator_fees: 60_000,
  pump_transfer_creator_fees_to_pump: 70_000,
} as const;
