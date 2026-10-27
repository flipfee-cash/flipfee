#!/usr/bin/env node
// Playwright flows for flipfee (DESIGN.md §3), with a Phantom-compatible provider (scripts/phantom-stub.js) backed by
// a local ed25519 key. Screens at 1440 and 390 go to .shots/e2e-*.png.
//
//   fixture  (default) the dev server with the synthetic world: watch, connect + sign in, want, share, buy 1h, see
//            cash land, dev connect + set price, Me, errors, no Phantom, the empty board, reduced motion
//   server   the real server (read-only mainnet data): watch, connect + sign in, want, share, coin, dev, Me. No
//            transactions are sent (the stub refuses to send on this mode).
//   localnet the program builder's local validator + the server on it: buy 1h and dev connect end to end
//            (--seed=<base64 32-byte seed of a funded key>, --rpc=http://127.0.0.1:8899)
//
//   npm run dev:fixture &   node scripts/e2e.mjs [--base=http://127.0.0.1:5197] [--mode=fixture] [--only=desk|phone]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { launch } from './pw.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => (a.startsWith('--') ? a.slice(2).split('=') : [a, true])).map(([k, v]) => [k, v ?? true]));
const BASE = (args.base || process.env.BASE || 'http://127.0.0.1:5197').replace(/\/$/, '');
const MODE = args.mode || 'fixture';
const ONLY = args.only || '';
const SHOTS = new URL('../.shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const STUB = readFileSync(new URL('./phantom-stub.js', import.meta.url), 'utf8');

const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  · ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DESK = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };

/** The exact connect-sheet lines (DESIGN.md §1.5). */
const CONNECT_LINES = [
  'Your coin’s fees go to flipfee from now on.',
  'You get every fee outside sold hours. It lands in your wallet.',
  'Buyers pay you for each hour. You get 95%.',
  'pump.fun allows one fee split per coin. This step is final.',
];

async function newCtx(browser, phone, { stub = true, cookie = '', reduced = false, seed = '', signIn = false } = {}) {
  const ctx = await browser.newContext({ ...(phone ? PHONE : DESK), reducedMotion: reduced ? 'reduce' : 'no-preference', permissions: ['clipboard-read', 'clipboard-write'] });
  if (cookie) {
    const [k, v] = cookie.split('=');
    await ctx.addCookies([{ name: k, value: v, url: BASE }]);
  }
  if (stub) {
    await ctx.addInitScript(
      ({ seed, rpc, signIn }) => {
        if (seed) window.__ffStubSeed = seed;
        if (rpc) window.__ffTestRpc = rpc;
        if (signIn) window.__ffStubSignIn = true;
      },
      { seed, rpc: MODE === 'localnet' ? args.rpc || 'http://127.0.0.1:8899' : MODE === 'server' ? 'http://127.0.0.1:1/refuse' : '', signIn },
    );
    await ctx.addInitScript(STUB);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // the browser's own network notes (a 4xx we asked for, an image CDN) are not app errors
    if (/Failed to load resource|net::ERR|status of 4\d\d/.test(t)) return;
    errors.push(t);
  });
  return { ctx, page, errors };
}

const shot = (page, name, full = false) => page.screenshot({ path: `${SHOTS}e2e-${MODE === 'fixture' ? '' : MODE + '-'}${name}.png`, fullPage: full });
/** Elements inside `sel` that stick out past the right edge of the screen (a phone layout bug). */
const overflowIn = (page, sel) =>
  page.evaluate((sel) => {
    const out = [];
    for (const root of document.querySelectorAll(sel)) for (const el of root.querySelectorAll('*')) if (el.getBoundingClientRect().right > innerWidth + 1) out.push(typeof el.className === 'string' ? el.className : el.tagName);
    return out;
  }, sel);
const tap = (page, phone, sel) => (phone ? page.locator(sel).first().tap() : page.locator(sel).first().click());

async function boardData() {
  const r = await fetch(BASE + '/api/board').catch(() => null);
  return r && r.ok ? r.json() : null;
}

