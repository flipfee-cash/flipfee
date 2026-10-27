mod common;

use anchor_lang::prelude::Pubkey;
use common::*;
use flipfee::{FlipfeeError, Registered};
use solana_keypair::Keypair;
use solana_signer::Signer;

const T: u64 = 1_000_000_000_000; // 1M tokens (6 decimals)

/// `create_fee_sharing_config` + `update_fee_shares_v2(new)` without `register`.
fn split(env: &mut Env, dev: &Keypair, coin: &TestCoin, new: &[(Pubkey, u16)]) {
    let ixs = vec![
        pump::create_fee_sharing_config(&dev.pubkey(), &coin.mint, None),
        pump::update_fee_shares_v2(&dev.pubkey(), &coin.mint, &[dev.pubkey()], new),
    ];
    env.ok_many("pump_split", ixs, &[dev]);
}

#[test]
fn connect_in_one_transaction() {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    let dev_before = env.lamports(&dev.pubkey());
    let curve_before = (env.lamports(&pump::bonding_curve(&coin.mint)), env.data(&pump::bonding_curve(&coin.mint)).len());
    let meta = env.connect(&dev, &coin, PRICE, MAX_AHEAD);

    // pump: the curve pays the sharing config, which sends 100% to the vault; admin revoked but kept
    let sc_key = pump::sharing_config(&coin.mint);
    assert_eq!(env.curve_creator(&coin.mint), sc_key);
    let d = env.data(&sc_key);
    assert_eq!(d[10], 1, "Active");
    assert_eq!(&d[43..75], dev.pubkey().as_ref(), "pump keeps the admin after revoking");
    assert_eq!(d[75], 1, "admin_revoked");
    assert_eq!(u32::from_le_bytes(d[76..80].try_into().unwrap()), 1);
    assert_eq!(&d[80..112], vault_pda(&coin.mint).as_ref());
    assert_eq!(u16::from_le_bytes([d[112], d[113]]), 10_000);

    let ev: Registered = event(&meta);
    assert_eq!(ev.mint, coin.mint);
    assert_eq!(ev.coin, coin_pda(&coin.mint));
    assert_eq!(ev.owner, dev.pubkey());
    assert_eq!(ev.vault, vault_pda(&coin.mint));
    assert_eq!((ev.price, ev.max_ahead), (PRICE, MAX_AHEAD));
    assert_eq!((ev.vault_funded, ev.carried), (RENT_MIN, 0));
    assert_eq!(ev.at, env.now());

    let c = env.coin(&coin.mint);
    assert_eq!((c.mint, c.owner, c.price, c.max_ahead, c.paused), (coin.mint, dev.pubkey(), PRICE, MAX_AHEAD, false));
    assert_eq!((c.last_sync, c.owner_owed, c.credited, c.fees_in, c.sales, c.hours_sold, c.paid_out), (env.now(), 0, 0, 0, 0, 0, 0));
    assert!(c.windows.is_empty());
    assert_eq!(env.lamports(&vault_pda(&coin.mint)), RENT_MIN, "vault funded with exactly the 0-byte rent");
    let coin_rent = env.rent(env.data(&coin_pda(&coin.mint)).len());
    assert_eq!(env.data(&coin_pda(&coin.mint)).len(), 8 + 2183, "Coin account size");
    let sc_rent = env.lamports(&sc_key);
    // pump grows the curve account (141 → 151 bytes on a create_v2 coin) when it opts into fee sharing
    let curve_growth = env.lamports(&pump::bonding_curve(&coin.mint)) - curve_before.0;
    assert_eq!(curve_growth, env.rent(env.data(&pump::bonding_curve(&coin.mint)).len()) - env.rent(curve_before.1));
    let spent = dev_before - env.lamports(&dev.pubkey());
    assert_eq!(spent, coin_rent + RENT_MIN + sc_rent + curve_growth, "the dev paid the rents, nothing else");
    println!("connect: dev pays {spent} lamports = Coin rent {coin_rent} + vault {RENT_MIN} + sharing config {sc_rent} + curve growth {curve_growth}");
    env.check_books(&coin.mint);
}

#[test]
fn register_after_a_v1_split_and_late_fees_are_carried() {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    let trader = env.user(200);
    // the split was set earlier with pump's v1 update (what pump.fun's site sends), not through flipfee
    let ixs = vec![
        pump::create_fee_sharing_config(&dev.pubkey(), &coin.mint, None),
        pump::update_fee_shares_v1(&dev.pubkey(), &coin.mint, &[dev.pubkey()], &[(vault_pda(&coin.mint), 10_000)]),
    ];
    env.ok_many("pump_split_v1", ixs, &[&dev]);
    env.trade_buy(&trader, &coin.mint, T);
    // with the vault still empty, pump only pays once it can also fund the vault's rent: below that its
    // distribute succeeds and does nothing ("Insufficient fees for distribution")
    assert_eq!(env.distribute(&coin.mint), 0);
    assert!(!env.exists(&vault_pda(&coin.mint)));
    // more trading: pump's vault passes 2 × rent, pump creates the vault with everything above its own rent
    for _ in 0..8 {
        env.trade_buy(&trader, &coin.mint, 20 * T);
    }
    let early = env.distribute(&coin.mint);
    assert!(early >= RENT_MIN, "pump funded the vault itself: {early}");
    env.warp(10);
    let meta = env.ok("register", env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD), &[&dev]);
    let ev: Registered = event(&meta);
    assert_eq!((ev.vault_funded, ev.carried), (0, early - RENT_MIN), "fees before joining are the owner's");
    let c = env.coin(&coin.mint);
    let carried = early - RENT_MIN;
    assert_eq!((c.owner_owed, c.credited, c.fees_in), (carried, carried, carried));
    env.check_books(&coin.mint);
    let before = env.lamports(&dev.pubkey());
    env.ok("crank", env.ix_crank(&coin.mint, &[dev.pubkey()]), &[]);
    assert_eq!(env.lamports(&dev.pubkey()) - before, carried);
    env.check_books(&coin.mint);
}

