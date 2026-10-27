mod common;

use anchor_lang::prelude::Pubkey;
use common::*;
use flipfee::{FeesSynced, FlipfeeError, HoursBought, OwnerTransferred, TermsSet};
use solana_keypair::Keypair;
use solana_signer::Signer;

fn setup() -> (Env, Keypair, TestCoin) {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    env.connect(&dev, &coin, PRICE, MAX_AHEAD);
    (env, dev, coin)
}

#[test]
fn buy_starts_now_then_queues() {
    let (mut env, dev, coin) = setup();
    let alice = env.user(10);
    let bob = env.user(10);
    let treasury = env.treasury.pubkey();
    env.warp(5);
    let t0 = env.now();
    let (a0, d0, f0) = (env.lamports(&alice.pubkey()), env.lamports(&dev.pubkey()), env.lamports(&treasury));
    let meta = env.buy_hours(&alice, &coin.mint, 1);
    let ev: HoursBought = event(&meta);
    let total = PRICE;
    let fee = total * 500 / 10_000;
    assert_eq!(
        (ev.mint, ev.coin, ev.buyer, ev.start, ev.end, ev.hours, ev.price, ev.total, ev.to_owner, ev.fee, ev.windows, ev.at),
        (coin.mint, coin_pda(&coin.mint), alice.pubkey(), t0, t0 + HOUR, 1, PRICE, total, total - fee, fee, 1, t0)
    );
    assert_eq!(a0 - env.lamports(&alice.pubkey()), total, "the buyer pays exactly price × hours");
    assert_eq!(env.lamports(&dev.pubkey()) - d0, total - fee, "95% to the dev at once");
    assert_eq!(env.lamports(&treasury) - f0, fee, "5% to the treasury");

    // bob's 3 hours queue right after alice's hour
    env.warp(600);
    let meta = env.buy_hours(&bob, &coin.mint, 3);
    let ev: HoursBought = event(&meta);
    assert_eq!((ev.start, ev.end, ev.total, ev.windows), (t0 + HOUR, t0 + 4 * HOUR, 3 * PRICE, 2));
    // alice again: after bob
    let meta = env.buy_hours(&alice, &coin.mint, 2);
    let ev: HoursBought = event(&meta);
    assert_eq!((ev.start, ev.end), (t0 + 4 * HOUR, t0 + 6 * HOUR));

    let c = env.coin(&coin.mint);
    assert_eq!(c.windows.len(), 3);
    assert_eq!((c.sales, c.hours_sold), (6 * PRICE, 6));
    assert_eq!(c.windows[0].holder, alice.pubkey());
    assert_eq!(c.windows[1].holder, bob.pubkey());
    env.check_books(&coin.mint);

    // after the queue ran out, the next hour starts now again
    env.warp_to(t0 + 7 * HOUR);
    env.keeper_tick(&coin.mint);
    let meta = env.buy_hours(&bob, &coin.mint, 1);
    let ev: HoursBought = event(&meta);
    assert_eq!(ev.start, env.now());
    env.check_books(&coin.mint);
}

