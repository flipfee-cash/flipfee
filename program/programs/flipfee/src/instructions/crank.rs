use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::FlipfeeError,
    events::{FeesSynced, PayKind, Paid, WindowDone},
    instructions::vault::{can_receive, pay_from_vault},
    state::{Coin, Synced},
};

/// Permissionless: allocate what arrived from pump since the last sync, pay the owner and the holders passed in
/// `remaining_accounts`, and drop finished windows. The keeper runs it about every 60 s, right after pump's
/// `distribute_creator_fees_v2` in the same transaction.
#[derive(Accounts)]
pub struct Crank<'info> {
    #[account(mut)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: the coin's vault PDA (seeds checked with the stored bump).
    #[account(mut, seeds = [VAULT_SEED, coin.mint.as_ref()], bump = coin.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Emits `FeesSynced` for a sync that allocated something.
pub fn emit_synced(coin: &Coin, coin_key: Pubkey, s: Option<Synced>, now: i64) {
    if let Some(s) = s {
        emit!(FeesSynced {
            mint: coin.mint,
            coin: coin_key,
            amount: s.amount,
            from: s.from,
            to: s.to,
            to_owner: s.to_owner,
            to_windows: s.to_windows,
            at: now,
        });
    }
}

/// Drops finished windows (ended before `last_sync`, nothing owed) and emits `WindowDone` for each.
pub fn prune_and_emit(coin: &mut Coin, coin_key: Pubkey, now: i64) {
    let mint = coin.mint;
    for w in coin.prune() {
        emit!(WindowDone {
            mint,
            coin: coin_key,
            holder: w.holder,
            start: w.start,
            end: w.end,
            earned: w.earned,
            at: now,
        });
    }
}

pub fn handle_crank<'info>(ctx: Context<'info, Crank<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rent_min = Rent::get()?.minimum_balance(0);
    let coin_key = ctx.accounts.coin.key();
    let vault = ctx.accounts.vault.to_account_info();

    let synced = ctx.accounts.coin.sync(vault.lamports(), rent_min, now)?;
    emit_synced(&ctx.accounts.coin, coin_key, synced, now);

    let coin = &mut ctx.accounts.coin;
    let mint = coin.mint;
    for to in ctx.remaining_accounts.iter() {
        let key = to.key();
        let owner_part = if key == coin.owner { coin.owner_owed } else { 0 };
        let mut holder_part: u64 = 0;
        for w in coin.windows.iter().filter(|w| w.holder == key) {
            holder_part = holder_part.checked_add(w.owed).ok_or(FlipfeeError::MathOverflow)?;
        }
        let amount = owner_part.checked_add(holder_part).ok_or(FlipfeeError::MathOverflow)?;
        if amount == 0 {
            continue; // not a recipient, nothing owed, or a duplicate already paid
        }
        require!(to.is_writable, FlipfeeError::RecipientNotWritable);
        if !can_receive(to, amount)? {
            continue; // stays owed until the account can take it
        }
        if vault.lamports().saturating_sub(amount) < rent_min {
            continue; // only if the Rent sysvar rose: stays owed until new fees refill the vault's floor
        }
        pay_from_vault(&vault, to, &mint, coin.vault_bump, rent_min, amount)?;
        if owner_part > 0 {
            coin.owner_owed = 0;
            emit!(Paid { mint, coin: coin_key, to: key, amount: owner_part, kind: PayKind::Owner, at: now });
        }
        if holder_part > 0 {
            for w in coin.windows.iter_mut().filter(|w| w.holder == key) {
                w.owed = 0;
            }
            emit!(Paid { mint, coin: coin_key, to: key, amount: holder_part, kind: PayKind::Holder, at: now });
        }
        coin.credited = coin.credited.checked_sub(amount).ok_or(FlipfeeError::MathOverflow)?;
        coin.paid_out = coin.paid_out.checked_add(amount).ok_or(FlipfeeError::MathOverflow)?;
    }

    prune_and_emit(coin, coin_key, now);
    Ok(())
}
