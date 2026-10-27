//! LiteSVM harness for the flipfee integration tests.
//!
//! The VM runs `target/deploy/flipfee.so` (build it first: `anchor build`) as an upgradeable program whose upgrade
//! authority is `deployer`, next to the **mainnet binaries** of pump, pump_amm, pump_fees and mayhem and the mainnet
//! accounts they read (fixtures/mainnet, fetched read-only by `npm run fixtures`), with the mainnet feature set and
//! mainnet's Rent sysvar (5,080 lamports per byte, threshold 1.0). Coins are created with pump `create_v2` and traded
//! with `buy_v2` / `sell_v2` exactly as on mainnet, so every creator fee in these tests is a real pump fee.
//! Every transaction's fee is paid by `payer`, a key that is never a participant.
#![allow(dead_code)]
#![allow(clippy::result_large_err)]

pub mod pump;

use std::collections::BTreeMap;

use anchor_lang::{
    prelude::Pubkey,
    solana_program::instruction::{AccountMeta, Instruction},
    AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
};
use base64::Engine;
use flipfee::{accounts as acc, instruction as ixd, Coin, Config, FlipfeeError};
use litesvm::{
    types::{FailedTransactionMetadata, SimulatedTransactionInfo, TransactionMetadata},
    LiteSVM,
};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

use pump::Recipients;

pub const SOL: u64 = 1_000_000_000;
/// 2026-10-06 12:00:00 UTC (the fixtures were read the same day).
pub const START_TIME: i64 = 1_791_288_000;
pub const HOUR: i64 = 3_600;
pub const SYSTEM_PROGRAM: Pubkey = anchor_lang::solana_program::system_program::ID;
pub const BPF_LOADER_UPGRADEABLE: Pubkey = anchor_lang::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
pub const RENT_SYSVAR: Pubkey = anchor_lang::pubkey!("SysvarRent111111111111111111111111111111111");
/// Rent sysvar bytes: 5080 lamports/byte-year, exemption threshold 1.0, burn 50% (mainnet, 2026-10-06).
pub const MAINNET_RENT: [u8; 17] = [0xd8, 0x13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f, 0x32];
/// Rent-exempt minimum of a 0-byte account under that sysvar (the vault's floor).
pub const RENT_MIN: u64 = 650_240;

pub const FEE_BPS: u16 = 500;
pub const PRICE: u64 = 300_000_000; // 0.3 SOL per hour
pub const MAX_AHEAD: u32 = 86_400;

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[flipfee::CONFIG_SEED], &flipfee::ID).0
}
pub fn coin_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[flipfee::COIN_SEED, mint.as_ref()], &flipfee::ID).0
}
pub fn vault_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[flipfee::VAULT_SEED, mint.as_ref()], &flipfee::ID).0
}
pub fn program_data_address(program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program.as_ref()], &BPF_LOADER_UPGRADEABLE).0
}

fn fixtures_dir() -> String {
    format!("{}/../../fixtures/mainnet", env!("CARGO_MANIFEST_DIR"))
}

fn pk(s: &str) -> Pubkey {
    s.parse().unwrap()
}

/// A coin created in the VM by pump `create_v2`.
#[derive(Clone, Copy, Debug)]
pub struct TestCoin {
    pub mint: Pubkey,
    pub creator: Pubkey,
}

pub struct Env {
    pub svm: LiteSVM,
    /// Fee payer of every transaction; never a participant.
    pub payer: Keypair,
    /// Upgrade authority of flipfee and its admin.
    pub deployer: Keypair,
    pub treasury: Keypair,
    pub rc: Recipients,
    /// Compute units of the flipfee instruction, per name.
    pub cu: BTreeMap<String, Vec<u64>>,
    /// Lamports sent straight to a vault by outsiders, per mint.
    pub donations: BTreeMap<Pubkey, u64>,
    seed: u64,
}

impl Env {
    /// VM with flipfee deployed and initialized (fee 5%), and the pump programs + mainnet accounts loaded.
    pub fn new() -> Self {
        let mut env = Self::bare();
        let deployer = env.deployer.insecure_clone();
        let treasury = env.treasury.pubkey();
        env.ok("initialize", env.ix_initialize(&deployer.pubkey(), &treasury, FEE_BPS), &[&deployer]);
        env
    }

