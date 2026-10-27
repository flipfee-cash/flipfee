//! pump.fun instruction builders for the tests (account lists from pump-public-docs idl/*.json, 2026-10). The
//! programs themselves are the mainnet binaries in fixtures/mainnet/programs.
#![allow(dead_code)]

use anchor_lang::{
    prelude::Pubkey,
    pubkey,
    solana_program::instruction::{AccountMeta, Instruction},
};

pub const PUMP: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMP_AMM: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const PUMP_FEES: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
pub const MAYHEM: Pubkey = pubkey!("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
pub const TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const SYSTEM: Pubkey = pubkey!("11111111111111111111111111111111");
pub const RENT_SYSVAR: Pubkey = pubkey!("SysvarRent111111111111111111111111111111111");

pub fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}
pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    pda(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM)
}
pub fn global() -> Pubkey {
    pda(&[b"global"], &PUMP)
}
pub fn bonding_curve(mint: &Pubkey) -> Pubkey {
    pda(&[b"bonding-curve", mint.as_ref()], &PUMP)
}
pub fn sharing_config(mint: &Pubkey) -> Pubkey {
    pda(&[b"sharing-config", mint.as_ref()], &PUMP_FEES)
}
pub fn creator_vault(creator: &Pubkey) -> Pubkey {
    pda(&[b"creator-vault", creator.as_ref()], &PUMP)
}
pub fn event_authority(program: &Pubkey) -> Pubkey {
    pda(&[b"__event_authority"], program)
}
pub fn fee_config(for_program: &Pubkey) -> Pubkey {
    pda(&[b"fee_config", for_program.as_ref()], &PUMP_FEES)
}
pub fn pool_authority(mint: &Pubkey) -> Pubkey {
    pda(&[b"pool-authority", mint.as_ref()], &PUMP)
}
pub fn canonical_pool(mint: &Pubkey) -> Pubkey {
    pda(&[b"pool", &0u16.to_le_bytes(), pool_authority(mint).as_ref(), mint.as_ref(), WSOL.as_ref()], &PUMP_AMM)
}
pub fn amm_creator_vault_authority(coin_creator: &Pubkey) -> Pubkey {
    pda(&[b"creator_vault", coin_creator.as_ref()], &PUMP_AMM)
}

fn w(k: Pubkey) -> AccountMeta {
    AccountMeta::new(k, false)
}
fn r(k: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}
fn ws(k: Pubkey) -> AccountMeta {
    AccountMeta::new(k, true)
}

fn borsh_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// Fee recipients picked from the mainnet `Global` (fixtures/mainnet/manifest.json roles).
#[derive(Clone, Debug)]
pub struct Recipients {
    pub fee_recipient: Pubkey,
    pub buyback_fee_recipient: Pubkey,
    pub amm_protocol_fee_recipient: Pubkey,
    pub amm_buyback_fee_recipient: Pubkey,
    pub withdraw_authority: Pubkey,
}

/// `create_v2`: a SOL-paired Token-2022 coin, not mayhem, not cashback, not holder-reward.
pub fn create_v2(mint: &Pubkey, user: &Pubkey, creator: &Pubkey, name: &str, symbol: &str) -> Instruction {
    let bc = bonding_curve(mint);
    let sol_vault = pda(&[b"sol-vault"], &MAYHEM);
    let mut data = vec![214, 144, 76, 236, 95, 139, 49, 180];
    borsh_str(&mut data, name);
    borsh_str(&mut data, symbol);
    borsh_str(&mut data, "https://flipfee.test/meta.json");
    data.extend_from_slice(creator.as_ref());
    data.push(0); // is_mayhem_mode
    data.push(0); // is_cashback_enabled: OptionBool(false)
    Instruction {
        program_id: PUMP,
        accounts: vec![
            ws(*mint),
            r(pda(&[b"mint-authority"], &PUMP)),
            w(bc),
            w(ata(&bc, mint, &TOKEN_2022)),
            r(global()),
            ws(*user),
            r(SYSTEM),
            r(TOKEN_2022),
            r(ATA_PROGRAM),
            w(MAYHEM),
            r(pda(&[b"global-params"], &MAYHEM)),
            w(sol_vault),
            w(pda(&[b"mayhem-state", mint.as_ref()], &MAYHEM)),
            w(ata(&sol_vault, mint, &TOKEN_2022)),
            r(event_authority(&PUMP)),
            r(PUMP),
        ],
        data,
    }
}

