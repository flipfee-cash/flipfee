//! Time-weighted splits with real pump.fun fees: trades on the mainnet pump program, `distribute_creator_fees_v2`
//! into the vault, `crank` / `buy` syncs. Every sync is checked against an independent model of DESIGN §1.2: a window
//! gets exactly `floor(amount × overlap / interval)`, the owner the rest; payouts land in the wallets.
mod common;

use std::collections::BTreeMap;

use anchor_lang::prelude::Pubkey;
use common::*;
use flipfee::{FeesSynced, FlipfeeError, PayKind, Paid, WindowDone};
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;

const T: u64 = 1_000_000_000_000; // 1M tokens

/// Lamports pump will move into the vault on the next distribute (its creator vault above its own rent).
fn pending(env: &Env, mint: &Pubkey) -> u64 {
    env.lamports(&pump::creator_vault(&pump::sharing_config(mint))).saturating_sub(RENT_MIN)
}

/// Expected share of a window `[start, end)` of `amount` allocated over `(from, to]`.
fn share(amount: u64, from: i64, to: i64, start: i64, end: i64) -> u64 {
    let lo = start.max(from);
    let hi = end.min(to);
    if hi <= lo {
        return 0;
    }
    (u128::from(amount) * (hi - lo) as u128 / (to - from) as u128) as u64
}

/// Runs `f` (a transaction that syncs), then checks the sync against the windows that existed before it:
/// `amount` = everything above rent + credited that reached the vault, each window's `earned` grew by exactly its
/// share, the owner's part is the rest. Returns the FeesSynced event (if any).
fn checked_sync(env: &mut Env, mint: &Pubkey, f: impl FnOnce(&mut Env) -> TransactionMetadata) -> (Option<FeesSynced>, TransactionMetadata) {
    let before = env.coin(mint);
    let expect_amount = env.lamports(&vault_pda(mint)) + pending(env, mint) - RENT_MIN - before.credited;
    let meta = f(env);
    let mut synced = events::<FeesSynced>(&meta);
    assert!(synced.len() <= 1);
    let after = env.coin(mint);
    let done: Vec<WindowDone> = events(&meta);
    let earned_after = |w: &flipfee::Window| -> u64 {
        after
            .windows
            .iter()
            .find(|x| x.holder == w.holder && x.start == w.start)
            .map(|x| x.earned)
            .or_else(|| done.iter().find(|d| d.holder == w.holder && d.start == w.start).map(|d| d.earned))
            .expect("window still there or reported done")
    };
    match synced.pop() {
        None => {
            assert_eq!(expect_amount, 0, "nothing new arrived");
            for w in &before.windows {
                assert_eq!(earned_after(w), w.earned);
            }
            (None, meta)
        }
        Some(s) => {
            assert_eq!(s.amount, expect_amount, "the sync allocates exactly what arrived");
            assert_eq!(s.to, env.now());
            let expect_from = if env.now() > before.last_sync { before.last_sync } else { env.now() - 1 };
            assert_eq!(s.from, expect_from);
            let mut to_windows = 0;
            for w in &before.windows {
                let sh = share(s.amount, s.from, s.to, w.start, w.end);
                assert_eq!(earned_after(w) - w.earned, sh, "window [{}, {}) gets exactly its overlap share", w.start, w.end);
                to_windows += sh;
            }
            assert_eq!(s.to_windows, to_windows);
            assert_eq!(s.to_owner, s.amount - to_windows);
            (Some(s), meta)
        }
    }
}

fn setup() -> (Env, Keypair, TestCoin, Keypair) {
    let mut env = Env::new();
    let dev = env.user(10);
    let coin = env.create_coin(&dev);
    env.connect(&dev, &coin, PRICE, MAX_AHEAD);
    let trader = env.user(1_000);
    // the first trade after connecting pays the rent of pump's new creator vault; get it out of the way
    env.trade_buy(&trader, &coin.mint, T);
    env.keeper_tick(&coin.mint);
    (env, dev, coin, trader)
}

fn paid_to(meta: &TransactionMetadata, who: &Pubkey, kind: PayKind) -> u64 {
    events::<Paid>(meta).iter().filter(|p| p.to == *who && p.kind == kind).map(|p| p.amount).sum()
}

