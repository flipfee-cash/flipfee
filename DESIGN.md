# flipfee on Solana — product, architecture and contracts

Owner's brief (2026-10-06): rebuild Feeflip (ex-Tollbooth, a market for coin creator fees) **fully for Solana**,
rename it **flipfee**, serve it on **https://flipfee.cash**. Login **only with Phantom**, and it must work. Simplify the
mechanic so a Solana trench trader reads the point and the benefit **in a split second** and can act at once. The UI is
as live and interactive as possible, with lots of simple, readable numbers. The product must *feel* like its domain:
**flip fee → cash**.

This file is the shared contract for three parallel builders (program, server, app). Code to the shapes here. If
something is wrong or impossible on chain, say so in your report with the evidence instead of improvising an
incompatible shape. Sister project to copy infrastructure from: `ft1/peek-sol/` (same toolchain, same box).

---

## 0. The hard fact this design is built on (pump.fun fee sharing)

Docs: `pump-fun/pump-public-docs` (fetch from `https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/…`:
`docs/instructions/CREATOR_FEE_SHARING.md`, `docs/instructions/COLLECT_CREATOR_FEE.md`, `idl/pump.json`,
`idl/pump_amm.json`, `idl/pump_fees.json`).

- pump.fun (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) pays a **creator fee** on every bonding-curve trade into
  `creator_vault = PDA["creator-vault", bonding_curve.creator]`; PumpSwap (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`)
  pays `coin_creator_fee` into the WSOL ATA of `PDA["creator_vault", pool.coin_creator]` (AMM).
- Pump Fees (`pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`) **fee sharing**: `create_fee_sharing_config` (signer = the
  coin creator) creates `sharing_config = PDA["sharing-config", mint]` and points the curve creator (and
  `pool.coin_creator`) at it; `update_fee_shares_v2` (signer = `sharing_config.admin`) sets up to 10 shareholders
  (`share_bps` sum 10 000) **once — the admin is revoked after** (errors `SharingConfigAdminRevoked`,
  `FeeSharesAlreadyUpdated`). `transfer_fee_sharing_authority` / `revoke_fee_sharing_authority` have no accounts in
  the IDL. `distribute_creator_fees_v2` (pump, permissionless) pays the vault to the shareholders in lamports for
  SOL-paired coins; `transfer_creator_fees_to_pump_v2` (AMM, permissionless) sweeps AMM creator fees into the pump
  vault first (graduated coins).
- Trade events carry the exact fee: pump `TradeEvent.creator_fee` (+ `creator_fee_basis_points`, `creator`,
  `shareholders`), PumpSwap `BuyEvent/SellEvent.coin_creator_fee`. `peek-sol/server/src/ingest/pumpevents.js` decodes
  the trade events already (extend it for the creator fee fields).

**Consequence.** A time-limited share cannot be granted through pump.fun itself (one split per coin, forever). So a coin
joins flipfee **once**: the dev sets the coin's split to **100% → the flipfee vault of that coin**. From then on the
flipfee program routes every fee: to the buyer of the current hour while an hour runs, to the dev the rest of the time.
The dev keeps every fee outside sold hours, paid automatically. This is irreversible on pump.fun, and the dev must see
that plainly before signing (§1.5).

---

## 1. Product

### 1.1 The point, in one glance

- Trader: **"Buy an hour of a coin's fees. Every trade in that hour pays you SOL."**
- Dev: **"Sell your coin's next hours of fees. Get SOL now."**
- Brand line (association with the domain): **"Flip fees into cash."**

Everything else on screen serves those two sentences with live numbers.

### 1.2 The mechanic (simplified from the RH version)

| | RH Feeflip (old) | flipfee (new) |
|---|---|---|
| What you buy | 25/50/100% of fees for 3–30 days | **100% of the coin's fees for N hours** |
| Length | days, slider | **hours: 1–12 per buy** (chips 1h · 3h · 6h · 12h) |
| Start | at purchase | **now**, or right after the last sold hour (a queue) |
| Price | per pass, set per listing | **one price per hour per coin**, set by the dev (suggested from live data) |
| Getting paid | claim button | **SOL lands in your wallet by itself** about every minute |
| Resale | yes | no (v2) |
| Dev setup | 3 steps, reversible | **one transaction**, one time (pump.fun allows one split) |

Numbers:
- Price per hour: dev sets it, 0.01–1 000 SOL. Suggested = 80% of the coin's creator fees in the last hour (fallback:
  last 6 h ÷ 6). Shown as "Suggested 0.31 SOL · last hour paid 0.39 SOL".
- How far ahead hours can be sold: dev sets 1–48 h (default 24 h).
- flipfee fee: **5% of each hour sale** (dev gets 95% at once). Fees routed outside sold hours: **0%** to flipfee.
- Payouts: pushed to wallets by the crank about every 60 s (holder during the hour, dev otherwise). Fees are split
  **by the second** over each crank interval (time-weighted), so an hour gets exactly the share of time it overlaps.

### 1.3 What a trader can do in the first second

1. **Buy an hour** on a live coin: one tap on "Buy 1h · 0.30 SOL" → Phantom → the hour starts (or is queued) → a live
   counter shows SOL arriving with each trade.
2. **Want** on any hot pump.fun coin that is not on flipfee yet (one tap after sign-in, free): the dev sees "12 traders
   want your fees". "Share" copies `flipfee.cash/c/<mint>` for the dev.
3. Watch: everything moves without a wallet.

### 1.4 What a dev can do

1. Connect Phantom → "Your coins" lists the pump.fun coins this wallet created, each with fees in the last hour/24 h,
   wants, and eligibility (§2.4).
2. **List this coin** (one transaction, §1.5) → set price per hour (suggested) and hours ahead.
3. Dashboard: hours sold, SOL received, fees routed to you, the queue, pause/resume sales, change price.

### 1.5 The one-time connect sheet (must be honest and short)

Lines (copy rules apply, §5):
- "Your coin's fees go to flipfee from now on."
- "You get every fee outside sold hours. It lands in your wallet."
- "Buyers pay you for each hour. You get 95%."
- "pump.fun allows one fee split per coin. This step is final."
- Button: "List $TICKER" → one Phantom signature. ("Connect" is only for Phantom; one verb per action, 2026-10-26.)

### 1.6 Screens

**Home = the board** (first paint < 1 s from cache/snapshot, live after):
- **Top ticker** (split-flap digits): "Creator fees, last hour (top coins): 312.4 SOL" · "flipfee hours sold today: 41" ·
  "Paid to buyers today: 18.2 SOL" · "Paid to devs today: 25.9 SOL" · SOL price. Label every number exactly (if a
  number covers only the tracked coins, the label says "top coins").
- **Hero** (left, short): the trader line, the dev line, two buttons: "Buy an hour" (scrolls/focuses the first live
  coin) and "Flip your fees" (dev page). Right: **the live cash counter** of the busiest live coin: "This hour: +0.184
  SOL to 7xQ…f2" with each trade flipping the digits and dropping a "+0.0021 SOL" chip.
- **Live coins** (registered on flipfee), one row each: image · $TICKER · name · "Paid last hour" · "Paid this hour" (live) ·
  trade dots streaming (green buy / red sell, size = SOL) · the hour bar (who holds now, time left, queue as segments) ·
  **Price per hour** · big button **Buy 1h**. Sort: paid last hour.
- **Hot on pump.fun** (not on flipfee yet): same row shape with "Creator fees last hour", "Trades", "Want" count, and
  buttons **Want** · **Share** (and **Connect** if the connected wallet is the coin's fee admin).
- Phone (≤ 760 px): ticker, the cash counter, then tabs `Live · Hot` with Live first; sticky bottom bar with
  "Buy an hour" / "Flip your fees".
- Empty states are first-class: with zero live coins the board leads with Hot coins and a dev call to action; it
  never looks broken.

**Coin page** `/c/<mint>`: header (image, ticker, name, mcap, age, CA copy, links: pump.fun, DexScreener, Solscan),
the **hour timeline** (now → +24 h; past hours greyed with what they paid; the live hour filling; sold hours with the
holder's short address; open hours with the price), the **trade stream** (each trade: buy/sell, SOL, creator fee),
stats (creator fees 1h/6h/24h, trades, volume, wants), the **buy panel** (hours chips, total, "Starts now" or "Starts in
42m", estimate line "Last 6 h paid on average 0.37 SOL per hour" — a fact, never a promise).

**Dev page** `/dev`: §1.4.

**Me** `/me`: my hours (live with the ticking amount, upcoming with countdown, past with paid), my coins (as dev),
totals (spent, received).

### 1.7 Look and feel: ink on paper, dithered (owner, 2026-10-26; replaces the split-flap board)

References the owner gave: Oriku175's dithered koi cards, Base's "Trencher Program" dot-matrix spot, em____97's
paper-sheet archive, maxyourenergy's 1-bit dither art. The old dark split-flap look is retired.

- **Paper and one ink.** Desk `#ECECE7` with a faint print screen of dots, sheets `#F7F7F3`, rules `#D8D8D0`. One ink:
  ultramarine `#1F2BFF` for money, live state, buys and the brand. Black `#0E0E10` for text, sells and "yours".
  No green, amber or red anywhere.
- **Dither is the image system.** Every coin image goes through one SVG filter (`src/dither/DitherDefs.tsx`): grey
  levels, a 4×4 Bayer screen, a hard threshold, ink on paper. The coin mark and the hero coin are drawn in code
  (`src/dither/coin.ts`: a reeded coin, lit, thresholded against an 8×8 Bayer matrix).
- **Numbers.** Big live numbers in Doto (a dot-matrix face, weight 900); small numbers and labels in Geist Mono; UI
  text in Geist. A changed character dithers in (25/50/75% of its dots, ~160 ms). Charts use a 50% ink dither, the
  current hour solid.
- **Logo.** The dithered coin, which flips on load and on hover, plus "flipfee" in Doto and ".cash" in ink. Assets:
  `design-kit/brand-dither/` (avatar 1000, icons, favicon.svg, og.png), all rendered from `coin.ts`.
- **Surfaces.** Flat sheets with a 1 px rule; soft shadow only on what floats (sheets, menus, toasts). Motion is
  calm: the hero coin turns slowly while on screen (faster on hover); reduced motion shows still frames.
- No beta badge in the header (owner rule). The risk line lives in the connect and buy sheets:
  "flipfee is new. Start small."
---

### 1.8 Order book and /market (owner, 2026-10-28: MVP, no contracts)

- Any coin has a book of **bids** (buy hours of its fees at a price per hour) and **asks** (sell them). Orders are
  intents in SQLite (`server/src/orders.js`): no settlement yet, so an order that would meet the other side is refused
  (`crosses`); the form warns first. Limits: 0.0001–1000 SOL per hour, 1–24 hours, 10 open per coin, 100 per wallet.
- **House quotes**: flipfee's own ladder (wallet `flipfee`, tagged "flipfee" in the book) on the 12 hottest coins with
  fees: bids at 85/70/55% and asks at 110/130/160% of the last hour's fees; requoted when fees move 15%+
  (`HOUSE_QUOTES`, on with the pump.fun API). They never cross a trader's order.
- **/market** (nav, footer, "Open the market" on the hot list): search by ticker, name or CA; each row shows fees last
  hour, best bid, best ask and a 3-level book; a row opens the coin page, whose sidebar has the full book, the order
  form (Bid · buy hours / Ask · sell hours, price, 1/2/4/6/12 h, total) and "Your orders" with Cancel. Tap a level to
  price an order just inside it. The stream's `book` event keeps every view fresh.
- API: `GET /api/market?q=`, `GET /api/book/:mint`, `POST /api/orders`, `DELETE /api/orders/:id`, `GET /api/orders/mine`.

## 2. Architecture

```
ft1/flipfee/
  DESIGN.md            this file
  program/             Anchor 1.2 program `flipfee` + client/ (TS builders, decoders, pump ix builders) + keeper/
  server/              Node ≥ 22, port 5295: live pump.fun data, flipfee index, SSE, SIWS, wants, keeper host
  app/                 Vite + React 19 + TS: the board, coin, dev, me; Phantom only
  release.sh           build → upload → restart → health (like peek-sol/release.sh)
```

Toolchain like peek-sol: Anchor 1.2.0 (`~/.avm/bin/anchor-1.2.0`), Solana CLI 4.1.2 at
`~/.local/share/solana/install/active_release/bin` (not on PATH by default), Node ≥ 22, `node:sqlite`.

### 2.1 Program `flipfee` (Anchor)

PDAs: `config = ["config"]`, `coin = ["coin", mint]`, `vault = ["vault", mint]` (a **system-owned PDA with no data**:
the pump.fun shareholder address that receives lamports).

```rust
Config { admin: Pubkey, treasury: Pubkey, fee_bps: u16 /* ≤ 1000, default 500 */, paused: bool, bump: u8 }
Coin {
  mint: Pubkey, owner: Pubkey /* the dev */, bump: u8, vault_bump: u8,
  price: u64 /* lamports per hour, 0.01–1000 SOL */, max_ahead: u32 /* seconds, 3600..=172800 */, paused: bool,
  last_sync: i64, owner_owed: u64, credited: u64 /* Σ owed not yet paid, vault must hold ≥ credited + rent */,
  windows: Vec<Window> /* max 32, sorted by start */,
  fees_in: u64, sales: u64 /* lamports buyers paid */, hours_sold: u32, paid_out: u64,
}
Window { holder: Pubkey, start: i64, end: i64, owed: u64, earned: u64 }
```

Instructions:
1. `initialize(treasury, fee_bps)` — once, signer = program upgrade authority.
2. `register(price, max_ahead)` — signer = the dev. Accounts: config, coin (init), vault, mint, `sharing_config`
   (owner pump_fees, seeds `["sharing-config", mint]` under pump_fees), `bonding_curve` (pump, `["bonding-curve",
   mint]`), system. Checks: config not paused; sharing_config `status == Active`, `admin_revoked == true`,
   `shareholders == [(vault, 10_000)]`, `bonding_curve.creator == sharing_config`; **ownership proof**: signer ==
   `sharing_config.admin` *if pump keeps the admin after revoking* — verify on a real revoked config from mainnet; if
   pump clears it, require instead (instruction introspection) an `update_fee_shares_v2` for this mint signed by the
   same key earlier in the same transaction. Funds the vault with the rent-exempt minimum (890 880 lamports) from the
   dev if empty. Sets `last_sync = now`.
3. `set_terms(price, max_ahead, paused)` — owner.
4. `transfer_owner(new_owner)` — owner (the dev can sell the whole fee right later; v2 UI).
5. `buy(hours: u8 /* 1..=12 */, max_price: u64)` — buyer. Not paused; `price ≤ max_price`; **sync first**; `start =
   max(now, last window end)`, `end = start + hours·3600`, `end - now ≤ max_ahead`; pays `price·hours`: 95% (by
   `fee_bps`) system-transfer buyer → `coin.owner` account (must match), the rest → `config.treasury` (must match);
   push window; emit `HoursBought`. The app puts pump's distribute (and the AMM sweep for graduated coins) right before
   `buy` in the same transaction so fees earned before the purchase are allocated before the hour starts; the program
   need not enforce it (leak ≤ one crank interval below pump's minimum distributable fee) — enforce with introspection
   only if it is cheap and safe.
6. `crank()` — permissionless. **sync**: `new = vault.lamports − rent_min − credited`; allocate `new` over `(last_sync,
   now]` to windows by overlap seconds, remainder to `owner_owed`; `last_sync = now`. **pay**: for the owner and each
   window holder passed in `remaining_accounts` (must match), transfer `owed` from the vault (PDA signer, system
   transfer) when the recipient stays rent-exempt after it, else keep it owed; prune windows that ended and are paid.
   Emit `FeesSynced { coin, amount, from, to }` and `Paid { coin, to, amount, kind }`.
7. `set_config(treasury, fee_bps, paused)` — admin.

Invariants (tests): vault lamports ≥ rent_min + credited; Σ allocated = Σ arrived; a window gets exactly its overlap
share; no instruction moves owner/holder money to anyone else; repeated cranks are idempotent; arithmetic with u128.

`client/` (TS, built with tsup like `peek-sol/program/client`): PDA helpers; account decoders (Config, Coin, Window,
pump `BondingCurve`, AMM `Pool`, `SharingConfig`); instruction builders for flipfee (`register`, `setTerms`, `buy`,
`crank`, …) **and** the pump instructions the app and keeper need (`createFeeSharingConfig`, `updateFeeSharesV2` with
the right remaining accounts, `transferCreatorFeesToPumpV2`, `distributeCreatorFeesV2`); `eligibility(conn, mint,
wallet)` → `{ kind: 'ready-new' | 'ready' | 'almost' | 'locked' | 'flipfee' | 'usdc' | 'not-admin', admin, graduated,
quoteMint }`; `buyTx`, `connectCoinTx`, `crankTx` helpers that assemble full transactions. SOL-paired coins only in v1.

`keeper/` (Node, reuses `client/`): every 60 s for each registered coin: if graduated and the AMM vault has fees →
`transfer_creator_fees_to_pump_v2`; if the pump vault ≥ pump's minimum distributable fee → `distribute_creator_fees_v2`
(remaining = [vault]); then `crank` with owner + live/ended holders. Skips coins with nothing to do. Priority fee
configurable. Logs one line per action. Exported as a module the server runs when `KEEPER=1` (and a CLI for tests).

### 2.2 Server (fork peek-sol infrastructure, trim the rest)

Port 5295, `node:sqlite`, SSE, SIWS (copy `peek-sol/server/src/auth.js`; statement "Sign in to flipfee."), sessions.

Data:
- **Live trades with exact creator fees** for tracked coins: the peek-sol ingest (`ingest/curvelogs.js` logsSubscribe
  per curve, PumpSwap events, PumpPortal for launches/migrations; `PUMPPORTAL_API_KEY` if set). Tracked = all
  registered coins + the top hot coins (by recent creator fees/volume from pump.fun's API and DexScreener), capped by
  the RPC budget (`TRACK_MAX`, default 60).
- **Per-coin metrics**: creator fees 1m/10m/1h/6h/24h, trades, volume, price, mcap, age, image (pump.fun image CDN),
  socials; moderation of names (copy `peek-sol/server/src/moderate.js`; slur coins masked and kept off the board).
- **flipfee index**: Config + all Coin accounts (getProgramAccounts at start, account subscription after), program logs
  for events; holders, queues, payouts, totals.
- **Wants**: `POST /api/want {mint}` (session), one per wallet per coin; counts per coin; list per dev.

API: `GET /api/board` (snapshot: ticker stats, live coins, hot coins), `GET /api/coin/:mint` (coin + timeline +
last 100 trades), `GET /api/dev/:wallet` (coins created by the wallet with eligibility + wants + metrics),
`GET /api/me/:wallet` (hours and payouts), `GET /api/stream` (SSE: `trade`, `fee`, `window`, `buy`, `paid`,
`register`, `stats`, `want`), `POST /api/auth/nonce|verify`, `POST /api/want`, `GET /health`. Amounts in lamports as
strings plus SOL numbers for display.

### 2.3 App

Vite + React 19 + TS + `@solana/web3.js` (like peek-sol app). **Phantom only**: copy `peek-sol/app/src/wallet/*`
(connect, deeplink to Phantom's in-app browser on phones, SIWS session). No other wallet appears anywhere.
Transactions: `client/` builders, `signAndSendTransaction` (or sign + send through our RPC), simulation before the
wallet, confirmation via SSE `buy`/`register` or signature status, plain errors.

Routes: `/` board, `/c/:mint`, `/dev`, `/me`. First paint from the `/api/board` snapshot (and a localStorage copy for
repeat visits), then SSE.

### 2.4 Eligibility of a coin (dev page and Connect)

| State (from chain) | Shown | Action |
|---|---|---|
| no `sharing_config`, wallet = curve creator (or `pool.coin_creator`) | Ready | Connect = create config + set split + register (one tx) |
| `sharing_config` with `admin_revoked = false`, wallet = admin | Ready | Connect = set split + register (one tx) |
| split already points 100% to the flipfee vault, no Coin account | Almost there | Register |
| `admin_revoked = true` with another split | "Fee split locked on pump.fun" | Want/Share only |
| USDC-paired coin | "SOL coins only for now" | — |
| wallet is not the creator/admin | — | Want/Share |

---

## 3. Testing

- **Program**: `solana-test-validator` with mainnet clones of pump, pump_amm, pump_fees (upgradeable programs) and
  their global/fee-config accounts; create a coin with pump `create_v2`, trade it, `create_fee_sharing_config`,
  `update_fee_shares_v2 → [vault, 10000]`, `register`, `buy` hours, trade during and after the hour, distribute,
  `crank`; assert exact time-weighted splits, payouts to wallets, idempotence, every error path. Also a graduated
  coin path if cloneable (AMM sweep). Report CU per instruction and the program size + mainnet deploy cost.
- **Server**: unit tests for metrics and the index; an integration run against the localnet above.
- **App**: Playwright against the localnet + server with an injected **Phantom-compatible provider** (`window.phantom.
  solana`, `isPhantom`, connect/disconnect events, `signMessage`, `signAndSendTransaction`) backed by a local keypair;
  flows: watch, connect + sign-in, want, buy 1h, see cash land, dev connect + set price. Screens at 1440 and 390. The
  owner checks real Phantom on the live site at the end.
- Copy gate: `node ../shared/copycheck.mjs src/copy.ts` (grade ≤ 3, affirmative, no metaphors/negations/hype/slang);
  owner-chosen strings go in its `APPROVED` set ("Flip fees into cash." is the domain line).

## 4. Deploy

- Program: build → size → mainnet cost; deployer keypair generated locally (`program/.keys/`, never printed); the owner
  funds it; the lead deploys (the lead never moves funds between wallets). Keeper keypair on the box, funded by the
  owner (~0.1 SOL to start).
- Box `5.75.168.69`: static app `/srv/ft1/flipfee`, server `/opt/flipfee-server` as user `flipfee`, env
  `/etc/flipfee/server.env`, keeper key `/etc/flipfee/keeper.json` (600), DB `/var/lib/flipfee`, unit
  `flipfee-server`; Caddy `flipfee.cash` (+ www → apex), `/api/*` → 127.0.0.1:5295 with `flush_interval -1` (SSE);
  `feeflip.pro` → 301 to `https://flipfee.cash`. DNS: A records of flipfee.cash and www → 5.75.168.69 (owner).
- Live since 2026-10-07 without the program (owner: no SOL yet; "no demo/test marks"): the board, coin, dev and Me
  pages run on live pump.fun data; Phantom connect and Sign-In With Solana work; Want works. Buy and Connect check that
  the program account is executable first and answer `err.setup` until the deploy. `KEEPER=0`. Caddy backup before
  the change: `/root/Caddyfile.ft1.bak-2026-10-07-flipfee`.
- Updates: `bash flipfee/release.sh` (`--app-only`, `--dry-run`). After the program deploy: set `FLIPFEE_PROGRAM_ID`
  if it differs, add the keeper key, `KEEPER=1`, restart.

## 5. Copy rules (all UI text, `src/copy.ts`)

Grade ≤ 3 English, short affirmative sentences, technical terms allowed (SOL, CA, fees, pump.fun, Phantom), no metaphors
(the brand line is the one exception), no negations, no comparisons, no hype, no crypto slang. Every number has a
plain label. Estimates are labeled as past facts ("Last hour paid …"), never as promises.
