//! A coin that graduates to PumpSwap: creator fees accrue as WSOL in the AMM creator vault,
//! `transfer_creator_fees_to_pump_v2` sweeps them into pump's creator vault, `distribute_creator_fees_v2` pays the
//! flipfee vault, `crank` splits them by the second. Both orders: connect before graduating, and after.
mod common;

use common::*;
use flipfee::{FeesSynced, PayKind, Paid};
use solana_signer::Signer;

const T: u64 = 1_000_000_000_000;

#[test]
fn connect_then_graduate() {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    let m = coin.mint;
    env.connect(&dev, &coin, PRICE, MAX_AHEAD);
    let whale = env.user(1_000);
    env.graduate(&whale, &m);
    let sc = pump::sharing_config(&m);
    assert_eq!(env.pool_coin_creator(&m), sc, "migrate copied the sharing config into pool.coin_creator");
    // settle the curve-side fees of the graduation run first
    env.warp(10);
    env.keeper_tick(&m);

    // an hour on the graduated coin; AMM trades inside it
    let alice = env.user(10);
    env.warp(10);
    env.buy_hours(&alice, &m, 1);
    env.wrap_sol(&whale, 100 * SOL);
    env.warp(60);
    let f1 = env.amm_buy(&whale, &m, 5_000_000 * 1_000_000);
    env.warp(60);
    let f2 = env.amm_sell(&whale, &m, 2_000_000 * 1_000_000);
    assert!(f1 > 0 && f2 > 0, "AMM creator fees {f1} {f2}");
    env.warp(60);
    let a0 = env.lamports(&alice.pubkey());
    let meta = env.keeper_tick_graduated(&m);
    let s: FeesSynced = event(&meta);
    println!("graduated: AMM creator fees {f1} + {f2}, synced {} to the hour", s.amount);
    assert_eq!(s.amount, f1 + f2, "every AMM creator fee reached the vault");
    assert_eq!(s.to_windows, s.amount);
    let paid: u64 = events::<Paid>(&meta).iter().filter(|p| p.kind == PayKind::Holder).map(|p| p.amount).sum();
    assert_eq!(paid, s.amount);
    assert_eq!(env.lamports(&alice.pubkey()) - a0, s.amount);
    env.check_books(&m);
}

#[test]
fn graduate_then_connect() {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    let m = coin.mint;
    let whale = env.user(1_000);
    env.graduate(&whale, &m);
    assert_eq!(env.pool_coin_creator(&m), dev.pubkey());
    // connect: the sharing config must also move pool.coin_creator (pump requires the pool for graduated coins)
    let pool = pump::canonical_pool(&m);
    let ixs = vec![
        pump::create_fee_sharing_config(&dev.pubkey(), &m, Some(pool)),
        // graduated coin: pump_fees reads the canonical pool as the LAST remaining account (not in the docs)
        pump::update_fee_shares_v2(&dev.pubkey(), &m, &[dev.pubkey(), pool], &[(vault_pda(&m), 10_000)]),
        env.ix_register(&dev.pubkey(), &m, PRICE, MAX_AHEAD),
    ];
    env.ok_many("register", ixs, &[&dev]);
    assert_eq!(env.pool_coin_creator(&m), pump::sharing_config(&m));

    env.wrap_sol(&whale, 100 * SOL);
    env.warp(30);
    let f = env.amm_buy(&whale, &m, 3_000_000 * 1_000_000);
    env.warp(30);
    let d0 = env.lamports(&dev.pubkey());
    // pump's creator vault for the sharing config does not exist yet (no curve trade since connecting): the first
    // sweep pays its rent out of the fees, once
    let pump_vault = pump::creator_vault(&pump::sharing_config(&m));
    assert_eq!(env.lamports(&pump_vault), 0);
    let meta = env.keeper_tick_graduated(&m);
    assert_eq!(env.lamports(&pump_vault), RENT_MIN);
    let s: FeesSynced = event(&meta);
    assert_eq!(s.amount, f - RENT_MIN);
    assert_eq!(s.to_owner, s.amount, "no hour sold: the dev's");
    assert_eq!(env.lamports(&dev.pubkey()) - d0, s.amount);
    // from now on every AMM fee arrives in full
    env.warp(30);
    let f2 = env.amm_sell(&whale, &m, 1_000_000 * 1_000_000);
    env.warp(30);
    let meta = env.keeper_tick_graduated(&m);
    assert_eq!(event::<FeesSynced>(&meta).amount, f2);
    env.check_books(&m);
    let _ = T;
}