#[test]
fn buy_limits() {
    let (mut env, dev, coin) = setup();
    let alice = env.user(100);
    for hours in [0u8, 13] {
        let res = env.send("buy", vec![env.ix_buy(&alice.pubkey(), &coin.mint, hours, PRICE)], &[&alice]);
        assert_err(&res, FlipfeeError::BadHours);
    }
    let res = env.send("buy", vec![env.ix_buy(&alice.pubkey(), &coin.mint, 1, PRICE - 1)], &[&alice]);
    assert_err(&res, FlipfeeError::PriceAboveMax);
    // max_ahead 24 h: 12 h + 12 h fits exactly, one more hour does not
    env.ok("buy", env.ix_buy(&alice.pubkey(), &coin.mint, 12, PRICE), &[&alice]);
    env.ok("buy", env.ix_buy(&alice.pubkey(), &coin.mint, 12, PRICE), &[&alice]);
    let res = env.send("buy", vec![env.ix_buy(&alice.pubkey(), &coin.mint, 1, PRICE)], &[&alice]);
    assert_err(&res, FlipfeeError::TooFarAhead);
    env.warp(HOUR);
    env.ok("buy", env.ix_buy(&alice.pubkey(), &coin.mint, 1, PRICE), &[&alice]);

    // the dev raises the price: a buyer's stale max_price fails, then pays the new price
    env.ok("set_terms", env.ix_set_terms(&dev.pubkey(), &coin.mint, 2 * PRICE, 172_800, false), &[&dev]);
    let res = env.send("buy", vec![env.ix_buy(&alice.pubkey(), &coin.mint, 1, PRICE)], &[&alice]);
    assert_err(&res, FlipfeeError::PriceAboveMax);
    let meta = env.ok("buy", env.ix_buy(&alice.pubkey(), &coin.mint, 1, 2 * PRICE), &[&alice]);
    assert_eq!(event::<HoursBought>(&meta).total, 2 * PRICE);

    // paused coin, paused flipfee
    env.ok("set_terms", env.ix_set_terms(&dev.pubkey(), &coin.mint, PRICE, 172_800, true), &[&dev]);
    let res = env.send("buy", vec![env.ix_buy(&alice.pubkey(), &coin.mint, 1, PRICE)], &[&alice]);
    assert_err(&res, FlipfeeError::CoinPaused);
    env.ok("set_terms", env.ix_set_terms(&dev.pubkey(), &coin.mint, PRICE, 172_800, false), &[&dev]);
    let admin = env.deployer.insecure_clone();
    let treasury = env.treasury.pubkey();
    env.ok("set_config", env.ix_set_config(&admin.pubkey(), &treasury, FEE_BPS, true), &[&admin]);
    let res = env.send("buy", vec![env.ix_buy(&alice.pubkey(), &coin.mint, 1, PRICE)], &[&alice]);
    assert_err(&res, FlipfeeError::Paused);
    // payouts never stop
    env.keeper_tick(&coin.mint);
    env.ok("set_config", env.ix_set_config(&admin.pubkey(), &treasury, FEE_BPS, false), &[&admin]);
    env.ok("buy", env.ix_buy(&alice.pubkey(), &coin.mint, 1, PRICE), &[&alice]);
    env.check_books(&coin.mint);
}

#[test]
fn buy_pays_only_the_owner_and_the_treasury() {
    let (mut env, _dev, coin) = setup();
    let alice = env.user(10);
    let thief = env.user(1);
    let ix = env.ix_buy(&alice.pubkey(), &coin.mint, 1, PRICE);
    let res = env.send("buy", vec![with_account(ix.clone(), 4, thief.pubkey())], &[&alice]);
    assert_err(&res, FlipfeeError::WrongOwner);
    let res = env.send("buy", vec![with_account(ix.clone(), 5, thief.pubkey())], &[&alice]);
    assert_err(&res, FlipfeeError::WrongTreasury);
    // a fake vault (more lamports than the real one) cannot feed the sync
    let other = env.create_coin(&alice);
    let res = env.send("buy", vec![with_account(ix.clone(), 3, vault_pda(&other.mint))], &[&alice]);
    assert_anchor_err(&res, anchor_codes::CONSTRAINT_SEEDS);
    let res = env.send("buy", vec![unsigned(ix.clone(), 0)], &[]);
    assert!(res.is_err(), "the buyer signs");
    env.ok("buy", ix, &[&alice]);
}

#[test]
fn buy_rechecks_the_pump_routing() {
    let (mut env, dev, coin) = setup();
    let alice = env.user(10);
    let bc = pump::bonding_curve(&coin.mint);
    let sc = pump::sharing_config(&coin.mint);
    let ix = env.ix_buy(&alice.pubkey(), &coin.mint, 1, PRICE);

    // a pump.fun takeover moves the curve's creator away from the sharing config
    let saved_bc = env.data(&bc);
    env.patch(&bc, 49, dev.pubkey().as_ref());
    let res = env.send("buy", vec![ix.clone()], &[&alice]);
    assert_err(&res, FlipfeeError::CurveNotRouted);
    env.patch(&bc, 0, &saved_bc);
    // … or resets the split
    let saved_sc = env.data(&sc);
    env.patch(&sc, 80, dev.pubkey().as_ref());
    let res = env.send("buy", vec![ix.clone()], &[&alice]);
    assert_err(&res, FlipfeeError::SplitNotToVault);
    env.patch(&sc, 0, &saved_sc);
    // … or pauses fee sharing
    env.patch(&sc, 10, &[0]);
    let res = env.send("buy", vec![ix.clone()], &[&alice]);
    assert_err(&res, FlipfeeError::SharingNotActive);
    env.patch(&sc, 0, &saved_sc);
    // accounts of another coin, or not pump accounts at all
    let other = env.create_coin(&alice);
    let res = env.send("buy", vec![with_account(ix.clone(), 6, pump::sharing_config(&other.mint))], &[&alice]);
    assert_err(&res, FlipfeeError::NotSharingConfig);
    let res = env.send("buy", vec![with_account(ix.clone(), 6, alice.pubkey())], &[&alice]);
    assert_err(&res, FlipfeeError::NotSharingConfig);
    let res = env.send("buy", vec![with_account(ix.clone(), 7, pump::bonding_curve(&other.mint))], &[&alice]);
    assert_err(&res, FlipfeeError::CurveNotRouted);
    let res = env.send("buy", vec![with_account(ix.clone(), 7, pump::global())], &[&alice]);
    assert_err(&res, FlipfeeError::NotBondingCurve);
    env.ok("buy", ix, &[&alice]);
}

