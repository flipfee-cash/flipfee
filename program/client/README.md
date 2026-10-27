# flipfee-client

TypeScript client for the `flipfee` Solana program and the pump.fun instructions around it. One ESM bundle
(`dist/index.js` + `dist/index.d.ts`), built with tsup like `peek-sol/program/client`. It runs in Node ≥ 22 and in
the browser (Vite). Peer dependencies: `@solana/web3.js` 1.x and `buffer`.

- Amounts are **lamports as `bigint`**. Times are **unix seconds as `number`** (chain clock).
- Every function takes an optional `programId` (default `FLIPFEE_PROGRAM_ID`), so a fresh mainnet id needs no
  code change.
- SOL-paired coins only (v1). A USDC-paired coin reads as `eligibility().kind === 'usdc'`.

Build: `npm run build:client` (in `flipfee/program/`). Use from the server or the app:

```jsonc
// package.json
"dependencies": { "flipfee-client": "file:../program/client" }
```

```ts
import { buyTx, fetchCoin, eligibility, coinStatus, parseEvents, formatSol } from 'flipfee-client';
```

## How a coin works (one paragraph)

pump.fun allows one fee split per coin. The dev sets it to **100% → the flipfee vault of the coin**
(`vault = PDA["vault", mint]`, a system account). pump pays creator fees into the vault when anyone calls pump's
`distribute_creator_fees_v2` (the keeper does it about every 60 s; `buyTx` and `crankTx` do it too). The program's
`crank` (and every `buy`) **syncs**: what arrived since the last sync is split over the time `(last_sync, now]`
**by the second** — a sold hour `[start, end)` gets `floor(amount × overlap / interval)`, the dev gets the rest — and
then pays the owner and the hour buyers passed to it. Buying `h` hours pays `price × h`: 95% to the dev at once,
5% (`config.feeBps`) to the treasury. A `buy` refuses while pump still holds fees of the coin (more than
`PENDING_TOLERANCE` = 10,000 lamports; `FeesNotCollected`):
`buyTx` puts PumpSwap's sweep and pump's distribute before it, so fees earned before a purchase are never the
buyer's.

## Constants

| Name | Value |
|---|---|
| `FLIPFEE_PROGRAM_ID` | from the IDL (`IDL_ADDRESS`) |
| `PUMP_PROGRAM_ID`, `PUMP_AMM_PROGRAM_ID`, `PUMP_FEES_PROGRAM_ID` | pump.fun mainnet ids |
| `WSOL_MINT`, `USDC_MINT`, `TOKEN_PROGRAM_ID`, `TOKEN_2022_PROGRAM_ID`, `ASSOCIATED_TOKEN_PROGRAM_ID` | |
| `HOUR` | 3600 |
| `MIN_HOURS`, `MAX_HOURS` | 1, 12 (per buy) |
| `MIN_PRICE`, `MAX_PRICE` | 10_000_000n (0.01 SOL), 1_000_000_000_000n (1000 SOL) per hour |
| `MIN_MAX_AHEAD`, `MAX_MAX_AHEAD`, `DEFAULT_MAX_AHEAD` | 3600, 172800, 86400 seconds |
| `MAX_WINDOWS` | 32 (sold hours a coin holds at once: live, queued, ended-unpaid) |
| `MAX_FEE_BPS`, `DEFAULT_FEE_BPS` | 1000, 500 |
| `PENDING_TOLERANCE` | 10_000n lamports of uncollected pump fees a `buy` accepts |
| `COMPUTE_UNITS` | per-instruction CU limits (measured maxima with headroom; see constants.ts) |
| `RENT_MIN_0` | 650_240n (mainnet 0-byte rent, display only; the program reads the Rent sysvar) |
| `ACCOUNT_SIZE` | `{ Config: 76, Coin: 2191 }` bytes |

## PDAs (`[address, bump]`)

