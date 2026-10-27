// DexScreener (forked from peek-sol): pair data per coin (price, market cap, liquidity, volume and trades over
// 5m/1h/6h/24h) for the Hot list's ranking and estimates, 30 mints per request. Limit: 300 requests per minute.
import { Source } from '../net.js';

const BASE = 'https://api.dexscreener.com';

function linksOf(list) {
  const out = {};
  for (const l of Array.isArray(list) ? list : []) {
    const url = typeof l?.url === 'string' ? l.url : null;
    if (!url || !/^https?:\/\//.test(url)) continue;
    const type = String(l.type || l.label || '').toLowerCase();
    if (type.includes('twitter') || /\/\/(www\.)?(x|twitter)\.com\//.test(url)) out.twitter ??= url;
    else if (type.includes('telegram') || /\/\/t\.me\//.test(url)) out.telegram ??= url;
    else if (type.includes('website') || !type || type === 'site') out.website ??= url;
    else if (type.includes('discord')) out.discord ??= url;
  }
  return out;
}

export class DexScreener {
  constructor({ fetchFn } = {}) {
    this.pairsSrc = new Source('dex-pairs', { minIntervalMs: 250, fetchFn });
  }

  /** Map mint → its most liquid Solana pair (up to 30 mints per request). */
  async pairs(mints, { front = false } = {}) {
    const out = new Map();
    const list = [...new Set(mints)].filter(Boolean);
    for (let i = 0; i < list.length; i += 30) {
      const ids = list.slice(i, i + 30);
      const data = await this.pairsSrc.json(`${BASE}/latest/dex/tokens/${ids.join(',')}`, { front });
      for (const p of data?.pairs ?? []) {
        if (p?.chainId !== 'solana') continue;
        const mint = p.baseToken?.address;
        if (!ids.includes(mint)) continue;
        const cur = out.get(mint);
        const liq = Number(p.liquidity?.usd) || 0;
        if (cur && (cur.liquidityUsd ?? 0) >= liq) continue;
        out.set(mint, normPair(p));
      }
    }
    return out;
  }
}

export function normPair(p) {
  const n = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);
  return {
    mint: p.baseToken?.address,
    symbol: String(p.baseToken?.symbol ?? ''),
    name: String(p.baseToken?.name ?? ''),
    dexId: p.dexId,
    pairAddress: p.pairAddress,
    priceUsd: n(p.priceUsd),
    priceNative: n(p.priceNative),
    liquidityUsd: n(p.liquidity?.usd),
    mcapUsd: n(p.marketCap) ?? n(p.fdv),
    vol5mUsd: n(p.volume?.m5),
    vol1hUsd: n(p.volume?.h1),
    vol6hUsd: n(p.volume?.h6),
    vol24hUsd: n(p.volume?.h24),
    buys5m: n(p.txns?.m5?.buys),
    sells5m: n(p.txns?.m5?.sells),
    trades1h: (n(p.txns?.h1?.buys) ?? 0) + (n(p.txns?.h1?.sells) ?? 0),
    change5m: n(p.priceChange?.m5),
    change1h: n(p.priceChange?.h1),
    createdAt: n(p.pairCreatedAt),
    image: p.info?.imageUrl ?? null,
    socials: { ...linksOf(p.info?.socials), ...(p.info?.websites?.[0]?.url ? { website: p.info.websites[0].url } : {}) },
    at: Date.now(),
  };
}