#[test]
fn queue_full_then_freed() {
    let (mut env, dev, coin) = setup();
    env.ok("set_terms", env.ix_set_terms(&dev.pubkey(), &coin.mint, PRICE, 172_800, false), &[&dev]);
    let buyers: Vec<Keypair> = (0..33).map(|_| env.user(2)).collect();
    for b in &buyers[..32] {
        env.ok("buy", env.ix_buy(&b.pubkey(), &coin.mint, 1, PRICE), &[b]);
    }
    assert_eq!(env.coin(&coin.mint).windows.len(), 32);
    let res = env.send("buy", vec![env.ix_buy(&buyers[32].pubkey(), &coin.mint, 1, PRICE)], &[&buyers[32]]);
    assert_err(&res, FlipfeeError::QueueFull);
    // two hours (and a second) later the first two windows ended with nothing owed: the next buy drops them and fits
    env.warp(2 * HOUR + 1);
    env.ok("buy", env.ix_buy(&buyers[32].pubkey(), &coin.mint, 1, PRICE), &[&buyers[32]]);
    assert_eq!(env.coin(&coin.mint).windows.len(), 31);
    env.check_books(&coin.mint);
}

#[test]
fn set_terms_only_by_the_owner() {
    let (mut env, dev, coin) = setup();
    let other = env.user(1);
    let res = env.send("set_terms", vec![env.ix_set_terms(&other.pubkey(), &coin.mint, PRICE, MAX_AHEAD, true)], &[&other]);
    assert_err(&res, FlipfeeError::NotOwner);
    for (price, ahead, err) in [
        (9_999_999, MAX_AHEAD, FlipfeeError::PriceOutOfRange),
        (1_000 * SOL + 1, MAX_AHEAD, FlipfeeError::PriceOutOfRange),
        (PRICE, 3_599, FlipfeeError::MaxAheadOutOfRange),
        (PRICE, 172_801, FlipfeeError::MaxAheadOutOfRange),
    ] {
        let res = env.send("set_terms", vec![env.ix_set_terms(&dev.pubkey(), &coin.mint, price, ahead, false)], &[&dev]);
        assert_err(&res, err);
    }
    let meta = env.ok("set_terms", env.ix_set_terms(&dev.pubkey(), &coin.mint, 10_000_000, 3_600, true), &[&dev]);
    let ev: TermsSet = event(&meta);
    assert_eq!((ev.price, ev.max_ahead, ev.paused), (10_000_000, 3_600, true));
    let c = env.coin(&coin.mint);
    assert_eq!((c.price, c.max_ahead, c.paused), (10_000_000, 3_600, true));
}

#[test]
fn transfer_owner_pays_the_old_owner_first() {
    let (mut env, dev, coin) = setup();
    let trader = env.user(200);
    let heir = env.user(1);
    env.warp(30);
    env.trade_buy(&trader, &coin.mint, 5_000_000_000_000);
    env.warp(30);
    env.distribute(&coin.mint); // arrived, not synced yet
    let owed_vault = env.lamports(&vault_pda(&coin.mint)) - RENT_MIN;
    assert!(owed_vault > 0);

    let res = env.send("transfer_owner", vec![env.ix_transfer_owner(&heir.pubkey(), &coin.mint, &heir.pubkey())], &[&heir]);
    assert_err(&res, FlipfeeError::NotOwner);
    // the new owner must sign: an account nobody can sign for (the vault, a program, a PDA) cannot become owner
    let ix = unsigned(env.ix_transfer_owner(&dev.pubkey(), &coin.mint, &heir.pubkey()), 3);
    let res = env.send("transfer_owner", vec![ix], &[&dev]);
    assert_anchor_err(&res, anchor_codes::ACCOUNT_NOT_SIGNER);

    let before = env.lamports(&dev.pubkey());
    let meta = env.ok("transfer_owner", env.ix_transfer_owner(&dev.pubkey(), &coin.mint, &heir.pubkey()), &[&dev, &heir]);
    let ev: OwnerTransferred = event(&meta);
    assert_eq!((ev.from, ev.to, ev.paid_to_old_owner), (dev.pubkey(), heir.pubkey(), owed_vault));
    assert_eq!(env.lamports(&dev.pubkey()) - before, owed_vault, "the old owner got every fee up to now");
    let c = env.coin(&coin.mint);
    assert_eq!((c.owner, c.owner_owed, c.credited), (heir.pubkey(), 0, 0));
    env.check_books(&coin.mint);

    // the old owner is out; sales now pay the heir
    let res = env.send("set_terms", vec![env.ix_set_terms(&dev.pubkey(), &coin.mint, PRICE, MAX_AHEAD, false)], &[&dev]);
    assert_err(&res, FlipfeeError::NotOwner);
    let alice = env.user(5);
    let h0 = env.lamports(&heir.pubkey());
    env.buy_hours(&alice, &coin.mint, 1);
    assert_eq!(env.lamports(&heir.pubkey()) - h0, PRICE - PRICE * 5 / 100);
    let _ = Pubkey::default();
}

