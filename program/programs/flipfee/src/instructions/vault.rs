//! Lamport moves out of the vault: a system-owned PDA with no data, so the System program debits it with the
//! program's PDA signature.

use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};

use crate::{constants::VAULT_SEED, errors::FlipfeeError};

/// Pays `amount` from the vault to `to`, never below the vault's rent-exempt minimum.
pub fn pay_from_vault<'info>(
    vault: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    mint: &Pubkey,
    vault_bump: u8,
    rent_min: u64,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let left = vault.lamports().checked_sub(amount).ok_or(FlipfeeError::VaultShort)?;
    require_gte!(left, rent_min, FlipfeeError::VaultShort);
    let bump = [vault_bump];
    let seeds: &[&[u8]] = &[VAULT_SEED, mint.as_ref(), &bump];
    transfer(
        CpiContext::new_with_signer(System::id(), Transfer { from: vault.clone(), to: to.clone() }, &[seeds]),
        amount,
    )
}

/// True when `to` can take `amount` and stay (or become) rent-exempt, so the System transfer cannot fail the
/// runtime's rent check. Executable accounts never take lamports.
pub fn can_receive(to: &AccountInfo, amount: u64) -> Result<bool> {
    if to.executable {
        return Ok(false);
    }
    let after = to.lamports().checked_add(amount).ok_or(FlipfeeError::MathOverflow)?;
    Ok(after >= Rent::get()?.minimum_balance(to.data_len()))
}
