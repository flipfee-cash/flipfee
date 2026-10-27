// Jupiter lite API (forked from peek-sol): SOL/USD and token USD prices (price/v3, up to 50 ids per call) and the
// top traded / trending lists (tokens/v2/toptraded, toptrending) that feed the Hot list's candidates with their 1h
// volume. Budget: 1 request per second.
import { Source } from '../net.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BASE = 'https://lite-api.jup.ag';

export class Jupiter {
  constructor({ fetchFn } = {}) {
    this.src = new Source('jupiter', { minIntervalMs: 1_050, timeoutMs: 6_000, fetchFn });
    this.sol = { usd: null, at: 0 };
  }

  /** Map mint → { usd, liquidity, decimals, launchpad, createdAt, blockId } (mints Jupiter knows). */
  async prices(mints, { front = false } = {}) {
    const out = new Map();
    const list = [...new Set(mints)].filter(Boolean);
    for (let i = 0; i < list.length; i += 50) {
      const ids = list.slice(i, i + 50);
      const data = await this.src.json(`${BASE}/price/v3?ids=${ids.join(',')}`, { front });
      for (const [mint, v] of Object.entries(data ?? {})) {
        const usd = Number(v?.usdPrice);
        if (!Number.isFinite(usd) || usd <= 0) continue;
        out.set(mint, {
          usd,
          liquidity: Number(v.liquidity) || null,
          decimals: v.decimals,
          launchpad: v.launchpad ?? null,
          createdAt: v.createdAt ? Date.parse(v.createdAt) : null,
          blockId: v.blockId ?? null,
          change24h: Number.isFinite(Number(v.priceChange24h)) ? Number(v.priceChange24h) : null,
        });
      }
    }
    return out;
  }

  /** SOL/USD, at most `maxAgeMs` old (the last good value when Jupiter fails). */
  async solUsd(maxAgeMs = 15_000) {
    if (this.sol.usd && Date.now() - this.sol.at < maxAgeMs) return this.sol.usd;
    try {
      const p = await this.prices([SOL_MINT]);
      const v = p.get(SOL_MINT)?.usd;
      if (v) this.sol = { usd: v, at: Date.now() };
    } catch {
      // keep the last value
    }
    return this.sol.usd;
  }

  /** Top trending tokens over `window` (Jupiter's own ranking), normalized. */
  async trending(window = '5m', limit = 50) {
    const data = await this.src.json(`${BASE}/tokens/v2/toptrending/${window}?limit=${limit}`);
    return (Array.isArray(data) ? data : []).map(normToken).filter(Boolean);
  }

  /** Top traded tokens (by volume) over `window`, normalized. */
  async toptraded(window = '1h', limit = 100) {
    const data = await this.src.json(`${BASE}/tokens/v2/toptraded/${window}?limit=${limit}`);
    return (Array.isArray(data) ? data : []).map(normToken).filter(Boolean);
  }
}

export function normToken(t) {
  if (!t?.id) return null;
  const s5 = t.stats5m ?? {};
  const s1h = t.stats1h ?? {};
  return {
    mint: t.id,
    name: String(t.name ?? ''),
    symbol: String(t.symbol ?? ''),
    icon: t.icon ?? null,
    launchpad: t.launchpad ?? null,
    createdAt: t.createdAt ? Date.parse(t.createdAt) : t.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : null,
    graduatedAt: t.graduatedAt ? Date.parse(t.graduatedAt) : null,
    bondingCurve: Number.isFinite(Number(t.bondingCurve)) ? Number(t.bondingCurve) : null,
    mcapUsd: Number(t.mcap) || null,
    priceUsd: Number(t.usdPrice) || null,
    liquidityUsd: Number(t.liquidity) || null,
    holders: t.holderCount ?? null,
    dev: t.dev ?? null,
    twitter: t.twitter ?? null,
    telegram: t.telegram ?? null,
    website: t.website ?? null,
    change5m: num(s5.priceChange),
    buyVol5m: num(s5.buyVolume),
    sellVol5m: num(s5.sellVolume),
    buys5m: num(s5.numBuys),
    sells5m: num(s5.numSells),
    traders5m: num(s5.numTraders),
    vol1h: (num(s1h.buyVolume) ?? 0) + (num(s1h.sellVolume) ?? 0) || null,
    trades1h: (num(s1h.numBuys) ?? 0) + (num(s1h.numSells) ?? 0) || null,
    vol6h: (num(t.stats6h?.buyVolume) ?? 0) + (num(t.stats6h?.sellVolume) ?? 0) || null,
    vol24h: (num(t.stats24h?.buyVolume) ?? 0) + (num(t.stats24h?.sellVolume) ?? 0) || null,
    graduatedPool: typeof t.graduatedPool === 'string' ? t.graduatedPool : null,
  };
}

const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
