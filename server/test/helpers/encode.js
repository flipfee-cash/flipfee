// Test helper: Borsh encoding driven by an Anchor IDL (the mirror of src/chain/borsh.js), to build program accounts
// and events exactly as the program would write them.
import bs58 from 'bs58';

export class IdlEncoder {
  constructor(idl) {
    this.types = new Map((idl.types ?? []).map((t) => [t.name, t]));
    this.accounts = new Map((idl.accounts ?? []).map((a) => [a.name, Buffer.from(a.discriminator)]));
    this.events = new Map((idl.events ?? []).map((e) => [e.name, Buffer.from(e.discriminator)]));
  }

  account(name, value) {
    return Buffer.concat([this.accounts.get(name), this.encode({ defined: { name } }, value)]);
  }

  event(name, value) {
    return Buffer.concat([this.events.get(name), this.encode({ defined: { name } }, value)]);
  }

  /** "Program data: …" log lines of events, wrapped in the program's invoke/success lines. */
  logs(programId, events) {
    return [`Program ${programId} invoke [1]`, 'Program log: Instruction: X', ...events.map(([n, v]) => `Program data: ${this.event(n, v).toString('base64')}`), `Program ${programId} consumed 1000 of 200000 compute units`, `Program ${programId} success`];
  }

  encode(type, v) {
    if (typeof type === 'string') return this.prim(type, v);
    if (type.vec) {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(v.length);
      return Buffer.concat([len, ...v.map((x) => this.encode(type.vec, x))]);
    }
    if (type.option) return v === null || v === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), this.encode(type.option, v)]);
    if (type.array) return Buffer.concat(v.map((x) => this.encode(type.array[0], x)));
    if (type.defined) {
      const def = this.types.get(type.defined.name ?? type.defined).type;
      if (def.kind === 'struct') return Buffer.concat(def.fields.map((f) => this.encode(f.type, v[f.name])));
      if (def.kind === 'enum') {
        const i = def.variants.findIndex((x) => x.name === (typeof v === 'string' ? v : v.kind));
        return Buffer.from([i]);
      }
    }
    throw new Error(`encode: ${JSON.stringify(type)}`);
  }

  prim(t, v) {
    const b = (n) => Buffer.alloc(n);
    switch (t) {
      case 'bool':
        return Buffer.from([v ? 1 : 0]);
      case 'u8':
        return Buffer.from([v]);
      case 'u16': {
        const x = b(2);
        x.writeUInt16LE(v);
        return x;
      }
      case 'u32': {
        const x = b(4);
        x.writeUInt32LE(v);
        return x;
      }
      case 'u64': {
        const x = b(8);
        x.writeBigUInt64LE(BigInt(v));
        return x;
      }
      case 'i64': {
        const x = b(8);
        x.writeBigInt64LE(BigInt(v));
        return x;
      }
      case 'u128':
      case 'i128': {
        const x = b(16);
        const n = BigInt.asUintN(128, BigInt(v));
        x.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
        x.writeBigUInt64LE(n >> 64n, 8);
        return x;
      }
      case 'pubkey':
        return Buffer.from(bs58.decode(v));
      case 'string': {
        const s = Buffer.from(v, 'utf8');
        const x = b(4);
        x.writeUInt32LE(s.length);
        return Buffer.concat([x, s]);
      }
      default:
        throw new Error(`encode: ${t}`);
    }
  }
}
