// Server config from the environment. Every value has a development default except the ones that would make a
// production server unsafe (ALLOWED_ORIGIN in production). See .env.example for the list.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(here, '..');
/** flipfee/program (the program builder's tree: client/, keeper/, Anchor.toml). */
export const PROGRAM_ROOT = resolve(SERVER_ROOT, '..', 'program');

export const CLUSTERS = ['mainnet-beta', 'devnet', 'localnet'];

// the app's dev server (vite 5197), its preview (5198) and vite's default port, on both local host names
export const DEV_ORIGINS = [5197, 5198, 5173].flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]);

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

export function pathFrom(p) {
  return isAbsolute(p) ? p : join(SERVER_ROOT, p);
}

/**
 * ALLOWED_ORIGIN: the origins the app is served from, comma-separated (production: `https://flipfee.cash`). They set
 * CORS and the Sign-In With Solana message: its domain is the origin's host (`flipfee.cash`), its URI the origin.
 */
export function parseOrigins(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      let u = null;
      try {
        u = new URL(s);
      } catch {
        u = null;
      }
      const bare = u && (u.protocol === 'https:' || u.protocol === 'http:') && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password;
      if (!bare) throw new Error(`ALLOWED_ORIGIN: "${s}" is not an origin (write it like https://flipfee.cash)`);
      return u.origin;
    });
}

export function wsFromHttp(url) {
  const u = new URL(url);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  // solana-test-validator serves its pubsub on the RPC port + 1
  if (/^(127\.0\.0\.1|localhost)$/.test(u.hostname) && u.port) u.port = String(Number(u.port) + 1);
  return u.toString();
}

