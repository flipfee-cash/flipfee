// The flipfee program behind one small adapter: account decoders (Config, Coin), event decoders, PDAs and the
// eligibility check. Sources, best first:
//   1. the program builder's TS client (flipfee/program/client, built to dist/ by tsup): its decoders, its
//      `eligibility(conn, mint, wallet)` and its PROGRAM_ID;
//   2. the program's Anchor IDL (client/idl/flipfee.json or target/idl/flipfee.json) through borsh.js;
//   3. the account shapes of DESIGN.md §2.1 (Config, Coin, Window), hand-decoded; events unknown.
// Whatever the source, the rest of the server sees one normalized shape (normCoin / normConfig / normEvent below):
// amounts in lamports as Numbers (all far below 2^53), times in unix seconds.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { IdlCoder } from './borsh.js';
import { forProgramData } from '../ingest/pumpevents.js';
import { logError } from '../log.js';

const disc = (s) => createHash('sha256').update(s).digest().subarray(0, 8);

const toNum = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v) || 0;
  if (typeof v === 'object' && typeof v.toString === 'function') return Number(v.toString()) || 0; // BN
  return 0;
};
const toKey = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v.toBase58 === 'function') return v.toBase58();
  if (v instanceof Uint8Array && v.length === 32) return bs58.encode(v);
  return null;
};
/** The first of `names` (camelCase or snake_case spellings) present on `o`. */
const pick = (o, ...names) => {
  for (const n of names) if (o && o[n] !== undefined) return o[n];
  return undefined;
};
const kindOf = (v) => {
  if (typeof v === 'string') return v.toLowerCase();
  if (typeof v === 'number') return v === 0 ? 'holder' : 'owner';
  if (v && typeof v === 'object') return String(v.kind ?? Object.keys(v)[0] ?? '').toLowerCase();
  return '';
};

export function normWindow(w) {
  return {
    holder: toKey(pick(w, 'holder', 'buyer')),
    start: toNum(pick(w, 'start', 'startTs', 'start_ts')),
    end: toNum(pick(w, 'end', 'endTs', 'end_ts')),
    owed: toNum(pick(w, 'owed')),
    earned: toNum(pick(w, 'earned')),
  };
}

export function normCoin(raw, address = null) {
  if (!raw) return null;
  return {
    kind: 'coin',
    address,
    mint: toKey(pick(raw, 'mint')),
    owner: toKey(pick(raw, 'owner', 'dev')),
    price: toNum(pick(raw, 'price', 'pricePerHour', 'price_per_hour')),
    maxAhead: toNum(pick(raw, 'maxAhead', 'max_ahead')),
    paused: !!pick(raw, 'paused'),
    lastSync: toNum(pick(raw, 'lastSync', 'last_sync')),
    ownerOwed: toNum(pick(raw, 'ownerOwed', 'owner_owed')),
    credited: toNum(pick(raw, 'credited')),
    windows: (pick(raw, 'windows') ?? []).map(normWindow).sort((a, b) => a.start - b.start),
    feesIn: toNum(pick(raw, 'feesIn', 'fees_in')),
    sales: toNum(pick(raw, 'sales')),
    hoursSold: toNum(pick(raw, 'hoursSold', 'hours_sold')),
    paidOut: toNum(pick(raw, 'paidOut', 'paid_out')),
    registeredAt: toNum(pick(raw, 'registeredAt', 'registered_at', 'createdAt', 'created_at')) || null,
  };
}

export function normConfig(raw, address = null) {
  if (!raw) return null;
  return {
    kind: 'config',
    address,
    admin: toKey(pick(raw, 'admin')),
    treasury: toKey(pick(raw, 'treasury')),
    feeBps: toNum(pick(raw, 'feeBps', 'fee_bps')),
    paused: !!pick(raw, 'paused'),
  };
}

/**
 * Program events → { type, mint, coin, at, … } (amounts in lamports, times in unix seconds). Names from the program
 * (programs/flipfee/src/events.rs): HoursBought, FeesSynced, Paid, Registered, TermsSet, OwnerTransferred, WindowDone,
 * ConfigSet; other spellings of the same events are accepted. Unknown events come back as { type: 'other', name }.
 */