    /// VM with everything loaded, flipfee not initialized.
    pub fn bare() -> Self {
        let mut svm = LiteSVM::new()
            .with_mainnet_features()
            .with_builtins()
            .with_lamports(10_000_000_000 * SOL)
            .with_sysvars()
            .with_default_programs()
            .with_sigverify(true)
            .with_blockhash_check(true)
            .with_log_bytes_limit(Some(10_000)); // mainnet's limit: events beyond it are lost there too
        svm.set_account(
            RENT_SYSVAR,
            Account {
                lamports: 1,
                data: MAINNET_RENT.to_vec(),
                owner: anchor_lang::pubkey!("Sysvar1111111111111111111111111111111111111"),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(format!("{}/manifest.json", fixtures_dir())).unwrap()).unwrap();
        let mut clock: solana_clock::Clock = svm.get_sysvar();
        clock.unix_timestamp = START_TIME;
        clock.slot = manifest["slot"].as_u64().unwrap() + 1_000;
        svm.set_sysvar(&clock);

        // pump.fun programs (mainnet ELFs) and accounts
        for (name, id) in [
            ("pump", pump::PUMP),
            ("pump_amm", pump::PUMP_AMM),
            ("pump_fees", pump::PUMP_FEES),
            ("mayhem", pump::MAYHEM),
        ] {
            let so = std::fs::read(format!("{}/programs/{name}.so", fixtures_dir()))
                .unwrap_or_else(|_| panic!("fixtures/mainnet/programs/{name}.so missing: run `npm run fixtures`"));
            svm.add_program(id, &so).unwrap();
        }
        for entry in std::fs::read_dir(format!("{}/accounts", fixtures_dir())).unwrap() {
            let path = entry.unwrap().path();
            let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let a = &j["account"];
            let data = base64::engine::general_purpose::STANDARD.decode(a["data"][0].as_str().unwrap()).unwrap();
            svm.set_account(
                pk(j["pubkey"].as_str().unwrap()),
                Account {
                    lamports: a["lamports"].as_u64().unwrap(),
                    data,
                    owner: pk(a["owner"].as_str().unwrap()),
                    executable: a["executable"].as_bool().unwrap(),
                    rent_epoch: 0,
                },
            )
            .unwrap();
        }
        let roles = &manifest["roles"];
        let rc = Recipients {
            fee_recipient: pk(roles["feeRecipients"][0].as_str().unwrap()),
            buyback_fee_recipient: pk(roles["buybackFeeRecipients"][0].as_str().unwrap()),
            amm_protocol_fee_recipient: pk(roles["ammProtocolFeeRecipients"][0].as_str().unwrap()),
            amm_buyback_fee_recipient: pk(roles["ammBuybackFeeRecipients"][0].as_str().unwrap()),
            withdraw_authority: pk(roles["withdrawAuthority"].as_str().unwrap()),
        };

        let mut seed = 0u64;
        let mut key = || {
            seed += 1;
            let mut secret = [11u8; 32];
            secret[..8].copy_from_slice(&seed.to_le_bytes());
            Keypair::new_from_array(secret)
        };
        let payer = key();
        let deployer = key();
        let treasury = key();
        svm.airdrop(&payer.pubkey(), 100_000 * SOL).unwrap();
        svm.airdrop(&deployer.pubkey(), 10 * SOL).unwrap();
        svm.airdrop(&treasury.pubkey(), SOL).unwrap();

        let so = std::fs::read(format!("{}/../../target/deploy/flipfee.so", env!("CARGO_MANIFEST_DIR")))
            .expect("target/deploy/flipfee.so missing: run `anchor build` first");
        svm.add_program(flipfee::ID, &so).unwrap();
        // Make `deployer` the upgrade authority (UpgradeableLoaderState::ProgramData { slot, Some(authority) }).
        let pd_key = program_data_address(&flipfee::ID);
        let mut pd = svm.get_account(&pd_key).unwrap();
        pd.data[..4].copy_from_slice(&3u32.to_le_bytes());
        pd.data[4..12].copy_from_slice(&0u64.to_le_bytes());
        pd.data[12] = 1;
        pd.data[13..45].copy_from_slice(deployer.pubkey().as_ref());
        svm.set_account(pd_key, pd).unwrap();

        Self {
            svm,
            payer,
            deployer,
            treasury,
            rc,
            cu: BTreeMap::new(),
            donations: BTreeMap::new(),
            seed: 1_000,
        }
    }

    // ───────────────────────────── plumbing ─────────────────────────────

    pub fn keypair(&mut self) -> Keypair {
        self.seed += 1;
        let mut secret = [7u8; 32];
        secret[..8].copy_from_slice(&self.seed.to_le_bytes());
        Keypair::new_from_array(secret)
    }

    /// A funded wallet.
    pub fn user(&mut self, sol: u64) -> Keypair {
        let k = self.keypair();
        self.svm.airdrop(&k.pubkey(), sol * SOL).unwrap();
        k
    }

    pub fn now(&self) -> i64 {
        let c: solana_clock::Clock = self.svm.get_sysvar();
        c.unix_timestamp
    }

    /// Moves the clock forward by `secs` seconds (and some slots).
    pub fn warp(&mut self, secs: i64) {
        let mut c: solana_clock::Clock = self.svm.get_sysvar();
        c.unix_timestamp += secs;
        c.slot += (secs.max(1) as u64) * 2;
        self.svm.set_sysvar(&c);
        self.svm.expire_blockhash();
    }

    /// Sets the clock to `ts` (forward only).
    pub fn warp_to(&mut self, ts: i64) {
        let now = self.now();
        assert!(ts >= now, "warp_to goes forward only");
        self.warp(ts - now);
    }

    /// Sends `ixs` with `payer` as fee payer plus `signers`, a 1.4M CU limit, and records the compute units of the
    /// flipfee instruction under `name`.
    pub fn send(&mut self, name: &str, ixs: Vec<Instruction>, signers: &[&Keypair]) -> TxResult {
        let mut all = vec![compute_limit(1_400_000)];
        all.extend(ixs);
        let msg = Message::new_with_blockhash(&all, Some(&self.payer.pubkey()), &self.svm.latest_blockhash());
        let mut keys: Vec<&Keypair> = vec![&self.payer];
        for s in signers {
            if !keys.iter().any(|k| k.pubkey() == s.pubkey()) {
                keys.push(s);
            }
        }
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &keys).unwrap();
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        if let Ok(meta) = &res {
            for units in flipfee_units(&meta.logs) {
                self.cu.entry(name.to_string()).or_default().push(units);
            }
        }
        res
    }