async function watch(browser, label, phone) {
  const { ctx, page, errors } = await newCtx(browser, phone);
  const t0 = Date.now();
  await page.goto(BASE + '/', { waitUntil: 'commit' });
  let firstMs = -1;
  try {
    await page.waitForSelector('[data-testid=ticker], [data-testid=live-row], [data-testid=hot-row]', { timeout: 8000 });
    firstMs = Date.now() - t0;
  } catch {
    firstMs = -1;
  }
  check(`${label}: first paint of live numbers`, firstMs >= 0 && firstMs < 2500, firstMs >= 0 ? `${firstMs} ms` : 'nothing in 8 s');
  await page.waitForSelector('[data-testid=live-row], [data-testid=live-empty], [data-testid=hot-row]', { timeout: 8000 }).catch(() => null);
  const liveRows = await page.locator('[data-testid=live-row]').count();
  const hotRows = await page.locator('[data-testid=hot-row]').count();
  const emptyLive = await page.locator('[data-testid=live-empty]').count();
  check(`${label}: board rows`, liveRows + hotRows > 0, `${liveRows} live · ${hotRows} hot${emptyLive ? ' · the empty live board' : ''}`);
  const conn = await page
    .waitForFunction(() => document.querySelector('[data-testid=top]')?.getAttribute('data-conn') === 'live', null, { timeout: 8000 })
    .then(() => 'live')
    .catch(async () => page.locator('[data-testid=top]').getAttribute('data-conn'));
  check(`${label}: stream connected`, conn === 'live', conn);
  // numbers move: the counter (or the first row's this-hour) flips within 20 s
  const sel = (await page.locator('[data-testid=counter-total]').count()) ? '[data-testid=counter-total]' : '[data-testid=tk-fees]';
  const v0 = await page.locator(sel).first().getAttribute('data-value');
  const dots0 = await page.locator('.td').count();
  let v1 = v0;
  for (let i = 0; i < 40 && v1 === v0; i++) {
    await sleep(500);
    v1 = await page.locator(sel).first().getAttribute('data-value');
  }
  const dots1 = await page.locator('.td').count();
  check(`${label}: live numbers flip with trades`, v1 !== v0, `${v0} → ${v1}`);
  check(`${label}: trade dots stream in`, dots1 > 0, `${dots0} → ${dots1} dots`);
  if (phone) {
    const sw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    check(`${label}: no sideways scroll`, sw[0] <= sw[1], `${sw[0]} / ${sw[1]}`);
    const bar = await page.locator('[data-testid=bottom-bar]').isVisible();
    const tabs = await page.locator('.tabs [data-tab=live]').isVisible();
    check(`${label}: ${liveRows ? 'tabs and bottom bar' : 'bottom bar (no tabs before the first live coin)'}`, bar && (liveRows ? tabs : !tabs));
    await shot(page, `${label}-board`);
    if (tabs) {
      await page.locator('.tabs [data-tab=hot]').tap();
      await sleep(400);
      await shot(page, `${label}-board-hot`);
      await page.locator('.tabs [data-tab=live]').tap();
    }
  } else {
    await page.mouse.move(2, 2);
    await sleep(300);
    await shot(page, `${label}-board`);
    await shot(page, `${label}-board-full`, true);
  }
  // "Buy an hour" focuses the first live coin
  const buyHero = phone ? '[data-testid=bar-buy]' : '[data-testid=hero-buy]';
  await tap(page, phone, buyHero);
  await sleep(700);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName);
  check(`${label}: "Buy an hour" focuses the first live coin`, liveRows ? focused === 'buy-1h' || focused === 'buy-yours' || focused === 'buy-soldout' : true, focused);
  check(`${label}: no page errors (watch)`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

/** Connect + sign in + want + share (+ buy, cash, dev connect in fixture/localnet). */
async function flows(browser, label, phone) {
  const { ctx, page, errors } = await newCtx(browser, phone, { seed: args.seed || '', signIn: label.endsWith('desk') });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=connect]', { timeout: 8000 });
  await tap(page, phone, '[data-testid=connect]');
  const pill = await page.waitForSelector('[data-testid=wallet-pill]', { timeout: 6000 }).then(() => true).catch(() => false);
  const addr = await page.evaluate(() => window.__ffTestWallet?.address ?? '');
  check(`${label}: Phantom connects in one tap`, pill && !!addr, addr.slice(0, 8));

  // Want on a hot coin: one sign-in signature, then the count goes up
  if (phone && (await page.locator('.tabs [data-tab=hot]').count())) {
    await page.locator('.tabs [data-tab=hot]').tap();
    await sleep(300);
  }
  const hot = page.locator('[data-testid=hot-row]:has([data-testid=want])').first();
  if (await hot.count()) {
    const mint = await hot.getAttribute('data-mint');
    const n0 = Number(await hot.locator('[data-testid=want-count]').getAttribute('data-value'));
    await (phone ? hot.locator('[data-testid=want]').tap() : hot.locator('[data-testid=want]').click());
    const done = await page.waitForFunction((m) => document.querySelector(`[data-testid=hot-row][data-mint="${m}"] [data-testid=want]`)?.getAttribute('aria-pressed') === 'true', mint, { timeout: 10000 }).then(() => true).catch(() => false);
    const n1 = Number(await page.locator(`[data-testid=hot-row][data-mint="${mint}"] [data-testid=want-count]`).getAttribute('data-value'));
    const sig = await page.evaluate(() => (window.__ffTestWallet?.signed ?? 0) + (window.__ffTestWallet?.signIns ?? 0));
    check(`${label}: sign in with one signature`, sig === 1, `${sig} signature(s)${label.endsWith('desk') ? ' (signIn)' : ' (signMessage)'}`);
    check(`${label}: Want counts`, done && n1 >= n0 + 1, `${n0} → ${n1}`);
    await shot(page, `${label}-wanted`);
    // Share copies flipfee.cash/c/<mint>
    if (!phone) {
      await hot.locator('[data-testid=share]').click();
      await sleep(300);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
      check(`${label}: Share copies the coin link`, clip === `https://flipfee.cash/c/${mint}`, clip);
    }
  } else check(`${label}: a hot coin to want`, false, 'no hot rows');
  if (phone && (await page.locator('.tabs [data-tab=live]').count())) {
    await page.locator('.tabs [data-tab=live]').tap();
    await sleep(300);
  }

  // the wallet menu shows the session
  await tap(page, phone, '[data-testid=wallet-pill]');
  const signed = await page.locator('[data-testid=signed-in]').isVisible().catch(() => false);
  check(`${label}: wallet menu shows the session`, signed);
  await sleep(400);
  await shot(page, `${label}-wallet-menu`);
  await page.keyboard.press('Escape');
  await sleep(200);

  if (MODE === 'server') {
    check(`${label}: no page errors (flows)`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
    return;
  }

  // Buy 1h on a coin whose hour starts now (one tap → Phantom)
  const rows = page.locator('[data-testid=live-row]');
  const n = await rows.count();
  // the busiest coin whose hour starts now (rows come sorted by paid last hour), so a payout follows soon
  let target = null;
  for (let i = 0; i < n; i++) {
    const r = rows.nth(i);
    const open = (await r.locator('[data-testid=holder-now]').textContent()) ?? '';
    if ((await r.locator('[data-testid=buy-1h]').count()) && /open now/i.test(open) && !(await r.locator('.hb-next').count())) {
      target = r;
      break;
    }
  }
  if (!target) for (let i = 0; i < n && !target; i++) if (await rows.nth(i).locator('[data-testid=buy-1h]').count()) target = rows.nth(i);
  if (target) {
    const mint = await target.getAttribute('data-mint');
    // a refusal first: the sheet says so in plain words
    await page.evaluate(() => (window.__ffStubReject = 'tx'));
    await (phone ? target.locator('[data-testid=buy-1h]').tap() : target.locator('[data-testid=buy-1h]').click());
    const refused = await page.waitForSelector('[data-testid=tx-error]', { timeout: 10000 }).then((e) => e.textContent()).catch(() => '');
    check(`${label}: a refusal in Phantom shows a plain line`, /Phantom closed the request/.test(refused ?? ''), refused);
    // then the real buy from the same sheet
    const txs0 = await page.evaluate(() => window.__ffTestWallet.txs);
    await tap(page, phone, '[data-testid=buy-go]');
    await page.waitForSelector('[data-testid=tx-steps]', { timeout: 4000 }).catch(() => null);
    await sleep(250);
    if (phone) {
      const o = await overflowIn(page, '.sheet');
      check(`${label}: buy sheet fits the screen`, o.length === 0, o.slice(0, 3).join(', '));
    }
    await shot(page, `${label}-buy-running`);
    const done = await page.waitForSelector('[data-testid=buy-done]', { timeout: 30000 }).then(() => true).catch(() => false);
    const txs1 = await page.evaluate(() => window.__ffTestWallet.txs);
    const err = done ? '' : await page.locator('[data-testid=tx-error]').textContent().catch(() => '');
    check(`${label}: buy 1h (one transaction, confirmed)`, done && txs1 === txs0 + 1, done ? `${mint.slice(0, 6)} · ${txs1 - txs0} tx` : err);
    await sleep(400);
    await shot(page, `${label}-buy-done`);
    // the board shows the hour as mine
    await page.keyboard.press('Escape');
    await sleep(600);
    const mineNow = await page.locator(`[data-testid=live-row][data-mint="${mint}"] .is-me, [data-testid=live-row][data-mint="${mint}"].is-me`).count();
    check(`${label}: the board shows my hour`, mineNow > 0);
    // cash lands: the next crank pays my hour (fixture: every 20 s)
    if (MODE === 'fixture' && !phone) {
      const landed = await page.waitForSelector('[data-testid=toast][data-kind=cash]', { timeout: 50000 }).then((e) => e.textContent()).catch(() => '');
      check(`${label}: cash lands in my wallet (toast)`, !!landed, (landed ?? '').replace(/\s+/g, ' ').slice(0, 60));
      await shot(page, `${label}-cash-landed`);
    }
    // Me: the hour is there
    await page.goto(BASE + '/me', { waitUntil: 'domcontentloaded' });
    const mine = await page.waitForSelector('[data-testid=my-hour]', { timeout: 8000 }).then(() => true).catch(() => false);
    check(`${label}: Me lists my hour`, mine);
    await sleep(800);
    await shot(page, `${label}-me`, !phone);
  } else check(`${label}: a live coin to buy`, false, 'no live rows with Buy');

  // Dev: my coins → Connect (one transaction) → live on the board → change the price
  await page.goto(BASE + '/dev', { waitUntil: 'domcontentloaded' });
  const listed = await page.waitForSelector('[data-testid=dev-row]', { timeout: 15000 }).then(() => true).catch(() => false);
  check(`${label}: dev page lists my coins with eligibility`, listed, listed ? (await page.locator('[data-testid=dev-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-elig')).join(','))) : '');
  await shot(page, `${label}-dev`, !phone);
  const ready = page.locator('[data-testid=dev-row][data-elig^=ready] [data-testid=dev-connect]').first();
  if (await ready.count()) {
    const mint = await page.locator('[data-testid=dev-row][data-elig^=ready]').first().getAttribute('data-mint');
    await (phone ? ready.tap() : ready.click());
    await page.waitForSelector('[data-testid=connect-body]', { timeout: 6000 });
    const lines = await page.locator('[data-testid=connect-lines] li').allTextContents();
    check(`${label}: connect sheet says the four lines`, JSON.stringify(lines) === JSON.stringify(CONNECT_LINES), lines.join(' | '));
    const risk = await page.locator('[data-testid=connect-body] .risk').textContent();
    check(`${label}: connect sheet has the risk line`, risk === 'flipfee is new. Start small.', risk);
    await page.locator('[data-testid=connect-price]').fill('0.25');
    await sleep(500);
    if (phone) {
      const o = await overflowIn(page, '.sheet');
      check(`${label}: connect sheet fits the screen`, o.length === 0, o.slice(0, 3).join(', '));
    }
    await shot(page, `${label}-connect-sheet`);
    const txs0 = await page.evaluate(() => window.__ffTestWallet.txs);
    await tap(page, phone, '[data-testid=connect-go]');
    const done = await page.waitForSelector('[data-testid=connect-done]', { timeout: 30000 }).then(() => true).catch(() => false);
    const txs1 = await page.evaluate(() => window.__ffTestWallet.txs);
    check(`${label}: dev connect (one transaction, confirmed)`, done && txs1 === txs0 + 1, done ? `${txs1 - txs0} tx` : await page.locator('[data-testid=tx-error]').textContent().catch(() => ''));
    await sleep(700);
    await shot(page, `${label}-connect-done`);
    await tap(page, phone, '[data-testid=connect-see]');
    await page.waitForSelector(`[data-testid=coin-page][data-mint="${mint}"][data-live="1"]`, { timeout: 8000 }).catch(() => null);
    const live = await page.locator(`[data-testid=coin-page][data-mint="${mint}"][data-live="1"]`).count();
    check(`${label}: the coin is live after connect`, live === 1);
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    const onBoard = await page.waitForSelector(`[data-testid=live-row][data-mint="${mint}"]`, { timeout: 8000 }).then(() => true).catch(() => false);
    check(`${label}: the board lists the new coin`, onBoard);
    // the dashboard: change the price (set_terms)
    await page.goto(BASE + '/dev', { waitUntil: 'domcontentloaded' });
    const dash = await page.waitForSelector(`[data-testid=dashboard][data-mint="${mint}"]`, { timeout: 10000 }).then(() => true).catch(() => false);
    check(`${label}: dashboard for my live coin`, dash);
    if (phone) {
      const sw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
      check(`${label}: no sideways scroll (dev dashboard)`, sw[0] <= sw[1], `${sw[0]} / ${sw[1]}`);
    }
    if (dash) {
      await page.locator(`[data-testid=dashboard][data-mint="${mint}"] [data-testid=dash-price]`).fill('0.4');
      await tap(page, phone, `[data-testid=dashboard][data-mint="${mint}"] [data-testid=dash-save]`);
      const saved = await page.waitForSelector('[data-testid=toast]:has-text("Saved")', { timeout: 30000 }).then(() => true).catch(() => false);
      check(`${label}: set price (one transaction)`, saved);
      await sleep(500);
      await shot(page, `${label}-dashboard`, !phone);
    }
  } else check(`${label}: a coin ready to connect`, false, 'none in the dev list');
  check(`${label}: no page errors (flows)`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

async function pages(browser, label, phone) {
  const b = await boardData();
  const { ctx, page, errors } = await newCtx(browser, phone);
  const liveMint = b?.live?.[0]?.mint;
  const hotMint = b?.hot?.[0]?.mint;
  if (liveMint) {
    await page.goto(BASE + '/c/' + liveMint, { waitUntil: 'domcontentloaded' });
    const ok = await page.waitForSelector('[data-testid=departures] li', { timeout: 8000 }).then(() => true).catch(() => false);
    const stream = await page.waitForSelector('[data-testid=trade-stream] li', { timeout: 8000 }).then(() => true).catch(() => false);
    const panel = await page.locator('[data-testid=buy-panel]').count();
    check(`${label}: coin page (hours, trades, buy panel)`, ok && stream && panel === 1);
    if (phone) {
      const sw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
      check(`${label}: no sideways scroll (coin)`, sw[0] <= sw[1], `${sw[0]} / ${sw[1]}`);
    }
    await sleep(600);
    await shot(page, `${label}-coin`, !phone);
  }
  if (hotMint) {
    await page.goto(BASE + '/c/' + hotMint, { waitUntil: 'domcontentloaded' });
    const ok = await page.waitForSelector('[data-testid=coin-off], [data-testid=hours]', { timeout: 8000 }).then(() => true).catch(() => false);
    check(`${label}: hot coin page (Want · Share · dev call)`, ok);
    await sleep(500);
    await shot(page, `${label}-coin-hot`, !phone);
  }
  await page.goto(BASE + '/dev', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=dev-connect-wallet]', { timeout: 8000 }).catch(() => null);
  await sleep(500);
  await shot(page, `${label}-dev-pitch`, !phone);
  await page.goto(BASE + '/me', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=me-connect]', { timeout: 8000 }).catch(() => null);
  await shot(page, `${label}-me-connect`);
  await page.goto(BASE + '/c/1111111111111111111111111111111111111111111', { waitUntil: 'domcontentloaded' });
  const missing = await page.waitForSelector('[data-testid=coin-missing]', { timeout: 8000 }).then(() => true).catch(() => false);
  check(`${label}: an unknown coin says so`, missing);
  check(`${label}: no page errors (pages)`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

async function noPhantom(browser, label, phone) {
  const { ctx, page } = await newCtx(browser, phone, { stub: false });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=connect]', { timeout: 8000 });
  await sleep(1400);
  await tap(page, phone, '[data-testid=connect]');
  const link = await page.waitForSelector('[data-testid=phantom-link]', { timeout: 4000 }).then((e) => e.getAttribute('href')).catch(() => null);
  const want = phone ? /^https:\/\/phantom\.app\/ul\/browse\/[^?]+\?ref=/ : /^https:\/\/phantom\.com\//;
  check(`${label}: without Phantom, ${phone ? 'the Phantom browse link' : 'Get Phantom'}`, !!link && want.test(link), link ?? 'no sheet');
  const others = await page.locator('text=/Solflare|Backpack|WalletConnect|MetaMask/i').count();
  check(`${label}: no other wallet anywhere`, others === 0);
  await sleep(300);
  await shot(page, `${label}-no-phantom`);
  await ctx.close();
}

async function emptyBoard(browser, label, phone) {
  const { ctx, page, errors } = await newCtx(browser, phone, { cookie: 'fx=empty' });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const empty = await page.waitForSelector('[data-testid=live-empty]', { timeout: 8000 }).then(() => true).catch(() => false);
  const counter = await page.waitForSelector('[data-testid=counter]', { timeout: 8000 }).then(() => true).catch(() => false);
  const hot = await page.locator('[data-testid=hot-row]').count();
  check(`${label}: empty board leads with hot coins and the dev call`, empty && counter && (phone || hot > 0), `${hot} hot rows`);
  await sleep(1200);
  await shot(page, `${label}-empty`, !phone);
  check(`${label}: no page errors (empty)`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

async function reducedMotion(browser, label) {
  const { ctx, page, errors } = await newCtx(browser, false, { reduced: true });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=counter-total]', { timeout: 8000 }).catch(() => null);
  let flips = 0;
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    flips += await page.locator('.fc.go, .fc.go2').count();
  }
  const v = await page.locator('[data-testid=counter-total]').getAttribute('data-value').catch(() => null);
  check(`${label}: reduced motion — numbers change in place, no flaps`, flips === 0 && !!v, `${flips} flaps seen`);
  check(`${label}: no page errors (reduced)`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

async function down(browser, label) {
  const { ctx, page } = await newCtx(browser, false, { cookie: 'fx=down' });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const msg = await page.waitForSelector('[data-testid=board-down]', { timeout: 15000 }).then(() => true).catch(() => false);
  check(`${label}: a server failure says so (board)`, msg);
  await shot(page, `${label}-down`);
  await ctx.close();
}

const browser = await launch();
try {
  const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
  console.log('server:', health ? JSON.stringify({ ok: health.ok, fixture: health.fixture, cluster: health.cluster, programId: health.programId }) : 'down');
  for (const [label, phone] of [
    ['desk', false],
    ['phone', true],
  ]) {
    if (ONLY && ONLY !== label) continue;
    await watch(browser, label, phone);
    await pages(browser, label, phone);
    await noPhantom(browser, label, phone);
    if (!args['shots-only']) await flows(browser, label, phone);
    if (MODE === 'fixture') await emptyBoard(browser, label, phone);
  }
  if (MODE === 'fixture' && ONLY !== 'phone') {
    await reducedMotion(browser, 'desk');
    await down(browser, 'desk');
  }
} finally {
  await browser.close();
}
writeFileSync(`${SHOTS}e2e-results-${MODE}.json`, JSON.stringify({ base: BASE, mode: MODE, at: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} checks passed (${MODE})`);
process.exit(failed ? 1 : 0);