export function normEvent(name, d) {
  const n = String(name).replace(/Event$/, '');
  const mint = toKey(pick(d, 'mint', 'coinMint', 'coin_mint')) ?? null;
  const coin = toKey(pick(d, 'coin')) ?? null;
  const at = toNum(pick(d, 'at', 'ts', 'timestamp')) || null;
  switch (n) {
    case 'HoursBought':
    case 'Bought':
    case 'Buy':
      return {
        type: 'buy',
        mint,
        coin,
        at,
        buyer: toKey(pick(d, 'buyer', 'holder')),
        hours: toNum(pick(d, 'hours')),
        start: toNum(pick(d, 'start')),
        end: toNum(pick(d, 'end')),
        price: toNum(pick(d, 'price', 'pricePerHour')),
        paid: toNum(pick(d, 'total', 'paid', 'cost', 'amount')),
        toOwner: toNum(pick(d, 'toOwner', 'to_owner', 'ownerAmount', 'owner_amount')),
        fee: toNum(pick(d, 'fee', 'toTreasury', 'to_treasury')),
        queued: toNum(pick(d, 'windows')),
      };
    case 'FeesSynced':
    case 'Synced':
      return {
        type: 'sync',
        mint,
        coin,
        at,
        amount: toNum(pick(d, 'amount', 'arrived')),
        from: toNum(pick(d, 'from', 'fromTs', 'from_ts')),
        to: toNum(pick(d, 'to', 'toTs', 'to_ts')),
        toOwner: toNum(pick(d, 'toOwner', 'to_owner')),
        toWindows: toNum(pick(d, 'toWindows', 'to_windows')),
      };
    case 'Paid':
    case 'Payout': {
      const k = kindOf(pick(d, 'kind'));
      return { type: 'paid', mint, coin, at, to: toKey(pick(d, 'to', 'recipient', 'wallet')), amount: toNum(pick(d, 'amount')), kind: k === 'owner' || k === 'dev' ? 'owner' : 'holder' };
    }
    case 'Registered':
    case 'Register':
    case 'CoinRegistered':
      return { type: 'register', mint, coin, at, owner: toKey(pick(d, 'owner', 'dev')), vault: toKey(pick(d, 'vault')), price: toNum(pick(d, 'price')), maxAhead: toNum(pick(d, 'maxAhead', 'max_ahead')), carried: toNum(pick(d, 'carried')) };
    case 'TermsSet':
    case 'TermsUpdated':
    case 'SetTerms':
      return { type: 'terms', mint, coin, at, price: toNum(pick(d, 'price')), maxAhead: toNum(pick(d, 'maxAhead', 'max_ahead')), paused: !!pick(d, 'paused') };
    case 'OwnerTransferred':
    case 'TransferOwner':
      return { type: 'owner', mint, coin, at, from: toKey(pick(d, 'from', 'oldOwner', 'old_owner')), owner: toKey(pick(d, 'to', 'newOwner', 'new_owner', 'owner')), paid: toNum(pick(d, 'paidToOldOwner', 'paid_to_old_owner')) };
    case 'WindowDone':
      return { type: 'windowDone', mint, coin, at, holder: toKey(pick(d, 'holder')), start: toNum(pick(d, 'start')), end: toNum(pick(d, 'end')), earned: toNum(pick(d, 'earned')) };
    case 'ConfigSet':
      return { type: 'config', mint: null, coin: null, at, admin: toKey(pick(d, 'admin')), treasury: toKey(pick(d, 'treasury')), feeBps: toNum(pick(d, 'feeBps', 'fee_bps')), paused: !!pick(d, 'paused') };
    default:
      return { type: 'other', name: n, mint, coin, at };
  }
}

// ───────────── DESIGN §2.1 hand decoder (no client, no IDL) ─────────────

const CONFIG_DISC = disc('account:Config');
const COIN_DISC = disc('account:Coin');

