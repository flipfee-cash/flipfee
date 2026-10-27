// flipfee keeper (DESIGN §2.1): about every 60 s, for each registered coin, bring pump.fun's creator fees into the
// vault (PumpSwap sweep for graduated coins, pump distribute) and crank (sync + pay the owner and the holders).
// Coins with nothing to do are skipped. It also runs right after window starts and ends, so a sold hour's edges
// are synced on the second. One log line per action. The server runs it in-process when KEEPER=1; `cli.ts` runs it
// alone.

import {
  type Commitment,
  type Connection,
  type Keypair,
  type PublicKey,
  type Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';

import {
  type Address,
  type CoinAccount,
  COMPUTE_UNITS,
  FLIPFEE_PROGRAM_ID,
  buildTx,
  chainTime,
  crankIx,
  crankRecipients,
  decodeCoin,
  distributeCreatorFeesV2Ix,
  fetchCoins,
  findCoinPda,
  findPumpCreatorVaultPda,
  findSharingConfigPda,
  findVaultPda,
  formatSol,
  getAmmCreatorVaultAta,
  parseEvents,
  parseFlipfeeError,
  toPublicKey,
  transferCreatorFeesToPumpV2Ix,
} from '../../client/src/index.js';

export interface KeeperOptions {
  connection: Connection;
  /** Pays the transaction fees (and nothing else). */
  payer: Keypair;
  programId?: Address;
  /** Default 60 000. */
  intervalMs?: number;
  /** Priority fee, micro-lamports per compute unit (default 0). */
  microLamports?: number;
  /** Only these coins (default: every registered coin). */
  mints?: Address[];
  /** Fees waiting at pump below this are left for later unless a payout or a window edge needs a crank. Default
   * 10 000 lamports (two transaction fees). */
  minPending?: bigint;
  /** Recipients per crank transaction (owner + holders); more are paid by follow-up cranks. Default 15 (keeps the
   * events under mainnet's 10,000-byte log limit). */
  maxRecipientsPerTx?: number;
  /** Extra runs at window starts and ends. Default true. */
  boundaryRuns?: boolean;
  commitment?: Commitment;
  /** One line per action. Default console.log. */
  log?: (line: string) => void;
}

export interface CoinAction {
  mint: string;
  signatures: string[];
  swept: boolean;
  distributed: boolean;
  /** Lamports allocated by the sync. */
  synced: bigint;
  /** Lamports paid, by recipient. */
  paid: { to: string; amount: bigint; kind: 'Owner' | 'Holder' }[];
  error?: string;
}

export interface TickResult {
  at: number;
  coins: number;
  acted: CoinAction[];
  skipped: number;
  /** Next window start/end after `at` among the coins (unix seconds), if any. */
  nextBoundary: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What one coin needs right now, from chain state. */
export function planCoin(
  coin: CoinAccount,
  s: { now: number; vaultLamports: bigint; pumpVaultLamports: bigint; ammPending: bigint; rentMin: bigint; minPending: bigint },
): { sweep: boolean; distribute: boolean; crank: boolean; why: string[] } {
  const why: string[] = [];
  const pumpPending = s.pumpVaultLamports > s.rentMin ? s.pumpVaultLamports - s.rentMin : 0n;
  const unallocated = s.vaultLamports - s.rentMin - coin.credited;
  const owed = coin.credited > 0n;
  const edge = coin.windows.some(
    (w) => (w.start > coin.lastSync && w.start <= s.now) || (w.end > coin.lastSync && w.end <= s.now),
  );
  const prunable = coin.windows.some((w) => w.end <= s.now && w.owed === 0n);
  const sweep = s.ammPending > 0n;
  if (sweep) why.push(`amm ${formatSol(s.ammPending)}`);
  if (pumpPending > 0n) why.push(`pump ${formatSol(pumpPending)}`);
  if (unallocated > 0n) why.push(`vault ${formatSol(unallocated)}`);
  if (owed) why.push(`owed ${formatSol(coin.credited)}`);
  if (edge) why.push('window edge');
  if (prunable) why.push('done window');
  const enough = s.ammPending + pumpPending >= s.minPending;
  const crank = enough || sweep || unallocated > 0n || owed || edge || prunable;
  return { sweep, distribute: crank && (sweep || pumpPending > 0n), crank, why };
}

export function createKeeper(opts: KeeperOptions) {
  const conn = opts.connection;
  const programId = toPublicKey(opts.programId ?? FLIPFEE_PROGRAM_ID);
  const commitment = opts.commitment ?? 'confirmed';
  const log = opts.log ?? ((l: string) => console.log(l));
  const intervalMs = opts.intervalMs ?? 60_000;
  const maxRecipients = opts.maxRecipientsPerTx ?? 15;
  const minPending = opts.minPending ?? 10_000n;
  const payer = opts.payer;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = true;
  let current: Promise<TickResult> | null = null;
  let rentMin: bigint | null = null;

  async function send(tx: Transaction): Promise<{ sig: string; logs: string[] }> {
    tx.sign(payer);
    const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: commitment, maxRetries: 5 });
    for (let i = 0; i < 120; i++) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw Object.assign(new Error(`transaction ${sig} failed: ${JSON.stringify(st.err)}`), { sig });
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') break;
      if (i === 119) throw new Error(`transaction ${sig} not confirmed`);
      await sleep(500);
    }
    // the logs feed the log line and the result; a lagging RPC can take a few seconds to serve the transaction
    for (let i = 0; i < 40; i++) {
      const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (t?.meta) return { sig, logs: t.meta.logMessages ?? [] };
      await sleep(500);
    }
    log(`crank ${sig}: confirmed, logs not served yet`);
    return { sig, logs: [] };
  }

  async function loadCoins(): Promise<{ address: PublicKey; account: CoinAccount }[]> {
    if (!opts.mints) return fetchCoins(conn, { programId, commitment });
    const keys = opts.mints.map((m) => findCoinPda(m, programId)[0]);
    const infos = await conn.getMultipleAccountsInfo(keys, commitment);
    return infos.flatMap((info, i) => (info ? [{ address: keys[i]!, account: decodeCoin(info.data) }] : []));
  }

  async function actOn(coin: CoinAccount, plan: ReturnType<typeof planCoin>, now: number): Promise<CoinAction> {
    const mint = coin.mint;
    const action: CoinAction = { mint: mint.toBase58(), signatures: [], swept: false, distributed: false, synced: 0n, paid: [] };
    const all = crankRecipients(coin, now, 64);
    const batches: PublicKey[][] = [];
    for (let i = 0; i < all.length; i += maxRecipients) batches.push(all.slice(i, i + maxRecipients));
    if (batches.length === 0) batches.push([]);
    for (let b = 0; b < batches.length; b++) {
      const ixs: TransactionInstruction[] = [];
      let units = COMPUTE_UNITS.crank;
      if (b === 0) {
        if (plan.sweep) {
          ixs.push(transferCreatorFeesToPumpV2Ix({ payer: payer.publicKey, coinCreator: findSharingConfigPda(mint)[0] }));
          units += COMPUTE_UNITS.pump_transfer_creator_fees_to_pump;
        }
        if (plan.distribute) {
          ixs.push(distributeCreatorFeesV2Ix({ payer: payer.publicKey, mint, shareholders: [findVaultPda(mint, programId)[0]] }));
          units += COMPUTE_UNITS.pump_distribute_creator_fees;
        }
      }
      ixs.push(crankIx({ mint, recipients: batches[b]!, programId }));
      const tx = await buildTx(conn, payer.publicKey, ixs, units, { microLamports: opts.microLamports, commitment });
      const { sig, logs } = await send(tx);
      action.signatures.push(sig);
      if (b === 0) {
        action.swept = plan.sweep;
        action.distributed = plan.distribute;
      }
      for (const e of parseEvents(logs, programId)) {
        if (e.name === 'FeesSynced') action.synced += e.data.amount;
        if (e.name === 'Paid') action.paid.push({ to: e.data.to.toBase58(), amount: e.data.amount, kind: e.data.kind });
      }
    }
    return action;
  }

  /** One pass over the coins. */
  async function tick(): Promise<TickResult> {
    const coins = await loadCoins();
    const now = await chainTime(conn, commitment);
    // the vault's floor and pump's creator-vault floor: the cluster's 0-byte rent-exempt minimum
    rentMin ??= BigInt(await conn.getMinimumBalanceForRentExemption(0, commitment));
    const result: TickResult = { at: now, coins: coins.length, acted: [], skipped: 0, nextBoundary: null };
    for (const { account: c } of coins) {
      for (const w of c.windows) {
        for (const t of [w.start, w.end]) {
          if (t > now && (result.nextBoundary === null || t < result.nextBoundary)) result.nextBoundary = t;
        }
      }
    }
    // chain state of every coin in batches of 33 coins × 3 accounts: vault, pump creator vault, AMM creator vault
    for (let i = 0; i < coins.length; i += 33) {
      const chunk = coins.slice(i, i + 33);
      const keys = chunk.flatMap(({ account: c }) => {
        const sc = findSharingConfigPda(c.mint)[0];
        return [findVaultPda(c.mint, programId)[0], findPumpCreatorVaultPda(sc)[0], getAmmCreatorVaultAta(sc)];
      });
      const infos = await conn.getMultipleAccountsInfo(keys, commitment);
      for (let j = 0; j < chunk.length; j++) {
        const coin = chunk[j]!.account;
        const [vault, pumpVault, amm] = infos.slice(j * 3, j * 3 + 3);
        const ammPending = amm && amm.data.length >= 72 ? new DataView(amm.data.buffer, amm.data.byteOffset).getBigUint64(64, true) : 0n;
        const plan = planCoin(coin, {
          now,
          vaultLamports: BigInt(vault?.lamports ?? 0),
          pumpVaultLamports: BigInt(pumpVault?.lamports ?? 0),
          ammPending,
          rentMin,
          minPending,
        });
        if (!plan.crank) {
          result.skipped++;
          continue;
        }
        try {
          const a = await actOn(coin, plan, now);
          result.acted.push(a);
          const paid = a.paid.map((p) => `${p.kind === 'Owner' ? 'owner' : 'holder'} ${p.to.slice(0, 4)}…${p.to.slice(-4)} ${formatSol(p.amount)}`);
          log(
            `crank ${a.mint} ${a.swept ? 'swept ' : ''}${a.distributed ? 'distributed ' : ''}synced ${formatSol(a.synced)} SOL` +
              `${paid.length ? `, paid ${paid.join(', ')}` : ''} (${plan.why.join(', ')}) ${a.signatures.join(' ')}`,
          );
        } catch (err) {
          const decoded = parseFlipfeeError(err);
          const msg = decoded ? `${decoded.source}:${decoded.name}` : (err as Error).message;
          result.acted.push({ mint: coin.mint.toBase58(), signatures: [], swept: false, distributed: false, synced: 0n, paid: [], error: msg });
          log(`crank ${coin.mint.toBase58()} failed: ${msg}`);
        }
      }
    }
    return result;
  }

  async function guardedTick(): Promise<TickResult | null> {
    if (running) return null;
    running = true;
    try {
      current = tick();
      return await current;
    } catch (err) {
      log(`keeper tick failed: ${(err as Error).message}`);
      return null;
    } finally {
      running = false;
      current = null;
    }
  }

  function schedule(next: TickResult | null): void {
    if (stopped) return;
    let wait = intervalMs;
    if ((opts.boundaryRuns ?? true) && next?.nextBoundary != null) {
      const untilEdge = (next.nextBoundary - next.at + 2) * 1_000;
      if (untilEdge > 0 && untilEdge < wait) wait = untilEdge;
    }
    timer = setTimeout(async () => schedule(await guardedTick()), wait);
  }

  return {
    tick,
    /** Starts the loop (first pass now). */
    start(): void {
      if (!stopped) return;
      stopped = false;
      log(`keeper started: payer ${payer.publicKey.toBase58()}, every ${intervalMs / 1000}s, program ${programId.toBase58()}`);
      void guardedTick().then(schedule);
    },
    /** Stops the loop and waits for a running pass. */
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (current) await current.catch(() => undefined);
    },
  };
}
