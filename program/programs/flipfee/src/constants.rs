//! Seeds, hard bounds and the pump.fun addresses the program reads.

use anchor_lang::prelude::*;

/// `Config` PDA: `["config"]`.
pub const CONFIG_SEED: &[u8] = b"config";
/// `Coin` PDA: `["coin", mint]`.
pub const COIN_SEED: &[u8] = b"coin";
/// Vault PDA: `["vault", mint]`, a system-owned account with no data. It is the coin's only pump.fun shareholder
/// (100%), so pump pays the coin's creator fees into it in lamports.
pub const VAULT_SEED: &[u8] = b"vault";

/// Basis points in one whole.
pub const BPS: u64 = 10_000;
/// flipfee's cut of an hour sale is at most 10%.
pub const MAX_FEE_BPS: u16 = 1_000;
/// Seconds in one sold hour.
pub const HOUR: i64 = 3_600;
/// Hours per `buy`.
pub const MIN_HOURS: u8 = 1;
pub const MAX_HOURS: u8 = 12;
/// Price per hour: 0.01 SOL ..= 1,000 SOL.
pub const MIN_PRICE: u64 = 10_000_000;
pub const MAX_PRICE: u64 = 1_000_000_000_000;
/// How far ahead hours can be sold (seconds from now to the end of the last sold hour): 1 h ..= 48 h.
pub const MIN_MAX_AHEAD: u32 = 3_600;
pub const MAX_MAX_AHEAD: u32 = 172_800;
/// Windows a coin keeps at once (live, queued, and ended ones not yet paid).
pub const MAX_WINDOWS: usize = 32;
/// Fees (lamports) that may still wait at pump when `buy` runs: a small change in pump's distribute or sweep must not
/// stop sales. A buyer who skips collecting pump's fees can take at most this much (about two transaction fees).
pub const PENDING_TOLERANCE: u64 = 10_000;

// ── pump.fun (mainnet program ids; the same ids are cloned into the local test validator) ──

/// pump.fun bonding-curve program.
pub const PUMP_PROGRAM_ID: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
/// Pump Fees program (fee sharing).
pub const PUMP_FEES_PROGRAM_ID: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
/// PumpSwap (where a graduated coin trades).
pub const PUMP_AMM_PROGRAM_ID: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
/// SPL Token and Token-2022 (a pump mint is owned by one of them).
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// Wrapped SOL. pump writes `Pubkey::default()` as the quote mint of a SOL-paired curve; WSOL is accepted too.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// SPL associated token account program (PumpSwap's creator vault is an ATA).
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// pump `["creator-vault", creator]`: where curve creator fees wait until pump distributes them.
pub const PUMP_CREATOR_VAULT_SEED: &[u8] = b"creator-vault";
/// PumpSwap `["creator_vault", coin_creator]`: authority of the WSOL account where AMM creator fees wait.
pub const AMM_CREATOR_VAULT_SEED: &[u8] = b"creator_vault";
/// Pump Fees `SharingConfig` PDA seed: `["sharing-config", mint]`.
pub const SHARING_CONFIG_SEED: &[u8] = b"sharing-config";
/// pump `BondingCurve` PDA seed: `["bonding-curve", mint]`.
pub const BONDING_CURVE_SEED: &[u8] = b"bonding-curve";
/// Anchor discriminators of the pump accounts (from pump-public-docs idl/pump_fees.json and idl/pump.json).
pub const SHARING_CONFIG_DISCRIMINATOR: [u8; 8] = [216, 74, 9, 0, 56, 140, 93, 75];
pub const BONDING_CURVE_DISCRIMINATOR: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];
pub const POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