function designAccount(buf) {
  let o = 8;
  const k = () => {
    const v = bs58.encode(buf.subarray(o, o + 32));
    o += 32;
    return v;
  };
  const u8 = () => buf[o++];
  const u16 = () => ((o += 2), buf.readUInt16LE(o - 2));
  const u32 = () => ((o += 4), buf.readUInt32LE(o - 4));
  const u64 = () => ((o += 8), buf.readBigUInt64LE(o - 8));
  const i64 = () => ((o += 8), buf.readBigInt64LE(o - 8));
  if (buf.subarray(0, 8).equals(CONFIG_DISC)) return { name: 'Config', data: { admin: k(), treasury: k(), fee_bps: u16(), paused: u8() === 1, bump: u8() } };
  if (buf.subarray(0, 8).equals(COIN_DISC)) {
    const d = { mint: k(), owner: k(), bump: u8(), vault_bump: u8(), price: u64(), max_ahead: u32(), paused: u8() === 1, last_sync: i64(), owner_owed: u64(), credited: u64() };
    const n = u32();
    d.windows = [];
    for (let i = 0; i < n; i++) d.windows.push({ holder: k(), start: i64(), end: i64(), owed: u64(), earned: u64() });
    Object.assign(d, { fees_in: u64(), sales: u64(), hours_sold: u32(), paid_out: u64() });
    return { name: 'Coin', data: d };
  }
  return null;
}

// ───────────── the adapter ─────────────

function findIdl(clientPath) {
  for (const f of [join(clientPath, 'idl', 'flipfee.json'), join(clientPath, '..', 'target', 'idl', 'flipfee.json')]) {
    if (existsSync(f)) {
      try {
        return { file: f, idl: JSON.parse(readFileSync(f, 'utf8')) };
      } catch {
        // a half-written file: try the next one
      }
    }
  }
  return null;
}

/** The client module: dist/index.js (tsup), else its package.json `main`/`exports`. Null when it is not built. */
export async function importClient(clientPath) {
  const candidates = [join(clientPath, 'dist', 'index.js'), join(clientPath, 'dist', 'index.mjs')];
  try {
    const pkg = JSON.parse(readFileSync(join(clientPath, 'package.json'), 'utf8'));
    const main = pkg.exports?.['.']?.import ?? pkg.exports?.['.']?.default ?? pkg.module ?? pkg.main;
    if (typeof main === 'string') candidates.unshift(join(clientPath, main));
  } catch {
    // no package.json yet
  }
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    try {
      return { file: f, mod: await import(pathToFileURL(f).href) };
    } catch (e) {
      logError('flipfee.client.import.fail', e, { file: f });
    }
  }
  return null;
}

/** A client value as plain JSON: public keys as base58, bigints as decimal strings. */
export function plain(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v !== 'object') return v;
  if (typeof v.toBase58 === 'function') return v.toBase58();
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
}

const fnOf = (mod, ...names) => names.map((n) => mod?.[n]).find((f) => typeof f === 'function') ?? null;

export class FlipfeeAdapter {
  constructor({ programId = '', client = null, idl = null, source = 'design' } = {}) {
    this.client = client; // { file, mod }
    this.idl = idl; // { file, idl }
    this.coder = idl ? new IdlCoder(idl.idl) : null;
    this.source = source;
    const fromClient = toKey(client?.mod?.PROGRAM_ID ?? client?.mod?.FLIPFEE_PROGRAM_ID ?? client?.mod?.programId);
    const fromIdl = idl?.idl?.address ?? '';
    this.programId = programId || fromClient || fromIdl || '';
    this.programKey = this.programId ? new PublicKey(this.programId) : null;
    const m = client?.mod;
    this.fn = {
      decodeCoin: fnOf(m, 'decodeCoin', 'decodeCoinAccount', 'coinFromAccount'),
      decodeConfig: fnOf(m, 'decodeConfig', 'decodeConfigAccount', 'configFromAccount'),
      decodeAccount: fnOf(m, 'decodeAccount', 'decodeFlipfeeAccount'),
      parseEvents: fnOf(m, 'parseEvents', 'parseLogs', 'eventsFromLogs', 'decodeEvents'),
      decodeEvent: fnOf(m, 'decodeEvent'),
      eligibility: fnOf(m, 'eligibility', 'getEligibility'),
      coinPda: fnOf(m, 'coinPda', 'findCoinPda', 'coinAddress'),
      vaultPda: fnOf(m, 'vaultPda', 'findVaultPda', 'vaultAddress'),
      configPda: fnOf(m, 'configPda', 'findConfigPda', 'configAddress'),
    };
  }

  get ready() {
    return !!this.programKey;
  }

