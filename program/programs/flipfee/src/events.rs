//! Events (`emit!`, logged as `Program data: <base64>`), one per state change. `at` is the chain clock
//! (`Clock::unix_timestamp`). Amounts are lamports. `coin` is the Coin PDA, `mint` the pump.fun mint.

use anchor_lang::prelude::*;

/// Emitted by `initialize`, `set_config` and `set_admin` with the full new settings.
#[event]
pub struct ConfigSet {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub paused: bool,
    pub at: i64,
}

/// A coin joined flipfee: its pump.fun split sends 100% to `vault`.
#[event]
pub struct Registered {
    pub mint: Pubkey,
    pub coin: Pubkey,
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub price: u64,
    pub max_ahead: u32,
    /// Lamports the owner put into the vault to make it rent-exempt (0 if it already was).
    pub vault_funded: u64,
    /// Lamports already in the vault above rent (fees that arrived before registering), owed to the owner.
    pub carried: u64,
    pub at: i64,
}

#[event]
pub struct TermsSet {
    pub mint: Pubkey,
    pub coin: Pubkey,
    pub price: u64,
    pub max_ahead: u32,
    pub paused: bool,
    pub at: i64,
}

#[event]
pub struct OwnerTransferred {
    pub mint: Pubkey,
    pub coin: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    /// What was owed to the old owner, paid to it before the change.
    pub paid_to_old_owner: u64,
    pub at: i64,
}

/// A buyer bought `hours` hours: the window `[start, end)` routes 100% of the coin's fees to `buyer`.
#[event]
pub struct HoursBought {
    pub mint: Pubkey,
    pub coin: Pubkey,
    pub buyer: Pubkey,
    pub start: i64,
    pub end: i64,
    pub hours: u8,
    /// Price per hour.
    pub price: u64,
    /// `price × hours`, paid by the buyer.
    pub total: u64,
    /// `total − fee`, paid to the coin owner at once.
    pub to_owner: u64,
    /// `total × fee_bps / 10000` (rounded down), paid to the treasury.
    pub fee: u64,
    /// Windows the coin holds after this purchase (live, queued, and ended ones not yet paid).
    pub windows: u8,
    pub at: i64,
}

/// `amount` lamports arrived in the vault and were allocated over `(from, to]` by overlap seconds.
#[event]
pub struct FeesSynced {
    pub mint: Pubkey,
    pub coin: Pubkey,
    pub amount: u64,
    pub from: i64,
    pub to: i64,
    /// Part allocated to the owner (time outside sold hours, plus rounding remainders).
    pub to_owner: u64,
    /// Part allocated to windows (`amount − to_owner`).
    pub to_windows: u64,
    pub at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PayKind {
    /// Fees outside sold hours, to the coin owner.
    Owner,
    /// Fees of sold hours, to the hour's buyer.
    Holder,
}

/// The vault paid `amount` lamports to `to`.
#[event]
pub struct Paid {
    pub mint: Pubkey,
    pub coin: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    pub kind: PayKind,
    pub at: i64,
}

/// A window ended, was fully allocated and paid, and left the coin's queue. `earned` is its final total.
#[event]
pub struct WindowDone {
    pub mint: Pubkey,
    pub coin: Pubkey,
    pub holder: Pubkey,
    pub start: i64,
    pub end: i64,
    pub earned: u64,
    pub at: i64,
}