/** The program id the program builder set for localnet in Anchor.toml (a fallback when nothing else names one). */
export function anchorProgramId(file = join(PROGRAM_ROOT, 'Anchor.toml')) {
  if (!existsSync(file)) return '';
  const m = /\[programs\.localnet\][^[]*?flipfee\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/s.exec(readFileSync(file, 'utf8'));
  return m ? m[1] : '';
}

export function loadConfig(baseEnv = process.env) {
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([, v]) => v !== undefined && v !== ''));
  const cluster = env.SOLANA_CLUSTER || 'mainnet-beta';
  if (!CLUSTERS.includes(cluster)) throw new Error(`SOLANA_CLUSTER must be one of ${CLUSTERS.join(', ')}`);
  const mainnet = cluster === 'mainnet-beta';
  const localnet = cluster === 'localnet';
  const production = env.FLIPFEE_ENV === 'production' || env.NODE_ENV === 'production';
  const siwsChainId = env.SIWS_CHAIN_ID || (mainnet ? 'mainnet' : cluster === 'devnet' ? 'devnet' : 'localnet');
  if (!['mainnet', 'devnet', 'testnet', 'localnet'].includes(siwsChainId)) throw new Error('SIWS_CHAIN_ID must be mainnet, devnet, testnet or localnet');
  const helius = env.HELIUS_API_KEY || '';

  // the cluster of the flipfee program (and of pump's accounts for eligibility: mainnet, or clones on a localnet)
  const rpcUrl =
    env.RPC_URL ||
    (localnet ? 'http://127.0.0.1:8899' : helius ? `https://${mainnet ? 'mainnet' : 'devnet'}.helius-rpc.com/?api-key=${helius}` : mainnet ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
  const rpcWsUrl = env.RPC_WS_URL || wsFromHttp(rpcUrl);
  // pump.fun trades: mainnet logs (or the local validator in a localnet test, where the pump programs are clones)
  const tradesWsUrl = env.TRADES_WS_URL || (localnet ? rpcWsUrl : helius ? `wss://mainnet.helius-rpc.com/?api-key=${helius}` : 'wss://api.mainnet-beta.solana.com');
  const tradesFromPublicRpc = !env.TRADES_WS_URL && !helius && !localnet;
  const publicRpc = !env.RPC_URL && !helius && !localnet;

  let origins = parseOrigins(env.ALLOWED_ORIGIN);
  if (!origins.length) {
    if (production) throw new Error('set ALLOWED_ORIGIN to the app origin, e.g. https://flipfee.cash (CORS and the sign-in message use it)');
    origins = DEV_ORIGINS;
  }

  const pumpPortalKey = env.PUMPPORTAL_API_KEY || '';
  const pumpApi = bool(env.PUMPFUN_API, !localnet); // pump.fun's REST API, DexScreener, Jupiter: mainnet data only
  return {
    cluster,
    mainnet,
    localnet,
    production,
    siwsChainId,
    rpcUrl,
    rpcWsUrl,
    tradesWsUrl,
    tradesFromPublicRpc,
    publicRpc,
    rpcMinIntervalMs: num(env.RPC_MIN_INTERVAL_MS, publicRpc ? 120 : localnet ? 0 : 25),
    pumpPortalUrl: env.PUMPPORTAL_WS_URL || 'wss://pumpportal.fun/api/data',
    pumpPortalKey,
    pumpPortalOn: bool(env.PUMPPORTAL, !localnet),
    heliusKey: helius,
    port: num(env.PORT, 5295),
    host: env.HOST || '127.0.0.1',
    origins,
    trustProxy: bool(env.TRUST_PROXY, false),
    dbPath: env.DB_PATH === ':memory:' ? ':memory:' : pathFrom(env.DB_PATH || (production ? '/var/lib/flipfee/flipfee.sqlite' : `./data/flipfee-${cluster}.sqlite`)),
    sessionHours: num(env.SESSION_HOURS, 24),

    // the flipfee program: FLIPFEE_PROGRAM_ID, else the client's PROGRAM_ID export, else Anchor.toml (localnet)
    programId: env.FLIPFEE_PROGRAM_ID || '',
    // the client and the keeper: FLIPFEE_CLIENT / FLIPFEE_KEEPER, else the program builder's tree (flipfee/program,
    // in the repo), else the copies in vendor/ (npm run vendor: what a deploy ships, where ../program is absent)
    clientPath: env.FLIPFEE_CLIENT ? [pathFrom(env.FLIPFEE_CLIENT)] : [join(PROGRAM_ROOT, 'client'), join(SERVER_ROOT, 'vendor', 'flipfee-client'), join(SERVER_ROOT, 'node_modules', 'flipfee-client')],
    keeperPath: env.FLIPFEE_KEEPER ? [pathFrom(env.FLIPFEE_KEEPER)] : [join(PROGRAM_ROOT, 'keeper'), join(SERVER_ROOT, 'vendor', 'flipfee-keeper')],
    indexOn: bool(env.INDEX, true),
    indexPollMs: num(env.INDEX_POLL_MS, 30_000),
    clientPollMs: num(env.CLIENT_POLL_MS, 30_000),

    // the keeper (program/keeper): off unless KEEPER=1
    keeperOn: bool(env.KEEPER, false),
    keeperKeypairFile: env.KEEPER_KEYPAIR_FILE ? pathFrom(env.KEEPER_KEYPAIR_FILE) : '',
    keeperIntervalMs: num(env.KEEPER_INTERVAL_MS, 60_000),
    keeperPriorityMicroLamports: num(env.KEEPER_PRIORITY_MICROLAMPORTS, 0),

    // live data
    ingestOn: bool(env.INGEST, true),
    tradesOn: bool(env.TRADES, true),
    pumpApi,
    hotOn: bool(env.HOT, pumpApi),
    // trade subscriptions are the scarce resource: registered coins first, then the hottest coins
    trackMax: Math.max(1, num(env.TRACK_MAX, 60)),
    hotMax: Math.max(0, num(env.HOT_MAX, 30)), // rows in the board's Hot list
    houseQuotes: bool(env.HOUSE_QUOTES, pumpApi), // flipfee's own bid/ask ladder on the hottest coins (orders.js)
    rotateMs: num(env.ROTATE_MS, 60_000),
    minDwellMs: num(env.MIN_DWELL_MIN, 15) * 60_000,
    swapMargin: num(env.SWAP_MARGIN, 1.5), // a candidate replaces a tracked coin when its score is this much higher
    maxSwaps: num(env.MAX_SWAPS, 3), // per rotation: every swap starts a coin's windows over
    subsPerSec: num(env.SUBS_PER_SEC, 0) || (pumpPortalKey || helius || env.TRADES_WS_URL || localnet ? 20 : 5),
    // trade sockets side by side: a dropped socket costs only its share of the coins (the public endpoint drops busy ones)
    tradesConns: Math.max(1, num(env.TRADES_CONNS, tradesFromPublicRpc ? 2 : 1)),
    // messages per second the trade sockets may bring (0 = no cap); the public endpoint gets 400 (about 0.6 MB/s)
    msgBudget: Math.max(0, num(env.MSG_BUDGET, tradesFromPublicRpc ? 400 : 0)),
    ringSize: num(env.RING_SIZE, 2_000),
    sseMaxPerIp: num(env.SSE_MAX_PER_IP, 12),
    sseTradesPerSec: num(env.SSE_TRADES_PER_SEC, 25),
  };
}