  describe() {
    if (this.build === undefined) {
      try {
        this.build = this.client?.file ? createHash('sha256').update(readFileSync(this.client.file)).digest('hex').slice(0, 16) : null;
      } catch {
        this.build = null;
      }
    }
    return { source: this.source, programId: this.programId || null, client: this.client?.file ?? null, clientBuild: this.build, idl: this.idl?.file ?? null, eligibility: this.fn.eligibility ? 'client' : 'chain fallback' };
  }

  pda(seeds) {
    return PublicKey.findProgramAddressSync(seeds, this.programKey)[0].toBase58();
  }

  configPda() {
    return this.pda([Buffer.from('config')]);
  }

  coinPda(mint) {
    return this.pda([Buffer.from('coin'), new PublicKey(mint).toBuffer()]);
  }

  vaultPda(mint) {
    return this.pda([Buffer.from('vault'), new PublicKey(mint).toBuffer()]);
  }

  /** A program account (raw data Buffer) → normCoin / normConfig, or null for other accounts. */
  decodeAccount(address, buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
    const isCoin = buf.subarray(0, 8).equals(COIN_DISC);
    const isConfig = buf.subarray(0, 8).equals(CONFIG_DISC);
    try {
      if (this.fn.decodeCoin && isCoin) return normCoin(this.fn.decodeCoin(buf), address);
      if (this.fn.decodeConfig && isConfig) return normConfig(this.fn.decodeConfig(buf), address);
      if (this.fn.decodeAccount) {
        const r = this.fn.decodeAccount(buf);
        if (r) {
          const name = String(r.name ?? r.kind ?? r.type ?? '').toLowerCase();
          const d = r.data ?? r.account ?? r;
          if (name.includes('coin')) return normCoin(d, address);
          if (name.includes('config')) return normConfig(d, address);
        }
      }
      const r = this.coder?.account(buf) ?? designAccount(buf);
      if (!r) return null;
      if (r.name === 'Coin') return normCoin(r.data, address);
      if (r.name === 'Config') return normConfig(r.data, address);
    } catch (e) {
      logError('flipfee.decode.fail', e, { address });
    }
    return null;
  }

  /** Every flipfee event logged by the program in one transaction's logs, normalized, in order. */
  eventsFromLogs(logs) {
    const out = [];
    if (!this.programId) return out;
    if (this.fn.parseEvents) {
      try {
        const evs = this.fn.parseEvents(logs, this.programKey) ?? [];
        for (const e of evs) out.push(normEvent(e.name ?? e.type ?? '', e.data ?? e));
        return out;
      } catch (e) {
        logError('flipfee.events.client.fail', e);
      }
    }
    forProgramData(logs, this.programId, (buf) => {
      try {
        const r = this.fn.decodeEvent?.(buf) ?? this.coder?.event(buf);
        if (r) out.push(normEvent(r.name, r.data ?? r));
      } catch (e) {
        logError('flipfee.event.decode.fail', e);
      }
    });
    return out;
  }

  /** The client's eligibility as plain JSON (null when the client has none: the caller uses the chain fallback). */
  async eligibility(conn, mint, wallet) {
    if (!this.fn.eligibility) return null;
    const r = await this.fn.eligibility(conn, new PublicKey(mint), new PublicKey(wallet), { programId: this.programKey });
    if (!r) return null;
    // the raw pump state (curve, sharing, pool) stays out: the API sends the verdict
    const { curve, sharing, pool, ...rest } = r;
    void curve, void sharing, void pool;
    return { ...plain(rest), kind: String(r.kind), graduated: !!r.graduated };
  }
}

/** Loads the best source available now. `clientPath`: one directory or a list, searched in order. */
export async function loadFlipfee({ clientPath, programId = '', fallbackProgramId = '' }) {
  const paths = (Array.isArray(clientPath) ? clientPath : [clientPath]).filter(Boolean);
  let client = null;
  let idl = null;
  for (const p of paths) {
    client = await importClient(p);
    if (client) break;
  }
  for (const p of paths) {
    idl = findIdl(p);
    if (idl) break;
  }
  const source = client ? 'client' : idl ? 'idl' : 'design';
  const a = new FlipfeeAdapter({ programId, client, idl, source });
  if (!a.programId && fallbackProgramId) {
    a.programId = fallbackProgramId;
    a.programKey = new PublicKey(fallbackProgramId);
  }
  return a;
}
