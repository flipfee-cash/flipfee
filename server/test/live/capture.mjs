// Read-only mainnet capture: finds real pump.fun curve trades and PumpSwap trades, decodes their events and checks
// the decoded creator fee against what the chain itself moved in the same transaction:
//   curve: the lamports the creator vault PDA ["creator-vault", creator] gained == TradeEvent.creator_fee
//   PumpSwap: the quote tokens the coin creator vault ATA (owner PDA ["creator_vault", coin_creator]) gained
//             == coin_creator_fee
// Writes the checked transactions to test/fixtures/creator-fees.json (the unit tests decode them offline).
//   node test/live/capture.mjs [RPC_URL]
import { writeFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { creatorVaultOf, curveTrade, decodeSwapEvent, decodeTradeEvent, forProgramData, isSolQuote, PUMP_PROGRAM, PUMPSWAP_PROGRAM, sharingConfigOf, swapTrade, WSOL_MINT } from '../../src/ingest/pumpevents.js';

const RPC = process.argv[2] || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
async function rpc(method, params) {
  for (let i = 0; i < 6; i++) {
    calls++;
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) {
      await sleep(2_000 * (i + 1));
      continue;
    }
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
    await sleep(250);
    return j.result;
  }
  throw new Error(`${method}: rate limited`);
}

const ammVaultAuthority = (coinCreator) => PublicKey.findProgramAddressSync([Buffer.from('creator_vault'), new PublicKey(coinCreator).toBuffer()], new PublicKey(PUMPSWAP_PROGRAM))[0].toBase58();

function keysOf(tx) {
  const m = tx.transaction.message;
  const keys = (m.accountKeys ?? m.staticAccountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey ?? k.toString()));
  const loaded = tx.meta?.loadedAddresses ?? {};
  return [...keys, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
}

function lamportDelta(tx, address) {
  const keys = keysOf(tx);
  const i = keys.indexOf(address);
  if (i < 0) return null;
  return tx.meta.postBalances[i] - tx.meta.preBalances[i];
}

function tokenDelta(tx, owner, mint) {
  const amt = (list) => {
    const e = (list ?? []).find((b) => b.owner === owner && b.mint === mint);
    return e ? BigInt(e.uiTokenAmount.amount) : null;
  };
  const pre = amt(tx.meta.preTokenBalances);
  const post = amt(tx.meta.postTokenBalances);
  if (post === null) return null;
  return Number(post - (pre ?? 0n));
}

async function txs(address, limit = 25) {
  const sigs = await rpc('getSignaturesForAddress', [address, { limit }]);
  const out = [];
  for (const s of sigs.filter((x) => !x.err).slice(0, limit)) {
    const tx = await rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    if (tx?.meta && !tx.meta.err) out.push({ sig: s.signature, tx });
  }
  return out;
}

const found = { curveBuy: null, curveSell: null, curveShared: null, curveZeroFee: null, ammBuy: null, ammSell: null, curveOtherQuote: null };
const checks = [];

function checkCurve(sig, tx) {
  const logs = tx.meta.logMessages;
  forProgramData(logs, PUMP_PROGRAM, (buf) => {
    const ev = decodeTradeEvent(buf);
    if (!ev) return;
    const t = curveTrade(ev);
    let gained = null;
    if (t.solQuote) gained = lamportDelta(tx, creatorVaultOf(ev.creator));
    const ok = gained === null ? null : gained === ev.creatorFee;
    const rate = ev.solAmount ? (ev.creatorFee / ev.solAmount) * 1e4 : null;
    checks.push({ venue: 'curve', sig, mint: ev.mint, isBuy: ev.isBuy, sol: ev.solAmount, creatorFee: ev.creatorFee, bps: ev.creatorFeeBasisPoints, rateBps: rate && Number(rate.toFixed(2)), vaultGained: gained, ok, quote: ev.quoteMint, ix: ev.ixName, shareholders: ev.shareholders?.length ?? null, creator: ev.creator });
    const rec = { sig, logs, mint: ev.mint, creator: ev.creator, creatorFee: ev.creatorFee, vaultGained: gained, slot: tx.slot, blockTime: tx.blockTime };
    if (!t.solQuote) found.curveOtherQuote ??= rec;
    else if (ev.shareholders?.length && ev.creator === sharingConfigOf(ev.mint)) found.curveShared ??= rec;
    else if (ok && !ev.creatorFee) found.curveZeroFee ??= rec;
    else if (ok && ev.isBuy) found.curveBuy ??= rec;
    else if (ok && !ev.isBuy) found.curveSell ??= rec;
  });
}

