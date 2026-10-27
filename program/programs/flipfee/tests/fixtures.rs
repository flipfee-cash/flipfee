//! Writes client/test/fixtures/flipfee.json: real account bytes, instructions built by Anchor (flipfee) and by the
//! pump builders that run against the mainnet binaries here, and real transaction logs. The TS unit tests
//! (client/test/unit.test.mjs) check the client's decoders and builders against it byte for byte.
mod common;

use anchor_lang::{prelude::Pubkey, solana_program::instruction::Instruction};
use common::*;
use serde_json::{json, Value};
use solana_signer::Signer;

const T: u64 = 1_000_000_000_000;

fn ix_json(name: &str, ix: &Instruction, args: Value) -> Value {
    json!({
        "name": name,
        "programId": ix.program_id.to_string(),
        "keys": ix.accounts.iter().map(|m| json!({ "pubkey": m.pubkey.to_string(), "isSigner": m.is_signer, "isWritable": m.is_writable })).collect::<Vec<_>>(),
        "data": hex(&ix.data),
        "args": args,
    })
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn b64(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}

#[test]
fn write_client_fixtures() {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    let m = coin.mint;
    let curve_before = env.data(&pump::bonding_curve(&m));
    let connect = env.connect(&dev, &coin, PRICE, MAX_AHEAD);
    let trader = env.user(2_000);
    let first_trade = {
        let creator = env.curve_creator(&m);
        let ixs = vec![
            pump::create_ata(&trader.pubkey(), &trader.pubkey(), &m, &pump::TOKEN_2022),
            pump::buy_v2(&env.rc.clone(), &m, &trader.pubkey(), &creator, 2 * T, 100 * SOL),
        ];
        env.ok_many("pump_buy_v2", ixs, &[&trader])
    };
    env.warp(30);
    let tick_owner = env.keeper_tick(&m);
    let alice = env.user(10);
    let bob = env.user(10);
    env.warp(30);
    let buy = env.buy_hours(&alice, &m, 2);
    env.buy_hours(&bob, &m, 1);
    env.warp(600);
    env.trade_buy(&trader, &m, 3 * T);
    let sell_trade = {
        let creator = env.curve_creator(&m);
        env.ok("pump_sell_v2", pump::sell_v2(&env.rc.clone(), &m, &trader.pubkey(), &creator, T, 0), &[&trader])
    };
    env.warp(60);
    let tick_holder = env.keeper_tick(&m);
    // a sync across alice's end and bob's hour, then alice's window is done
    env.warp_to(env.coin(&m).windows[0].end + 120);
    env.trade_buy(&trader, &m, 2 * T);
    let tick_done = env.keeper_tick(&m);
    let terms = env.ok("set_terms", env.ix_set_terms(&dev.pubkey(), &m, 2 * PRICE, 172_800, false), &[&dev]);
    let heir = env.user(1);
    env.warp(30);
    let transfer = env.ok("transfer_owner", env.ix_transfer_owner(&dev.pubkey(), &m, &heir.pubkey()), &[&dev, &heir]);
    let admin = env.deployer.insecure_clone();
    let treasury = env.treasury.pubkey();
    let set_config = env.ok("set_config", env.ix_set_config(&admin.pubkey(), &treasury, 400, false), &[&admin]);
    let failed = env.send("buy", vec![env.ix_buy(&alice.pubkey(), &m, 13, PRICE)], &[&alice]).unwrap_err();
    env.check_books(&m);

    // a graduated coin with a pool (for the Pool decoder and the AMM events)
    let dev2 = env.user(10);
    let coin2 = env.create_coin(&dev2);
    env.connect(&dev2, &coin2, PRICE, MAX_AHEAD);
    let whale = env.user(1_000);
    env.graduate(&whale, &coin2.mint);
    env.wrap_sol(&whale, 50 * SOL);
    let amm_buy = {
        let cc = env.pool_coin_creator(&coin2.mint);
        let rc = env.rc.clone();
        let ixs = vec![
            pump::create_ata(&whale.pubkey(), &whale.pubkey(), &coin2.mint, &pump::TOKEN_2022),
            pump::amm_trade(&rc, &coin2.mint, &whale.pubkey(), &cc, true, 1_000_000 * 1_000_000, 1_000 * SOL),
        ];
        env.ok_many("amm_buy", ixs, &[&whale])
    };
    let amm_sell = {
        let cc = env.pool_coin_creator(&coin2.mint);
        let rc = env.rc.clone();
        env.ok("amm_sell", pump::amm_trade(&rc, &coin2.mint, &whale.pubkey(), &cc, false, 500_000 * 1_000_000, 0), &[&whale])
    };

    let c = env.coin(&m);
    let cfg = env.config();
    let sc = pump::sharing_config(&m);
    let pdas = |mint: &Pubkey| {
        json!({
            "mint": mint.to_string(),
            "coin": coin_pda(mint).to_string(),
            "vault": vault_pda(mint).to_string(),
            "sharingConfig": pump::sharing_config(mint).to_string(),
            "bondingCurve": pump::bonding_curve(mint).to_string(),
            "pumpCreatorVault": pump::creator_vault(&pump::sharing_config(mint)).to_string(),
            "poolAuthority": pump::pool_authority(mint).to_string(),
            "canonicalPool": pump::canonical_pool(mint).to_string(),
            "ammCreatorVaultAuthority": pump::amm_creator_vault_authority(&pump::sharing_config(mint)).to_string(),
            "ammCreatorVaultAta": pump::ata(&pump::amm_creator_vault_authority(&pump::sharing_config(mint)), &pump::WSOL, &pump::TOKEN).to_string(),
        })
    };
    let window = |w: &flipfee::Window| json!({ "holder": w.holder.to_string(), "start": w.start, "end": w.end, "owed": w.owed.to_string(), "earned": w.earned.to_string() });

    let payer = env.payer.pubkey();
    let vault = vault_pda(&m);
    let pool2 = pump::canonical_pool(&coin2.mint);
    let instructions = vec![
        ix_json("initialize", &env.ix_initialize(&admin.pubkey(), &treasury, 500), json!({ "authority": admin.pubkey().to_string(), "treasury": treasury.to_string(), "feeBps": 500 })),
        ix_json("set_config", &env.ix_set_config(&admin.pubkey(), &treasury, 400, true), json!({ "admin": admin.pubkey().to_string(), "treasury": treasury.to_string(), "feeBps": 400, "paused": true })),
        ix_json("set_admin", &env.ix_set_admin(&admin.pubkey(), heir.pubkey()), json!({ "admin": admin.pubkey().to_string(), "newAdmin": heir.pubkey().to_string() })),
        ix_json("register", &env.ix_register(&dev.pubkey(), &m, PRICE, MAX_AHEAD), json!({ "owner": dev.pubkey().to_string(), "mint": m.to_string(), "price": PRICE.to_string(), "maxAhead": MAX_AHEAD })),
        ix_json("set_terms", &env.ix_set_terms(&heir.pubkey(), &m, 123_456_789, 7_200, true), json!({ "owner": heir.pubkey().to_string(), "mint": m.to_string(), "price": "123456789", "maxAhead": 7200, "paused": true })),
        ix_json("transfer_owner", &env.ix_transfer_owner(&heir.pubkey(), &m, &dev.pubkey()), json!({ "owner": heir.pubkey().to_string(), "mint": m.to_string(), "newOwner": dev.pubkey().to_string() })),
        ix_json("buy", &env.ix_buy_by(&alice.pubkey(), &m, 3, 2 * PRICE, 1_791_300_000), json!({ "buyer": alice.pubkey().to_string(), "mint": m.to_string(), "owner": heir.pubkey().to_string(), "treasury": treasury.to_string(), "hours": 3, "maxPrice": (2 * PRICE).to_string(), "maxStart": 1_791_300_000 })),
        ix_json("crank", &env.ix_crank(&m, &[heir.pubkey(), alice.pubkey()]), json!({ "mint": m.to_string(), "recipients": [heir.pubkey().to_string(), alice.pubkey().to_string()] })),
        ix_json("pump_create_fee_sharing_config", &pump::create_fee_sharing_config(&dev.pubkey(), &m, None), json!({ "creator": dev.pubkey().to_string(), "mint": m.to_string() })),
        ix_json("pump_create_fee_sharing_config_pool", &pump::create_fee_sharing_config(&dev2.pubkey(), &coin2.mint, Some(pool2)), json!({ "creator": dev2.pubkey().to_string(), "mint": coin2.mint.to_string(), "pool": pool2.to_string() })),
        ix_json("pump_update_fee_shares_v2", &pump::update_fee_shares_v2(&dev.pubkey(), &m, &[dev.pubkey()], &[(vault, 10_000)]), json!({ "authority": dev.pubkey().to_string(), "mint": m.to_string(), "current": [dev.pubkey().to_string()], "next": [{ "address": vault.to_string(), "shareBps": 10_000 }] })),
        ix_json("pump_update_fee_shares_v2_pool", &pump::update_fee_shares_v2(&dev2.pubkey(), &coin2.mint, &[dev2.pubkey(), pool2], &[(vault_pda(&coin2.mint), 10_000)]), json!({ "authority": dev2.pubkey().to_string(), "mint": coin2.mint.to_string(), "current": [dev2.pubkey().to_string()], "pool": pool2.to_string(), "next": [{ "address": vault_pda(&coin2.mint).to_string(), "shareBps": 10_000 }] })),
        ix_json("pump_update_fee_shares_v1", &pump::update_fee_shares_v1(&dev.pubkey(), &m, &[dev.pubkey()], &[(vault, 10_000)]), json!({ "authority": dev.pubkey().to_string(), "mint": m.to_string(), "current": [dev.pubkey().to_string()], "next": [{ "address": vault.to_string(), "shareBps": 10_000 }] })),
        ix_json("pump_distribute_creator_fees_v2", &pump::distribute_creator_fees_v2(&payer, &m, &[vault]), json!({ "payer": payer.to_string(), "mint": m.to_string(), "shareholders": [vault.to_string()] })),
        ix_json("pump_get_minimum_distributable_fee", &pump::get_minimum_distributable_fee(&m, &[vault]), json!({ "mint": m.to_string(), "shareholders": [vault.to_string()] })),
        ix_json("pump_transfer_creator_fees_to_pump_v2", &pump::transfer_creator_fees_to_pump_v2(&payer, &sc), json!({ "payer": payer.to_string(), "coinCreator": sc.to_string() })),
        ix_json("pump_create_v2", &pump::create_v2(&m, &dev.pubkey(), &dev.pubkey(), "Flip Test", "FLIP"), json!({ "mint": m.to_string(), "user": dev.pubkey().to_string(), "creator": dev.pubkey().to_string(), "name": "Flip Test", "symbol": "FLIP", "uri": "https://flipfee.test/meta.json" })),
        ix_json("pump_buy_v2", &pump::buy_v2(&env.rc, &m, &trader.pubkey(), &sc, 5 * T, 3 * SOL), json!({ "feeRecipient": env.rc.fee_recipient.to_string(), "buybackFeeRecipient": env.rc.buyback_fee_recipient.to_string(), "mint": m.to_string(), "user": trader.pubkey().to_string(), "curveCreator": sc.to_string(), "amount": (5 * T).to_string(), "maxSolCost": (3 * SOL).to_string() })),
        ix_json("pump_sell_v2", &pump::sell_v2(&env.rc, &m, &trader.pubkey(), &sc, 5 * T, 7), json!({ "feeRecipient": env.rc.fee_recipient.to_string(), "buybackFeeRecipient": env.rc.buyback_fee_recipient.to_string(), "mint": m.to_string(), "user": trader.pubkey().to_string(), "curveCreator": sc.to_string(), "amount": (5 * T).to_string(), "minSolOutput": "7" })),
        ix_json("create_ata", &pump::create_ata(&trader.pubkey(), &trader.pubkey(), &m, &pump::TOKEN_2022), json!({ "payer": trader.pubkey().to_string(), "owner": trader.pubkey().to_string(), "mint": m.to_string(), "tokenProgram": pump::TOKEN_2022.to_string() })),
    ];

    let out = json!({
        "programId": flipfee::ID.to_string(),
        "pdas": {
            "config": config_pda().to_string(),
            "programData": program_data_address(&flipfee::ID).to_string(),
            "pumpGlobal": pump::global().to_string(),
            "coins": [pdas(&m), pdas(&coin2.mint)],
        },
        "accounts": {
            "config": { "data": b64(&env.data(&config_pda())), "admin": cfg.admin.to_string(), "treasury": cfg.treasury.to_string(), "feeBps": cfg.fee_bps, "paused": cfg.paused, "bump": cfg.bump },
            "coin": {
                "data": b64(&env.data(&coin_pda(&m))),
                "mint": c.mint.to_string(), "owner": c.owner.to_string(), "bump": c.bump, "vaultBump": c.vault_bump,
                "price": c.price.to_string(), "maxAhead": c.max_ahead, "paused": c.paused, "lastSync": c.last_sync,
                "ownerOwed": c.owner_owed.to_string(), "credited": c.credited.to_string(),
                "windows": c.windows.iter().map(window).collect::<Vec<_>>(),
                "feesIn": c.fees_in.to_string(), "sales": c.sales.to_string(), "hoursSold": c.hours_sold, "paidOut": c.paid_out.to_string(),
            },
            "bondingCurveBefore": { "data": b64(&curve_before), "creator": dev.pubkey().to_string() },
            "bondingCurve": { "data": b64(&env.data(&pump::bonding_curve(&m))), "creator": sc.to_string() },
            "bondingCurveGraduated": { "data": b64(&env.data(&pump::bonding_curve(&coin2.mint))) },
            "sharingConfig": { "data": b64(&env.data(&sc)), "admin": dev.pubkey().to_string(), "mint": m.to_string(), "vault": vault.to_string() },
            "pool": { "data": b64(&env.data(&pool2)), "coinCreator": pump::sharing_config(&coin2.mint).to_string(), "baseMint": coin2.mint.to_string(), "creator": pump::pool_authority(&coin2.mint).to_string() },
        },
        "instructions": instructions,
        "logs": {
            "connect": connect.logs,
            "firstTrade": first_trade.logs,
            "sellTrade": sell_trade.logs,
            "tickOwner": tick_owner.logs,
            "buy": buy.logs,
            "tickHolder": tick_holder.logs,
            "tickDone": tick_done.logs,
            "setTerms": terms.logs,
            "transferOwner": transfer.logs,
            "setConfig": set_config.logs,
            "failedBuy": failed.meta.logs,
            "ammBuy": amm_buy.logs,
            "ammSell": amm_sell.logs,
        },
        "people": {
            "dev": dev.pubkey().to_string(), "alice": alice.pubkey().to_string(), "bob": bob.pubkey().to_string(),
            "heir": heir.pubkey().to_string(), "trader": trader.pubkey().to_string(), "treasury": treasury.to_string(),
            "whale": whale.pubkey().to_string(),
        },
    });
    let path = format!("{}/../../client/test/fixtures/flipfee.json", env!("CARGO_MANIFEST_DIR"));
    std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
    std::fs::write(&path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
    println!("wrote {path}");
}