| Function | Seeds |
|---|---|
| `findConfigPda()` | `["config"]` |
| `findCoinPda(mint)` | `["coin", mint]` |
| `findVaultPda(mint)` | `["vault", mint]` (system-owned, no data; the pump shareholder) |
| `findProgramDataAddress()` | upgradeable loader ProgramData |
| `findBondingCurvePda(mint)` | pump `["bonding-curve", mint]` |
| `findSharingConfigPda(mint)` | pump_fees `["sharing-config", mint]` |
| `findPumpCreatorVaultPda(creator)` | pump `["creator-vault", creator]` (after joining: creator = sharing config) |
| `findPoolAuthorityPda(mint)`, `findCanonicalPoolPda(mint)` | PumpSwap canonical pool of a graduated coin |
| `findAmmCreatorVaultAuthorityPda(coinCreator)` | PumpSwap `["creator_vault", coinCreator]` |
| `getAta(owner, mint, tokenProgram?)` | associated token account |

## Accounts and decoders

```ts
interface ConfigAccount { admin: PublicKey; treasury: PublicKey; feeBps: number; paused: boolean; bump: number }
interface WindowAccount { holder: PublicKey; start: number; end: number; owed: bigint; earned: bigint }
interface CoinAccount {
  mint: PublicKey; owner: PublicKey; bump: number; vaultBump: number;
  price: bigint;            // lamports per hour
  maxAhead: number;         // seconds
  paused: boolean;
  lastSync: number;
  ownerOwed: bigint;
  credited: bigint;         // ownerOwed + Σ windows.owed
  windows: WindowAccount[]; // sorted by start
  feesIn: bigint;           // lamports allocated in total
  sales: bigint;            // lamports buyers paid in total (fee included)
  hoursSold: number;
  paidOut: bigint;          // lamports the vault paid in total
}
decodeConfig(data: Uint8Array): ConfigAccount
decodeCoin(data: Uint8Array): CoinAccount
fetchConfig(conn, opts?): Promise<ConfigAccount>
fetchCoin(conn, mint, opts?): Promise<CoinAccount | null>
fetchCoins(conn, opts?): Promise<{ address: PublicKey; account: CoinAccount }[]>   // getProgramAccounts
fetchCoinsOfOwner(conn, owner, opts?)                                               // memcmp on owner
COIN_OFFSETS = { mint: 8, owner: 40 }   // for memcmp filters

// pump.fun accounts (length-tolerant: missing trailing fields read as defaults)
interface BondingCurveAccount { virtualTokenReserves; virtualQuoteReserves; realTokenReserves; realQuoteReserves;
  tokenTotalSupply: bigint; complete: boolean; creator: PublicKey; isMayhemMode: boolean; isCashbackCoin: boolean;
  quoteMint: PublicKey /* default = SOL */; creatorFeeBps: bigint; isHolderReward: boolean }
interface SharingConfigAccount { bump: number; version: number; status: 'Paused' | 'Active'; mint: PublicKey;
  admin: PublicKey; adminRevoked: boolean; shareholders: { address: PublicKey; shareBps: number }[] }
interface PoolAccount { poolBump: number; index: number; creator: PublicKey; baseMint: PublicKey; quoteMint: PublicKey;
  lpMint: PublicKey; poolBaseTokenAccount: PublicKey; poolQuoteTokenAccount: PublicKey; lpSupply: bigint;
  coinCreator: PublicKey; isMayhemMode: boolean; isCashbackCoin: boolean }
decodeBondingCurve(data), decodeSharingConfig(data), decodePool(data)
fetchBondingCurve(conn, mint), fetchSharingConfig(conn, mint), fetchCanonicalPool(conn, mint)
```

### Reading a coin (`coinStatus`)

```ts
coinStatus(coin: CoinAccount, now: number): {
  holder: PublicKey | null;      // who gets the fees right now (null = the owner)
  live: WindowAccount | null;    // the window covering `now`
  endsIn: number;                // seconds left in the live window (0 if none)
  queue: WindowAccount[];        // windows starting after now
  nextStart: number;             // where a purchase made now would start
  aheadLeft: number;             // seconds still sellable: maxAhead − (nextStart − now)
  maxHoursNow: number;           // hours a buy can take right now (0..12), 0 if paused or the queue is full
  queueFull: boolean;
}
```

## Instruction builders (flipfee)

All return a `TransactionInstruction`.

