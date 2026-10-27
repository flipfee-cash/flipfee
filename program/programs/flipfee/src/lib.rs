//! # flipfee
//!
//! A market for one pump.fun coin's creator fees, sold by the hour (DESIGN.md §2.1). pump.fun allows one fee split
//! per coin, so a coin joins once: its dev sets the split to 100% → the coin's flipfee vault (`["vault", mint]`, a
//! system-owned PDA). From then on every fee pump pays into the vault is allocated by this program, by the second:
//! to the buyer of the hour while a sold hour runs, to the dev the rest of the time. Buyers pay the dev for each
//! hour at once (minus flipfee's `fee_bps`). `crank` (permissionless, about every 60 s) pays everyone out.
//!
//! Money only moves to the coin owner, the hour buyers and the treasury (the fee on sales). The admin has no path
//! to vault money; the owner has no path to a buyer's fees.

#![allow(unexpected_cfgs)]

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod pump;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use errors::FlipfeeError;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("D6sPTL4KkP6bc1QpC33h8f5MKEALJtRmB89f8H4CbpjW");

#[program]
pub mod flipfee {
    use super::*;

    /// One-time setup, signed by the program's upgrade authority (who becomes the admin).
    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        instructions::admin::handle_initialize(ctx, fee_bps)
    }

    /// Admin: treasury (the account passed), fee on hour sales (≤ 1000 bps), pause of `register` and `buy`.
    pub fn set_config(ctx: Context<SetConfig>, fee_bps: u16, paused: bool) -> Result<()> {
        instructions::admin::handle_set_config(ctx, fee_bps, paused)
    }

    /// Admin: hands the admin role to `new_admin` (addition to DESIGN §2.1).
    pub fn set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::handle_set_admin(ctx, new_admin)
    }

    /// Dev (the coin's pump.fun fee sharing admin): joins a coin whose final pump split sends 100% to the vault.
    pub fn register(ctx: Context<Register>, price: u64, max_ahead: u32) -> Result<()> {
        instructions::register::handle_register(ctx, price, max_ahead)
    }

    /// Owner: price per hour, hours ahead (seconds), pause of sales.
    pub fn set_terms(ctx: Context<SetTerms>, price: u64, max_ahead: u32, paused: bool) -> Result<()> {
        instructions::terms::handle_set_terms(ctx, price, max_ahead, paused)
    }

    /// Owner and new owner (both sign): hands the coin to `new_owner` (pays the old owner what it is owed first).
    pub fn transfer_owner(ctx: Context<TransferOwner>) -> Result<()> {
        instructions::terms::handle_transfer_owner(ctx)
    }

    /// Buyer: `hours` (1..=12) hours of the coin's fees at the coin's price (at most `max_price` per hour), starting
    /// no later than `max_start` (unix seconds). pump's fees of the coin must be collected first in the transaction.
    pub fn buy(ctx: Context<Buy>, hours: u8, max_price: u64, max_start: i64) -> Result<()> {
        instructions::buy::handle_buy(ctx, hours, max_price, max_start)
    }

    /// Anyone: allocate new vault lamports by the second, pay the owner and the holders passed as remaining
    /// accounts (writable), drop finished windows.
    pub fn crank<'info>(ctx: Context<'info, Crank<'info>>) -> Result<()> {
        instructions::crank::handle_crank(ctx)
    }
}
