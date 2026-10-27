# flipfee program: build, test, deploy (mainnet runbook, not run)

Nothing here has been run on mainnet or devnet. The lead deploys; the owner funds the deployer and the keeper. Every
mainnet call made while building this was read-only (getAccountInfo / getProgramAccounts / getSignaturesForAddress /
getTransaction / simulateTransaction / getMinimumBalanceForRentExemption).

## Layout

| Path | What |
|---|---|
| `programs/flipfee/src/` | the Anchor 1.2 program (DESIGN §2.1) |
| `programs/flipfee/tests/` | LiteSVM tests with the **mainnet** pump / pump_amm / pump_fees / mayhem binaries |
| `client/` | TS client (tsup → `client/dist`), API in `client/README.md`; `test/unit.test.mjs`, `test/localnet.test.mjs` |
| `keeper/` | keeper module (`createKeeper`, for the server with `KEEPER=1`) + CLI (`keeper/dist/cli.js`) |
| `fixtures/mainnet/` | mainnet program ELFs + accounts the tests clone (`npm run fixtures` refreshes, read-only RPC) |
| `pump/` | pump-public-docs copies (docs + IDLs) used to write the pump builders |
| `scripts/init.mjs` | `initialize` after a deploy (dry run unless `--yes`) |
| `.keys/` (gitignored) | `deployer.json`, `flipfee-program.json` — generated here, never printed |

## Keys

| Key | Public key | File |
|---|---|---|
| Program id | `D6sPTL4KkP6bc1QpC33h8f5MKEALJtRmB89f8H4CbpjW` | `.keys/flipfee-program.json` |
| Deployer (upgrade authority, then admin) | `7FBfPdBduWckk4XyEKZkicDmHmaack8TRhYoJVuAbGAp` | `.keys/deployer.json` |

The program checks its id at runtime (`declare_id!`). For a different id: new keypair, put its address in
`programs/flipfee/src/lib.rs` and `Anchor.toml`, rebuild, rerun every test; the client takes `programId` everywhere.

## Build and test

```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"   # Agave 4.1.2
cd /Users/ettrq/ft1/flipfee/program
npm install
cp .keys/flipfee-program.json target/deploy/flipfee-keypair.json
~/.avm/bin/anchor-1.2.0 build                 # target/deploy/flipfee.so + target/idl/flipfee.json
cargo test -p flipfee                         # 7 unit + 37 LiteSVM integration tests (writes client fixtures)
FLIPFEE_SEED=123 cargo test -p flipfee --test splits randomized   # the randomized model test with another schedule
npm run build:client && npm run build:keeper
npm run typecheck
npm run test:client                           # 13 tests against the LiteSVM fixtures
npm run test:keeper                           # 5 tests of the keeper decision
npm run test:localnet                         # 8 tests on solana-test-validator (ports 28899/29900/28001-28050)
shasum -a 256 target/deploy/flipfee.so
```

## The binary

| | |
|---|---|
| File | `target/deploy/flipfee.so` (Anchor 1.2.0, platform-tools v1.57) |
| Size | **320,096 bytes** |
| sha256 | `5a1805cd74c2c37869412aff1ed61fa822a2fdb182473acb10d61cb1f1ac548c` (rebuild and compare before deploying) |

## SOL needed (mainnet Rent read 2026-10-06: 5,080 lamports per byte, an account of `n` bytes costs `(128 + n) × 5,080`)

| Account | Bytes | Lamports | SOL |
|---|---|---|---|
| ProgramData at exact size (`--max-len` = program size) | 45 + 320,096 | 1,626,966,520 | **1.6270** |
| ProgramData at 2× (`--max-len 640192`, room to grow) | 45 + 640,192 | 3,253,054,200 | 3.2531 |
| Program account | 36 | 833,120 | 0.0008 |
| Deploy buffer (temporary; the loader drains it to the payer before creating ProgramData) | 37 + 320,096 | 1,626,925,880 | 1.6269 |
| Config (paid by `initialize`) | 76 | 1,036,320 | 0.0010 |
| ~320 buffer writes + deploy + init, 5,000 lamports each | | ~1,610,000 | ~0.0016 (+ priority fees) |

**Deployer needs ≈ 1.63 SOL** for an exact-size deploy (peak = buffer + program account + fees; ≈ 1.629 SOL stays
spent). Fund **1.8 SOL** to leave room for priority fees. With `--max-len` 2×: fund **3.5 SOL** (≈ 3.256 SOL stays
spent). Every later upgrade needs a buffer of the new size for a moment (≈ 1.6 SOL, refunded) plus the rent of any
growth (`solana program deploy` extends ProgramData automatically).

