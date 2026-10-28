# A holder whose lamports are zero can never be paid, and 32 of them block every sale of the coin

**Severity: Medium** (liveness of one coin's market; no funds lost by the attacker, no role needed)
**Component: `program/programs/flipfee` — commit `c57b2e3` (current `main`)**

## Summary

An ended window whose holder cannot receive its fee (balance below the rent-exempt minimum) is never
pruned: `crank` skips the payment by design, and `prune()` only frees windows with `owed == 0`
(`state.rs:166`). `buy` refuses while `windows.len() >= MAX_WINDOWS` (32) (`buy.rs:90`). So 32
ended-but-unpayable windows brick one coin completely: every later `buy` reverts `QueueFull` even
though every hour ended and the fees are already in the vault.

Reaching the state is permissionless and costs only 32 × the coin's hour price (minimum 0.32 SOL
total, recoverable by topping the wallets back up — this is cheap market-freeze grief):

1. Prepare 32 wallets. Each buys 1 hour, then sends its whole balance away (the runtime only
   requires rent-exemption *during* the buy).
2. Wait for the hours to end and fees to allocate (the keeper's normal tick).
3. The owed amounts are below the rent floor (890,880 lamports for a 0-byte account on mainnet), so
   every payout is skipped (`can_receive` false) and no window prunes.
4. Any `buy` now fails with `QueueFull` (6014).

The program has no repair path for this state: the keeper cannot move the money, the dev has no
hook, only the stuck holder itself can top up — and nothing tells it that it must.

## Root cause

- `prune()` keeps ended windows with `owed > 0` forever (`state.rs:162-173`).
- `can_receive(to, amount)` requires the recipient to end rent-exempt after the credit
  (`instructions/vault.rs`) — correct for transfers, unbounded as a payout precondition.
- `buy` counts bookkeeping windows, not future-sale capacity (`buy.rs:90`).

## Proof of concept

Two LiteSVM tests in `tests/dust.rs`, run against the mainnet pump binaries and real rent sysvar
(every threshold read from `Rent::get()`, so behaviour is identical under mainnet's 890,880 and the
LiteSVM value):

```rust
#[test]
fn broke_holder_keeps_the_window_and_the_slot() {
    env.buy_hours(&broke, &coin.mint, 1);
    // drain the wallet to zero after the purchase
    let bal = env.lamports(&broke.pubkey());
    env.ok("drain", system_instruction::transfer(&broke.pubkey(), &sink.pubkey(), bal), &[&broke]);
    env.warp(HOUR / 2);
    env.trade_buy(&trader, &coin.mint, 100_000);
    env.keeper_tick(&coin.mint);
    env.warp(HOUR);
    env.keeper_tick(&coin.mint);
    assert_eq!(env.coin(&coin.mint).windows.len(), 1);   // never pruned
    assert!(env.coin(&coin.mint).windows[0].owed > 0);
}

#[test]
fn full_queue_of_unpayable_windows_blocks_the_next_buy() {
    for _ in 0..32 { /* buy 1 h from a fresh wallet, then drain it to zero */ }
    env.donate(&trader, &coin.mint, 32_000);   // ~1 000 lamports per window, under the rent floor
    env.warp(HOUR * 32 + 10);
    env.keeper_tick(&coin.mint);
    assert_eq!(env.coin(&coin.mint).windows.len(), 32);
    let r = env.buy_hours_res(&late, &coin.mint, 1);
    assert_err(&r, FlipfeeError::QueueFull);   // 6014
}
```

Observed output:

```
windows=32 owed_total=Some(31968)
buy_code=Some(6014)
```

Run: `RUSTUP_TOOLCHAIN=stable cargo test -p flipfee --test dust` → **5 passed** (plus a third test
for the graduated/PumpSwap path, which sticks the same way, and one for the dev handover below).

## Second path, same root

`transfer_owner` pays the old owner and refuses if it cannot receive (`terms.rs:73-75`,
`OwnerCannotReceive` 6028). A dev at zero lamports with dust owed cannot hand the coin over at all.
Same missing top-up; blocks a market action instead of an hour.

## The composition is what is new

Each rule is documented — the skip (`crank.rs:80`, "stays owed until the account can take it";
upstream `splits.rs::payout_rules`), the prune rule in one `DESIGN.md` sentence (§crank: "prune
windows that ended and are paid"), the full queue (upstream `hours.rs::queue_full_then_freed`). But
every upstream queue test frees by time *with nothing owed* ("the first two windows ended with
nothing owed"), and `DESIGN.md` never names the capacity consequence: an ended-but-unpaid window
keeps consuming one of the 32 slots, which turns settled debt into a market-wide `buy` outage.
The docs also promise "SOL lands in your wallet by itself" — no page tells a holder it must keep
its wallet rent-exempt.

## Recommendation

Any one of these closes it (full analysis in the report):

1. Convert owed that `can_receive` rejects into a per-holder claim entry (reuse the freed window
   slot), then prune — payment becomes a pull the holder claims later to any funded destination.
2. Or stop counting ended-and-unpayable windows toward `MAX_WINDOWS`.
3. Do **not** top-up from the vault: funding a ~650k-lamport deficit to deliver 2 lamports pays the
   attacker's wallets with other holders' fees.

## Limits

Proven in LiteSVM with the mainnet pump binaries and real rent parameters; not executed against a
deployed program (per `program/DEPLOY.md` nothing is deployed yet). Model: reporter, Solana program
security review — commit `c57b2e3`, no drift at submission time.