```ts
initializeIx({ authority, treasury, feeBps })
setConfigIx({ admin, treasury, feeBps, paused })
setAdminIx({ admin, newAdmin })
registerIx({ owner, mint, price, maxAhead })              // owner = the pump fee-sharing admin (the dev)
setTermsIx({ owner, mint, price, maxAhead, paused })
transferOwnerIx({ owner, mint, newOwner })               // both sign (the new owner accepts)
buyIx({ buyer, mint, owner, treasury, hours, maxPrice, maxStart })
  // owner = coin.owner, treasury = config.treasury; maxStart = latest acceptable start (unix seconds)
crankIx({ mint, recipients })                             // recipients: owner and/or holders (writable), ≤ 15
```

`registerIx` and `buyIx` also pass the coin's pump sharing config, bonding curve and canonical PumpSwap pool (derived
from `mint`): the program checks the coin's fees still route to the vault (`buy` refuses with `CurveNotRouted`,
`SplitNotToVault`, `SharingNotActive`, `HolderRewardCoin` or, once graduated, `PoolNotRouted`). `buyIx` also passes
pump's creator vault and PumpSwap's creator vault (derived): the program checks both are empty (`FeesNotCollected`).
If the treasury cannot take a fee (emptied below rent), the fee goes to the owner (`HoursBought.fee = 0`).

## Instruction builders (pump.fun, SOL-paired)

```ts
createFeeSharingConfigIx({ creator, mint, pool? })        // pool = canonical pool if graduated
updateFeeSharesV2Ix({ authority, mint, current, next, pool? })
  // current = sharing config's current shareholders (remaining accounts, in order);
  // a graduated coin also needs `pool` (pump reads it as the LAST remaining account — not in pump's docs)
updateFeeSharesIx({ authority, mint, current, next, pool? })  // v1; the one that works on version-1 configs
distributeCreatorFeesV2Ix({ payer, mint, shareholders })  // shareholders = [vault] for a flipfee coin
transferCreatorFeesToPumpV2Ix({ payer, coinCreator })     // coinCreator = sharing config; graduated coins
getMinimumDistributableFeeIx({ mint, shareholders })      // simulate; returns { minimumRequired, distributableFees, canDistribute }
```

Facts measured on the mainnet programs (cloned into the tests), some not in pump's docs:
- `distribute_creator_fees_v2` never fails on small amounts: below its minimum it logs "Insufficient fees for
  distribution" and moves nothing. Minimum = pump vault rent (650,240) plus the shareholder's rent if the vault does
  not exist yet. So `buyTx`/`crankTx` always include it.
- `update_fee_shares_v2` on a **graduated** coin wants the canonical pool as the **last** remaining account (after
  the current shareholders); `updateFeeSharesV2Ix({ pool })` does it.
- `create_fee_sharing_config` grows a `create_v2` curve from 141 to 151 bytes (the dev pays 50,800 lamports) and,
  with a pool, moves `pool.coin_creator` to the sharing config.
- The first fee after joining pays 650,240 lamports of rent for pump's new creator vault (from the trader on a curve
  trade, from the fees on the first AMM sweep).
