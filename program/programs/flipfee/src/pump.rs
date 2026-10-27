//! Read-only views of the two pump.fun accounts flipfee checks. Parsed by hand from the raw bytes (no CPI, no
//! pump crate): the layouts are the Anchor/Borsh layouts of pump-public-docs `idl/pump_fees.json` (`SharingConfig`)
//! and `idl/pump.json` (`BondingCurve`). pump appends fields to these accounts over time, so trailing fields that an
//! older (shorter) account lacks read as their defaults, as pump's own docs prescribe.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::FlipfeeError};

/// `SharingConfig` (Pump Fees): `bump u8, version u8, status u8 (0 Paused, 1 Active), mint, admin,
/// admin_revoked bool, shareholders Vec<{address, share_bps u16}>`.
///
/// Mainnet facts (read 2026-10-06, see client/README.md): pump keeps `admin` set after `update_fee_shares(_v2)`
/// revokes it (`admin_revoked = true`), and `admin` is the key that signed that update. flipfee uses it as the
/// ownership proof in `register`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SharingConfigView {
    pub bump: u8,
    pub version: u8,
    pub active: bool,
    pub mint: Pubkey,
    pub admin: Pubkey,
    pub admin_revoked: bool,
    pub shareholders: u32,
    /// First shareholder `(address, share_bps)`, if any.
    pub first: Option<(Pubkey, u16)>,
}

impl SharingConfigView {
    /// The split sends 100% to `vault` and nothing to anyone else.
    pub fn routes_only_to(&self, vault: &Pubkey) -> bool {
        self.shareholders == 1 && self.first == Some((*vault, BPS as u16))
    }
}

fn key_at(d: &[u8], off: usize) -> Pubkey {
    let mut b = [0u8; 32];
    b.copy_from_slice(&d[off..off + 32]);
    Pubkey::new_from_array(b)
}

pub fn read_sharing_config(info: &AccountInfo) -> Result<SharingConfigView> {
    require_keys_eq!(*info.owner, PUMP_FEES_PROGRAM_ID, FlipfeeError::NotSharingConfig);
    let d = info.try_borrow_data()?;
    require!(d.len() >= 80, FlipfeeError::NotSharingConfig);
    require!(d[..8] == SHARING_CONFIG_DISCRIMINATOR, FlipfeeError::NotSharingConfig);
    let shareholders = u32::from_le_bytes([d[76], d[77], d[78], d[79]]);
    let first = if shareholders >= 1 && d.len() >= 80 + 34 {
        Some((key_at(&d, 80), u16::from_le_bytes([d[112], d[113]])))
    } else {
        None
    };
    Ok(SharingConfigView {
        bump: d[8],
        version: d[9],
        active: d[10] == 1,
        mint: key_at(&d, 11),
        admin: key_at(&d, 43),
        admin_revoked: d[75] != 0,
        shareholders,
        first,
    })
}

/// `BondingCurve` (pump): `virtual_token_reserves, virtual_quote_reserves, real_token_reserves,
/// real_quote_reserves, token_total_supply (u64 ×5), complete bool, creator, is_mayhem_mode bool,
/// is_cashback_coin bool, quote_mint, creator_fee_bps u64, can_edit_creator_fee bool, is_holder_reward bool`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BondingCurveView {
    pub complete: bool,
    pub creator: Pubkey,
    pub is_cashback_coin: bool,
    /// `Pubkey::default()` on a SOL-paired coin (and on curves written before the field existed).
    pub quote_mint: Pubkey,
    pub is_holder_reward: bool,
}

impl BondingCurveView {
    pub fn sol_paired(&self) -> bool {
        self.quote_mint == Pubkey::default() || self.quote_mint == WSOL_MINT
    }
}

pub fn read_bonding_curve(info: &AccountInfo) -> Result<BondingCurveView> {
    require_keys_eq!(*info.owner, PUMP_PROGRAM_ID, FlipfeeError::NotBondingCurve);
    let d = info.try_borrow_data()?;
    require!(d.len() >= 81, FlipfeeError::NotBondingCurve);
    require!(d[..8] == BONDING_CURVE_DISCRIMINATOR, FlipfeeError::NotBondingCurve);
    Ok(BondingCurveView {
        complete: d[48] != 0,
        creator: key_at(&d, 49),
        is_cashback_coin: d.len() > 82 && d[82] != 0,
        quote_mint: if d.len() >= 115 { key_at(&d, 83) } else { Pubkey::default() },
        is_holder_reward: d.len() > 124 && d[124] != 0,
    })
}

/// PumpSwap `Pool`: `pool_bump u8, index u16, creator, base_mint, quote_mint, lp_mint, pool_base_token_account,
/// pool_quote_token_account, lp_supply u64, coin_creator, …` (idl/pump_amm.json).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolView {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    /// Where AMM creator fees go; set only on canonical pools (`Pubkey::default()` on any other pool).
    pub coin_creator: Pubkey,
    pub is_holder_reward: bool,
}

