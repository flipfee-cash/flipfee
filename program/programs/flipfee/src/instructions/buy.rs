use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};

use crate::{
    constants::*,
    errors::FlipfeeError,
    events::HoursBought,
    instructions::{
        crank::{emit_synced, prune_and_emit},
        vault::can_receive,
    },
    pump::{check_fees_collected, check_routing},
    state::{bps_of, Coin, Config, Window},
};

/// A buyer buys `hours` hours of the coin's fees, starting now or right after the last sold hour.
///
/// The app puts PumpSwap's `transfer_creator_fees_to_pump_v2` (graduated coins) and pump's
/// `distribute_creator_fees_v2` right before this in the same transaction: fees earned before the purchase must reach
/// the vault and be allocated (by the sync below) before the new hours start. `buy` refuses while pump still holds
/// fees of the coin (`FeesNotCollected`), so a buyer cannot skip that step and take them.
#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: the coin's vault PDA (seeds checked with the stored bump); read for the sync.
    #[account(seeds = [VAULT_SEED, coin.mint.as_ref()], bump = coin.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: receives the sale minus the fee; must be `coin.owner`.
    #[account(mut, address = coin.owner @ FlipfeeError::WrongOwner)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: receives the fee; must be `config.treasury`.
    #[account(mut, address = config.treasury @ FlipfeeError::WrongTreasury)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: the coin's pump.fun sharing config, parsed by `check_routing` (protects the buyer: the hours only
    /// sell while the coin's fees still route to the vault).
    pub sharing_config: UncheckedAccount<'info>,
    /// CHECK: the coin's pump.fun bonding curve, parsed by `check_routing`.
    pub bonding_curve: UncheckedAccount<'info>,
    /// CHECK: the coin's canonical PumpSwap pool, parsed by `check_routing` once the curve is complete (ignored
    /// before; it may not exist yet).
    pub pool: UncheckedAccount<'info>,
    /// CHECK: pump `["creator-vault", sharing_config]`; address derived and balance checked by
    /// `check_fees_collected`.
    pub pump_creator_vault: UncheckedAccount<'info>,
    /// CHECK: PumpSwap's WSOL creator vault of the sharing config; address derived and balance checked by
    /// `check_fees_collected` once the curve is complete (ignored before).
    pub amm_creator_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_buy(ctx: Context<Buy>, hours: u8, max_price: u64, max_start: i64) -> Result<()> {
    require!(!ctx.accounts.config.paused, FlipfeeError::Paused);
    require!(!ctx.accounts.coin.paused, FlipfeeError::CoinPaused);
    require!((MIN_HOURS..=MAX_HOURS).contains(&hours), FlipfeeError::BadHours);
    let price = ctx.accounts.coin.price;
    require_gte!(max_price, price, FlipfeeError::PriceAboveMax);
    let mint = ctx.accounts.coin.mint;
    let sharing_key = ctx.accounts.sharing_config.key();
    let (_, curve) = check_routing(
        &ctx.accounts.sharing_config.to_account_info(),
        &ctx.accounts.bonding_curve.to_account_info(),
        &ctx.accounts.pool.to_account_info(),
        &mint,
        &ctx.accounts.vault.key(),
    )?;
    let rent_min = Rent::get()?.minimum_balance(0);
    check_fees_collected(
        &sharing_key,
        &ctx.accounts.pump_creator_vault.to_account_info(),
        &ctx.accounts.amm_creator_vault.to_account_info(),
        curve.complete,
        rent_min,
    )?;

    // Sync first: fees that arrived before this purchase belong to the time before it.
    let now = Clock::get()?.unix_timestamp;
    let coin_key = ctx.accounts.coin.key();
    let synced = ctx.accounts.coin.sync(ctx.accounts.vault.lamports(), rent_min, now)?;
    emit_synced(&ctx.accounts.coin, coin_key, synced, now);
    prune_and_emit(&mut ctx.accounts.coin, coin_key, now);

    let coin = &ctx.accounts.coin;
    require!(coin.windows.len() < MAX_WINDOWS, FlipfeeError::QueueFull);
    let start = coin.next_start(now);
    require_gte!(max_start, start, FlipfeeError::StartsTooLate);
    let end = i64::from(hours)
        .checked_mul(HOUR)
        .and_then(|d| start.checked_add(d))
        .ok_or(FlipfeeError::MathOverflow)?;
    let ahead = end.checked_sub(now).ok_or(FlipfeeError::MathOverflow)?;
    require_gte!(i64::from(coin.max_ahead), ahead, FlipfeeError::TooFarAhead);

    let total = price.checked_mul(u64::from(hours)).ok_or(FlipfeeError::MathOverflow)?;
    let mut fee = bps_of(total, ctx.accounts.config.fee_bps)?;
    let treasury = ctx.accounts.treasury.to_account_info();
    if fee > 0 && !can_receive(&treasury, fee)? {
        fee = 0; // an emptied treasury cannot take a fee below rent: the owner gets it, the sale goes through
    }
    let to_owner = total.checked_sub(fee).ok_or(FlipfeeError::MathOverflow)?;
    let buyer = ctx.accounts.buyer.to_account_info();
    transfer(
        CpiContext::new(System::id(), Transfer { from: buyer.clone(), to: ctx.accounts.owner.to_account_info() }),
        to_owner,
    )?;
    if fee > 0 {
        transfer(CpiContext::new(System::id(), Transfer { from: buyer, to: treasury }), fee)?;
    }

    let holder = ctx.accounts.buyer.key();
    let coin = &mut ctx.accounts.coin;
    coin.windows.push(Window { holder, start, end, owed: 0, earned: 0 });
    coin.sales = coin.sales.checked_add(total).ok_or(FlipfeeError::MathOverflow)?;
    coin.hours_sold = coin.hours_sold.checked_add(u32::from(hours)).ok_or(FlipfeeError::MathOverflow)?;

    emit!(HoursBought {
        mint,
        coin: coin_key,
        buyer: holder,
        start,
        end,
        hours,
        price,
        total,
        to_owner,
        fee,
        windows: u8::try_from(coin.windows.len()).map_err(|_| error!(FlipfeeError::MathOverflow))?,
        at: now,
    });
    Ok(())
}