/// Accounts shared by `buy_v2` and `sell_v2` (SOL-paired coin, Token-2022 base mint).
fn trade_v2_accounts(rc: &Recipients, mint: &Pubkey, user: &Pubkey, curve_creator: &Pubkey, buy: bool) -> Vec<AccountMeta> {
    let bc = bonding_curve(mint);
    let cv = creator_vault(curve_creator);
    let uva = pda(&[b"user_volume_accumulator", user.as_ref()], &PUMP);
    let mut v = vec![
        r(global()),
        r(*mint),
        r(WSOL),
        r(TOKEN_2022),
        r(TOKEN),
        r(ATA_PROGRAM),
        w(rc.fee_recipient),
        w(ata(&rc.fee_recipient, &WSOL, &TOKEN)),
        w(rc.buyback_fee_recipient),
        w(ata(&rc.buyback_fee_recipient, &WSOL, &TOKEN)),
        w(bc),
        w(ata(&bc, mint, &TOKEN_2022)),
        w(ata(&bc, &WSOL, &TOKEN)),
        ws(*user),
        w(ata(user, mint, &TOKEN_2022)),
        w(ata(user, &WSOL, &TOKEN)),
        w(cv),
        w(ata(&cv, &WSOL, &TOKEN)),
        r(sharing_config(mint)),
    ];
    if buy {
        v.push(r(pda(&[b"global_volume_accumulator"], &PUMP)));
    }
    v.extend([
        w(uva),
        w(ata(&uva, &WSOL, &TOKEN)),
        r(fee_config(&PUMP)),
        r(PUMP_FEES),
        r(SYSTEM),
        r(event_authority(&PUMP)),
        r(PUMP),
    ]);
    v
}

/// `buy_v2`: buy `amount` base units, paying at most `max_sol_cost` lamports.
pub fn buy_v2(rc: &Recipients, mint: &Pubkey, user: &Pubkey, curve_creator: &Pubkey, amount: u64, max_sol_cost: u64) -> Instruction {
    let mut data = vec![184, 23, 238, 97, 103, 197, 211, 61];
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&max_sol_cost.to_le_bytes());
    Instruction { program_id: PUMP, accounts: trade_v2_accounts(rc, mint, user, curve_creator, true), data }
}

/// `sell_v2`: sell `amount` base units for at least `min_sol_output` lamports.
pub fn sell_v2(rc: &Recipients, mint: &Pubkey, user: &Pubkey, curve_creator: &Pubkey, amount: u64, min_sol_output: u64) -> Instruction {
    let mut data = vec![93, 246, 130, 60, 231, 233, 64, 178];
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&min_sol_output.to_le_bytes());
    Instruction { program_id: PUMP, accounts: trade_v2_accounts(rc, mint, user, curve_creator, false), data }
}

/// ATA program `CreateIdempotent`.
pub fn create_ata(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![ws(*payer), w(ata(owner, mint, token_program)), r(*owner), r(*mint), r(SYSTEM), r(*token_program)],
        data: vec![1],
    }
}

/// Pump Fees `create_fee_sharing_config` (signer = the coin creator). `pool` for a graduated coin.
pub fn create_fee_sharing_config(payer: &Pubkey, mint: &Pubkey, pool: Option<Pubkey>) -> Instruction {
    let mut accounts = vec![
        r(event_authority(&PUMP_FEES)),
        r(PUMP_FEES),
        ws(*payer),
        r(global()),
        r(*mint),
        w(sharing_config(mint)),
        r(SYSTEM),
        w(bonding_curve(mint)),
        r(PUMP),
        r(event_authority(&PUMP)),
    ];
    match pool {
        Some(p) => accounts.extend([w(p), r(PUMP_AMM), r(event_authority(&PUMP_AMM))]),
        // Anchor optional accounts: the program id in the slot means "none".
        None => accounts.extend([r(PUMP_FEES), r(PUMP_FEES), r(PUMP_FEES)]),
    }
    Instruction { program_id: PUMP_FEES, accounts, data: vec![195, 78, 86, 76, 111, 52, 251, 213] }
}

/// Pump Fees `update_fee_shares_v2` (signer = sharing_config.admin). `current` = the current shareholders (the
/// remaining accounts of the inner distribute), `new` = the final split.
pub fn update_fee_shares_v2(authority: &Pubkey, mint: &Pubkey, current: &[Pubkey], new: &[(Pubkey, u16)]) -> Instruction {
    let sc = sharing_config(mint);
    let cv = creator_vault(&sc);
    let amm_auth = amm_creator_vault_authority(&sc);
    let mut accounts = vec![
        r(event_authority(&PUMP_FEES)),
        r(PUMP_FEES),
        ws(*authority),
        r(global()),
        r(*mint),
        w(sc),
        r(bonding_curve(mint)),
        w(cv),
        w(ata(&cv, &WSOL, &TOKEN)),
        r(SYSTEM),
        r(PUMP),
        r(event_authority(&PUMP)),
        r(PUMP_AMM),
        r(event_authority(&PUMP_AMM)),
        r(WSOL),
        r(TOKEN),
        r(ATA_PROGRAM),
        w(amm_auth),
        w(ata(&amm_auth, &WSOL, &TOKEN)),
    ];
    accounts.extend(current.iter().map(|k| w(*k)));
    let mut data = vec![111, 251, 49, 6, 78, 78, 106, 18];
    data.extend_from_slice(&(new.len() as u32).to_le_bytes());
    for (k, bps) in new {
        data.extend_from_slice(k.as_ref());
        data.extend_from_slice(&bps.to_le_bytes());
    }
    Instruction { program_id: PUMP_FEES, accounts, data }
}