    /// Like `send`, panics with the logs on failure.
    pub fn ok_many(&mut self, name: &str, ixs: Vec<Instruction>, signers: &[&Keypair]) -> TransactionMetadata {
        match self.send(name, ixs, signers) {
            Ok(m) => m,
            Err(e) => panic!("{name} failed: {:?}\n{}", e.err, e.meta.logs.join("\n")),
        }
    }

    pub fn ok(&mut self, name: &str, ix: Instruction, signers: &[&Keypair]) -> TransactionMetadata {
        self.ok_many(name, vec![ix], signers)
    }

    pub fn simulate(&self, ixs: Vec<Instruction>) -> Result<SimulatedTransactionInfo, FailedTransactionMetadata> {
        let msg = Message::new_with_blockhash(&ixs, Some(&self.payer.pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&self.payer]).unwrap();
        self.svm.simulate_transaction(tx)
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
    }

    pub fn exists(&self, key: &Pubkey) -> bool {
        self.svm.get_account(key).map(|a| a.lamports > 0).unwrap_or(false)
    }

    pub fn rent(&self, len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(len)
    }

    pub fn config(&self) -> Config {
        let a = self.svm.get_account(&config_pda()).expect("config");
        Config::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    pub fn coin(&self, mint: &Pubkey) -> Coin {
        self.coin_opt(mint).expect("coin account")
    }

    pub fn coin_opt(&self, mint: &Pubkey) -> Option<Coin> {
        let a = self.svm.get_account(&coin_pda(mint))?;
        if a.lamports == 0 || a.owner != flipfee::ID {
            return None;
        }
        Some(Coin::try_deserialize(&mut a.data.as_slice()).unwrap())
    }

    /// Raw account data.
    pub fn data(&self, key: &Pubkey) -> Vec<u8> {
        self.svm.get_account(key).map(|a| a.data).unwrap_or_default()
    }

    /// Overwrites part of an account's data (to fake pump.fun admin actions such as a takeover).
    pub fn patch(&mut self, key: &Pubkey, offset: usize, bytes: &[u8]) {
        let mut a = self.svm.get_account(key).unwrap();
        a.data[offset..offset + bytes.len()].copy_from_slice(bytes);
        self.svm.set_account(*key, a).unwrap();
    }

    /// Sends lamports straight to a vault (not through pump), recorded as a donation.
    pub fn donate(&mut self, from: &Keypair, mint: &Pubkey, lamports: u64) {
        let ix = anchor_lang::solana_program::system_instruction::transfer(&from.pubkey(), &vault_pda(mint), lamports);
        self.ok("donate", ix, &[from]);
        *self.donations.entry(*mint).or_default() += lamports;
    }

    // ───────────────────────────── flipfee instructions ─────────────────────────────

    pub fn ix_initialize(&self, authority: &Pubkey, treasury: &Pubkey, fee_bps: u16) -> Instruction {
        Instruction {
            program_id: flipfee::ID,
            accounts: acc::Initialize {
                authority: *authority,
                config: config_pda(),
                treasury: *treasury,
                program: flipfee::ID,
                program_data: program_data_address(&flipfee::ID),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: ixd::Initialize { fee_bps }.data(),
        }
    }

    pub fn ix_set_config(&self, admin: &Pubkey, treasury: &Pubkey, fee_bps: u16, paused: bool) -> Instruction {
        Instruction {
            program_id: flipfee::ID,
            accounts: acc::SetConfig { admin: *admin, config: config_pda(), treasury: *treasury }.to_account_metas(None),
            data: ixd::SetConfig { fee_bps, paused }.data(),
        }
    }

    pub fn ix_set_admin(&self, admin: &Pubkey, new_admin: Pubkey) -> Instruction {
        Instruction {
            program_id: flipfee::ID,
            accounts: acc::SetAdmin { admin: *admin, config: config_pda() }.to_account_metas(None),
            data: ixd::SetAdmin { new_admin }.data(),
        }
    }

    pub fn ix_register(&self, owner: &Pubkey, mint: &Pubkey, price: u64, max_ahead: u32) -> Instruction {
        Instruction {
            program_id: flipfee::ID,
            accounts: acc::Register {
                owner: *owner,
                config: config_pda(),
                coin: coin_pda(mint),
                vault: vault_pda(mint),
                mint: *mint,
                sharing_config: pump::sharing_config(mint),
                bonding_curve: pump::bonding_curve(mint),
                pool: pump::canonical_pool(mint),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: ixd::Register { price, max_ahead }.data(),
        }
    }

    pub fn ix_set_terms(&self, owner: &Pubkey, mint: &Pubkey, price: u64, max_ahead: u32, paused: bool) -> Instruction {
        Instruction {
            program_id: flipfee::ID,
            accounts: acc::SetTerms { owner: *owner, coin: coin_pda(mint) }.to_account_metas(None),
            data: ixd::SetTerms { price, max_ahead, paused }.data(),
        }
    }

    pub fn ix_transfer_owner(&self, owner: &Pubkey, mint: &Pubkey, new_owner: &Pubkey) -> Instruction {
        Instruction {
            program_id: flipfee::ID,
            accounts: acc::TransferOwner {
                owner: *owner,
                coin: coin_pda(mint),
                vault: vault_pda(mint),
                new_owner: *new_owner,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: ixd::TransferOwner {}.data(),
        }
    }

    /// `buy` with the coin's current owner and the config's treasury, no start limit.
    pub fn ix_buy(&self, buyer: &Pubkey, mint: &Pubkey, hours: u8, max_price: u64) -> Instruction {
        self.ix_buy_by(buyer, mint, hours, max_price, i64::MAX)
    }

    /// `buy` that must start by `max_start`.
    pub fn ix_buy_by(&self, buyer: &Pubkey, mint: &Pubkey, hours: u8, max_price: u64, max_start: i64) -> Instruction {
        let owner = self.coin(mint).owner;
        let sc = pump::sharing_config(mint);
        Instruction {
            program_id: flipfee::ID,
            accounts: acc::Buy {
                buyer: *buyer,
                config: config_pda(),
                coin: coin_pda(mint),
                vault: vault_pda(mint),
                owner,
                treasury: self.config().treasury,
                sharing_config: sc,
                bonding_curve: pump::bonding_curve(mint),
                pool: pump::canonical_pool(mint),
                pump_creator_vault: pump::creator_vault(&sc),
                amm_creator_vault: pump::ata(&pump::amm_creator_vault_authority(&sc), &pump::WSOL, &pump::TOKEN),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: ixd::Buy { hours, max_price, max_start }.data(),
        }
    }

    /// `crank` paying `recipients` (writable remaining accounts).
    pub fn ix_crank(&self, mint: &Pubkey, recipients: &[Pubkey]) -> Instruction {
        let mut accounts = acc::Crank { coin: coin_pda(mint), vault: vault_pda(mint), system_program: SYSTEM_PROGRAM }
            .to_account_metas(None);
        accounts.extend(recipients.iter().map(|k| AccountMeta::new(*k, false)));
        Instruction { program_id: flipfee::ID, accounts, data: ixd::Crank {}.data() }
    }

    /// `crank` paying the owner and every holder with something owed (what the keeper sends).
    pub fn ix_crank_all(&self, mint: &Pubkey) -> Instruction {
        let c = self.coin(mint);
        let mut r = vec![c.owner];
        for w in &c.windows {
            if !r.contains(&w.holder) {
                r.push(w.holder);
            }
        }
        self.ix_crank(mint, &r)
    }

    // ───────────────────────────── pump flows ─────────────────────────────

    /// Creates a SOL-paired pump coin with `create_v2` (creator = `dev`, who also pays).
    pub fn create_coin(&mut self, dev: &Keypair) -> TestCoin {
        let mint = self.keypair();
        let ix = pump::create_v2(&mint.pubkey(), &dev.pubkey(), &dev.pubkey(), "Flip Test", "FLIP");
        self.ok("pump_create_v2", ix, &[dev, &mint]);
        TestCoin { mint: mint.pubkey(), creator: dev.pubkey() }
    }

    /// Current `bonding_curve.creator` (where the creator fee goes).
    pub fn curve_creator(&self, mint: &Pubkey) -> Pubkey {
        let d = self.data(&pump::bonding_curve(mint));
        Pubkey::new_from_array(d[49..81].try_into().unwrap())
    }

    /// Token balance (base units) of an SPL / Token-2022 account.
    pub fn token_balance(&self, account: &Pubkey) -> u64 {
        let d = self.data(account);
        if d.len() < 72 {
            return 0;
        }
        u64::from_le_bytes(d[64..72].try_into().unwrap())
    }

    /// pump `buy_v2` of `tokens` base units (creates the trader's Token-2022 ATA first). Returns the creator fee
    /// pump charged, measured as the creator vault's balance change.
    pub fn trade_buy(&mut self, trader: &Keypair, mint: &Pubkey, tokens: u64) -> u64 {
        let creator = self.curve_creator(mint);
        let vault = pump::creator_vault(&creator);
        let before = self.lamports(&vault);
        let ixs = vec![
            pump::create_ata(&trader.pubkey(), &trader.pubkey(), mint, &pump::TOKEN_2022),
            pump::buy_v2(&self.rc.clone(), mint, &trader.pubkey(), &creator, tokens, 100 * SOL),
        ];
        self.ok_many("pump_buy_v2", ixs, &[trader]);
        self.lamports(&vault) - before
    }

    /// pump `sell_v2` of `tokens` base units. Returns the creator fee (creator vault balance change).
    pub fn trade_sell(&mut self, trader: &Keypair, mint: &Pubkey, tokens: u64) -> u64 {
        let creator = self.curve_creator(mint);
        let vault = pump::creator_vault(&creator);
        let before = self.lamports(&vault);
        let ix = pump::sell_v2(&self.rc.clone(), mint, &trader.pubkey(), &creator, tokens, 0);
        self.ok("pump_sell_v2", ix, &[trader]);
        self.lamports(&vault) - before
    }

    /// The one-transaction connect of DESIGN §1.5: `create_fee_sharing_config` + `update_fee_shares_v2 → [vault,
    /// 100%]` + `register`.
    pub fn connect(&mut self, dev: &Keypair, coin: &TestCoin, price: u64, max_ahead: u32) -> TransactionMetadata {
        let mint = coin.mint;
        let ixs = vec![
            pump::create_fee_sharing_config(&dev.pubkey(), &mint, None),
            pump::update_fee_shares_v2(&dev.pubkey(), &mint, &[dev.pubkey()], &[(vault_pda(&mint), 10_000)]),
            self.ix_register(&dev.pubkey(), &mint, price, max_ahead),
        ];
        self.ok_many("register", ixs, &[dev])
    }

    /// pump `distribute_creator_fees_v2` to the vault (permissionless). Returns the lamports the vault received.
    pub fn distribute(&mut self, mint: &Pubkey) -> u64 {
        let before = self.lamports(&vault_pda(mint));
        let payer = self.payer.pubkey();
        let ix = pump::distribute_creator_fees_v2(&payer, mint, &[vault_pda(mint)]);
        self.ok("pump_distribute", ix, &[]);
        self.lamports(&vault_pda(mint)) - before
    }

    /// What the keeper sends each minute: distribute, then crank with the owner and every holder.
    pub fn keeper_tick(&mut self, mint: &Pubkey) -> TransactionMetadata {
        let payer = self.payer.pubkey();
        let ixs = vec![
            pump::distribute_creator_fees_v2(&payer, mint, &[vault_pda(mint)]),
            self.ix_crank_all(mint),
        ];
        self.ok_many("crank", ixs, &[])
    }

    /// Buys the whole bonding curve (in chunks) and migrates it to its canonical PumpSwap pool with `migrate_v2`.
    pub fn graduate(&mut self, whale: &Keypair, mint: &Pubkey) {
        loop {
            let d = self.data(&pump::bonding_curve(mint));
            let left = u64::from_le_bytes(d[24..32].try_into().unwrap());
            if left == 0 {
                break;
            }
            self.trade_buy(whale, mint, left.min(50_000_000_000_000));
        }
        assert_eq!(self.data(&pump::bonding_curve(mint))[48], 1, "curve complete");
        let rc = self.rc.clone();
        self.ok("pump_migrate_v2", pump::migrate_v2(&rc, mint, &whale.pubkey()), &[whale]);
        assert!(self.exists(&pump::canonical_pool(mint)), "pool created");
    }

    /// `pool.coin_creator` of the canonical pool (offset 8 + 1 + 2 + 32·6 + 8 = 211).
    pub fn pool_coin_creator(&self, mint: &Pubkey) -> Pubkey {
        let d = self.data(&pump::canonical_pool(mint));
        Pubkey::new_from_array(d[211..243].try_into().unwrap())
    }

    /// Wraps `lamports` into the trader's WSOL account (created if needed).
    pub fn wrap_sol(&mut self, trader: &Keypair, lamports: u64) {
        let wsol = pump::ata(&trader.pubkey(), &pump::WSOL, &pump::TOKEN);
        let ixs = vec![
            pump::create_ata(&trader.pubkey(), &trader.pubkey(), &pump::WSOL, &pump::TOKEN),
            anchor_lang::solana_program::system_instruction::transfer(&trader.pubkey(), &wsol, lamports),
            pump::sync_native(&wsol),
        ];
        self.ok_many("wrap", ixs, &[trader]);
    }

    /// PumpSwap buy of `tokens` base units (pays from the trader's WSOL). Returns the coin creator fee (WSOL that
    /// reached the AMM creator vault).
    pub fn amm_buy(&mut self, trader: &Keypair, mint: &Pubkey, tokens: u64) -> u64 {
        let cc = self.pool_coin_creator(mint);
        let vault = pump::ata(&pump::amm_creator_vault_authority(&cc), &pump::WSOL, &pump::TOKEN);
        let before = self.token_balance(&vault);
        let rc = self.rc.clone();
        let ixs = vec![
            pump::create_ata(&trader.pubkey(), &trader.pubkey(), mint, &pump::TOKEN_2022),
            pump::amm_trade(&rc, mint, &trader.pubkey(), &cc, true, tokens, 1_000 * SOL),
        ];
        self.ok_many("amm_buy", ixs, &[trader]);
        self.token_balance(&vault) - before
    }

    /// PumpSwap sell of `tokens` base units (receives WSOL). Returns the coin creator fee.
    pub fn amm_sell(&mut self, trader: &Keypair, mint: &Pubkey, tokens: u64) -> u64 {
        let cc = self.pool_coin_creator(mint);
        let vault = pump::ata(&pump::amm_creator_vault_authority(&cc), &pump::WSOL, &pump::TOKEN);
        let before = self.token_balance(&vault);
        let rc = self.rc.clone();
        self.ok("amm_sell", pump::amm_trade(&rc, mint, &trader.pubkey(), &cc, false, tokens, 0), &[trader]);
        self.token_balance(&vault) - before
    }

    /// The keeper's tick for a graduated coin: sweep the AMM creator vault into pump, distribute, crank.
    pub fn keeper_tick_graduated(&mut self, mint: &Pubkey) -> TransactionMetadata {
        let payer = self.payer.pubkey();
        let sc = pump::sharing_config(mint);
        let ixs = vec![
            pump::transfer_creator_fees_to_pump_v2(&payer, &sc),
            pump::distribute_creator_fees_v2(&payer, mint, &[vault_pda(mint)]),
            self.ix_crank_all(mint),
        ];
        self.ok_many("crank", ixs, &[])
    }

    /// pump's fees of the coin into the vault: PumpSwap's sweep when its creator vault exists, then distribute.
    pub fn collect_ixs(&self, mint: &Pubkey) -> Vec<Instruction> {
        let payer = self.payer.pubkey();
        let sc = pump::sharing_config(mint);
        let amm_vault = pump::ata(&pump::amm_creator_vault_authority(&sc), &pump::WSOL, &pump::TOKEN);
        let mut ixs = Vec::new();
        if self.exists(&amm_vault) {
            ixs.push(pump::transfer_creator_fees_to_pump_v2(&payer, &sc));
        }
        ixs.push(pump::distribute_creator_fees_v2(&payer, mint, &[vault_pda(mint)]));
        ixs
    }

    /// What the app sends to buy: collect pump's fees, then buy.
    pub fn buy_hours_res(&mut self, buyer: &Keypair, mint: &Pubkey, hours: u8) -> TxResult {
        let price = self.coin(mint).price;
        let mut ixs = self.collect_ixs(mint);
        ixs.push(self.ix_buy(&buyer.pubkey(), mint, hours, price));
        self.send("buy", ixs, &[buyer])
    }

    pub fn buy_hours(&mut self, buyer: &Keypair, mint: &Pubkey, hours: u8) -> TransactionMetadata {
        match self.buy_hours_res(buyer, mint, hours) {
            Ok(m) => m,
            Err(e) => panic!("buy failed: {:?}\n{}", e.err, e.meta.logs.join("\n")),
        }
    }

    // ───────────────────────────── checks ─────────────────────────────

    /// The money books of one coin: the vault is rent-exempt and holds at least `rent + credited`; `credited` is
    /// exactly what is owed; everything allocated was either paid or is still owed.
    pub fn check_books(&self, mint: &Pubkey) {
        let c = self.coin(mint);
        let vault = self.lamports(&vault_pda(mint));
        assert!(vault >= RENT_MIN + c.credited, "vault {vault} < rent + credited {}", c.credited);
        assert_eq!(c.owed_total(), Some(c.credited), "credited == owner_owed + Σ windows.owed");
        assert_eq!(c.fees_in - c.paid_out, c.credited, "allocated − paid == still owed");
        for pair in c.windows.windows(2) {
            assert!(pair[0].end <= pair[1].start, "windows sorted and never overlapping");
        }
        for w in &c.windows {
            assert!(w.owed <= w.earned);
            assert!(w.start < w.end);
        }
        let a = self.svm.get_account(&vault_pda(mint)).unwrap();
        assert_eq!(a.owner, SYSTEM_PROGRAM, "vault stays a system account");
        assert!(a.data.is_empty(), "vault has no data");
    }
}

pub fn compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: anchor_lang::pubkey!("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data,
    }
}

/// Compute units consumed by each top-level flipfee instruction, from the runtime's "consumed" log lines.
pub fn flipfee_units(logs: &[String]) -> Vec<u64> {
    program_units(logs, &flipfee::ID)
}

/// Compute units consumed by every top-level (not CPI) invocation of `program`.
pub fn program_units(logs: &[String], program: &Pubkey) -> Vec<u64> {
    let me = program.to_string();
    let mut depth = 0usize;
    let mut out = Vec::new();
    for l in logs {
        if l.starts_with("Program ") && l.contains(" invoke [") {
            depth += 1;
        } else if l.starts_with("Program ") && (l.ends_with(" success") || l.contains(" failed")) {
            depth = depth.saturating_sub(1);
        } else if let Some(rest) = l.strip_prefix(&format!("Program {me} consumed ")) {
            if depth == 1 {
                if let Some(n) = rest.split(' ').next().and_then(|n| n.parse().ok()) {
                    out.push(n);
                }
            }
        }
    }
    out
}

/// Every `Program data:` payload in the logs (Anchor events).
pub fn event_payloads(logs: &[String]) -> Vec<Vec<u8>> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .collect()
}

/// Every event of type `T` in the logs (flipfee events only: matched by discriminator).
pub fn events<T: Discriminator + AnchorDeserialize>(meta: &TransactionMetadata) -> Vec<T> {
    event_payloads(&meta.logs)
        .into_iter()
        .filter(|d| d.len() >= 8 && d[..8] == *T::DISCRIMINATOR)
        .map(|d| T::try_from_slice(&d[8..]).unwrap())
        .collect()
}

/// The single event of type `T`.
pub fn event<T: Discriminator + AnchorDeserialize>(meta: &TransactionMetadata) -> T {
    let mut found = events::<T>(meta);
    assert_eq!(found.len(), 1, "expected exactly one event of this type");
    found.remove(0)
}

/// The custom error code of a failed transaction, if any.
pub fn custom_error(res: &TxResult) -> Option<u32> {
    let e = res.as_ref().err()?;
    let s = format!("{:?}", e.err);
    let i = s.find("Custom(")?;
    s[i + 7..].split(')').next()?.parse().ok()
}

/// Asserts a transaction failed with a flipfee error.
pub fn assert_err(res: &TxResult, expected: FlipfeeError) {
    let want = 6000 + expected as u32;
    match res {
        Ok(_) => panic!("expected {expected:?}, the transaction succeeded"),
        Err(e) => assert_eq!(
            custom_error(res),
            Some(want),
            "expected {expected:?} ({want}), got {:?}\n{}",
            e.err,
            e.meta.logs.join("\n")
        ),
    }
}

/// Asserts a transaction failed with an Anchor framework error code.
pub fn assert_anchor_err(res: &TxResult, code: u32) {
    match res {
        Ok(_) => panic!("expected anchor error {code}, the transaction succeeded"),
        Err(e) => assert_eq!(custom_error(res), Some(code), "{:?}\n{}", e.err, e.meta.logs.join("\n")),
    }
}

/// Asserts a transaction failed and one of its log lines contains `needle`.
pub fn assert_failed_with_log(res: &TxResult, needle: &str) {
    match res {
        Ok(_) => panic!("expected a failure with log `{needle}`, the transaction succeeded"),
        Err(e) => assert!(
            e.meta.logs.iter().any(|l| l.contains(needle)),
            "no log contains `{needle}`: {:?}\n{}",
            e.err,
            e.meta.logs.join("\n")
        ),
    }
}

/// Anchor framework error codes used by the tests.
pub mod anchor_codes {
    pub const CONSTRAINT_HAS_ONE: u32 = 2001;
    pub const CONSTRAINT_SEEDS: u32 = 2006;
    pub const CONSTRAINT_ADDRESS: u32 = 2012;
    pub const ACCOUNT_DISCRIMINATOR_MISMATCH: u32 = 3002;
    pub const ACCOUNT_OWNED_BY_WRONG_PROGRAM: u32 = 3007;
    pub const ACCOUNT_NOT_SIGNER: u32 = 3010;
    pub const ACCOUNT_NOT_INITIALIZED: u32 = 3012;
}

/// Replaces account `index` of an instruction (to try wrong accounts).
pub fn with_account(mut ix: Instruction, index: usize, key: Pubkey) -> Instruction {
    ix.accounts[index].pubkey = key;
    ix
}

/// Clears the signer flag of account `index` (to try a missing signature).
pub fn unsigned(mut ix: Instruction, index: usize) -> Instruction {
    let m = &ix.accounts[index];
    ix.accounts[index] = AccountMeta { pubkey: m.pubkey, is_signer: false, is_writable: m.is_writable };
    ix
}
