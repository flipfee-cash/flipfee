// Sign-In With Solana (statement "Sign in to flipfee."). The Wallet Standard `solana:signIn`
// message format, CAIP-122 style: POST /api/auth/nonce
// gives the exact message (and the same fields as a `SolanaSignInInput`, for wallets that build it themselves);
// POST /api/auth/verify checks the ed25519 signature over the signed bytes, the domain, URI, version, chain id,
// statement, nonce (single use, 10 minutes) and times, then opens a bearer session (SESSION_HOURS, default 24 h).
import { createHash, randomBytes } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { httpError } from './errors.js';

const NONCE_TTL_MS = 10 * 60_000;
export const STATEMENT = 'Sign in to flipfee.';
const now = () => Date.now();
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function isAddress(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

/** The SIWS message text (same as @solana/wallet-standard-util createSignInMessageText). */
export function buildMessage(f) {
  let m = `${f.domain} wants you to sign in with your Solana account:\n${f.address}`;
  if (f.statement) m += `\n\n${f.statement}`;
  const fields = [];
  if (f.uri) fields.push(`URI: ${f.uri}`);
  if (f.version) fields.push(`Version: ${f.version}`);
  if (f.chainId) fields.push(`Chain ID: ${f.chainId}`);
  if (f.nonce) fields.push(`Nonce: ${f.nonce}`);
  if (f.issuedAt) fields.push(`Issued At: ${f.issuedAt}`);
  if (f.expirationTime) fields.push(`Expiration Time: ${f.expirationTime}`);
  if (f.notBefore) fields.push(`Not Before: ${f.notBefore}`);
  if (f.requestId) fields.push(`Request ID: ${f.requestId}`);
  if (f.resources?.length) {
    fields.push('Resources:');
    for (const r of f.resources) fields.push(`- ${r}`);
  }
  if (fields.length) m += `\n\n${fields.join('\n')}`;
  return m;
}

const FIELD = {
  URI: 'uri',
  Version: 'version',
  'Chain ID': 'chainId',
  Nonce: 'nonce',
  'Issued At': 'issuedAt',
  'Expiration Time': 'expirationTime',
  'Not Before': 'notBefore',
  'Request ID': 'requestId',
};

/** Parses a SIWS message (strict about the header; unknown lines fail). */
export function parseMessage(text) {
  const s = String(text ?? '');
  const m = /^(?<domain>[^\s]+) wants you to sign in with your Solana account:\n(?<address>[1-9A-HJ-NP-Za-km-z]{32,44})(?:\n\n(?<rest>[\s\S]*))?$/.exec(s);
  if (!m) return null;
  const out = { domain: m.groups.domain, address: m.groups.address };
  let rest = m.groups.rest ?? '';
  const blocks = rest.split('\n\n');
  // an optional statement block, then the field block
  if (blocks.length > 2) return null;
  if (blocks.length === 2) {
    out.statement = blocks[0];
    rest = blocks[1];
  } else if (blocks.length === 1 && rest && !/^[A-Za-z ]+: /.test(rest.split('\n')[0])) {
    out.statement = rest;
    rest = '';
  }
  const lines = rest ? rest.split('\n') : [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === 'Resources:') {
      out.resources = [];
      for (i++; i < lines.length && lines[i].startsWith('- '); i++) out.resources.push(lines[i].slice(2));
      i--;
      continue;
    }
    const k = /^([A-Za-z ]+): (.*)$/.exec(line);
    if (!k || !FIELD[k[1]] || out[FIELD[k[1]]] !== undefined) return null;
    out[FIELD[k[1]]] = k[2];
  }
  return out;
}

function decodeBytes(v) {
  if (typeof v !== 'string' || !v) return null;
  try {
    const b = bs58.decode(v);
    if (b.length === 64) return Buffer.from(b);
  } catch {
    // not base58
  }
  try {
    const b = Buffer.from(v, 'base64');
    if (b.length === 64) return b;
  } catch {
    // not base64
  }
  if (/^[0-9a-fA-F]{128}$/.test(v)) return Buffer.from(v, 'hex');
  return null;
}

export class Auth {
  /**
   * `origins`: the allowed app origins (ALLOWED_ORIGIN). The message names the site the request came from (Origin
   * header, else the proxy's forwarded host) when it is allowed, else the first origin.
   */
  constructor(db, { origins, chainId = 'devnet', sessionHours = 24, devAnyLocal = false }) {
    this.db = db;
    this.origins = origins;
    this.chainId = chainId;
    this.sessionMs = Math.round(sessionHours * 3_600_000);
    this.devAnyLocal = devAnyLocal;
  }

  allowed(origin) {
    if (!origin) return false;
    if (this.origins.includes(origin)) return true;
    if (!this.devAnyLocal) return false;
    try {
      const u = new URL(origin);
      return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    } catch {
      return false;
    }
  }