#[test]
fn an_hour_gets_exactly_its_overlap() {
    let (mut env, dev, coin, trader) = setup();
    let alice = env.user(10);
    let m = coin.mint;
    let t0 = env.now();

    // fees before any hour: the owner's
    env.warp(60);
    env.trade_buy(&trader, &m, 3 * T);
    let d0 = env.lamports(&dev.pubkey());
    let (s, meta) = checked_sync(&mut env, &m, |e| e.keeper_tick(&m));
    let s = s.unwrap();
    assert_eq!((s.from, s.to, s.to_owner), (t0, t0 + 60, s.amount));
    assert_eq!(env.lamports(&dev.pubkey()) - d0, s.amount, "lands in the dev's wallet");
    assert_eq!(paid_to(&meta, &dev.pubkey(), PayKind::Owner), s.amount);
    env.check_books(&m);

    // alice buys 1 h at t0+300; fees pending at that moment are allocated before her hour starts
    env.warp_to(t0 + 200);
    env.trade_sell(&trader, &m, T);
    env.warp_to(t0 + 300);
    let (s, _) = checked_sync(&mut env, &m, |e| e.buy_hours(&alice, &m, 1));
    let s = s.unwrap();
    assert_eq!(s.to_owner, s.amount, "fees from before the purchase go to the owner");
    let start = t0 + 300;
    let end = start + HOUR;

    // trades inside her hour: 100% to alice, paid to her wallet
    let mut alice_got = 0;
    for (at, tokens) in [(t0 + 400, 2 * T), (t0 + 900, 4 * T)] {
        env.warp_to(at);
        env.trade_buy(&trader, &m, tokens);
        env.warp(100);
        let a0 = env.lamports(&alice.pubkey());
        let (s, meta) = checked_sync(&mut env, &m, |e| e.keeper_tick(&m));
        let s = s.unwrap();
        assert_eq!((s.to_windows, s.to_owner), (s.amount, 0));
        assert_eq!(env.lamports(&alice.pubkey()) - a0, s.amount);
        assert_eq!(paid_to(&meta, &alice.pubkey(), PayKind::Holder), s.amount);
        alice_got += s.amount;
        env.check_books(&m);
    }
    let last = env.now();

    // a trade late in the hour, distributed only after it ended: split by seconds
    env.warp_to(t0 + 3_000);
    env.trade_buy(&trader, &m, 6 * T);
    env.warp_to(end + 600);
    let (a0, d0) = (env.lamports(&alice.pubkey()), env.lamports(&dev.pubkey()));
    let (s, meta) = checked_sync(&mut env, &m, |e| e.keeper_tick(&m));
    let s = s.unwrap();
    let span = (end + 600 - last) as u128;
    let alice_share = (u128::from(s.amount) * (end - last) as u128 / span) as u64;
    assert_eq!(s.to_windows, alice_share);
    assert_eq!(env.lamports(&alice.pubkey()) - a0, alice_share);
    assert_eq!(env.lamports(&dev.pubkey()) - d0, s.amount - alice_share);
    alice_got += alice_share;
    // her hour is over and paid: it leaves the queue with its final total
    let done: WindowDone = event(&meta);
    assert_eq!((done.holder, done.start, done.end, done.earned), (alice.pubkey(), start, end, alice_got));
    assert!(env.coin(&m).windows.is_empty());
    env.check_books(&m);
    assert_eq!(env.lamports(&vault_pda(&m)), RENT_MIN, "everything allocated was paid");

    // repeated cranks: nothing moves
    for wait in [0, 0, 1, 30] {
        env.warp(wait);
        let (s, meta) = checked_sync(&mut env, &m, |e| e.keeper_tick(&m));
        assert!(s.is_none());
        assert!(events::<Paid>(&meta).is_empty());
    }
    env.check_books(&m);
}

