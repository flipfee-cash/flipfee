use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::FlipfeeError,
    events::{OwnerTransferred, PayKind, Paid, TermsSet},
    instructions::{
        crank::{emit_synced, prune_and_emit},
        vault::{can_receive, pay_from_vault},
    },
    state::{check_max_ahead, check_price, Coin},
};

#[derive(Accounts)]
pub struct SetTerms<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ FlipfeeError::NotOwner)]
    pub coin: Box<Account<'info, Coin>>,
}

/// Owner: price per hour, how far ahead hours sell, and pause/resume sales. Sold hours keep their terms.
pub fn handle_set_terms(ctx: Context<SetTerms>, price: u64, max_ahead: u32, paused: bool) -> Result<()> {
    check_price(price)?;
    check_max_ahead(max_ahead)?;
    let coin_key = ctx.accounts.coin.key();
    let coin = &mut ctx.accounts.coin;
    coin.price = price;
    coin.max_ahead = max_ahead;
    coin.paused = paused;
    emit!(TermsSet {
        mint: coin.mint,
        coin: coin_key,
        price,
        max_ahead,
        paused,
        at: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct TransferOwner<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ FlipfeeError::NotOwner)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: the coin's vault PDA (seeds checked with the stored bump).
    #[account(mut, seeds = [VAULT_SEED, coin.mint.as_ref()], bump = coin.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// The new owner signs too: it accepts the coin, and only an account that can sign can receive sales and fees.
    pub new_owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Owner: hands the coin (sales and fees outside sold hours) to `new_owner`. Fees up to now are synced and what the
/// old owner is owed is paid to it first, so no owner money moves to the new owner.
pub fn handle_transfer_owner(ctx: Context<TransferOwner>) -> Result<()> {
    let new_owner = ctx.accounts.new_owner.to_account_info();
    let vault = ctx.accounts.vault.to_account_info();
    require!(!new_owner.executable, FlipfeeError::BadNewOwner);
    require_keys_neq!(new_owner.key(), vault.key(), FlipfeeError::BadNewOwner);
    require_keys_neq!(new_owner.key(), Pubkey::default(), FlipfeeError::BadNewOwner);

    let now = Clock::get()?.unix_timestamp;
    let rent_min = Rent::get()?.minimum_balance(0);
    let coin_key = ctx.accounts.coin.key();
    let synced = ctx.accounts.coin.sync(vault.lamports(), rent_min, now)?;
    emit_synced(&ctx.accounts.coin, coin_key, synced, now);

    let owner = ctx.accounts.owner.to_account_info();
    let coin = &mut ctx.accounts.coin;
    let owed = coin.owner_owed;
    if owed > 0 {
        require!(can_receive(&owner, owed)?, FlipfeeError::OwnerCannotReceive);
        pay_from_vault(&vault, &owner, &coin.mint, coin.vault_bump, rent_min, owed)?;
        coin.owner_owed = 0;
        coin.credited = coin.credited.checked_sub(owed).ok_or(FlipfeeError::MathOverflow)?;
        coin.paid_out = coin.paid_out.checked_add(owed).ok_or(FlipfeeError::MathOverflow)?;
        emit!(Paid { mint: coin.mint, coin: coin_key, to: owner.key(), amount: owed, kind: PayKind::Owner, at: now });
    }
    prune_and_emit(coin, coin_key, now);

    let from = coin.owner;
    coin.owner = new_owner.key();
    emit!(OwnerTransferred {
        mint: coin.mint,
        coin: coin_key,
        from,
        to: coin.owner,
        paid_to_old_owner: owed,
        at: now,
    });
    Ok(())
}