pub fn read_pool(info: &AccountInfo) -> Result<PoolView> {
    require_keys_eq!(*info.owner, PUMP_AMM_PROGRAM_ID, FlipfeeError::PoolNotRouted);
    let d = info.try_borrow_data()?;
    require!(d.len() >= 243, FlipfeeError::PoolNotRouted);
    require!(d[..8] == POOL_DISCRIMINATOR, FlipfeeError::PoolNotRouted);
    Ok(PoolView {
        base_mint: key_at(&d, 43),
        quote_mint: key_at(&d, 75),
        coin_creator: key_at(&d, 211),
        is_holder_reward: d.len() > 270 && d[270] != 0,
    })
}

/// The curve's routing: it pays its creator fees to the sharing config; SOL-paired; not a cashback coin. Once the
/// curve is complete (graduated), most fees come from PumpSwap, so the coin's pool must pay the sharing config too
/// (`pool` is the canonical pool; ignored before graduation). Only canonical pools carry a `coin_creator`, so a pool
/// of this mint paying the sharing config is the one trades use.
pub fn check_curve_and_pool(
    sharing_key: &Pubkey,
    curve: &AccountInfo,
    pool: &AccountInfo,
    mint: &Pubkey,
) -> Result<BondingCurveView> {
    let bc = read_bonding_curve(curve)?;
    require_keys_eq!(bc.creator, *sharing_key, FlipfeeError::CurveNotRouted);
    require!(bc.sol_paired(), FlipfeeError::NotSolPaired);
    require!(!bc.is_cashback_coin, FlipfeeError::CashbackCoin);
    require!(!bc.is_holder_reward, FlipfeeError::HolderRewardCoin);
    if bc.complete {
        let p = read_pool(pool)?;
        require_keys_eq!(p.base_mint, *mint, FlipfeeError::PoolNotRouted);
        require!(p.quote_mint == WSOL_MINT, FlipfeeError::PoolNotRouted);
        require_keys_eq!(p.coin_creator, *sharing_key, FlipfeeError::PoolNotRouted);
        require!(!p.is_holder_reward, FlipfeeError::HolderRewardCoin);
    }
    Ok(bc)
}

/// Fees still waiting at pump for this coin would be allocated to the time after the next sync, so a purchase made
/// before they are collected could take fees earned before it. `buy` therefore requires them collected (the app puts
/// PumpSwap's sweep and pump's distribute right before `buy`): pump's creator vault holds no more than its rent, and,
/// once graduated, PumpSwap's creator vault holds no WSOL (both up to `PENDING_TOLERANCE`). Both addresses are
/// derived here, so they cannot be faked.
pub fn check_fees_collected(
    sharing_key: &Pubkey,
    pump_vault: &AccountInfo,
    amm_vault: &AccountInfo,
    graduated: bool,
    rent_min: u64,
) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(&[PUMP_CREATOR_VAULT_SEED, sharing_key.as_ref()], &PUMP_PROGRAM_ID);
    require_keys_eq!(pump_vault.key(), expected, FlipfeeError::WrongPumpVault);
    let floor = rent_min.checked_add(PENDING_TOLERANCE).ok_or(FlipfeeError::MathOverflow)?;
    require_gte!(floor, pump_vault.lamports(), FlipfeeError::FeesNotCollected);
    if graduated {
        let (authority, _) = Pubkey::find_program_address(&[AMM_CREATOR_VAULT_SEED, sharing_key.as_ref()], &PUMP_AMM_PROGRAM_ID);
        let (ata, _) = Pubkey::find_program_address(
            &[authority.as_ref(), TOKEN_PROGRAM_ID.as_ref(), WSOL_MINT.as_ref()],
            &ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        require_keys_eq!(amm_vault.key(), ata, FlipfeeError::WrongPumpVault);
        if *amm_vault.owner == TOKEN_PROGRAM_ID {
            let d = amm_vault.try_borrow_data()?;
            if d.len() >= 72 {
                let amount = u64::from_le_bytes(d[64..72].try_into().map_err(|_| error!(FlipfeeError::MathOverflow))?);
                require!(amount <= PENDING_TOLERANCE, FlipfeeError::FeesNotCollected);
            }
        }
    }
    Ok(())
}

/// The routing every sale relies on: the bonding curve (and, once graduated, the PumpSwap pool) pays its creator
/// fees to the sharing config, the sharing config is active and sends 100% to the vault. A pump.fun admin action
/// (community takeover) can change this; `buy` checks it again so nobody buys hours of a coin whose fees no longer
/// reach the vault.
pub fn check_routing(
    sharing: &AccountInfo,
    curve: &AccountInfo,
    pool: &AccountInfo,
    mint: &Pubkey,
    vault: &Pubkey,
) -> Result<(SharingConfigView, BondingCurveView)> {
    let sc = read_sharing_config(sharing)?;
    require_keys_eq!(sc.mint, *mint, FlipfeeError::NotSharingConfig);
    require!(sc.active, FlipfeeError::SharingNotActive);
    require!(sc.routes_only_to(vault), FlipfeeError::SplitNotToVault);
    let bc = check_curve_and_pool(&sharing.key(), curve, pool, mint)?;
    Ok((sc, bc))
}