#[test]
fn one_interval_across_a_queue() {
    let (mut env, dev, coin, trader) = setup();
    let (alice, bob) = (env.user(10), env.user(10));
    let m = coin.mint;
    env.warp(100);
    let t = env.now();
    env.buy_hours(&alice, &m, 1); // [t, t+1h)
    env.buy_hours(&bob, &m, 1); // [t+1h, t+2h)
    env.warp(600);
    env.keeper_tick(&m);
    // trading through both hours and past them, one distribute at t+2h+800
    for at in [t + 1_000, t + 4_000, t + 7_000, t + 7_500] {
        env.warp_to(at);
        env.trade_buy(&trader, &m, 3 * T);
    }
    env.warp_to(t + 2 * HOUR + 800);
    let (a0, b0, d0) = (env.lamports(&alice.pubkey()), env.lamports(&bob.pubkey()), env.lamports(&dev.pubkey()));
    let (s, meta) = checked_sync(&mut env, &m, |e| e.keeper_tick(&m));
    let s = s.unwrap();
    // interval (t+600, t+8000]: 7400 s = alice 3000 + bob 3600 + owner 800
    assert_eq!((s.from, s.to), (t + 600, t + 2 * HOUR + 800));
    let a = (u128::from(s.amount) * 3_000 / 7_400) as u64;
    let b = (u128::from(s.amount) * 3_600 / 7_400) as u64;
    assert_eq!(env.lamports(&alice.pubkey()) - a0, a);
    assert_eq!(env.lamports(&bob.pubkey()) - b0, b);
    assert_eq!(env.lamports(&dev.pubkey()) - d0, s.amount - a - b);
    assert_eq!(events::<WindowDone>(&meta).len(), 2);
    env.check_books(&m);
}

#[test]
fn same_second_syncs_go_to_the_second_that_passed() {
    let (mut env, dev, coin, trader) = setup();
    let alice = env.user(10);
    let m = coin.mint;
    env.warp(10);
    env.buy_hours(&alice, &m, 1);
    env.warp(120);
    env.trade_buy(&trader, &m, 2 * T);
    env.keeper_tick(&m);
    // the dev tries crank → distribute → crank in one second to sweep pending fees to itself
    env.trade_buy(&trader, &m, 5 * T);
    let (a0, d0) = (env.lamports(&alice.pubkey()), env.lamports(&dev.pubkey()));
    let payer = env.payer.pubkey();
    let ixs = vec![
        env.ix_crank_all(&m),
        pump::distribute_creator_fees_v2(&payer, &m, &[vault_pda(&m)]),
        env.ix_crank_all(&m),
    ];
    let (s, _) = checked_sync(&mut env, &m, |e| e.ok_many("crank", ixs, &[]));
    let s = s.unwrap();
    assert_eq!((s.from, s.to), (env.now() - 1, env.now()));
    assert_eq!(s.to_windows, s.amount, "the holder of the second that passed gets it");
    assert_eq!(env.lamports(&alice.pubkey()) - a0, s.amount);
    assert_eq!(env.lamports(&dev.pubkey()), d0);
    env.check_books(&m);
}

#[test]
fn payout_rules() {
    let (mut env, dev, coin, trader) = setup();
    let m = coin.mint;
    // a buyer with exactly the price: after buying, the wallet is empty (closed)
    let carol = env.user(0);
    env.svm.airdrop(&carol.pubkey(), PRICE).unwrap();
    env.warp(10);
    env.buy_hours(&carol, &m, 1);
    assert!(!env.exists(&carol.pubkey()));
    // a small fee inside her hour: less than rent, so it stays owed
    env.warp(30);
    env.trade_buy(&trader, &m, 1_000_000_000);
    env.warp(30);
    let meta = env.keeper_tick(&m);
    let owed = env.coin(&m).windows[0].owed;
    assert!(owed > 0 && owed < RENT_MIN, "owed {owed}");
    assert_eq!(paid_to(&meta, &carol.pubkey(), PayKind::Holder), 0);
    assert!(!env.exists(&carol.pubkey()));
    env.check_books(&m);
    // once her wallet exists, the crank pays her
    env.svm.airdrop(&carol.pubkey(), RENT_MIN).unwrap();
    env.warp(1);
    let meta = env.keeper_tick(&m);
    assert_eq!(paid_to(&meta, &carol.pubkey(), PayKind::Holder), owed);
    assert_eq!(env.lamports(&carol.pubkey()), RENT_MIN + owed);

    // holders not passed stay owed; strangers passed get nothing; duplicates pay once
    env.warp(30);
    env.trade_buy(&trader, &m, 4 * T);
    env.warp(30);
    env.distribute(&m);
    let stranger = env.user(1);
    let s0 = env.lamports(&stranger.pubkey());
    let meta = env.ok("crank", env.ix_crank(&m, &[stranger.pubkey(), dev.pubkey()]), &[]);
    assert_eq!(env.lamports(&stranger.pubkey()), s0);
    assert!(events::<Paid>(&meta).is_empty(), "the dev has nothing owed inside carol's hour");
    assert!(env.coin(&m).windows[0].owed > 0);
    let c0 = env.lamports(&carol.pubkey());
    let owed = env.coin(&m).windows[0].owed;
    let meta = env.ok("crank", env.ix_crank(&m, &[carol.pubkey(), carol.pubkey(), stranger.pubkey()]), &[]);
    assert_eq!(events::<Paid>(&meta).len(), 1);
    assert_eq!(env.lamports(&carol.pubkey()) - c0, owed);
    env.check_books(&m);

    // a recipient passed read-only is a builder bug: refused
    env.warp(30);
    env.trade_buy(&trader, &m, T);
    env.warp(30);
    env.distribute(&m);
    let mut ix = env.ix_crank(&m, &[carol.pubkey()]);
    ix.accounts[3].is_writable = false;
    let res = env.send("crank", vec![ix], &[]);
    assert_err(&res, FlipfeeError::RecipientNotWritable);
    // a wrong vault is refused
    let other = env.create_coin(&dev);
    let ix = with_account(env.ix_crank(&m, &[carol.pubkey()]), 1, vault_pda(&other.mint));
    let res = env.send("crank", vec![ix], &[]);
    assert_anchor_err(&res, anchor_codes::CONSTRAINT_SEEDS);
}