#[test]
fn transfer_owner_refuses_while_the_old_owner_cannot_take_its_fees() {
    let (mut env, dev, coin) = setup();
    let trader = env.user(100);
    let heir = env.user(1);
    env.trade_buy(&trader, &coin.mint, 1_000_000_000_000);
    env.warp(30);
    env.trade_buy(&trader, &coin.mint, 100_000_000); // a fee far below the 0-byte rent
    env.warp(30);
    env.keeper_tick(&coin.mint); // the dev is paid what arrived so far
    env.trade_buy(&trader, &coin.mint, 100_000_000);
    env.warp(30);
    env.distribute(&coin.mint);
    let small = env.lamports(&vault_pda(&coin.mint)) - RENT_MIN;
    assert!(small > 0 && small < RENT_MIN, "{small}");
    // the dev empties its wallet (the account closes)
    let all = env.lamports(&dev.pubkey());
    let ix = anchor_lang::solana_program::system_instruction::transfer(&dev.pubkey(), &heir.pubkey(), all);
    env.ok("empty", ix, &[&dev]);
    assert!(!env.exists(&dev.pubkey()));
    let res = env.send("transfer_owner", vec![env.ix_transfer_owner(&dev.pubkey(), &coin.mint, &heir.pubkey())], &[&dev, &heir]);
    assert_err(&res, FlipfeeError::OwnerCannotReceive);
    assert_eq!(env.coin(&coin.mint).owner, dev.pubkey(), "nothing changed");
    // with SOL in the wallet again it goes through and the old owner gets its fees
    env.svm.airdrop(&dev.pubkey(), SOL).unwrap();
    let meta = env.ok("transfer_owner", env.ix_transfer_owner(&dev.pubkey(), &coin.mint, &heir.pubkey()), &[&dev, &heir]);
    assert_eq!(event::<OwnerTransferred>(&meta).paid_to_old_owner, small);
    assert_eq!(env.lamports(&dev.pubkey()), SOL + small);
    env.check_books(&coin.mint);
}

#[test]
fn buy_refuses_until_pump_fees_are_collected() {
    let (mut env, dev, coin) = setup();
    let m = coin.mint;
    let alice = env.user(10);
    let trader = env.user(100);
    env.trade_buy(&trader, &m, 1_000_000_000_000);
    env.warp(60);
    env.trade_buy(&trader, &m, 3_000_000_000_000);
    let pump_vault = pump::creator_vault(&pump::sharing_config(&m));
    let pending = env.lamports(&pump_vault) - RENT_MIN;
    assert!(pending > 0);
    // buying without distributing first would let alice's hour take fees earned before it
    let res = env.send("buy", vec![env.ix_buy(&alice.pubkey(), &m, 1, PRICE)], &[&alice]);
    assert_err(&res, FlipfeeError::FeesNotCollected);
    // a fake (empty) pump vault is refused
    let other = env.create_coin(&alice);
    let fake = with_account(env.ix_buy(&alice.pubkey(), &m, 1, PRICE), 9, pump::creator_vault(&pump::sharing_config(&other.mint)));
    let res = env.send("buy", vec![fake], &[&alice]);
    assert_err(&res, FlipfeeError::WrongPumpVault);
    // distribute + buy: the pending fees are the dev's, the hour starts clean
    let d0 = env.lamports(&dev.pubkey());
    let meta = env.buy_hours(&alice, &m, 1);
    let s: FeesSynced = event(&meta);
    assert_eq!((s.amount, s.to_owner), (pending, pending));
    env.ok("crank", env.ix_crank(&m, &[dev.pubkey()]), &[]);
    assert_eq!(env.lamports(&dev.pubkey()) - d0, pending + PRICE - PRICE * 5 / 100);
    env.check_books(&m);
    // dust up to PENDING_TOLERANCE (two transaction fees) does not stop a sale; more does
    let friend = env.user(1);
    let tolerance = flipfee::PENDING_TOLERANCE;
    env.ok("dust", anchor_lang::solana_program::system_instruction::transfer(&friend.pubkey(), &pump_vault, tolerance), &[&friend]);
    env.ok("buy", env.ix_buy(&alice.pubkey(), &m, 1, PRICE), &[&alice]);
    env.ok("dust", anchor_lang::solana_program::system_instruction::transfer(&friend.pubkey(), &pump_vault, 1), &[&friend]);
    let res = env.send("buy", vec![env.ix_buy(&alice.pubkey(), &m, 1, PRICE)], &[&alice]);
    assert_err(&res, FlipfeeError::FeesNotCollected);
}

