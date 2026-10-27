#!/usr/bin/env node
// End to end on a local validator (DESIGN.md §3, app): the program builder's setup — flipfee
// (program/target/deploy/flipfee.so) next to the mainnet binaries of pump, pump_amm, pump_fees and mayhem and the
// mainnet accounts they read (program/fixtures/mainnet) — the flipfee server on it (with its keeper), and this app built
// for localnet. Playwright drives real Phantom-shaped wallets (scripts/phantom-stub.js with funded local keys):
//   1. a dev connects its new pump coin in one transaction (create fee-sharing config + split → vault + register)
//   2. a trader buys 1 hour in one transaction (pump distribute + buy) and the board shows the hour
//   3. trades during the hour; the keeper distributes and cranks; SOL lands in the buyer's wallet (toast + balance)
//   4. the dev changes the price (set_terms)
// Every transaction goes to the local validator only. Ports: RPC 48899 (+ws 48900), faucet 49900, gossip 48001,
// 48002-48050; server 5492; app 5173. Screens: .shots/localnet-*.png.
//
//   node scripts/localnet.mjs [--keep] (needs `anchor build` and `npm run build:client` in flipfee/program)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './pw.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
const PROGRAM = join(APP, '..', 'program');
const SERVER = join(APP, '..', 'server');
const KEEP = process.argv.includes('--keep');
const RPC = 'http://127.0.0.1:48899';
const API_PORT = 5492;
const APP_URL = 'http://127.0.0.1:5173';
const SHOTS = join(APP, '.shots');
mkdirSync(SHOTS, { recursive: true });

const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  if (!ok) failed++;
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  · ' + detail : ''}`);
};

// web3.js and the client come from the program workspace (where they are installed)
const { createRequire } = await import('node:module');
const req = createRequire(join(PROGRAM, 'package.json'));
const web3 = req('@solana/web3.js');
const { Connection, Keypair, LAMPORTS_PER_SOL } = web3;
const ff = await import(join(PROGRAM, 'client', 'dist', 'index.js'));
const manifest = JSON.parse(readFileSync(join(PROGRAM, 'fixtures/mainnet/manifest.json'), 'utf8'));
const rc = { feeRecipient: manifest.roles.feeRecipients[0], buybackFeeRecipient: manifest.roles.buybackFeeRecipients[0] };
const conn = new Connection(RPC, 'confirmed');

const work = mkdtempSync(join(tmpdir(), 'flipfee-app-localnet-'));
const procs = [];
function stopAll() {
  for (const p of procs.reverse()) {
    try {
      p.kill('SIGTERM');
    } catch {
      // gone already
    }
  }
  if (!KEEP) rmSync(work, { recursive: true, force: true });
}
process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});

const authority = Keypair.generate();
const treasury = Keypair.generate();
const dev = Keypair.generate();
const buyer = Keypair.generate();
const trader = Keypair.generate();
const keeperKey = Keypair.generate();
const T = 1_000_000_000_000n;

async function waitSig(sig) {
  for (let i = 0; i < 160; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw Object.assign(new Error('tx failed ' + sig), { err: st.err });
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return;
    await sleep(250);
  }
  throw new Error('tx timeout ' + sig);
}
async function send(ixs, payer, signers = [], units = 600_000) {
  const tx = await ff.buildTx(conn, payer.publicKey, ixs, units);
  const uniq = [payer, ...signers].filter((s, i, a) => a.findIndex((x) => x.publicKey.equals(s.publicKey)) === i);
  tx.sign(...uniq);
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  await waitSig(sig);
  return sig;
}
async function airdrop(k, sol) {
  await waitSig(await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL));
}
async function curveBuy(who, mint, amount) {
  const curve = await ff.fetchBondingCurve(conn, mint);
  return send(
    [
      ff.createAtaIdempotentIx({ payer: who.publicKey, owner: who.publicKey, mint, tokenProgram: ff.TOKEN_2022_PROGRAM_ID }),
      ff.pumpBuyV2Ix({ rc, mint, user: who.publicKey, curveCreator: curve.creator, amount, maxSolCost: 200n * BigInt(LAMPORTS_PER_SOL) }),
    ],
    who,
  );
}
async function curveSell(who, mint, amount) {
  const curve = await ff.fetchBondingCurve(conn, mint);
  return send([ff.pumpSellV2Ix({ rc, mint, user: who.publicKey, curveCreator: curve.creator, amount, minSolOutput: 0n })], who);
}
const seedOf = (k) => Buffer.from(k.secretKey.slice(0, 32)).toString('base64');
const lamports = async (k) => BigInt(await conn.getBalance(k.publicKey, 'confirmed'));