#[test]
fn owner_who_holds_an_hour_is_paid_once() {
    let (mut env, dev, coin, trader) = setup();
    let m = coin.mint;
    env.warp(30);
    env.trade_buy(&trader, &m, 2 * T);
    env.warp(30);
    env.distribute(&m); // owner's fees, not synced yet
    env.buy_hours(&dev, &m, 1); // the sync inside credits the owner first
    env.warp(30);
    env.trade_buy(&trader, &m, 2 * T);
    env.warp(30);
    let c = env.coin(&m);
    let d0 = env.lamports(&dev.pubkey());
    let meta = env.keeper_tick(&m);
    let c2 = env.coin(&m);
    let owner_paid = paid_to(&meta, &dev.pubkey(), PayKind::Owner);
    let holder_paid = paid_to(&meta, &dev.pubkey(), PayKind::Holder);
    assert_eq!(owner_paid, c.owner_owed);
    assert!(holder_paid > 0);
    assert_eq!(env.lamports(&dev.pubkey()) - d0, owner_paid + holder_paid);
    assert_eq!((c2.owner_owed, c2.credited), (0, 0));
    env.check_books(&m);
}

#[test]
fn donations_count_as_fees() {
    let (mut env, dev, coin, _trader) = setup();
    let alice = env.user(10);
    let m = coin.mint;
    env.warp(10);
    env.buy_hours(&alice, &m, 2);
    env.warp(600);
    let friend = env.user(5);
    env.donate(&friend, &m, SOL);
    let (s, _) = checked_sync(&mut env, &m, |e| e.keeper_tick(&m));
    let s = s.unwrap();
    assert_eq!(s.amount, SOL);
    assert_eq!(s.to_windows, SOL, "inside alice's hours");
    let _ = dev;
    env.check_books(&m);
}

/// xorshift64*, deterministic.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Independent model of the allocation rules.
#[derive(Default)]
struct Model {
    last_sync: i64,
    windows: Vec<(Pubkey, i64, i64)>,
    earned: BTreeMap<Pubkey, u64>,
    owner: u64,
}
impl Model {
    fn sync(&mut self, amount: u64, now: i64) {
        let (from, to) = if now > self.last_sync { (self.last_sync, now) } else { (now - 1, now) };
        self.last_sync = self.last_sync.max(now);
        if amount == 0 {
            return;
        }
        let mut given = 0;
        for (h, s, e) in &self.windows {
            let sh = share(amount, from, to, *s, *e);
            *self.earned.entry(*h).or_default() += sh;
            given += sh;
        }
        self.owner += amount - given;
    }
}

