// pump.fun REST (forked from peek-sol): coin records (frontend-api-v3 /coins-v2/<mint>), the coin lists that feed the
// Hot list (/coins sorted by last trade or market cap, /coins/currently-live), a wallet's created coins
// (/coins-v2/user-created-coins/<wallet>), per-coin market activity (swap-api /v1/coins/<mint>/market-activity:
// volume and trades over 5m/1h/6h/24h) and SOL/USD (/sol-price). Images come from pump.fun's image CDN.
// Pace: ≤ 1 request per second per host (pump.fun allows about 60 per minute), records cached 60 s.
import { Source } from '../net.js';

const API = 'https://frontend-api-v3.pump.fun';
const SWAP = 'https://swap-api.pump.fun';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const DEFAULT_KEY = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';

/** pump.fun's image CDN (Cloudflare Images): 86x86 for rows, 256x256 for the coin page. */
export const imageUrl = (mint, size = '86x86') => `https://images.pump.fun/coin-image/${mint}?variant=${size}`;

export const isPumpMint = (mint) => typeof mint === 'string' && mint.endsWith('pump');

const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const url = (v) => (typeof v === 'string' && /^https?:\/\/\S+$/.test(v.trim()) ? v.trim().slice(0, 300) : undefined);
const n = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** The quote of a pump.fun coin: 'sol' (the default key or wrapped SOL), else the quote mint. */
export const quoteOf = (q) => (!q || q === DEFAULT_KEY || q === WSOL ? 'sol' : q);

export function normCoin(c) {
  if (!c?.mint) return null;
  const socials = {};
  if (url(c.twitter)) socials.twitter = url(c.twitter);
  if (url(c.telegram)) socials.telegram = url(c.telegram);
  if (url(c.website)) socials.website = url(c.website);
  const decimals = n(c.base_decimals) ?? 6;
  const supply = n(c.total_supply) !== null ? n(c.total_supply) / 10 ** decimals : null;
  const quote = quoteOf(c.quote_mint);
  // a PumpSwap pool: pump_swap_pool, or pool_address when it is no Raydium pool (coins from before PumpSwap)
  const pool = c.pump_swap_pool ?? (c.complete && c.pool_address && c.pool_address !== c.raydium_pool ? c.pool_address : null);
  return {
    mint: c.mint,
    name: str(c.name, 64) ?? '',
    symbol: str(c.symbol, 24) ?? '',
    description: str(c.description, 600),
    image: url(c.image_uri),
    socials,
    creator: c.creator ?? null,
    createdAt: n(c.created_timestamp),
    complete: !!c.complete,
    bondingCurve: c.bonding_curve ?? null,
    pool: pool ?? null,
    raydium: !!c.raydium_pool && !c.pump_swap_pool,
    quote,
    quoteMint: c.quote_mint ?? null,
    mcapUsd: n(c.usd_market_cap) ?? n(c.market_cap_usd),
    mcapSol: quote === 'sol' ? n(c.market_cap_quote) ?? n(c.market_cap) : null,
    supply,
    vol1hUsd: n(c.volume_1h_usd),
    lastTradeAt: n(c.last_trade_timestamp),
    live: !!c.is_currently_live,
    program: c.program ?? c.protocol ?? null,
    nsfw: !!c.nsfw,
    banned: !!c.is_banned,
    cashback: !!c.is_cashback_enabled, // trading fees go back to traders: the coin has no creator fees
    at: Date.now(),
  };
}

/** swap-api market activity → { m5, h1, h6, h24: { volUsd, trades, buys, sells, traders } | null }. */
export function normActivity(j) {
  if (!j || typeof j !== 'object') return null;
  const w = (x) => (x && typeof x === 'object' ? { volUsd: n(x.volumeUSD) ?? 0, trades: n(x.numTxs) ?? 0, buys: n(x.numBuys) ?? 0, sells: n(x.numSells) ?? 0, traders: n(x.numUsers) ?? 0 } : null);
  return { m5: w(j['5m']), h1: w(j['1h']), h6: w(j['6h']), h24: w(j['24h']), at: Date.now() };
}

