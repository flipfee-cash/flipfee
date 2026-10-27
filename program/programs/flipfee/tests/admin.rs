mod common;

use anchor_lang::prelude::Pubkey;
use common::*;
use flipfee::{ConfigSet, FlipfeeError};
use solana_signer::Signer;

#[test]
fn initialize_once_by_the_upgrade_authority() {
    let mut env = Env::bare();
    let stranger = env.user(5);
    let treasury = env.treasury.pubkey();
    // a stranger cannot initialize (front-running between deploy and init)
    let res = env.send("initialize", vec![env.ix_initialize(&stranger.pubkey(), &treasury, FEE_BPS)], &[&stranger]);
    assert_err(&res, FlipfeeError::NotUpgradeAuthority);
    // fee above 10%
    let deployer = env.deployer.insecure_clone();
    let res = env.send("initialize", vec![env.ix_initialize(&deployer.pubkey(), &treasury, 1_001)], &[&deployer]);
    assert_err(&res, FlipfeeError::BadFeeBps);
    // an empty treasury cannot take a small fee
    let empty = env.keypair().pubkey();
    let res = env.send("initialize", vec![env.ix_initialize(&deployer.pubkey(), &empty, FEE_BPS)], &[&deployer]);
    assert_err(&res, FlipfeeError::BadTreasury);
    // a program-owned treasury is refused
    let res = env.send(
        "initialize",
        vec![env.ix_initialize(&deployer.pubkey(), &pump::global(), FEE_BPS)],
        &[&deployer],
    );
    assert_err(&res, FlipfeeError::BadTreasury);

    let meta = env.ok("initialize", env.ix_initialize(&deployer.pubkey(), &treasury, FEE_BPS), &[&deployer]);
    let ev: ConfigSet = event(&meta);
    assert_eq!(ev.admin, deployer.pubkey());
    assert_eq!(ev.treasury, treasury);
    assert_eq!(ev.fee_bps, 500);
    assert!(!ev.paused);
    let c = env.config();
    assert_eq!((c.admin, c.treasury, c.fee_bps, c.paused), (deployer.pubkey(), treasury, 500, false));
    // only once
    let res = env.send("initialize", vec![env.ix_initialize(&deployer.pubkey(), &treasury, FEE_BPS)], &[&deployer]);
    assert!(res.is_err(), "config already exists");
}

#[test]
fn set_config_and_set_admin() {
    let mut env = Env::new();
    let admin = env.deployer.insecure_clone();
    let other = env.user(2);
    let new_treasury = env.user(1);

    let res = env.send("set_config", vec![env.ix_set_config(&other.pubkey(), &new_treasury.pubkey(), 100, true)], &[&other]);
    assert_err(&res, FlipfeeError::NotAdmin);
    let res = env.send("set_config", vec![env.ix_set_config(&admin.pubkey(), &new_treasury.pubkey(), 1_001, false)], &[&admin]);
    assert_err(&res, FlipfeeError::BadFeeBps);
    let empty = env.keypair().pubkey();
    let res = env.send("set_config", vec![env.ix_set_config(&admin.pubkey(), &empty, 100, false)], &[&admin]);
    assert_err(&res, FlipfeeError::BadTreasury);
    let res = env.send(
        "set_config",
        vec![unsigned(env.ix_set_config(&admin.pubkey(), &new_treasury.pubkey(), 100, false), 0)],
        &[],
    );
    assert_anchor_err(&res, anchor_codes::ACCOUNT_NOT_SIGNER);

    let meta = env.ok("set_config", env.ix_set_config(&admin.pubkey(), &new_treasury.pubkey(), 1_000, true), &[&admin]);
    let ev: ConfigSet = event(&meta);
    assert_eq!((ev.treasury, ev.fee_bps, ev.paused), (new_treasury.pubkey(), 1_000, true));
    let c = env.config();
    assert_eq!((c.treasury, c.fee_bps, c.paused), (new_treasury.pubkey(), 1_000, true));

    // hand the admin role over; the old admin is out
    let res = env.send("set_admin", vec![env.ix_set_admin(&admin.pubkey(), Pubkey::default())], &[&admin]);
    assert_err(&res, FlipfeeError::NotAdmin);
    let res = env.send("set_admin", vec![env.ix_set_admin(&other.pubkey(), other.pubkey())], &[&other]);
    assert_err(&res, FlipfeeError::NotAdmin);
    env.ok("set_admin", env.ix_set_admin(&admin.pubkey(), other.pubkey()), &[&admin]);
    assert_eq!(env.config().admin, other.pubkey());
    let res = env.send("set_config", vec![env.ix_set_config(&admin.pubkey(), &new_treasury.pubkey(), 500, false)], &[&admin]);
    assert_err(&res, FlipfeeError::NotAdmin);
    env.ok("set_config", env.ix_set_config(&other.pubkey(), &new_treasury.pubkey(), 500, false), &[&other]);
    assert!(!env.config().paused);
}
