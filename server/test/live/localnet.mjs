// Integration run on a local validator with the program builder's setup: flipfee (program/target/deploy/flipfee.so)
// and mainnet clones of pump, pump_amm, pump_fees and mayhem with their global accounts (program/fixtures/mainnet).
// By default it starts its own validator on ports 38899/38900 (temp ledger, its own upgrade authority so it can call
// `initialize`); LOCALNET_RPC=http://127.0.0.1:28899 uses a running one instead (Config must exist there).
//
// The flow, driven with the flipfee client's builders (program/client): a dev creates two pump coins (create_v2),
// a trader buys one on the curve, the server's dev page shows both as `ready-new`; the dev connects one
// (connectCoinTx: fee-sharing config + split → vault + register); a buyer buys 1 hour (buyTx); the trader trades
// during the hour; the server's hosted keeper (KEEPER=1) distributes and cranks. Checks what the server shows at each
// step: the stream (register, buy, trade with the exact creator fee, fee, paid, window), the board, the coin page,
// Me, Dev, the ticker and /health. Exits 0 when every check passes.
//   npm run test:localnet
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js';
import { IdlCoder } from '../../src/chain/borsh.js';
import { loadConfig, PROGRAM_ROOT, SERVER_ROOT } from '../../src/config.js';
import { startServer } from '../../src/main.js';

process.env.LOG_QUIET ??= '1';
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ───────── the client ─────────
const cfg0 = loadConfig({ FLIPFEE_CLIENT: process.env.FLIPFEE_CLIENT ?? '' });
const clientDir = cfg0.clientPath.find((p) => existsSync(join(p, 'dist', 'index.js')));
if (!clientDir) {
  console.error('no built flipfee client: build it in flipfee/program (npm run build:client) or set FLIPFEE_CLIENT');
  process.exit(2);
}
const C = await import(pathToFileURL(join(clientDir, 'dist', 'index.js')).href);
const PROGRAM_ID = C.FLIPFEE_PROGRAM_ID.toBase58();
say('client', clientDir, 'program', PROGRAM_ID);