export class PumpFun {
  constructor({ fetchFn } = {}) {
    this.src = new Source('pumpfun', { minIntervalMs: 1_050, timeoutMs: 6_000, maxQueue: 120, fetchFn });
    this.swap = new Source('pumpfun-swap', { minIntervalMs: 1_050, timeoutMs: 6_000, maxQueue: 120, fetchFn });
    this.cache = new Map(); // key → { at, v, pending }
  }

  /** One cached request per key at a time (`maxAgeMs` fresh). */
  cached(key, maxAgeMs, fn) {
    const hit = this.cache.get(key);
    if (hit?.v !== undefined && Date.now() - hit.at < maxAgeMs) return Promise.resolve(hit.v);
    if (hit?.pending) return hit.pending;
    const pending = fn()
      .then((v) => {
        this.cache.set(key, { at: Date.now(), v });
        if (this.cache.size > 6000) for (const k of [...this.cache.keys()].slice(0, 1500)) this.cache.delete(k);
        return v;
      })
      .catch((e) => {
        if (hit?.v !== undefined) this.cache.set(key, { at: hit.at, v: hit.v });
        else this.cache.delete(key);
        throw e;
      });
    this.cache.set(key, { ...(hit ?? {}), pending });
    return pending;
  }

  /** The pump.fun coin record (normalized); null when pump.fun does not know the mint. */
  coin(mint, { maxAgeMs = 60_000, front = false } = {}) {
    return this.cached(`coin:${mint}`, maxAgeMs, async () => normCoin(await this.src.json(`${API}/coins-v2/${mint}`, { front, allow404: true })));
  }

  /** /coins sorted by `sort` (last_trade_timestamp | market_cap | created_timestamp …), normalized. */
  list({ sort = 'last_trade_timestamp', limit = 50, offset = 0, maxAgeMs = 20_000 } = {}) {
    return this.cached(`list:${sort}:${limit}:${offset}`, maxAgeMs, async () => {
      const data = await this.src.json(`${API}/coins?offset=${offset}&limit=${limit}&sort=${sort}&order=DESC&includeNsfw=false`);
      return (Array.isArray(data) ? data : []).map(normCoin).filter(Boolean);
    });
  }

  /** Coins streaming live on pump.fun right now. */
  live({ limit = 50, maxAgeMs = 60_000 } = {}) {
    return this.cached(`live:${limit}`, maxAgeMs, async () => {
      const data = await this.src.json(`${API}/coins/currently-live?offset=0&limit=${limit}&includeNsfw=false`);
      return (Array.isArray(data) ? data : []).map(normCoin).filter(Boolean);
    });
  }

  /** The coins a wallet created on pump.fun (newest first), normalized. */
  created(wallet, { limit = 50, maxAgeMs = 60_000, front = true } = {}) {
    return this.cached(`created:${wallet}:${limit}`, maxAgeMs, async () => {
      const data = await this.src.json(`${API}/coins-v2/user-created-coins/${wallet}?limit=${limit}&offset=0`, { front, allow404: true });
      return (Array.isArray(data?.coins) ? data.coins : Array.isArray(data) ? data : []).map(normCoin).filter((c) => c && c.creator === wallet);
    });
  }

  /** Volume and trades of a coin over 5m/1h/6h/24h (pump.fun's own numbers, USD). */
  activity(mint, { maxAgeMs = 120_000, front = false } = {}) {
    return this.cached(`act:${mint}`, maxAgeMs, async () => normActivity(await this.swap.json(`${SWAP}/v1/coins/${mint}/market-activity`, { front, allow404: true })));
  }

  async solUsd() {
    const j = await this.src.json(`${API}/sol-price`);
    const v = n(j?.solPrice);
    return v && v > 0 ? v : null;
  }

  status() {
    return { api: this.src.status(), swap: this.swap.status() };
  }
}