#[test]
fn a_graduated_coin_sells_hours_only_while_its_pool_pays_the_vault() {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    let m = coin.mint;
    let whale = env.user(1_000);
    // split set before graduating, registered after ("almost" on a graduated coin)
    let ixs = vec![
        pump::create_fee_sharing_config(&dev.pubkey(), &m, None),
        pump::update_fee_shares_v2(&dev.pubkey(), &m, &[dev.pubkey()], &[(vault_pda(&m), 10_000)]),
    ];
    env.ok_many("pump_split", ixs, &[&dev]);
    env.graduate(&whale, &m);
    let pool = pump::canonical_pool(&m);
    let saved = env.data(&pool);
    // a pool that pays someone else (a PumpSwap admin change of coin_creator) blocks register and buy
    env.patch(&pool, 211, dev.pubkey().as_ref());
    let res = env.send("register", vec![env.ix_register(&dev.pubkey(), &m, PRICE, MAX_AHEAD)], &[&dev]);
    assert_err(&res, flipfee::FlipfeeError::PoolNotRouted);
    env.patch(&pool, 0, &saved);
    env.ok("register", env.ix_register(&dev.pubkey(), &m, PRICE, MAX_AHEAD), &[&dev]);

    let alice = env.user(10);
    env.patch(&pool, 211, dev.pubkey().as_ref());
    let res = env.send("buy", vec![env.ix_buy(&alice.pubkey(), &m, 1, PRICE)], &[&alice]);
    assert_err(&res, flipfee::FlipfeeError::PoolNotRouted);
    env.patch(&pool, 0, &saved);
    // another account in the pool slot (not a pool, or another coin's pool) is refused once graduated
    let ix = env.ix_buy(&alice.pubkey(), &m, 1, PRICE);
    let res = env.send("buy", vec![with_account(ix.clone(), 8, pump::global())], &[&alice]);
    assert_err(&res, flipfee::FlipfeeError::PoolNotRouted);
    let other = env.create_coin(&alice);
    let res = env.send("buy", vec![with_account(ix.clone(), 8, pump::canonical_pool(&other.mint))], &[&alice]);
    assert_err(&res, flipfee::FlipfeeError::PoolNotRouted);
    // the graduation run left curve fees at pump: collect them first, then buy
    let mut ixs = env.collect_ixs(&m);
    ixs.push(ix);
    env.ok_many("buy", ixs, &[&alice]);
    env.check_books(&m);

    // before graduation the pool slot is not read
    let coin2 = env.create_coin(&dev);
    env.connect(&dev, &coin2, PRICE, MAX_AHEAD);
    let ix = with_account(env.ix_buy(&alice.pubkey(), &coin2.mint, 1, PRICE), 8, alice.pubkey());
    env.ok("buy", ix, &[&alice]);
}

#[test]
fn a_graduated_coin_needs_pumpswap_fees_swept_before_a_buy() {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    let m = coin.mint;
    env.connect(&dev, &coin, PRICE, MAX_AHEAD);
    let whale = env.user(1_000);
    env.graduate(&whale, &m);
    env.keeper_tick(&m);
    env.wrap_sol(&whale, 50 * SOL);
    let f = env.amm_buy(&whale, &m, 1_000_000 * 1_000_000);
    assert!(f > 0);
    let alice = env.user(10);
    // distribute alone leaves the AMM fees waiting: refused
    let payer = env.payer.pubkey();
    let ixs = vec![
        pump::distribute_creator_fees_v2(&payer, &m, &[vault_pda(&m)]),
        env.ix_buy(&alice.pubkey(), &m, 1, PRICE),
    ];
    let res = env.send("buy", ixs, &[&alice]);
    assert_err(&res, flipfee::FlipfeeError::FeesNotCollected);
    // a fake AMM vault is refused
    let other = env.create_coin(&alice);
    let mut ixs = env.collect_ixs(&m);
    let fake = pump::ata(&pump::amm_creator_vault_authority(&pump::sharing_config(&other.mint)), &pump::WSOL, &pump::TOKEN);
    ixs.push(with_account(env.ix_buy(&alice.pubkey(), &m, 1, PRICE), 10, fake));
    let res = env.send("buy", ixs, &[&alice]);
    assert_err(&res, flipfee::FlipfeeError::WrongPumpVault);
    // sweep + distribute + buy: the AMM fees are the dev's
    let meta = env.buy_hours(&alice, &m, 1);
    let s: FeesSynced = event(&meta);
    assert_eq!((s.amount, s.to_owner), (f, f));
    env.check_books(&m);
}