#[test]
fn randomized_ten_hours_match_the_model() {
    let (mut env, dev, coin, trader) = setup();
    let m = coin.mint;
    env.ok("set_terms", env.ix_set_terms(&dev.pubkey(), &m, 10_000_000, 172_800, false), &[&dev]);
    let buyers: Vec<Keypair> = (0..4).map(|_| env.user(50)).collect();
    // FLIPFEE_SEED=<n> runs another schedule (the default is fixed so CI is deterministic)
    let seed = std::env::var("FLIPFEE_SEED").ok().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0x5eed_f11f_fee5_0001);
    let mut rng = Rng(seed | 1);
    let mut model = Model { last_sync: env.now(), ..Default::default() };
    let mut paid: BTreeMap<Pubkey, u64> = BTreeMap::new();
    let mut synced_total = 0u64;
    let mut arrived_total = 0u64;
    let mut refused = 0;
    let mut holding = 0u64; // tokens the trader holds
    let end_at = env.now() + 10 * HOUR;
    let mut steps = 0;
    while env.now() < end_at {
        steps += 1;
        env.warp(1 + rng.below(400) as i64);
        match rng.below(10) {
            0..=4 => {
                let tokens = (1 + rng.below(8)) * T;
                env.trade_buy(&trader, &m, tokens);
                holding += tokens;
            }
            5 if holding > T => {
                let tokens = T * (1 + rng.below(holding / T - 1).min(5));
                env.trade_sell(&trader, &m, tokens);
                holding -= tokens;
            }
            6 => {
                let b = &buyers[rng.below(4) as usize];
                let hours = 1 + rng.below(3) as u8;
                let c = env.coin(&m);
                let now = env.now();
                let start = c.windows.last().map_or(now, |w| w.end.max(now));
                let kept = c.windows.iter().filter(|w| !(w.end <= now && w.owed == 0)).count();
                if start + i64::from(hours) * HOUR - now > i64::from(c.max_ahead) || kept >= 32 {
                    // the program refuses: past the hours sold ahead, or a full queue
                    let res = env.buy_hours_res(b, &m, hours);
                    let code = custom_error(&res);
                    assert!(code == Some(6000 + FlipfeeError::TooFarAhead as u32) || code == Some(6000 + FlipfeeError::QueueFull as u32), "{code:?}");
                    refused += 1;
                    continue;
                }
                let before = c.windows.len();
                arrived_total += pending(&env, &m);
                let unalloc = env.lamports(&vault_pda(&m)) + pending(&env, &m) - RENT_MIN - env.coin(&m).credited;
                let meta = env.buy_hours(b, &m, hours);
                model.sync(unalloc, env.now());
                for s in events::<FeesSynced>(&meta) {
                    synced_total += s.amount;
                }
                let ev: flipfee::HoursBought = event(&meta);
                model.windows.push((b.pubkey(), ev.start, ev.end));
                assert!(env.coin(&m).windows.len() <= before + 1);
            }
            _ => {
                arrived_total += pending(&env, &m);
                let unalloc = env.lamports(&vault_pda(&m)) + pending(&env, &m) - RENT_MIN - env.coin(&m).credited;
                let meta = env.keeper_tick(&m);
                model.sync(unalloc, env.now());
                for s in events::<FeesSynced>(&meta) {
                    synced_total += s.amount;
                }
                for p in events::<Paid>(&meta) {
                    *paid.entry(p.to).or_default() += p.amount;
                }
            }
        }
        env.check_books(&m);
    }
    // settle everything: wait for the last queued hour to end
    let last_end = env.coin(&m).windows.iter().map(|w| w.end).max().unwrap_or(0);
    env.warp_to(last_end.max(env.now()) + 60);
    arrived_total += pending(&env, &m);
    let unalloc = env.lamports(&vault_pda(&m)) + pending(&env, &m) - RENT_MIN - env.coin(&m).credited;
    let meta = env.keeper_tick(&m);
    model.sync(unalloc, env.now());
    for s in events::<FeesSynced>(&meta) {
        synced_total += s.amount;
    }
    for p in events::<Paid>(&meta) {
        *paid.entry(p.to).or_default() += p.amount;
    }
    let c = env.coin(&m);
    // keeper_tick of setup() paid the dev before the model started; count only what the model saw
    assert_eq!(synced_total, arrived_total, "Σ allocated = Σ arrived");
    assert_eq!(c.credited, 0, "everything paid");
    assert!(c.windows.is_empty(), "every window ended, paid and dropped");
    for b in &buyers {
        assert_eq!(paid.get(&b.pubkey()).copied().unwrap_or(0), model.earned.get(&b.pubkey()).copied().unwrap_or(0), "holder paid exactly the model's share");
    }
    assert_eq!(paid.get(&dev.pubkey()).copied().unwrap_or(0), model.owner, "owner paid exactly the model's rest");
    assert_eq!(env.lamports(&vault_pda(&m)), RENT_MIN);
    println!(
        "randomized: {steps} steps, {refused} buys refused, {} lamports of fees, owner {}, holders {:?}, {} windows",
        synced_total,
        model.owner,
        buyers.iter().map(|b| model.earned.get(&b.pubkey()).copied().unwrap_or(0)).collect::<Vec<_>>(),
        model.windows.len()
    );
}