- Fees a coin earned before joining stay in pump's creator vault of the dev (`["creator-vault", dev]`); the dev claims
  them on pump.fun as before (pump's `collect_creator_fee_v2`).
- PumpSwap `buy`/`sell` take 3 remaining accounts not in the IDL: `PDA["pool-v2", mint]` (PumpSwap), one of
  `GlobalConfig.buyback_fee_recipients`, and its WSOL account. pump `migrate_v2` takes 2: `PDA["boost_vault", pool]`
  (PumpSwap) and its WSOL account. (Only tests and tools need these; the app does not trade.)
- Some mainnet transactions are now **version 1**: `getTransaction` needs `maxSupportedTransactionVersion: 1` for
  them (web3.js 1.x may not parse them; logs-based ingest is unaffected).
- pump keeps `sharing_config.admin` set after the split is final (560,147 revoked configs on mainnet, 100/100 sampled
  keep a non-zero admin equal to the key that signed the final update). `register` uses it as the ownership proof.

## Full transactions

Each returns a legacy `Transaction` with `feePayer`, a recent blockhash, a compute-unit limit and an optional
priority fee (`microLamports`). The app signs with Phantom (`signAndSendTransaction`) after a simulation.

```ts
connectCoinTx(conn, { wallet, mint, price, maxAhead?, microLamports? }): Promise<{
  tx: Transaction;
  kind: 'ready-new' | 'ready' | 'almost';  // which steps it holds (see eligibility)
  coin: PublicKey; vault: PublicKey; eligibility: Eligibility;
}>   // throws NotEligibleError (with .eligibility) for any other state
     // ready-new = 4 instructions, 1,035 bytes (1,036 for a graduated coin): one Phantom signature

buyTx(conn, { buyer, mint, hours, maxPrice?, maxStart?, startSlack?, microLamports? }): Promise<{
  tx: Transaction;
  start: number; end: number;   // expected window (from the chain clock at build time)
  maxStart: number;             // the limit sent: maxStart ?? start + (startSlack ?? 120)
  price: bigint; total: bigint; // price × hours; the buyer pays this
  toOwner: bigint; fee: bigint;
}>   // = [PumpSwap sweep (when its creator vault exists)] + distribute + buy
     // StartsTooLate when another purchase landed first and moved the start: show the new start and rebuild

crankTx(conn, { payer, mint, recipients?, microLamports? }): Promise<{ tx: Transaction; recipients: PublicKey[] }>
  // = [sweep (graduated)] + distribute + crank(owner + holders with something owed or live)

// building blocks
collectFeesIxs(conn, { payer, mint }): Promise<{ ixs; units; graduated }>  // sweep (if PumpSwap's creator vault exists) + distribute
crankRecipients(coin, now, max = 15): PublicKey[]   // owner, then holders of live/ended windows (deduplicated)
buildTx(conn, feePayer, ixs, units, { microLamports? }): Promise<Transaction>
chainTime(conn): Promise<number>                    // Clock sysvar unix_timestamp
simulateTx(conn, tx): Promise<{ ok; logs; unitsConsumed; err }>   // then parseFlipfeeError({ logs })
class NotEligibleError extends Error { eligibility: Eligibility }
```

## Eligibility (DESIGN §2.4)

```ts
eligibility(conn, mint, wallet?): Promise<{
  kind: 'ready-new' | 'ready' | 'almost' | 'locked' | 'flipfee' | 'usdc' | 'not-admin' | 'unsupported' | 'not-found';
  admin: PublicKey | null;        // who can act: sharing_config.admin, else the curve/pool creator
  graduated: boolean;             // bonding curve complete (trades on PumpSwap)
  quoteMint: PublicKey;           // WSOL_MINT for SOL-paired
  sharingConfig: PublicKey; vault: PublicKey; coin: PublicKey;
  registered: boolean;            // a flipfee Coin account exists
  reason?: string;                // for 'unsupported' and some 'locked'
  curve: BondingCurveAccount | null; sharing: SharingConfigAccount | null; pool: PoolAccount | null;  // raw pump state
}>
```

| kind | chain state | action |
|---|---|---|
| `ready-new` | no sharing config; wallet = curve creator (or `pool.coin_creator` when graduated) | `connectCoinTx`: create config + split + register |
| `ready` | sharing config, `admin_revoked = false`, wallet = admin | `connectCoinTx`: split + register |
| `almost` | split already 100% → the vault, no Coin account, wallet = admin | `connectCoinTx`: register |
| `flipfee` | Coin account exists | live on flipfee |
| `locked` | `admin_revoked = true` with another split, or a pump.fun takeover moved the creator | Want / Share only |
| `usdc` | quote mint is not SOL | "SOL coins only for now" |
| `not-admin` | the wallet cannot connect it (or no wallet given) | Want / Share |
| `unsupported` | cashback or holder-rewards coin (its creator fee does not reach a creator), or pump paused its fee sharing | — |
| `not-found` | no pump bonding curve for this mint | — |

## Events

```ts
parseEvents(logs: string[], programId?): FlipfeeEvent[]   // only flipfee's own `Program data:` lines
decodeEvent(bytes): FlipfeeEvent | null
fetchTransactionEvents(conn, signature): Promise<FlipfeeEvent[] | null>

type FlipfeeEvent =
  | { name: 'ConfigSet';        data: { admin, treasury, feeBps, paused, at } }
  | { name: 'Registered';       data: { mint, coin, owner, vault, price, maxAhead, vaultFunded, carried, at } }
  | { name: 'TermsSet';         data: { mint, coin, price, maxAhead, paused, at } }
  | { name: 'OwnerTransferred'; data: { mint, coin, from, to, paidToOldOwner, at } }
  | { name: 'HoursBought';      data: { mint, coin, buyer, start, end, hours, price, total, toOwner, fee, windows, at } }
  | { name: 'FeesSynced';       data: { mint, coin, amount, from, to, toOwner, toWindows, at } }
  | { name: 'Paid';             data: { mint, coin, to, amount, kind: 'Owner' | 'Holder', at } }
  | { name: 'WindowDone';       data: { mint, coin, holder, start, end, earned, at } }
```

pump.fun trade events (the creator fee of every trade), from `Program data:` lines of pump / PumpSwap:

```ts
decodePumpTradeEvent(bytes): { mint, solAmount, tokenAmount, isBuy, user, timestamp, creator, creatorFee, creatorFeeBps,
  fee, feeBps, virtualSolReserves, virtualTokenReserves } | null
decodeAmmTradeEvent(bytes): { side: 'buy' | 'sell'; timestamp; pool; user; quoteAmount; baseAmount; coinCreator;
  coinCreatorFee; coinCreatorFeeBps } | null
parsePumpEvents(logs): Array<{ program: 'pump' | 'pump_amm'; event }>
```

## Math and formatting

```ts
saleSplit(total, feeBps): { fee, toOwner }               // fee = floor(total × feeBps / 10000)
allocate(windows, amount, from, to): { perWindow: bigint[]; toOwner: bigint }   // the program's split, exactly
suggestedPrice({ lastHour, last6h }): bigint             // 80% of last hour, else last 6 h ÷ 6 × 80%, clamped to bounds
isValidPrice(price): boolean
formatSol(lamports, digits?): string   // exact without digits ("0.0015"); with digits: that many decimals, rounded down
toSol(lamports): number                // display math only
parseSol("0.31"): bigint
```

## Keeper (`flipfee/program/keeper`, package `flipfee-keeper`)

```ts
import { createKeeper } from 'flipfee-keeper';   // or '../program/keeper/dist/index.js'
const keeper = createKeeper({
  connection, payer: keeperKeypair,   // pays fees only
  intervalMs: 60_000,                 // plus extra runs right after window starts/ends
  microLamports: 0,                   // priority fee
  mints?,                             // default: every registered coin
  minPending: 10_000n,                // pump fees below this wait unless a payout or a window edge needs a crank
  maxRecipientsPerTx: 15,             // keeps a crank's events under mainnet's 10,000-byte log limit
  log: (line) => console.log(line),   // one line per action
});
keeper.start(); await keeper.stop();
const r = await keeper.tick();        // one pass: { at, coins, acted: [{ mint, signatures, swept, distributed, synced, paid, error? }], skipped, nextBoundary }
```

CLI: `node keeper/dist/cli.js --rpc <url> --keypair <path> [--interval 60] [--priority 0] [--mint <mint>]… [--once]`
(env: `RPC_URL`, `KEEPER_KEYPAIR`, `KEEPER_INTERVAL`, `KEEPER_PRIORITY`). Example line:
`crank 7xQ…f2 distributed synced 0.0123 SOL, paid holder 9aB…c3 0.0123 (pump 0.0123) 5sig…`

## Errors

```ts
parseFlipfeeError(err): { code, name, msg, source: 'program' | 'anchor' | 'pump' | 'system' } | null
FLIPFEE_ERRORS  // the program's error table (6000 + index)
```

Program errors (6000+): NotUpgradeAuthority, NotAdmin, NotOwner, BadFeeBps, BadTreasury, WrongTreasury,
WrongOwner, Paused, CoinPaused, PriceOutOfRange, MaxAheadOutOfRange, BadHours, PriceAboveMax, TooFarAhead, QueueFull,
NotSharingConfig, SharingNotActive, SplitNotFinal, SplitNotToVault, NotFeeAdmin, NotBondingCurve, CurveNotRouted,
NotSolPaired, CashbackCoin, BadMint, BadVault, BadNewOwner, RecipientNotWritable, OwnerCannotReceive, VaultShort,
MathOverflow, PoolNotRouted, FeesNotCollected, HolderRewardCoin, StartsTooLate, WrongPumpVault.
