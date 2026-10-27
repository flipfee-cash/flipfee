# flipfee

**Flip fees into cash.** A market for the creator fees of pump.fun coins on Solana, sold by the hour.

- **Traders** buy an hour of a coin's fees. Every trade on that coin during the hour pays them SOL, about every minute.
- **Devs** sell their coin's next hours of fees and get SOL now. They keep every fee outside the hours they sold.

Live: https://flipfee.cash · X: https://x.com/flipfeecash

## How it works

pump.fun lets a coin's creator set its fee split **once**. A coin joins flipfee by pointing 100% of its creator fees at
its own flipfee vault (a program-owned address). The flipfee program then splits every fee that arrives **by the
second**: to whoever bought the current hour, and to the dev the rest of the time. A keeper calls `crank` about every
minute and the SOL goes straight to wallets. Buyers pay the dev for each hour at once; flipfee keeps 5% of hour sales
and nothing else.

Full design: [DESIGN.md](DESIGN.md).

## Repository

| Path | What |
|---|---|
| `program/` | Anchor program `flipfee` (Rust), TypeScript `client/`, `keeper/`; LiteSVM tests on real pump.fun binaries |
| `server/` | Node ≥ 22 server: live pump.fun trades with exact creator fees, the flipfee index, SSE, Sign-In With Solana |
| `app/` | Vite + React 19 web app; Phantom only; dithered ink-on-paper look |
| `design-kit/` | brand assets (avatar, favicons) |

## Run locally

```bash
cd program && npm install && npm run build:client && npm run build:keeper
cd ../server && npm install && cp .env.example .env && npm start      # http://127.0.0.1:5295
cd ../app && npm install && npm run dev                                # http://127.0.0.1:5197
```

Program build and tests: see [program/DEPLOY.md](program/DEPLOY.md).

## Status

The board, coin pages, Want and Phantom sign-in run on live pump.fun data. Buying hours and listing coins turn on once
the program is deployed to mainnet.

flipfee is new. Start small.
