// Minimal little-endian Borsh reader/writer for the flipfee and pump.fun layouts (no dependencies).

import { PublicKey } from '@solana/web3.js';

export type U64Like = bigint | number | string;
export type Address = PublicKey | string;

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/** Normalizes a public key given as a string or as a PublicKey (possibly from another @solana/web3.js copy). */
export function toPublicKey(a: Address): PublicKey {
  if (a instanceof PublicKey) return a;
  if (typeof a === 'string') return new PublicKey(a);
  const k = a as { toBase58?: () => string };
  if (typeof k?.toBase58 === 'function') return new PublicKey(k.toBase58());
  throw new TypeError('expected a PublicKey or a base58 string');
}

export function toU64(v: U64Like, what = 'value'): bigint {
  const n = typeof v === 'bigint' ? v : BigInt(v);
  if (n < 0n || n > U64_MAX) throw new RangeError(`${what} is out of u64 range: ${String(v)}`);
  return n;
}

export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private off = 0;

  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }
  bytes(b: ArrayLike<number>, len?: number): this {
    if (len !== undefined && b.length !== len) throw new RangeError(`expected ${len} bytes, got ${b.length}`);
    this.buf.set(b, this.off);
    this.off += b.length;
    return this;
  }
  u8(v: number): this {
    this.view.setUint8(this.off, v);
    this.off += 1;
    return this;
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  u16(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`u16 out of range: ${v}`);
    this.view.setUint16(this.off, v, true);
    this.off += 2;
    return this;
  }
  u32(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`u32 out of range: ${v}`);
    this.view.setUint32(this.off, v, true);
    this.off += 4;
    return this;
  }
  u64(v: U64Like): this {
    this.view.setBigUint64(this.off, toU64(v), true);
    this.off += 8;
    return this;
  }
  i64(v: bigint | number): this {
    const n = BigInt(v);
    if (n < I64_MIN || n > I64_MAX) throw new RangeError(`i64 out of range: ${String(v)}`);
    this.view.setBigInt64(this.off, n, true);
    this.off += 8;
    return this;
  }
  pubkey(k: Address): this {
    return this.bytes(toPublicKey(k).toBytes(), 32);
  }
  done(): Uint8Array {
    if (this.off !== this.buf.length) throw new Error(`encoded ${this.off} bytes, expected ${this.buf.length}`);
    return this.buf;
  }
}

export class Reader {
  private view: DataView;
  off: number;

  constructor(private buf: Uint8Array, offset = 0) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.off = offset;
  }
  private need(n: number): void {
    if (this.off + n > this.buf.length) throw new RangeError(`account data too short (${this.buf.length} bytes)`);
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }
  u8(): number {
    this.need(1);
    return this.view.getUint8(this.off++);
  }
  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new RangeError(`invalid bool ${v}`);
    return v === 1;
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.off, true);
    this.off += 8;
    return v;
  }
  /** i64 as a JS number (timestamps and durations; exact up to ±2^53). */
  i64(): number {
    this.need(8);
    const v = this.view.getBigInt64(this.off, true);
    this.off += 8;
    return Number(v);
  }
  pubkey(): PublicKey {
    return new PublicKey(this.bytes(32));
  }
}

export function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function toHex(b: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i]! & 0xff).toString(16).padStart(2, '0');
  return s;
}

export function fromHex(h: string): Uint8Array {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new TypeError('invalid hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** 32 bytes from a Uint8Array, a number[] or a hex string (salts, commitments). */
export function toBytes32(v: Uint8Array | number[] | string, what = 'value'): Uint8Array {
  const b = typeof v === 'string' ? fromHex(v) : Uint8Array.from(v);
  if (b.length !== 32) throw new RangeError(`${what} must be 32 bytes, got ${b.length}`);
  return b;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 (for getProgramAccounts memcmp filters). */
export function base58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  return '1'.repeat(zeros) + s;
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from((globalThis as unknown as { Buffer: { from(s: string, e: string): Uint8Array } }).Buffer.from(b64, 'base64'));
}