#[test]
fn register_with_a_vault_someone_funded() {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    let trader = env.user(100);
    split(&mut env, &dev, &coin, &[(vault_pda(&coin.mint), 10_000)]);
    env.trade_buy(&trader, &coin.mint, T);
    let friend = env.user(2);
    env.donate(&friend, &coin.mint, RENT_MIN);
    let early = env.distribute(&coin.mint);
    assert!(early > 0, "a funded vault takes any amount above pump's rent");
    let dev_before = env.lamports(&dev.pubkey());
    let meta = env.ok("register", env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD), &[&dev]);
    let ev: Registered = event(&meta);
    assert_eq!((ev.vault_funded, ev.carried), (0, early));
    assert_eq!(dev_before - env.lamports(&dev.pubkey()), env.rent(8 + 2183), "only the Coin rent");
    env.check_books(&coin.mint);
}

#[test]
fn register_refuses_what_is_not_routed_to_the_vault() {
    let mut env = Env::new();
    let dev = env.user(10);

    // no sharing config at all
    let coin = env.create_coin(&dev);
    let res = env.send("register", vec![env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD)], &[&dev]);
    assert_err(&res, FlipfeeError::NotSharingConfig);

    // config created, split not final yet (admin not revoked, 100% to the dev)
    env.ok("pump_create_fsc", pump::create_fee_sharing_config(&dev.pubkey(), &coin.mint, None), &[&dev]);
    let res = env.send("register", vec![env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD)], &[&dev]);
    assert_err(&res, FlipfeeError::SplitNotFinal);

    // final split, but 50% to someone else
    let other = env.user(1);
    let ix = pump::update_fee_shares_v2(
        &dev.pubkey(),
        &coin.mint,
        &[dev.pubkey()],
        &[(vault_pda(&coin.mint), 5_000), (other.pubkey(), 5_000)],
    );
    env.ok("pump_update", ix, &[&dev]);
    let res = env.send("register", vec![env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD)], &[&dev]);
    assert_err(&res, FlipfeeError::SplitNotToVault);
    // pump allows one split per coin
    let ix = pump::update_fee_shares_v2(
        &dev.pubkey(),
        &coin.mint,
        &[vault_pda(&coin.mint), other.pubkey()],
        &[(vault_pda(&coin.mint), 10_000)],
    );
    let res = env.send("pump_update", vec![ix], &[&dev]);
    assert!(res.is_err(), "a second update_fee_shares_v2 fails on pump");

    // final split 100% to another wallet
    let coin2 = env.create_coin(&dev);
    split(&mut env, &dev, &coin2, &[(other.pubkey(), 10_000)]);
    let res = env.send("register", vec![env.ix_register(&dev.pubkey(), &coin2.mint, PRICE, MAX_AHEAD)], &[&dev]);
    assert_err(&res, FlipfeeError::SplitNotToVault);

    // 100% to the vault of ANOTHER mint
    let coin3 = env.create_coin(&dev);
    split(&mut env, &dev, &coin3, &[(vault_pda(&coin2.mint), 10_000)]);
    let res = env.send("register", vec![env.ix_register(&dev.pubkey(), &coin3.mint, PRICE, MAX_AHEAD)], &[&dev]);
    assert_err(&res, FlipfeeError::SplitNotToVault);
}

#[test]
fn only_the_fee_admin_registers() {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    split(&mut env, &dev, &coin, &[(vault_pda(&coin.mint), 10_000)]);
    let thief = env.user(10);
    let res = env.send("register", vec![env.ix_register(&thief.pubkey(), &coin.mint, PRICE, MAX_AHEAD)], &[&thief]);
    assert_err(&res, FlipfeeError::NotFeeAdmin);
    let res = env.send("register", vec![unsigned(env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD), 0)], &[]);
    assert!(res.is_err(), "the admin must sign");
    env.ok("register", env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD), &[&dev]);
    // once per coin
    let res = env.send("register", vec![env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD)], &[&dev]);
    assert!(res.is_err(), "coin account already exists");
}