/// Pump Fees `update_fee_shares` (v1, WSOL fixed; what the pump.fun site sent through 2026-09 per mainnet history).
pub fn update_fee_shares_v1(authority: &Pubkey, mint: &Pubkey, current: &[Pubkey], new: &[(Pubkey, u16)]) -> Instruction {
    let sc = sharing_config(mint);
    let cv = creator_vault(&sc);
    let amm_auth = amm_creator_vault_authority(&sc);
    let mut accounts = vec![
        r(event_authority(&PUMP_FEES)),
        r(PUMP_FEES),
        AccountMeta::new_readonly(*authority, true),
        r(global()),
        r(*mint),
        w(sc),
        r(bonding_curve(mint)),
        w(cv),
        r(SYSTEM),
        r(PUMP),
        r(event_authority(&PUMP)),
        r(PUMP_AMM),
        r(event_authority(&PUMP_AMM)),
        r(WSOL),
        r(TOKEN),
        r(ATA_PROGRAM),
        w(amm_auth),
        w(ata(&amm_auth, &WSOL, &TOKEN)),
    ];
    accounts.extend(current.iter().map(|k| w(*k)));
    let mut data = vec![189, 13, 136, 99, 187, 164, 237, 35];
    data.extend_from_slice(&(new.len() as u32).to_le_bytes());
    for (k, bps) in new {
        data.extend_from_slice(k.as_ref());
        data.extend_from_slice(&bps.to_le_bytes());
    }
    Instruction { program_id: PUMP_FEES, accounts, data }
}

/// pump `distribute_creator_fees_v2` (permissionless): pays the creator vault of `sharing_config` to `shareholders`.
pub fn distribute_creator_fees_v2(payer: &Pubkey, mint: &Pubkey, shareholders: &[Pubkey]) -> Instruction {
    let sc = sharing_config(mint);
    let cv = creator_vault(&sc);
    let mut accounts = vec![
        ws(*payer),
        r(*mint),
        r(bonding_curve(mint)),
        r(sc),
        w(cv),
        r(SYSTEM),
        r(event_authority(&PUMP)),
        r(PUMP),
        w(ata(&cv, &WSOL, &TOKEN)),
        r(WSOL),
        r(TOKEN),
        r(ATA_PROGRAM),
    ];
    accounts.extend(shareholders.iter().map(|k| w(*k)));
    Instruction { program_id: PUMP, accounts, data: vec![255, 203, 19, 79, 244, 68, 8, 159, 0] }
}

/// pump `get_minimum_distributable_fee` (simulate it; the answer is the return data).
pub fn get_minimum_distributable_fee(mint: &Pubkey, shareholders: &[Pubkey]) -> Instruction {
    let sc = sharing_config(mint);
    let mut accounts = vec![r(*mint), r(bonding_curve(mint)), r(sc), r(creator_vault(&sc))];
    accounts.extend(shareholders.iter().map(|k| r(*k)));
    Instruction { program_id: PUMP, accounts, data: vec![117, 225, 127, 202, 134, 95, 68, 35] }
}

/// PumpSwap `transfer_creator_fees_to_pump_v2` (permissionless, SOL-paired): AMM creator fees → pump creator vault.
pub fn transfer_creator_fees_to_pump_v2(payer: &Pubkey, coin_creator: &Pubkey) -> Instruction {
    let auth = amm_creator_vault_authority(coin_creator);
    let pcv = creator_vault(coin_creator);
    Instruction {
        program_id: PUMP_AMM,
        accounts: vec![
            ws(*payer),
            r(WSOL),
            r(TOKEN),
            r(SYSTEM),
            r(ATA_PROGRAM),
            r(*coin_creator),
            w(auth),
            w(ata(&auth, &WSOL, &TOKEN)),
            w(pcv),
            w(ata(&pcv, &WSOL, &TOKEN)),
            r(event_authority(&PUMP_AMM)),
            r(PUMP_AMM),
        ],
        data: vec![1, 33, 78, 185, 33, 67, 44, 92],
    }
}