// ───────── the validator ─────────
const work = mkdtempSync(join(tmpdir(), 'flipfee-localnet-'));
let validator = null;
let rpcUrl = process.env.LOCALNET_RPC || '';
const admin = Keypair.generate(); // the upgrade authority of our own validator's flipfee
if (!rpcUrl) {
  const bin = join(homedir(), '.local/share/solana/install/active_release/bin/solana-test-validator');
  const so = join(PROGRAM_ROOT, 'target', 'deploy', 'flipfee.so');
  const fx = join(PROGRAM_ROOT, 'fixtures', 'mainnet');
  for (const f of [bin, so, join(fx, 'programs', 'pump.so')]) if (!existsSync(f)) throw new Error(`missing ${f}`);
  const authFile = join(work, 'authority.json');
  writeFileSync(authFile, JSON.stringify([...admin.secretKey]), { mode: 0o600 });
  const progs = { '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.so', pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'pump_amm.so', pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ: 'pump_fees.so', MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e: 'mayhem.so' };
  const args = ['--reset', '--quiet', '--ledger', join(work, 'ledger'), '--bind-address', '127.0.0.1', '--rpc-port', '38899', '--faucet-port', '39900', '--gossip-port', '38001', '--dynamic-port-range', '38002-38050', '--faucet-sol', '1000000'];
  args.push('--upgradeable-program', PROGRAM_ID, so, admin.publicKey.toBase58());
  for (const [id, f] of Object.entries(progs)) args.push('--upgradeable-program', id, join(fx, 'programs', f), 'none');
  args.push('--account-dir', join(fx, 'accounts'));
  validator = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  validator.stderr.on('data', (d) => process.env.VALIDATOR_LOG && process.stderr.write(d));
  rpcUrl = 'http://127.0.0.1:38899';
  say('validator starting', rpcUrl, 'ledger', work);
}
const wsUrl = process.env.LOCALNET_WS || rpcUrl.replace(/^http/, 'ws').replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`);
const conn = new Connection(rpcUrl, { commitment: 'confirmed', wsEndpoint: wsUrl });
for (let i = 0; ; i++) {
  try {
    await conn.getSlot();
    break;
  } catch {
    if (i > 120) throw new Error('the validator did not start');
    await sleep(500);
  }
}
say('validator up, slot', await conn.getSlot());

let app = null;
const cleanup = async () => {
  try {
    await app?.stop();
  } catch {
    // stopping anyway
  }
  validator?.kill('SIGINT');
  await sleep(500);
  rmSync(work, { recursive: true, force: true });
};

async function main() {
  // ───────── wallets ─────────
  const dev = Keypair.generate();
  const buyer = Keypair.generate();
  const trader = Keypair.generate();
  const keeper = Keypair.generate();
  const treasury = Keypair.generate();
  for (const [k, sol] of [[admin, 10], [dev, 50], [buyer, 50], [trader, 500], [keeper, 10], [treasury, 1]]) {
    const sig = await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
  }
  const send = async (tx, signers, what) => {
    if (!(tx instanceof Transaction) && typeof tx.serialize !== 'function') throw new Error('not a transaction');
    if (!tx.recentBlockhash) tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    if (!tx.feePayer) tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
    const r = await conn.confirmTransaction(sig, 'confirmed');
    if (r.value.err) throw new Error(`${what} failed: ${JSON.stringify(r.value.err)}`);
    return sig;
  };
  const ixTx = (...ixs) => {
    const tx = new Transaction();
    for (const ix of ixs) tx.add(ix);
    return tx;
  };

  // ───────── flipfee Config ─────────
  const configInfo = await conn.getAccountInfo(new PublicKey(C.findConfigPda()[0].toBase58()));
  if (!configInfo) {
    if (process.env.LOCALNET_RPC) throw new Error('Config is missing on this validator and this run is no upgrade authority there');
    await send(ixTx(C.initializeIx({ authority: admin.publicKey, treasury: treasury.publicKey, feeBps: 500 })), [admin], 'initialize');
    say('initialized Config (fee 5%)');
  }

  // ───────── the server (read-only, plus the hosted keeper) ─────────
  const keeperFile = join(work, 'keeper.json');
  mkdirSync(work, { recursive: true });
  writeFileSync(keeperFile, JSON.stringify([...keeper.secretKey]), { mode: 0o600 });
  const cfg = loadConfig({
    SOLANA_CLUSTER: 'localnet',
    RPC_URL: rpcUrl,
    RPC_WS_URL: wsUrl,
    FLIPFEE_PROGRAM_ID: PROGRAM_ID,
    FLIPFEE_CLIENT: clientDir,
    DB_PATH: join(work, 'server.sqlite'),
    PORT: '0',
    KEEPER: '1',
    KEEPER_KEYPAIR_FILE: keeperFile,
    KEEPER_INTERVAL_MS: '4000',
    INDEX_POLL_MS: '5000',
    LOG_QUIET: process.env.LOG_QUIET,
  });
  app = await startServer(cfg);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();
  say('server up', base, 'adapter', app.adapter.source);
  check('the server indexes the program through the client', app.adapter.source === 'client' && app.indexer?.loaded, JSON.stringify(app.adapter.describe()));

  // the stream, from the start
  const events = [];
  const ac = new AbortController();
  void (async () => {
    const r = await fetch(`${base}/api/stream`, { signal: ac.signal });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (\w+)$/m.exec(block)?.[1];
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n');
        if (ev && data) events.push({ type: ev, data: JSON.parse(data) });
      }
    }
  })();
  const waitFor = async (pred, ms = 60_000, what = 'event') => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const e = events.find(pred);
      if (e) return e;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  // ───────── two pump coins by the dev; a trade before flipfee ─────────
  const globalAcc = await conn.getAccountInfo(new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf'));
  const pumpIdl = JSON.parse(readFileSync(new URL('../fixtures/pump-idl-subset.json', import.meta.url), 'utf8')).pump;
  const global = new IdlCoder(pumpIdl).account(Buffer.from(globalAcc.data)).data;
  const rc = { feeRecipient: global.fee_recipients[0], buybackFeeRecipient: global.buyback_fee_recipients[0] };
  const coinA = Keypair.generate();
  const coinB = Keypair.generate();
  for (const [k, name, symbol] of [[coinA, 'Flip Test', 'FLIPT'], [coinB, 'Other Test', 'OTHER']]) {
    await send(ixTx(C.pumpCreateV2Ix({ mint: k.publicKey, user: dev.publicKey, creator: dev.publicKey, name, symbol, uri: 'https://example.com/m.json' })), [dev, k], `create ${symbol}`);
  }
  const A = coinA.publicKey.toBase58();
  const B = coinB.publicKey.toBase58();
  say('created coins', A, B);
  const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const trade = async (buy, curveCreator, amount, label) => {
    const ixs = [C.createAtaIdempotentIx({ payer: trader.publicKey, owner: trader.publicKey, mint: coinA.publicKey, tokenProgram: T22 })];
    ixs.push(buy ? C.pumpBuyV2Ix({ rc, mint: coinA.publicKey, user: trader.publicKey, curveCreator, amount, maxSolCost: 100n * BigInt(LAMPORTS_PER_SOL) }) : C.pumpSellV2Ix({ rc, mint: coinA.publicKey, user: trader.publicKey, curveCreator, amount, minSolOutput: 0n }));
    const sig = await send(ixTx(...ixs), [trader], label);
    const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 1 });
    const keys = tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys;
    const vault = C.findPumpCreatorVaultPda(curveCreator)[0].toBase58();
    const i = keys.findIndex((k) => k.toBase58() === vault);
    if (i < 0) return { sig, vaultGained: null };
    // the first fee into a new creator vault also pays the vault's rent (the trader pays it): count the fee only
    const created = tx.meta.preBalances[i] === 0;
    const rent = created ? await conn.getMinimumBalanceForRentExemption(0) : 0;
    return { sig, vaultGained: tx.meta.postBalances[i] - tx.meta.preBalances[i] - rent, created };
  };
  await trade(true, dev.publicKey, 20_000_000_000_000n, 'trade before flipfee');

  // ───────── dev page before connecting ─────────
  let devPage = await get(`/api/dev/${dev.publicKey.toBase58()}`);
  const kindOf = (p, m) => p.coins.find((c) => c.mint === m)?.eligibility?.kind;
  check('dev page finds both coins on chain (no pump.fun API on localnet)', kindOf(devPage, A) && kindOf(devPage, B), JSON.stringify(devPage.coins.map((c) => [c.symbol, c.eligibility?.kind])));
  check('both are ready-new for their creator (client eligibility)', kindOf(devPage, A) === 'ready-new' && kindOf(devPage, B) === 'ready-new' && devPage.coins[0].eligibility.source === 'client');
  check('names come from the Token-2022 metadata of the mint', devPage.coins.some((c) => c.symbol === 'FLIPT'), devPage.coins.map((c) => c.symbol).join(','));
  const other = await get(`/api/dev/${buyer.publicKey.toBase58()}`);
  check('another wallet has no coins', other.coins.length === 0);

  // ───────── connect coin A (one transaction) ─────────
  const price = 50_000_000n; // 0.05 SOL per hour
  const connect = await C.connectCoinTx(conn, { wallet: dev.publicKey, mint: coinA.publicKey, price, maxAhead: 86_400 });
  check('connectCoinTx sees ready-new', connect.kind === 'ready-new', connect.kind);
  await send(connect.tx, [dev], 'connect');
  const reg = await waitFor((e) => e.type === 'register' && e.data.mint === A, 30_000, 'register');
  check('stream: register', reg.data.owner === dev.publicKey.toBase58() && reg.data.price.lamports === String(price), JSON.stringify({ owner: reg.data.owner, price: reg.data.price }));
  for (let i = 0; i < 40 && !(await get('/api/board')).live.find((c) => c.mint === A)?.symbol; i++) await sleep(250);
  let board = await get('/api/board');
  let row = board.live.find((c) => c.mint === A);
  check('board: coin A is live with its flipfee part', !!row?.flipfee && row.flipfee.price.lamports === String(price) && row.symbol === 'FLIPT', row ? `${row.symbol} ${row.flipfee?.price?.sol} SOL/h` : 'missing');
  devPage = await get(`/api/dev/${dev.publicKey.toBase58()}`);
  check('dev page: A is on flipfee, B stays ready-new', kindOf(devPage, A) === 'flipfee' && kindOf(devPage, B) === 'ready-new');

  // ───────── a buyer buys 1 hour ─────────
  const buy = await C.buyTx(conn, { buyer: buyer.publicKey, mint: coinA.publicKey, hours: 1 });
  await send(buy.tx, [buyer], 'buy 1h');
  const b = await waitFor((e) => e.type === 'buy' && e.data.mint === A, 30_000, 'buy');
  check('stream: buy (hours, cost, start/end in ms)', b.data.buyer === buyer.publicKey.toBase58() && b.data.hours === 1 && b.data.paid.lamports === String(price) && b.data.end - b.data.start === 3_600_000, JSON.stringify({ hours: b.data.hours, paid: b.data.paid, toOwner: b.data.toOwner }));
  await waitFor((e) => e.type === 'window' && e.data.mint === A && e.data.windows?.length, 30_000, 'window');
  // the coin is followed (its curve's logs) before the trades
  for (let i = 0; i < 40 && !(await get(`/api/coin/${A}`)).coin.tracked; i++) await sleep(250);
  board = await get('/api/board');
  row = board.live.find((c) => c.mint === A);
  check('board: the buyer holds the live window; this hour goes to the buyer', row?.flipfee?.windows?.[0]?.holder === buyer.publicKey.toBase58() && row.thisHour?.kind === 'holder' && row.thisHour.to === buyer.publicKey.toBase58());

  // ───────── trades during the hour: exact creator fees ─────────
  const sc = C.findSharingConfigPda(coinA.publicKey)[0];
  const done = [];
  for (let i = 0; i < 4; i++) done.push(await trade(i % 2 === 0, sc, 30_000_000_000_000n, `trade ${i}`));
  for (const d of done.filter((x) => x.vaultGained > 0)) {
    const e = await waitFor((x) => x.type === 'trade' && x.data.sig === d.sig, 20_000, `trade ${d.sig.slice(0, 8)}`).catch(() => null);
    check(`stream: trade ${d.sig.slice(0, 8)} with the exact creator fee`, e && Number(e.data.fee.lamports) === d.vaultGained, e ? `fee ${e.data.fee.lamports} = vault +${d.vaultGained}${d.created ? ' (+ rent of the new vault)' : ''}; to ${e.data.to?.kind}` : 'missing');
  }
  const tradesSeen = events.filter((e) => e.type === 'trade' && e.data.mint === A);
  check('trades during the hour are marked for the holder', tradesSeen.length > 0 && tradesSeen.every((e) => e.data.to?.kind === 'holder'));

  // ───────── the hosted keeper distributes and cranks ─────────
  const paid = await waitFor((e) => e.type === 'paid' && e.data.mint === A && e.data.kind === 'holder', 90_000, 'paid to the holder');
  const synced = events.find((e) => e.type === 'fee' && e.data.mint === A);
  check('stream: fee (FeesSynced) and paid to the holder', !!synced && paid.data.to === buyer.publicKey.toBase58() && Number(paid.data.amount.lamports) > 0, `synced ${synced?.data.amount.sol} SOL, paid ${paid.data.amount.sol} SOL`);
  await sleep(1500);
  const me = await get(`/api/me/${buyer.publicKey.toBase58()}`);
  check('Me: the buyer’s live hour, what it earned, what was received', me.hours[0]?.mint === A && me.hours[0].state === 'live' && Number(me.hours[0].earned.lamports) > 0 && Number(me.totals.received.lamports) > 0 && me.totals.spent.lamports === String(price), JSON.stringify({ earned: me.hours[0]?.earned, received: me.totals.received, spent: me.totals.spent }));
  const meDev = await get(`/api/me/${dev.publicKey.toBase58()}`);
  check('Me (dev): the coin and the 95% of the sale', meDev.coins[0]?.mint === A && meDev.totals.devSales.lamports === String((price * 95n) / 100n), JSON.stringify(meDev.totals));
  const stats = (await get('/api/board')).stats;
  check('ticker: hours sold, paid to buyers, paid to devs today', stats.hoursSoldToday === 1 && Number(stats.paidBuyersToday.lamports) > 0 && Number(stats.paidDevsToday.lamports) >= Number((price * 95n) / 100n), JSON.stringify({ hours: stats.hoursSoldToday, buyers: stats.paidBuyersToday.sol, devs: stats.paidDevsToday.sol, feesHour: stats.feesHour.sol }));
  const page = await get(`/api/coin/${A}`);
  const live = page.timeline.segments.find((s) => s.state === 'live' && s.kind === 'holder');
  check('coin page: trades with fees, the live hour on the timeline', page.trades.length >= tradesSeen.length && live?.holder === buyer.publicKey.toBase58() && page.coin.fees.m10.exact === false, `${page.trades.length} trades, live ${live?.holderShort}`);
  check('coin page: fees of the last 10 minutes match the trades we saw', Number(page.coin.fees.m10.lamports) === tradesSeen.reduce((s, e) => s + Number(e.data.fee.lamports), 0));
  if (process.env.OUT_DIR) {
    // examples of every API shape, from this run
    mkdirSync(process.env.OUT_DIR, { recursive: true });
    const keep = (name, v) => writeFileSync(join(process.env.OUT_DIR, `${name}.json`), JSON.stringify(v, null, 1));
    keep('board', await get('/api/board'));
    keep('coin', page);
    keep('me-buyer', me);
    keep('me-dev', meDev);
    keep('dev', await get(`/api/dev/${dev.publicKey.toBase58()}`));
    const byType = {};
    for (const e of events) byType[e.type] ??= e.data;
    keep('stream', byType);
  }
  const health = await get('/health');
  check('health: keeper hosted and acting, index loaded, trade feed connected', health.keeper.on && health.keeper.lines > 0 && health.index.loaded && health.rpcLoad.tradesWs.connected, JSON.stringify({ keeper: health.keeper.last, http: health.rpcLoad.http.requests }));
  ac.abort();
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error('ERROR', e?.stack ?? e);
}
await cleanup();
const bad = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - bad.length}/${checks.length} checks passed${failed ? ' (the run stopped on an error)' : ''}`);
for (const c of bad) console.log(`  FAIL ${c.name} ${c.detail}`);
process.exit(failed || bad.length ? 1 : 0);
void readdirSync, void resolve, void SERVER_ROOT;