#[test]
fn register_checks_terms_pause_and_accounts() {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    split(&mut env, &dev, &coin, &[(vault_pda(&coin.mint), 10_000)]);
    let ix = |env: &Env, price: u64, ahead: u32| env.ix_register(&dev.pubkey(), &coin.mint, price, ahead);

    for (price, ahead, err) in [
        (10_000_000 - 1, MAX_AHEAD, FlipfeeError::PriceOutOfRange),
        (1_000 * SOL + 1, MAX_AHEAD, FlipfeeError::PriceOutOfRange),
        (PRICE, 3_599, FlipfeeError::MaxAheadOutOfRange),
        (PRICE, 172_801, FlipfeeError::MaxAheadOutOfRange),
    ] {
        let res = env.send("register", vec![ix(&env, price, ahead)], &[&dev]);
        assert_err(&res, err);
    }
    // wrong PDAs
    let other = env.create_coin(&dev);
    let res = env.send("register", vec![with_account(ix(&env, PRICE, MAX_AHEAD), 5, pump::sharing_config(&other.mint))], &[&dev]);
    assert_anchor_err(&res, anchor_codes::CONSTRAINT_SEEDS);
    let res = env.send("register", vec![with_account(ix(&env, PRICE, MAX_AHEAD), 6, pump::bonding_curve(&other.mint))], &[&dev]);
    assert_anchor_err(&res, anchor_codes::CONSTRAINT_SEEDS);
    let res = env.send("register", vec![with_account(ix(&env, PRICE, MAX_AHEAD), 3, vault_pda(&other.mint))], &[&dev]);
    assert_anchor_err(&res, anchor_codes::CONSTRAINT_SEEDS);
    // a "mint" that is not a token mint (every PDA derived from it, so only the mint check can catch it)
    let fake = env.user(1).pubkey();
    let res = env.send("register", vec![env.ix_register(&dev.pubkey(), &fake, PRICE, MAX_AHEAD)], &[&dev]);
    assert_err(&res, FlipfeeError::BadMint);

    // paused
    let admin = env.deployer.insecure_clone();
    let treasury = env.treasury.pubkey();
    env.ok("set_config", env.ix_set_config(&admin.pubkey(), &treasury, FEE_BPS, true), &[&admin]);
    let res = env.send("register", vec![ix(&env, PRICE, MAX_AHEAD)], &[&dev]);
    assert_err(&res, FlipfeeError::Paused);
    env.ok("set_config", env.ix_set_config(&admin.pubkey(), &treasury, FEE_BPS, false), &[&admin]);
    // bounds are inclusive
    env.ok("register", ix(&env, 1_000 * SOL, 172_800), &[&dev]);
    assert_eq!(env.coin(&coin.mint).price, 1_000 * SOL);
}

#[test]
fn register_refuses_curves_that_do_not_pay_the_vault() {
    let mut env = Env::new();
    let dev = env.user(10);
    let bc_of = |m: &Pubkey| pump::bonding_curve(m);

    // a takeover moved the curve's creator elsewhere
    let coin = env.create_coin(&dev);
    split(&mut env, &dev, &coin, &[(vault_pda(&coin.mint), 10_000)]);
    let saved = env.data(&bc_of(&coin.mint));
    env.patch(&bc_of(&coin.mint), 49, dev.pubkey().as_ref());
    let res = env.send("register", vec![env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD)], &[&dev]);
    assert_err(&res, FlipfeeError::CurveNotRouted);
    env.patch(&bc_of(&coin.mint), 0, &saved);

    // USDC-paired curve
    let usdc: Pubkey = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".parse().unwrap();
    env.patch(&bc_of(&coin.mint), 83, usdc.as_ref());
    let res = env.send("register", vec![env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD)], &[&dev]);
    assert_err(&res, FlipfeeError::NotSolPaired);
    env.patch(&bc_of(&coin.mint), 0, &saved);

    // cashback coin (its creator fee goes to traders)
    env.patch(&bc_of(&coin.mint), 82, &[1]);
    let res = env.send("register", vec![env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD)], &[&dev]);
    assert_err(&res, FlipfeeError::CashbackCoin);
    env.patch(&bc_of(&coin.mint), 0, &saved);

    // paused sharing config
    let sc = pump::sharing_config(&coin.mint);
    env.patch(&sc, 10, &[0]);
    let res = env.send("register", vec![env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD)], &[&dev]);
    assert_err(&res, FlipfeeError::SharingNotActive);
    env.patch(&sc, 10, &[1]);

    env.ok("register", env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD), &[&dev]);
}

#[test]
fn register_refuses_a_vault_that_is_not_a_plain_system_account() {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    split(&mut env, &dev, &coin, &[(vault_pda(&coin.mint), 10_000)]);
    // nobody but flipfee can sign for the vault, so this state cannot happen on chain; faked here
    let vault = vault_pda(&coin.mint);
    for (owner, data) in [(pump::PUMP, vec![]), (SYSTEM_PROGRAM, vec![0u8; 8])] {
        env.svm
            .set_account(vault, solana_account::Account { lamports: 10 * RENT_MIN, data, owner, executable: false, rent_epoch: 0 })
            .unwrap();
        let res = env.send("register", vec![env.ix_register(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD)], &[&dev]);
        assert_err(&res, FlipfeeError::BadVault);
    }
}
