// ULID (https://github.com/ulid/spec): 48-bit ms time + 80 random bits, Crockford base32, 26 chars. Monotonic within
// one process: ids made in the same ms (or with a clock step back) keep sorting in creation order.
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = -1;
let lastRand = null; // 10 bytes

function encodeTime(t) {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRand(bytes) {
  // 80 bits → 16 chars
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out = ALPHABET[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

function increment(bytes) {
  const b = Buffer.from(bytes);
  for (let i = b.length - 1; i >= 0; i--) {
    if (b[i] < 255) {
      b[i]++;
      return b;
    }
    b[i] = 0;
  }
  return randomBytes(10); // overflow of 80 bits in one ms: practically never
}

export function ulid(now = Date.now()) {
  let t = Math.floor(now);
  if (t <= lastTime) {
    t = lastTime;
    lastRand = increment(lastRand);
  } else {
    lastTime = t;
    lastRand = randomBytes(10);
  }
  return encodeTime(t) + encodeRand(lastRand);
}

/** The ms time inside a ULID (or NaN). */
export function ulidTime(id) {
  if (!isUlid(id)) return NaN;
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + ALPHABET.indexOf(ch);
  return t;
}

export const isUlid = (s) => typeof s === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