#[test]
fn a_rent_rise_keeps_payouts_owed_instead_of_failing() {
    let (mut env, dev, coin, trader) = setup();
    let m = coin.mint;
    env.warp(30);
    env.trade_buy(&trader, &m, 3 * T);
    env.warp(30);
    env.distribute(&m);
    env.ok("crank", env.ix_crank(&m, &[]), &[]); // allocated, not paid
    let owed = env.coin(&m).owner_owed;
    assert!(owed > 0);
    // the Rent sysvar doubles: the vault's floor is now above what it holds minus what is owed
    let mut rent = MAINNET_RENT;
    rent[..8].copy_from_slice(&(2 * 5_080u64).to_le_bytes());
    env.svm
        .set_account(RENT_SYSVAR, solana_account::Account { lamports: 1, data: rent.to_vec(), owner: anchor_lang::pubkey!("Sysvar1111111111111111111111111111111111111"), executable: false, rent_epoch: 0 })
        .unwrap();
    env.warp(30);
    let d0 = env.lamports(&dev.pubkey());
    let meta = env.ok("crank", env.ix_crank(&m, &[dev.pubkey()]), &[]);
    assert!(events::<Paid>(&meta).is_empty(), "nothing paid below the new floor");
    assert_eq!(env.lamports(&dev.pubkey()), d0);
    assert_eq!(env.coin(&m).owner_owed, owed, "still owed");
    let heir = env.user(1);
    let res = env.send("transfer_owner", vec![env.ix_transfer_owner(&dev.pubkey(), &m, &heir.pubkey())], &[&dev, &heir]);
    assert_err(&res, FlipfeeError::VaultShort);
    // new fees first refill the floor (allocated to nobody), then the payout goes through
    let floor = 2 * RENT_MIN;
    let gap = floor + owed - env.lamports(&vault_pda(&m));
    let friend = env.user(1);
    env.donate(&friend, &m, gap);
    env.warp(30);
    let meta = env.ok("crank", env.ix_crank(&m, &[dev.pubkey()]), &[]);
    assert!(events::<FeesSynced>(&meta).is_empty(), "the refill was not allocated");
    assert_eq!(events::<Paid>(&meta).iter().map(|p| p.amount).sum::<u64>(), owed);
    assert_eq!(env.lamports(&vault_pda(&m)), floor);
}

#[test]
fn the_second_a_window_ends_still_pays_its_holder() {
    let (mut env, dev, coin, trader) = setup();
    let alice = env.user(10);
    let m = coin.mint;
    env.warp(10);
    let hb: flipfee::HoursBought = event(&env.buy_hours(&alice, &m, 1));
    env.warp_to(hb.end - 30);
    env.keeper_tick(&m);
    env.trade_buy(&trader, &m, 4 * T); // fees of alice's last 30 seconds
    env.warp_to(hb.end);
    // in the second her hour ends: crank (pays her) → distribute → crank, all at `end`
    let (a0, d0) = (env.lamports(&alice.pubkey()), env.lamports(&dev.pubkey()));
    let payer = env.payer.pubkey();
    let pending = pending(&env, &m);
    let ixs = vec![env.ix_crank_all(&m), pump::distribute_creator_fees_v2(&payer, &m, &[vault_pda(&m)]), env.ix_crank_all(&m)];
    env.ok_many("crank", ixs, &[]);
    // the first crank allocated (end − 30, end] (nothing had arrived), the second the unit second (end − 1, end]:
    // her window is still there, so all of it is hers
    assert_eq!(env.lamports(&alice.pubkey()) - a0, pending);
    assert_eq!(env.lamports(&dev.pubkey()), d0);
    assert_eq!(env.coin(&m).windows.len(), 1, "kept one more second");
    env.warp(1);
    let meta = env.keeper_tick(&m);
    assert_eq!(events::<WindowDone>(&meta).len(), 1);
    assert!(env.coin(&m).windows.is_empty());
    env.check_books(&m);
}