  challenge(address, ...candidates) {
    if (!isAddress(address)) throw httpError(400, 'badAddress', 'bad address');
    const origin = candidates.find((c) => this.allowed(c)) ?? this.origins[0];
    const url = new URL(origin);
    const t = now();
    const fields = {
      domain: url.host,
      address,
      statement: STATEMENT,
      uri: url.origin,
      version: '1',
      chainId: this.chainId,
      nonce: randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x'),
      issuedAt: new Date(t).toISOString(),
      expirationTime: new Date(t + NONCE_TTL_MS).toISOString(),
    };
    const message = buildMessage(fields);
    this.db.run('DELETE FROM nonces WHERE expires_at < ?', t - 3_600_000);
    this.db.run('INSERT INTO nonces (nonce, address, message, expires_at) VALUES (?, ?, ?, ?)', fields.nonce, address, message, t + NONCE_TTL_MS);
    return { message, nonce: fields.nonce, input: fields, expiresAt: t + NONCE_TTL_MS };
  }

  /**
   * `body`: { message (text) | signedMessage (base64 bytes), signature (base58 | base64 | hex), address? }.
   * Returns { token, address, expiresAt }.
   */
  verify(body) {
    let bytes;
    if (typeof body?.signedMessage === 'string' && body.signedMessage) {
      try {
        bytes = Buffer.from(body.signedMessage, 'base64');
      } catch {
        bytes = null;
      }
    } else if (typeof body?.message === 'string') bytes = Buffer.from(body.message, 'utf8');
    if (!bytes || bytes.length === 0 || bytes.length > 2_000) throw httpError(400, 'badSignIn', 'bad sign-in');
    const sig = decodeBytes(body?.signature);
    if (!sig) throw httpError(400, 'badSignIn', 'bad signature format');
    const text = bytes.toString('utf8');
    const m = parseMessage(text);
    if (!m || !m.nonce || !isAddress(m.address)) throw httpError(400, 'badSignIn', 'bad sign-in message');
    if (body?.address && body.address !== m.address) throw httpError(401, 'badSignIn', 'sign-in address');
    const row = this.db.get('SELECT address, message, expires_at, used FROM nonces WHERE nonce = ?', m.nonce);
    const t = now();
    if (!row || row.used || row.expires_at < t) throw httpError(401, 'expired', 'sign-in expired');
    if (row.address !== m.address) throw httpError(401, 'badSignIn', 'sign-in address');
    // the URI is an allowed origin and the domain is its host (the message this server wrote says exactly that)
    let uri = null;
    try {
      uri = new URL(m.uri);
    } catch {
      uri = null;
    }
    if (!uri || !this.allowed(uri.origin)) throw httpError(401, 'badSignIn', 'sign-in uri');
    if (uri.host !== m.domain) throw httpError(401, 'badSignIn', 'sign-in domain');
    if (m.version !== '1') throw httpError(401, 'badSignIn', 'sign-in version');
    if (m.chainId !== this.chainId && m.chainId !== `solana:${this.chainId}`) throw httpError(401, 'badSignIn', 'sign-in chain');
    if (m.statement !== STATEMENT) throw httpError(401, 'badSignIn', 'sign-in text');
    const issued = Date.parse(m.issuedAt ?? '');
    if (!Number.isFinite(issued) || issued > t + 60_000 || issued < t - NONCE_TTL_MS - 60_000) throw httpError(401, 'expired', 'sign-in time');
    if (m.expirationTime && Date.parse(m.expirationTime) < t) throw httpError(401, 'expired', 'sign-in expired');
    if (m.notBefore && Date.parse(m.notBefore) > t) throw httpError(401, 'badSignIn', 'sign-in not yet valid');
    const ok = nacl.sign.detached.verify(new Uint8Array(bytes), new Uint8Array(sig), new PublicKey(m.address).toBytes());
    if (!ok) throw httpError(401, 'badSignature', 'bad signature');
    const used = this.db.run('UPDATE nonces SET used = 1 WHERE nonce = ? AND used = 0', m.nonce);
    if (!used.changes) throw httpError(401, 'expired', 'sign-in expired');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = t + this.sessionMs;
    this.db.run('DELETE FROM sessions WHERE expires_at < ?', t);
    this.db.run('INSERT INTO sessions (token_hash, address, expires_at) VALUES (?, ?, ?)', sha(token), m.address, expiresAt);
    return { token, address: m.address, expiresAt };
  }

  /** The wallet of a bearer token, or null. */
  session(header) {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(String(header || ''));
    if (!m) return null;
    const row = this.db.get('SELECT address, expires_at FROM sessions WHERE token_hash = ?', sha(m[1]));
    if (!row || row.expires_at < now()) return null;
    return row.address;
  }

  logout(header) {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(String(header || ''));
    if (m) this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha(m[1]));
  }
}
