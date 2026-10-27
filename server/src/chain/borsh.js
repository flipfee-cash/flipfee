// A small Borsh decoder driven by an Anchor IDL (the 0.30+ format: `accounts` / `events` with 8-byte discriminators,
// layouts in `types`). Used for the flipfee program before (and besides) its TS client, and by the tests to check the
// hand-written pump event decoders against pump's own IDLs. 64/128-bit integers decode to BigInt.
import bs58 from 'bs58';

const SIZES = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8, u128: 16, i128: 16, pubkey: 32 };

export class IdlCoder {
  constructor(idl) {
    this.idl = idl;
    this.types = new Map((idl.types ?? []).map((t) => [t.name, t]));
    this.accounts = (idl.accounts ?? []).map((a) => ({ name: a.name, disc: Buffer.from(a.discriminator) }));
    this.events = (idl.events ?? []).map((e) => ({ name: e.name, disc: Buffer.from(e.discriminator) }));
  }

  /** { name, data } of an account by its discriminator, or null. */
  account(buf) {
    const a = this.accounts.find((x) => buf.length >= 8 && buf.subarray(0, 8).equals(x.disc));
    if (!a) return null;
    return { name: a.name, data: this.decodeType({ defined: { name: a.name } }, buf, { o: 8 }) };
  }

  /** { name, data } of an event ("Program data:" bytes) by its discriminator, or null. */
  event(buf) {
    const e = this.events.find((x) => buf.length >= 8 && buf.subarray(0, 8).equals(x.disc));
    if (!e) return null;
    return { name: e.name, data: this.decodeType({ defined: { name: e.name } }, buf, { o: 8 }) };
  }

  decodeType(type, buf, cur) {
    if (typeof type === 'string') return this.prim(type, buf, cur);
    if (type.vec) {
      const n = buf.readUInt32LE(cur.o);
      cur.o += 4;
      if (type.vec === 'u8') {
        const v = buf.subarray(cur.o, cur.o + n);
        cur.o += n;
        return Buffer.from(v);
      }
      const out = [];
      for (let i = 0; i < n; i++) out.push(this.decodeType(type.vec, buf, cur));
      return out;
    }
    if (type.option || type.coption) {
      const tag = type.option ? buf[cur.o] : buf.readUInt32LE(cur.o);
      cur.o += type.option ? 1 : 4;
      if (!tag) return null;
      return this.decodeType(type.option ?? type.coption, buf, cur);
    }
    if (type.array) {
      const [inner, n] = type.array;
      if (inner === 'u8') {
        const v = buf.subarray(cur.o, cur.o + n);
        cur.o += n;
        return Buffer.from(v);
      }
      const out = [];
      for (let i = 0; i < n; i++) out.push(this.decodeType(inner, buf, cur));
      return out;
    }
    if (type.defined) {
      const name = typeof type.defined === 'string' ? type.defined : type.defined.name;
      const def = this.types.get(name);
      if (!def) throw new Error(`idl: unknown type ${name}`);
      return this.decodeDef(def.type, buf, cur);
    }
    throw new Error(`idl: unsupported type ${JSON.stringify(type)}`);
  }

  decodeDef(def, buf, cur) {
    if (def.kind === 'struct') {
      const out = {};
      for (const f of def.fields ?? []) out[f.name] = this.decodeType(f.type, buf, cur);
      return out;
    }
    if (def.kind === 'enum') {
      const i = buf[cur.o];
      cur.o += 1;
      const v = def.variants[i];
      if (!v) throw new Error(`idl: bad enum variant ${i}`);
      if (!v.fields?.length) return { kind: v.name };
      const out = { kind: v.name };
      v.fields.forEach((f, k) => {
        if (typeof f === 'object' && f.name) out[f.name] = this.decodeType(f.type, buf, cur);
        else out[k] = this.decodeType(f, buf, cur);
      });
      return out;
    }
    throw new Error(`idl: unsupported kind ${def.kind}`);
  }

  prim(t, buf, cur) {
    const o = cur.o;
    if (t === 'string') {
      const n = buf.readUInt32LE(o);
      cur.o += 4 + n;
      return buf.toString('utf8', o + 4, o + 4 + n);
    }
    if (t === 'bytes') {
      const n = buf.readUInt32LE(o);
      cur.o += 4 + n;
      return Buffer.from(buf.subarray(o + 4, o + 4 + n));
    }
    const size = SIZES[t];
    if (!size) throw new Error(`idl: unsupported primitive ${t}`);
    if (o + size > buf.length) throw new RangeError(`idl: ${t} past the end`);
    cur.o += size;
    switch (t) {
      case 'bool':
        return buf[o] === 1;
      case 'u8':
        return buf[o];
      case 'i8':
        return buf.readInt8(o);
      case 'u16':
        return buf.readUInt16LE(o);
      case 'i16':
        return buf.readInt16LE(o);
      case 'u32':
        return buf.readUInt32LE(o);
      case 'i32':
        return buf.readInt32LE(o);
      case 'f32':
        return buf.readFloatLE(o);
      case 'f64':
        return buf.readDoubleLE(o);
      case 'u64':
        return buf.readBigUInt64LE(o);
      case 'i64':
        return buf.readBigInt64LE(o);
      case 'u128':
        return buf.readBigUInt64LE(o) | (buf.readBigUInt64LE(o + 8) << 64n);
      case 'i128':
        return BigInt.asIntN(128, buf.readBigUInt64LE(o) | (buf.readBigUInt64LE(o + 8) << 64n));
      case 'pubkey':
        return bs58.encode(buf.subarray(o, o + 32));
      default:
        throw new Error(`idl: ${t}`);
    }
  }
}
