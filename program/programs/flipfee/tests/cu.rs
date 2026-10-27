//! Compute units of every flipfee instruction (mainnet feature set), typical and worst case. Prints a table; the
//! client's COMPUTE_UNITS limits are these maxima × 1.5 (see client/src/constants.ts).
mod common;

use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const T: u64 = 1_000_000_000_000;

#[test]
fn compute_units() {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    let m = coin.mint;
    let meta = env.connect(&dev, &coin, PRICE, MAX_AHEAD);
    let fees_units = program_units(&meta.logs, &pump::PUMP_FEES);
    println!("pump create_fee_sharing_config {} CU, update_fee_shares_v2 {} CU", fees_units[0], fees_units[1]);
    let trader = env.user(2_000);
    env.trade_buy(&trader, &m, T);

    env.ok("set_terms", env.ix_set_terms(&dev.pubkey(), &m, PRICE, 172_800, false), &[&dev]);
    let admin = env.deployer.insecure_clone();
    let treasury = env.treasury.pubkey();
    env.ok("set_config", env.ix_set_config(&admin.pubkey(), &treasury, FEE_BPS, false), &[&admin]);
    env.ok("set_admin", env.ix_set_admin(&admin.pubkey(), admin.pubkey()), &[&admin]);

    // crank: nothing to do, sync only, sync + pay owner
    env.ok("crank (nothing)", env.ix_crank(&m, &[]), &[]);
    env.warp(30);
    env.distribute(&m);
    env.ok("crank (sync, no recipients)", env.ix_crank(&m, &[]), &[]);
    env.warp(30);
    env.trade_buy(&trader, &m, T);
    env.distribute(&m);
    env.ok("crank (sync + pay owner)", env.ix_crank(&m, &[dev.pubkey()]), &[]);

    // buy into an empty queue and into a long one
    let buyers: Vec<Keypair> = (0..32).map(|_| env.user(2)).collect();
    for (i, b) in buyers.iter().enumerate() {
        let name = if i == 0 { "buy (empty queue)" } else if i == 31 { "buy (31 queued)" } else { "buy" };
        env.ok(name, env.ix_buy(&b.pubkey(), &m, 1, PRICE), &[b]);
    }
    // 32 windows, trades through all of them, one sync across all 32 hours
    for _ in 0..32 {
        env.warp(HOUR);
        env.trade_buy(&trader, &m, T);
    }
    env.distribute(&m);
    // 15 recipients per crank keeps the logs under mainnet's 10,000-byte limit (the client and keeper batch so)
    let mut recipients = vec![dev.pubkey()];
    recipients.extend(buyers.iter().take(14).map(|b| b.pubkey()));
    env.ok("crank (sync over 32 windows + pay 15)", env.ix_crank(&m, &recipients), &[]);
    let rest: Vec<_> = buyers.iter().skip(14).take(15).map(|b| b.pubkey()).collect();
    env.ok("crank (pay 15, prune 14)", env.ix_crank(&m, &rest), &[]);
    let rest: Vec<_> = buyers.iter().skip(29).map(|b| b.pubkey()).collect();
    env.ok("crank (pay 3, prune 15)", env.ix_crank(&m, &rest), &[]);
    // the last window ends at the sync second: it is dropped one second later
    env.warp(1);
    env.ok("crank (nothing)", env.ix_crank(&m, &[]), &[]);
    assert!(env.coin(&m).windows.is_empty());
    env.check_books(&m);

    let heir = env.user(1);
    env.warp(30);
    env.trade_buy(&trader, &m, T);
    env.distribute(&m);
    env.ok("transfer_owner (sync + pay)", env.ix_transfer_owner(&dev.pubkey(), &m, &heir.pubkey()), &[&dev, &heir]);

    // a graduated coin: connect with its pool, AMM sweep
    let dev2 = env.user(10);
    let coin2 = env.create_coin(&dev2);
    let m2 = coin2.mint;
    let whale = env.user(2_000);
    env.graduate(&whale, &m2);
    let pool = pump::canonical_pool(&m2);
    let ixs = vec![
        pump::create_fee_sharing_config(&dev2.pubkey(), &m2, Some(pool)),
        pump::update_fee_shares_v2(&dev2.pubkey(), &m2, &[dev2.pubkey(), pool], &[(vault_pda(&m2), 10_000)]),
        env.ix_register(&dev2.pubkey(), &m2, PRICE, MAX_AHEAD),
    ];
    let meta = env.ok_many("register (graduated)", ixs, &[&dev2]);
    let fees_units = program_units(&meta.logs, &pump::PUMP_FEES);
    println!("pump create_fee_sharing_config (graduated) {} CU, update_fee_shares_v2 (graduated) {} CU", fees_units[0], fees_units[1]);
    env.wrap_sol(&whale, 100 * SOL);
    env.amm_buy(&whale, &m2, 2_000_000 * 1_000_000);
    let meta = env.keeper_tick_graduated(&m2);
    println!(
        "pump_amm transfer_creator_fees_to_pump_v2 {} CU, pump distribute_creator_fees_v2 {} CU",
        program_units(&meta.logs, &pump::PUMP_AMM)[0],
        program_units(&meta.logs, &pump::PUMP)[0]
    );

    // flipfee's own share of the connect transaction is recorded as "register"
    println!("\n{:<44} {:>8} {:>8}", "instruction", "max CU", "runs");
    let mut names: Vec<_> = env.cu.keys().cloned().collect();
    names.sort();
    for n in names {
        let v = &env.cu[&n];
        println!("{:<44} {:>8} {:>8}", n, v.iter().max().unwrap(), v.len());
    }
    let so = std::fs::metadata(format!("{}/../../target/deploy/flipfee.so", env!("CARGO_MANIFEST_DIR"))).unwrap().len();
    println!("\nprogram size: {so} bytes");
    let max_crank = env.cu.iter().filter(|(k, _)| k.starts_with("crank")).flat_map(|(_, v)| v.iter()).max().copied().unwrap();
    assert!(max_crank < 200_000, "worst crank fits the default 200k limit: {max_crank}");
}