function checkSwap(sig, tx, pool, mint, quoteMint) {
  const logs = tx.meta.logMessages;
  forProgramData(logs, PUMPSWAP_PROGRAM, (buf) => {
    const ev = decodeSwapEvent(buf);
    if (!ev || ev.pool !== pool) return;
    const t = swapTrade(ev, mint, quoteMint);
    const gained = ev.coinCreator ? tokenDelta(tx, ammVaultAuthority(ev.coinCreator), quoteMint) : null;
    const ok = gained === null ? null : gained === ev.coinCreatorFee;
    checks.push({ venue: 'amm', sig, pool, isBuy: ev.isBuy, quote: ev.quoteAmount, creatorFee: ev.coinCreatorFee, bps: ev.coinCreatorFeeBasisPoints, rateBps: ev.quoteAmount ? Number(((ev.coinCreatorFee / ev.quoteAmount) * 1e4).toFixed(2)) : null, vaultGained: gained, ok, coinCreator: ev.coinCreator, tradeLamports: t.lamports });
    const rec = { sig, logs, pool, mint, quoteMint, coinCreator: ev.coinCreator, creatorFee: ev.coinCreatorFee, vaultGained: gained, slot: tx.slot, blockTime: tx.blockTime };
    if (ok && ev.isBuy) found.ammBuy ??= rec;
    else if (ok && !ev.isBuy) found.ammSell ??= rec;
  });
}

// 1. recent pump.fun coins on the curve, and big graduated ones (PumpSwap pools), from pump.fun's own lists
const pf = async (q) => (await fetch(`https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&${q}&includeNsfw=false`, { headers: { 'user-agent': 'flipfee-capture/0.1' } })).json();
const recent = await pf('sort=last_trade_timestamp&order=DESC');
const top = await pf('sort=market_cap&order=DESC');
const onCurve = recent.filter((c) => !c.complete && c.bonding_curve).slice(0, 4);
const graduated = top.filter((c) => c.complete && c.pump_swap_pool && (c.quote_mint === '11111111111111111111111111111111' || !c.quote_mint)).slice(0, 4);
for (const c of onCurve) {
  for (const { sig, tx } of await txs(c.bonding_curve, 6)) checkCurve(sig, tx);
  if (found.curveBuy && found.curveSell) break;
}
for (const c of graduated) {
  for (const { sig, tx } of await txs(c.pump_swap_pool, found.ammBuy ? 25 : 8)) {
    if (found.ammBuy && !tx.meta.logMessages.some((l) => l.includes('Instruction: Sell'))) continue;
    checkSwap(sig, tx, c.pump_swap_pool, c.mint, WSOL_MINT);
  }
  if (found.ammBuy && found.ammSell) break;
}
// 2. a coin with fee sharing: among recently traded coins, the ones whose sharing_config PDA exists (one
//    getMultipleAccounts call); their trades name the config as the creator and list the shareholders
const pool = [...recent, ...(await pf('sort=created_timestamp&order=DESC'))].filter((c) => c.bonding_curve);
const cfgs = pool.map((c) => sharingConfigOf(c.mint));
const infos = [];
for (let i = 0; i < cfgs.length; i += 100) infos.push(...(await rpc('getMultipleAccounts', [cfgs.slice(i, i + 100), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }])).value);
const shared = pool.filter((c, i) => infos[i]);
console.log(`coins with a sharing config: ${shared.length} of ${pool.length}`);
for (const c of shared.slice(0, 6)) {
  if (found.curveShared) break;
  for (const { sig, tx } of await txs(c.bonding_curve, 4)) checkCurve(sig, tx);
}

console.table(checks.slice(-12).map((c) => ({ venue: c.venue, buy: c.isBuy, size: c.sol ?? c.quote, fee: c.creatorFee, bps: c.bps, rateBps: c.rateBps, vault: c.vaultGained, ok: c.ok, holders: c.shareholders })));
const bad = checks.filter((c) => c.ok === false);
console.log(`checked ${checks.length} trades; vault matches: ${checks.filter((c) => c.ok).length}; mismatches: ${bad.length}; rpc calls: ${calls}`);
if (bad.length) console.log(JSON.stringify(bad.slice(0, 3), null, 1));
const out = Object.fromEntries(Object.entries(found).filter(([, v]) => v));
const need = ['curveBuy', 'curveSell', 'curveShared', 'ammBuy', 'ammSell'];
const missing = need.filter((k) => !out[k]);
if (missing.length) console.log(`kept the old fixtures: this run found no ${missing.join(', ')} (run it again)`);
else {
  writeFileSync(new URL('../fixtures/creator-fees.json', import.meta.url), JSON.stringify({ capturedAt: new Date().toISOString(), rpc: 'mainnet-beta (public)', ...out }, null, 1));
  console.log('saved', Object.keys(out).join(', '));
}
void isSolQuote;