#[test]
fn buy_refuses_to_start_later_than_max_start() {
    let (mut env, _dev, coin) = setup();
    let m = coin.mint;
    let (front, victim) = (env.user(10), env.user(10));
    env.warp(10);
    let now = env.now();
    // the victim's app expects "starts now"; a front-runner queues 12 hours first
    env.buy_hours(&front, &m, 12);
    let res = env.send("buy", vec![env.ix_buy_by(&victim.pubkey(), &m, 1, PRICE, now + 120)], &[&victim]);
    assert_err(&res, FlipfeeError::StartsTooLate);
    // a buyer who accepts the later start gets it
    let meta = env.ok("buy", env.ix_buy_by(&victim.pubkey(), &m, 1, PRICE, now + 12 * HOUR), &[&victim]);
    assert_eq!(event::<HoursBought>(&meta).start, now + 12 * HOUR);
}

#[test]
fn an_emptied_treasury_does_not_block_sales() {
    let (mut env, dev, coin) = setup();
    let m = coin.mint;
    env.ok("set_terms", env.ix_set_terms(&dev.pubkey(), &m, 10_000_000, MAX_AHEAD, false), &[&dev]);
    // the treasury's owner moves everything out: a 500,000-lamport fee could not create it again
    let treasury = env.treasury.insecure_clone();
    let all = env.lamports(&treasury.pubkey());
    let sink = env.user(1).pubkey();
    env.ok("empty", anchor_lang::solana_program::system_instruction::transfer(&treasury.pubkey(), &sink, all), &[&treasury]);
    let alice = env.user(10);
    let d0 = env.lamports(&dev.pubkey());
    let meta = env.buy_hours(&alice, &m, 1);
    let ev: HoursBought = event(&meta);
    assert_eq!((ev.total, ev.fee, ev.to_owner), (10_000_000, 0, 10_000_000), "the fee goes to the owner");
    assert_eq!(env.lamports(&dev.pubkey()) - d0, 10_000_000);
    assert!(!env.exists(&treasury.pubkey()));
    // a fee large enough to fund the account goes to the treasury again
    let meta = env.buy_hours(&alice, &m, 12);
    assert_eq!(event::<HoursBought>(&meta).fee, 6_000_000, "5% of 0.12 SOL");
    let _ = Pubkey::default();
}

#[test]
fn holder_rewards_coins_are_refused() {
    let (mut env, _dev, coin) = setup();
    let alice = env.user(10);
    let bc = pump::bonding_curve(&coin.mint);
    // a takeover could turn a coin into a holder-rewards coin: its creator fee then goes to holders
    env.patch(&bc, 124, &[1]);
    let res = env.send("buy", vec![env.ix_buy(&alice.pubkey(), &coin.mint, 1, PRICE)], &[&alice]);
    assert_err(&res, FlipfeeError::HolderRewardCoin);
    env.patch(&bc, 124, &[0]);
    env.buy_hours(&alice, &coin.mint, 1);
    // and register refuses them
    let dev2 = env.user(10);
    let coin2 = env.create_coin(&dev2);
    let ixs = vec![
        pump::create_fee_sharing_config(&dev2.pubkey(), &coin2.mint, None),
        pump::update_fee_shares_v2(&dev2.pubkey(), &coin2.mint, &[dev2.pubkey()], &[(vault_pda(&coin2.mint), 10_000)]),
    ];
    env.ok_many("pump_split", ixs, &[&dev2]);
    env.patch(&pump::bonding_curve(&coin2.mint), 124, &[1]);
    let res = env.send("register", vec![env.ix_register(&dev2.pubkey(), &coin2.mint, PRICE, MAX_AHEAD)], &[&dev2]);
    assert_err(&res, FlipfeeError::HolderRewardCoin);
}
