use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};

use crate::{
    constants::*,
    errors::FlipfeeError,
    events::Registered,
    pump::{check_curve_and_pool, read_sharing_config},
    state::{check_max_ahead, check_price, Coin, Config},
};

/// The dev joins a coin whose pump.fun split already sends 100% to the flipfee vault (the app puts
/// `create_fee_sharing_config` and `update_fee_shares_v2` before this in the same transaction).
#[derive(Accounts)]
pub struct Register<'info> {
    /// The pump.fun fee sharing admin of the coin (the key that set the final split).
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = owner,
        space = 8 + Coin::INIT_SPACE,
        seeds = [COIN_SEED, mint.key().as_ref()],
        bump,
    )]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: the vault PDA (seeds checked); the handler checks it is a system account with no data.
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the pump.fun mint; the handler checks a token program owns it. The sharing config ties it to the coin.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Pump Fees PDA `["sharing-config", mint]` (seeds checked); parsed by `read_sharing_config`.
    #[account(seeds = [SHARING_CONFIG_SEED, mint.key().as_ref()], bump, seeds::program = PUMP_FEES_PROGRAM_ID)]
    pub sharing_config: UncheckedAccount<'info>,
    /// CHECK: pump PDA `["bonding-curve", mint]` (seeds checked); parsed by `check_curve_and_pool`.
    #[account(seeds = [BONDING_CURVE_SEED, mint.key().as_ref()], bump, seeds::program = PUMP_PROGRAM_ID)]
    pub bonding_curve: UncheckedAccount<'info>,
    /// CHECK: the canonical PumpSwap pool of the mint; parsed only if the curve is complete (graduated).
    pub pool: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register(ctx: Context<Register>, price: u64, max_ahead: u32) -> Result<()> {
    require!(!ctx.accounts.config.paused, FlipfeeError::Paused);
    check_price(price)?;
    check_max_ahead(max_ahead)?;

    let mint_info = ctx.accounts.mint.to_account_info();
    require!(
        *mint_info.owner == TOKEN_PROGRAM_ID || *mint_info.owner == TOKEN_2022_PROGRAM_ID,
        FlipfeeError::BadMint
    );
    let mint = mint_info.key();
    let owner = ctx.accounts.owner.key();
    let vault_key = ctx.accounts.vault.key();
    let sharing_key = ctx.accounts.sharing_config.key();

    // Ownership proof: pump keeps `admin` after revoking it (mainnet, 2026-10-06), and only the admin could have
    // set the split. So the signer must be that admin.
    let sc = read_sharing_config(&ctx.accounts.sharing_config.to_account_info())?;
    require_keys_eq!(sc.mint, mint, FlipfeeError::NotSharingConfig);
    require_keys_eq!(sc.admin, owner, FlipfeeError::NotFeeAdmin);
    require!(sc.active, FlipfeeError::SharingNotActive);
    require!(sc.admin_revoked, FlipfeeError::SplitNotFinal);
    require!(sc.routes_only_to(&vault_key), FlipfeeError::SplitNotToVault);
    check_curve_and_pool(
        &sharing_key,
        &ctx.accounts.bonding_curve.to_account_info(),
        &ctx.accounts.pool.to_account_info(),
        &mint,
    )?;

    // The vault must exist (lamports ≥ rent) for pump to pay into it.
    let vault = ctx.accounts.vault.to_account_info();
    require_keys_eq!(*vault.owner, System::id(), FlipfeeError::BadVault);
    require!(vault.data_is_empty(), FlipfeeError::BadVault);
    let rent_min = Rent::get()?.minimum_balance(0);
    let had = vault.lamports();
    let vault_funded = rent_min.saturating_sub(had);
    if vault_funded > 0 {
        transfer(
            CpiContext::new(
                System::id(),
                Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: vault.clone(),
                },
            ),
            vault_funded,
        )?;
    }
    // Fees that reached the vault before the coin joined are the owner's.
    let carried = had.saturating_sub(rent_min);
    let now = Clock::get()?.unix_timestamp;

    let coin_key = ctx.accounts.coin.key();
    ctx.accounts.coin.set_inner(Coin {
        mint,
        owner,
        bump: ctx.bumps.coin,
        vault_bump: ctx.bumps.vault,
        price,
        max_ahead,
        paused: false,
        last_sync: now,
        owner_owed: carried,
        credited: carried,
        windows: Vec::new(),
        fees_in: carried,
        sales: 0,
        hours_sold: 0,
        paid_out: 0,
    });

    emit!(Registered {
        mint,
        coin: coin_key,
        owner,
        vault: vault_key,
        price,
        max_ahead,
        vault_funded,
        carried,
        at: now,
    });
    Ok(())
}