async function waitHttp(url, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = await fetch(url).then((r) => r.status < 500).catch(() => false);
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

let browser = null;
try {
  // ───────── 1. the validator ─────────
  const bin = join(homedir(), '.local/share/solana/install/active_release/bin/solana-test-validator');
  const so = join(PROGRAM, 'target/deploy/flipfee.so');
  for (const f of [bin, so]) if (!existsSync(f)) throw new Error('missing ' + f);
  const args = ['--reset', '--quiet', '--ledger', join(work, 'ledger'), '--bind-address', '127.0.0.1', '--rpc-port', '48899', '--faucet-port', '49900', '--gossip-port', '48001', '--dynamic-port-range', '48002-48050', '--faucet-sol', '1000000'];
  args.push('--upgradeable-program', ff.FLIPFEE_PROGRAM_ID.toBase58(), so, authority.publicKey.toBase58());
  for (const [name, p] of Object.entries(manifest.programs)) args.push('--upgradeable-program', p.id, join(PROGRAM, 'fixtures/mainnet/programs', `${name}.so`), 'none');
  args.push('--account-dir', join(PROGRAM, 'fixtures/mainnet/accounts'));
  const vlog = openSync(join(work, 'validator.log'), 'a');
  const validator = spawn(bin, args, { stdio: ['ignore', vlog, vlog] });
  procs.push(validator);
  say('validator starting…');
  for (let i = 0; i < 240; i++) {
    if ((await conn.getSlot().catch(() => 0)) > 1) break;
    await sleep(500);
  }
  check('local validator up', (await conn.getSlot().catch(() => 0)) > 1, RPC);

  // ───────── 2. the chain state: config, a dev's new pump coin, some trades ─────────
  await Promise.all([authority, treasury, dev, buyer, trader, keeperKey].map((k) => airdrop(k, 500)));
  await send([ff.initializeIx({ authority: authority.publicKey, treasury: treasury.publicKey, feeBps: 500 })], authority);
  const mintKp = Keypair.generate();
  await send([ff.pumpCreateV2Ix({ mint: mintKp.publicKey, user: dev.publicKey, creator: dev.publicKey, name: 'Flip Lake', symbol: 'LAKE', uri: 'https://flipfee.test/lake.json' })], dev, [mintKp]);
  const mint = mintKp.publicKey;
  await curveBuy(trader, mint, 3n * T);
  const e0 = await ff.eligibility(conn, mint, dev.publicKey);
  check('a dev coin ready to connect', e0.kind === 'ready-new', `${mint.toBase58().slice(0, 8)} · ${e0.kind}`);

  // ───────── 3. the server (with its keeper) ─────────
  const keeperFile = join(work, 'keeper.json');
  writeFileSync(keeperFile, JSON.stringify([...keeperKey.secretKey]), { mode: 0o600 });
  const slog = openSync(join(work, 'server.log'), 'a');
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
    cwd: SERVER,
    env: { ...process.env, SOLANA_CLUSTER: 'localnet', RPC_URL: RPC, PORT: String(API_PORT), HOST: '127.0.0.1', DB_PATH: join(work, 'server.sqlite'), KEEPER: '1', KEEPER_KEYPAIR_FILE: keeperFile, KEEPER_INTERVAL_MS: '8000', INDEX_POLL_MS: '5000', LOG_QUIET: '1' },
    stdio: ['ignore', slog, slog],
  });
  procs.push(server);
  check('flipfee server on localnet', await waitHttp(`http://127.0.0.1:${API_PORT}/api/health`), `:${API_PORT}`);

  // ───────── 4. the app, built for localnet ─────────
  const env = { ...process.env, VITE_SOLANA_CLUSTER: 'localnet', VITE_RPC_URL: RPC, FLIPFEE_API: `http://127.0.0.1:${API_PORT}` };
  const VITE = join(APP, 'node_modules/vite/bin/vite.js');
  const b = spawnSync(process.execPath, [VITE, 'build', '--outDir', join(work, 'app-dist'), '--emptyOutDir'], { cwd: APP, env, encoding: 'utf8' });
  check('app builds for localnet', b.status === 0, b.status === 0 ? '' : (b.stderr || b.stdout).slice(-400));
  const plog = openSync(join(work, 'preview.log'), 'a');
  const preview = spawn(process.execPath, [VITE, 'preview', '--outDir', join(work, 'app-dist'), '--port', '5173', '--strictPort', '--host', '127.0.0.1'], { cwd: APP, env, stdio: ['ignore', plog, plog] });
  procs.push(preview);
  check('app served', await waitHttp(APP_URL + '/'), APP_URL);

  // ───────── 5. Playwright: dev connect → buy 1h → cash lands → set price ─────────
  browser = await launch();
  const STUB = readFileSync(join(APP, 'scripts/phantom-stub.js'), 'utf8');
  const wallet = async (key, phone = false) => {
    const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(({ seed, rpc }) => {
      window.__ffStubSeed = seed;
      window.__ffTestRpc = rpc;
    }, { seed: seedOf(key), rpc: RPC });
    await ctx.addInitScript(STUB);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|net::ERR|status of 4\d\d/.test(m.text()) && errors.push(m.text()));
    return { ctx, page, errors };
  };

  // the dev
  const D = await wallet(dev);
  await D.page.goto(APP_URL + '/dev', { waitUntil: 'domcontentloaded' });
  await D.page.click('[data-testid=dev-connect-wallet]');
  const addr = await D.page.waitForFunction(() => window.__ffTestWallet?.address, null, { timeout: 8000 }).then((h) => h.jsonValue());
  check('Phantom (stub) holds the dev key', addr === dev.publicKey.toBase58(), addr);
  const row = `[data-testid=dev-row][data-mint="${mint.toBase58()}"]`;
  const listed = await D.page.waitForSelector(row, { timeout: 30000 }).then(() => true).catch(() => false);
  const elig = listed ? await D.page.locator(row).getAttribute('data-elig') : '';
  check('dev page lists the coin as ready', listed && elig === 'ready-new', elig);
  if (listed) {
    await D.page.locator(`${row} [data-testid=dev-connect]`).click();
    await D.page.waitForSelector('[data-testid=connect-body]', { timeout: 8000 });
    await D.page.locator('[data-testid=connect-price]').fill('0.05');
    await sleep(400);
    await D.page.screenshot({ path: join(SHOTS, 'localnet-connect-sheet.png') });
    await D.page.click('[data-testid=connect-go]');
    const done = await D.page.waitForSelector('[data-testid=connect-done]', { timeout: 60000 }).then(() => true).catch(() => false);
    const err = done ? '' : await D.page.locator('[data-testid=tx-error]').textContent().catch(() => '');
    const coin = await ff.fetchCoin(conn, mint).catch(() => null);
    check('dev connect: one transaction, the coin is on flipfee', done && !!coin && coin.owner.equals(dev.publicKey) && coin.price === 50_000_000n, done ? `price ${coin?.price} · max ahead ${coin?.maxAhead}s` : err);
    const e1 = await ff.eligibility(conn, mint, dev.publicKey);
    check('pump.fun split points 100% to the vault (admin revoked)', e1.kind === 'flipfee' && e1.sharing?.adminRevoked === true && e1.sharing?.shareholders?.[0]?.address.equals(e1.vault), e1.kind);
    await sleep(600);
    await D.page.screenshot({ path: join(SHOTS, 'localnet-connect-done.png') });
  }

  // the buyer
  const B = await wallet(buyer);
  await B.page.goto(APP_URL + '/', { waitUntil: 'domcontentloaded' });
  await B.page.click('[data-testid=connect]');
  await B.page.waitForSelector('[data-testid=wallet-pill]', { timeout: 8000 });
  const lrow = `[data-testid=live-row][data-mint="${mint.toBase58()}"]`;
  let onBoard = false;
  for (let i = 0; i < 40 && !onBoard; i++) {
    onBoard = (await B.page.locator(lrow).count()) > 0;
    if (!onBoard) {
      await sleep(1500);
      if (i % 6 === 5) await B.page.reload({ waitUntil: 'domcontentloaded' });
    }
  }
  check('the board lists the live coin', onBoard);
  if (onBoard) {
    const b0 = await lamports(buyer);
    const d0 = await lamports(dev);
    await B.page.locator(`${lrow} [data-testid=buy-1h]`).click();
    const done = await B.page.waitForSelector('[data-testid=buy-done]', { timeout: 60000 }).then(() => true).catch(() => false);
    const err = done ? '' : await B.page.locator('[data-testid=tx-error]').textContent().catch(() => '');
    const coin = await ff.fetchCoin(conn, mint);
    const w = coin.windows.find((x) => x.holder.equals(buyer.publicKey));
    check('buy 1h: one transaction, the window is the buyer’s', done && !!w && w.end - w.start === 3600, done ? `window ${w?.start}→${w?.end}` : err);
    const paid = b0 - (await lamports(buyer));
    const toDev = (await lamports(dev)) - d0;
    check('the buyer paid the price, the dev got 95% at once', paid >= 50_000_000n && toDev === 47_500_000n, `buyer −${paid} · dev +${toDev} lamports`);
    await sleep(600);
    await B.page.screenshot({ path: join(SHOTS, 'localnet-buy-done.png') });
    await B.page.keyboard.press('Escape');
    const mine = await B.page.waitForSelector(`${lrow}.is-me, ${lrow} .is-me`, { timeout: 20000 }).then(() => true).catch(() => false);
    check('the board shows the hour as mine', mine);

    // trades during the hour; the keeper (in the server) distributes and cranks every 8 s
    const r0 = await lamports(buyer);
    const v0 = await B.page.locator(`${lrow} [data-testid=row-this-hour]`).getAttribute('data-value');
    for (let i = 0; i < 3; i++) {
      await curveBuy(trader, mint, 2n * T);
      await curveSell(trader, mint, T);
    }
    let v1 = v0;
    for (let i = 0; i < 30 && v1 === v0; i++) {
      await sleep(500);
      v1 = await B.page.locator(`${lrow} [data-testid=row-this-hour]`).getAttribute('data-value');
    }
    check('trades flip "this hour" on the row (exact creator fees from the stream)', v1 !== v0, `${v0} → ${v1}`);
    const landed = await B.page.waitForSelector('[data-testid=toast][data-kind=cash]', { timeout: 60000 }).then((e) => e.textContent()).catch(() => '');
    const got = (await lamports(buyer)) - r0;
    check('cash lands: the keeper paid the buyer (toast + balance)', !!landed && got > 0n, `${(landed ?? '').replace(/\s+/g, ' ').slice(0, 50)} · +${got} lamports`);
    await B.page.screenshot({ path: join(SHOTS, 'localnet-cash.png') });
    await B.page.goto(APP_URL + '/me', { waitUntil: 'domcontentloaded' });
    const me = await B.page.waitForSelector('[data-testid=my-hour]', { timeout: 15000 }).then(() => true).catch(() => false);
    check('Me lists the hour', me);
    await sleep(800);
    await B.page.screenshot({ path: join(SHOTS, 'localnet-me.png') });
    await B.page.goto(APP_URL + '/c/' + mint.toBase58(), { waitUntil: 'domcontentloaded' });
    await B.page.waitForSelector('[data-testid=departures] li', { timeout: 15000 }).catch(() => null);
    await sleep(1200);
    await B.page.screenshot({ path: join(SHOTS, 'localnet-coin.png'), fullPage: true });
    check('no page errors (buyer)', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
  }

  // the dev changes the price
  await D.page.goto(APP_URL + '/dev', { waitUntil: 'domcontentloaded' });
  const dash = `[data-testid=dashboard][data-mint="${mint.toBase58()}"]`;
  const hasDash = await D.page.waitForSelector(dash, { timeout: 30000 }).then(() => true).catch(() => false);
  check('dev dashboard for the live coin', hasDash);
  if (hasDash) {
    await D.page.locator(`${dash} [data-testid=dash-price]`).fill('0.08');
    await D.page.click(`${dash} [data-testid=dash-save]`);
    const saved = await D.page.waitForSelector('[data-testid=toast]:has-text("Saved")', { timeout: 60000 }).then(() => true).catch(() => false);
    const coin = await ff.fetchCoin(conn, mint);
    check('set price: one transaction (set_terms)', saved && coin.price === 80_000_000n, `price ${coin.price}`);
    await sleep(800);
    await D.page.screenshot({ path: join(SHOTS, 'localnet-dashboard.png'), fullPage: true });
  }
  check('no page errors (dev)', D.errors.length === 0, D.errors.slice(0, 3).join(' | '));
} catch (e) {
  check('localnet run', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await browser?.close().catch(() => null);
  writeFileSync(join(SHOTS, 'e2e-results-localnet.json'), JSON.stringify({ at: new Date().toISOString(), work: KEEP ? work : null, results }, null, 2));
  if (KEEP) say('kept', work);
  stopAll();
}
say(`${results.length - failed}/${results.length} checks passed (localnet)`);
process.exit(failed ? 1 : 0);
