use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::FlipfeeError,
    events::ConfigSet,
    program::Flipfee as FlipfeeProgram,
    state::Config,
};

/// One-time setup, signed by the program's upgrade authority (checked against `ProgramData`), so nobody can
/// front-run it between the deploy and the init. The signer becomes the admin.
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: becomes `config.treasury`; the handler checks it is system-owned and rent-exempt.
    pub treasury: UncheckedAccount<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ FlipfeeError::NotUpgradeAuthority)]
    pub program: Program<'info, FlipfeeProgram>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ FlipfeeError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FlipfeeError::NotAdmin)]
    pub config: Account<'info, Config>,
    /// CHECK: becomes `config.treasury`; the handler checks it is system-owned and rent-exempt.
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SetAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FlipfeeError::NotAdmin)]
    pub config: Account<'info, Config>,
}

/// Fees are paid straight to the treasury, so it must be able to take any small credit: a system-owned account
/// (wallet or multisig vault) that is already rent-exempt.
fn check_treasury(info: &AccountInfo) -> Result<()> {
    require_keys_eq!(*info.owner, System::id(), FlipfeeError::BadTreasury);
    require_gte!(
        info.lamports(),
        Rent::get()?.minimum_balance(info.data_len()),
        FlipfeeError::BadTreasury
    );
    Ok(())
}

fn emit_config(c: &Config) -> Result<()> {
    emit!(ConfigSet {
        admin: c.admin,
        treasury: c.treasury,
        fee_bps: c.fee_bps,
        paused: c.paused,
        at: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

pub fn handle_initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, FlipfeeError::BadFeeBps);
    check_treasury(&ctx.accounts.treasury.to_account_info())?;
    let config = &mut ctx.accounts.config;
    config.set_inner(Config {
        admin: ctx.accounts.authority.key(),
        treasury: ctx.accounts.treasury.key(),
        fee_bps,
        paused: false,
        bump: ctx.bumps.config,
    });
    emit_config(config)
}

pub fn handle_set_config(ctx: Context<SetConfig>, fee_bps: u16, paused: bool) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, FlipfeeError::BadFeeBps);
    check_treasury(&ctx.accounts.treasury.to_account_info())?;
    let config = &mut ctx.accounts.config;
    config.treasury = ctx.accounts.treasury.key();
    config.fee_bps = fee_bps;
    config.paused = paused;
    emit_config(config)
}

pub fn handle_set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
    require_keys_neq!(new_admin, Pubkey::default(), FlipfeeError::NotAdmin);
    let config = &mut ctx.accounts.config;
    config.admin = new_admin;
    emit_config(config)
}