Per coin, paid by the dev in the connect transaction: Coin account 11,780,520 + vault 650,240 + pump's sharing config
5,852,160 + pump's curve growth 50,800 = **18,333,720 lamports ≈ 0.0183 SOL** (+ fees).

Other wallets:
- **Treasury**: a system account (wallet or multisig vault) holding at least 650,240 lamports at all times
  (`initialize` / `set_config` refuse an empty one; 5% of the cheapest hour is 500,000 lamports).
- **Keeper**: pays 5,000 lamports per transaction (+ priority fee). It skips coins with nothing to do; an active
  coin costs about one transaction per minute ≈ 0.0072 SOL per day. 0.1 SOL to start (DESIGN §4).

## Commands (the lead, by hand)

```bash
RPC=https://<paid-mainnet-rpc>     # the public RPC rate-limits a 300-transaction deploy
solana-keygen new --no-bip39-passphrase --silent -o .keys/deploy-buffer.json   # fixed buffer: a failed deploy resumes
solana program deploy target/deploy/flipfee.so \
  -u "$RPC" \
  --keypair .keys/deployer.json \
  --program-id .keys/flipfee-program.json \
  --upgrade-authority .keys/deployer.json \
  --buffer .keys/deploy-buffer.json \
  --with-compute-unit-price 100000 \
  --max-sign-attempts 100 \
  --use-rpc
solana program show D6sPTL4KkP6bc1QpC33h8f5MKEALJtRmB89f8H4CbpjW -u "$RPC"   # Authority = deployer, Data Length = 320096

# Initialize: the deployer (upgrade authority) becomes the admin; treasury = the owner's fee wallet
node scripts/init.mjs --rpc "$RPC" --treasury <TREASURY_PUBKEY> --fee-bps 500          # dry run, prints everything
node scripts/init.mjs --rpc "$RPC" --treasury <TREASURY_PUBKEY> --fee-bps 500 --yes
```

Optional after init: `set_admin` to a multisig (`setAdminIx`), and `solana program set-upgrade-authority` to the
same multisig.

## Keeper on the box

```bash
solana-keygen new --no-bip39-passphrase --silent -o /etc/flipfee/keeper.json && chmod 600 /etc/flipfee/keeper.json
solana-keygen pubkey /etc/flipfee/keeper.json    # the owner funds this address (~0.1 SOL)
# in-process with the server (KEEPER=1): import { createKeeper } from 'flipfee-keeper'
# or alone:
node keeper/dist/cli.js --rpc "$RPC" --keypair /etc/flipfee/keeper.json --interval 60 --priority 10000
```

## Risks the owner should know

- **pump.fun admin powers.** pump's `admin_cto` / `admin_cto_sharing_config` (community takeover) can move a coin's
  creator fee away from its sharing config, or reset the split. Then fees stop reaching the vault. `buy` re-checks
  the routing (curve creator, split 100% → vault, active, and the PumpSwap pool once graduated), so no new hours sell
  on such a coin; hours already sold earn nothing after the change. pump's programs are upgradeable
  (authority `7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8`); flipfee only reads two pump account layouts
  (`SharingConfig`, `BondingCurve`, + `Pool` once graduated) and never CPIs into pump.
- **Allocation by time, delivery by keeper.** Fees reach the vault only when pump's distribute runs (the keeper, every
  buy and every crank do it). A sync splits what arrived over the time since the previous sync, so fees generated in
  the last keeper interval before an hour's end can be split with the next owner/holder. The keeper runs at window
  edges to keep this to a few seconds. A purchase cannot take fees earned before it: `buy` refuses while pump still
  holds fees of the coin (the app collects them in the same transaction).
- **Holders who cannot receive (open, for the lead).** A payout to an empty wallet smaller than the 0-byte rent stays
  owed until the wallet holds SOL again (the next crank pays it). Such a window keeps a queue slot (32 per coin), so a
  griefer can fill a coin's queue: 32 hours at the dev's price (95% of it paid to the dev), then empty the 32 wallets.
  Anyone clears it by sending each holder wallet ≥ 0.00065 SOL. A program-side fix (hand unpayable dust of long-ended
  windows to the owner) would break the rule "no instruction moves holder money to anyone else", so it is not done.
- **Logs.** Mainnet keeps 10,000 bytes of logs per transaction; a crank paying 15 recipients over 32 windows stays
  under it (the client and keeper batch 15). Indexers should also read the Coin accounts, not only the events.
- **Trust.** The upgrade authority can replace the program (and so could move vault money); the admin cannot. Move
  both to a multisig after launch. `set_admin` is one step (no accept).