/// pump `migrate_v2` (permissionless): a complete curve → canonical PumpSwap pool.
pub fn migrate_v2(rc: &Recipients, mint: &Pubkey, user: &Pubkey) -> Instruction {
    let bc = bonding_curve(mint);
    let pa = pool_authority(mint);
    let pool = canonical_pool(mint);
    let lp_mint = pda(&[b"pool_lp_mint", pool.as_ref()], &PUMP_AMM);
    let boost = pda(&[b"boost_vault", pool.as_ref()], &PUMP_AMM);
    Instruction {
        program_id: PUMP,
        accounts: vec![
            r(global()),
            w(rc.withdraw_authority),
            r(*mint),
            r(WSOL),
            w(bc),
            w(ata(&bc, mint, &TOKEN_2022)),
            w(ata(&bc, &WSOL, &TOKEN)),
            ws(*user),
            r(SYSTEM),
            r(PUMP_AMM),
            w(pool),
            w(pa),
            w(ata(&pa, mint, &TOKEN_2022)),
            w(ata(&pa, &WSOL, &TOKEN)),
            r(pda(&[b"global_config"], &PUMP_AMM)),
            w(lp_mint),
            w(ata(&pa, &lp_mint, &TOKEN_2022)),
            w(ata(&pool, mint, &TOKEN_2022)),
            w(ata(&pool, &WSOL, &TOKEN)),
            r(TOKEN_2022),
            r(TOKEN),
            r(TOKEN_2022),
            r(ATA_PROGRAM),
            r(event_authority(&PUMP_AMM)),
            r(RENT_SYSVAR),
            r(event_authority(&PUMP)),
            r(PUMP),
            // remaining (not in the IDL; seen on every mainnet migrate_v2): PumpSwap's boost vault of the new pool
            w(boost),
            w(ata(&boost, &WSOL, &TOKEN)),
        ],
        data: vec![187, 203, 18, 31, 206, 237, 254, 41],
    }
}

/// PumpSwap `buy` / `sell` on the canonical pool of `mint` (SOL-paired, Token-2022 base). The user's WSOL ATA pays
/// (buy) or receives (sell).
pub fn amm_trade(rc: &Recipients, mint: &Pubkey, user: &Pubkey, coin_creator: &Pubkey, buy: bool, a: u64, b: u64) -> Instruction {
    let pool = canonical_pool(mint);
    let auth = amm_creator_vault_authority(coin_creator);
    let mut accounts = vec![
        w(pool),
        ws(*user),
        r(pda(&[b"global_config"], &PUMP_AMM)),
        r(*mint),
        r(WSOL),
        w(ata(user, mint, &TOKEN_2022)),
        w(ata(user, &WSOL, &TOKEN)),
        w(ata(&pool, mint, &TOKEN_2022)),
        w(ata(&pool, &WSOL, &TOKEN)),
        r(rc.amm_protocol_fee_recipient),
        w(ata(&rc.amm_protocol_fee_recipient, &WSOL, &TOKEN)),
        r(TOKEN_2022),
        r(TOKEN),
        r(SYSTEM),
        r(ATA_PROGRAM),
        r(event_authority(&PUMP_AMM)),
        r(PUMP_AMM),
        w(ata(&auth, &WSOL, &TOKEN)),
        r(auth),
    ];
    if buy {
        accounts.push(r(pda(&[b"global_volume_accumulator"], &PUMP_AMM)));
        accounts.push(w(pda(&[b"user_volume_accumulator", user.as_ref()], &PUMP_AMM)));
    }
    accounts.extend([
        r(fee_config(&PUMP_AMM)),
        r(PUMP_FEES),
        // remaining (not in the IDL; seen on every mainnet PumpSwap trade): pool_v2, a buyback fee recipient and its
        // WSOL account
        r(pda(&[b"pool-v2", mint.as_ref()], &PUMP_AMM)),
        r(rc.amm_buyback_fee_recipient),
        w(ata(&rc.amm_buyback_fee_recipient, &WSOL, &TOKEN)),
    ]);
    let mut data = if buy { vec![102, 6, 61, 18, 1, 218, 235, 234] } else { vec![51, 230, 133, 164, 1, 127, 131, 173] };
    data.extend_from_slice(&a.to_le_bytes());
    data.extend_from_slice(&b.to_le_bytes());
    if buy {
        data.push(0); // track_volume: OptionBool(false)
    }
    Instruction { program_id: PUMP_AMM, accounts, data }
}

/// SPL Token `SyncNative` (wrap lamports sent to a WSOL account).
pub fn sync_native(account: &Pubkey) -> Instruction {
    Instruction { program_id: TOKEN, accounts: vec![w(*account)], data: vec![17] }
}
