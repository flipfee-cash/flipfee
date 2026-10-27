// Fetches the mainnet programs and accounts the tests clone: pump, pump_amm, pump_fees and mayhem (program ELFs
// from their ProgramData accounts) plus the global / fee-config / fee-recipient accounts their trade, fee-sharing
// and migrate instructions read. Read-only RPC only (getAccountInfo / getMultipleAccounts / getSlot); nothing is
// signed or sent. Output: fixtures/mainnet/{programs/*.so, accounts/*.json, manifest.json}. The account JSON is the
// `solana account --output json` shape that `solana-test-validator --account <addr> <file>` loads.
//
//   node scripts/fetch-mainnet.mjs            (RPC from $MAINNET_RPC or https://api.mainnet-beta.solana.com)
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PublicKey } from '@solana/web3.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../fixtures/mainnet');
const RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PUMP_FEES = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const MAYHEM = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');
const BPF_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (r.status === 429) {
      await sleep(1500 * (i + 1));
      continue;
    }
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }
  throw new Error(`${method}: rate limited`);
}

const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];
const s = (x) => Buffer.from(x);
const ata = (owner, mint, tokenProgram = TOKEN) => pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA);

const genesis = await rpc('getGenesisHash', []);
if (genesis !== MAINNET_GENESIS) throw new Error(`RPC ${RPC} is not mainnet-beta (genesis ${genesis})`);
const slot = await rpc('getSlot', [{ commitment: 'confirmed' }]);

mkdirSync(join(out, 'programs'), { recursive: true });
mkdirSync(join(out, 'accounts'), { recursive: true });

async function getMany(keys) {
  const res = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = await rpc('getMultipleAccounts', [chunk.map((k) => k.toBase58()), { encoding: 'base64', commitment: 'confirmed' }]);
    res.push(...r.value);
  }
  return res;
}

const manifest = { slot, fetchedAt: new Date().toISOString(), rpc: RPC.replace(/api-key=[^&]+/, 'api-key=…'), programs: {}, accounts: {} };

// ── programs ──
const programs = { pump: PUMP, pump_amm: PUMP_AMM, pump_fees: PUMP_FEES, mayhem: MAYHEM };
for (const [name, id] of Object.entries(programs)) {
  const [acc] = await getMany([id]);
  if (!acc || acc.owner !== BPF_UPGRADEABLE.toBase58()) throw new Error(`${name} is not an upgradeable program`);
  const pdata = new PublicKey(Buffer.from(acc.data[0], 'base64').subarray(4, 36));
  const [pd] = await getMany([pdata]);
  const raw = Buffer.from(pd.data[0], 'base64');
  const lastDeploySlot = Number(raw.readBigUInt64LE(4));
  const authority = raw[12] === 1 ? new PublicKey(raw.subarray(13, 45)).toBase58() : null;
  // The ELF without the zero padding ProgramData keeps after it: its length is the end of the section header table
  // (ELF64: e_shoff u64 @0x28, e_shentsize u16 @0x3A, e_shnum u16 @0x3C), or of the last program segment.
  const body = raw.subarray(45);
  if (body.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${name}: ProgramData does not hold an ELF`);
  const shEnd = Number(body.readBigUInt64LE(0x28)) + body.readUInt16LE(0x3a) * body.readUInt16LE(0x3c);
  const phoff = Number(body.readBigUInt64LE(0x20));
  const phentsize = body.readUInt16LE(0x36);
  let segEnd = 0;
  for (let i = 0; i < body.readUInt16LE(0x38); i++) {
    const p = phoff + i * phentsize;
    segEnd = Math.max(segEnd, Number(body.readBigUInt64LE(p + 8)) + Number(body.readBigUInt64LE(p + 32)));
  }
  const elf = body.subarray(0, Math.max(shEnd, segEnd));
  writeFileSync(join(out, 'programs', `${name}.so`), elf);
  manifest.programs[name] = {
    id: id.toBase58(),
    programData: pdata.toBase58(),
    lastDeploySlot,
    upgradeAuthority: authority,
    bytes: elf.length,
    sha256: createHash('sha256').update(elf).digest('hex'),
  };
  console.log(`program ${name} ${id.toBase58()} ${elf.length} bytes (deployed at slot ${lastDeploySlot})`);
}

// ── accounts ──
const named = {
  pump_global: pda([s('global')], PUMP),
  pump_global_volume_accumulator: pda([s('global_volume_accumulator')], PUMP),
  pump_fee_config: pda([s('fee_config'), PUMP.toBuffer()], PUMP_FEES),
  amm_fee_config: pda([s('fee_config'), PUMP_AMM.toBuffer()], PUMP_FEES),
  amm_global_config: pda([s('global_config')], PUMP_AMM),
  amm_global_volume_accumulator: pda([s('global_volume_accumulator')], PUMP_AMM),
  mayhem_global_params: pda([s('global-params')], MAYHEM),
  mayhem_sol_vault: pda([s('sol-vault')], MAYHEM),
  wsol_mint: WSOL,
  usdc_mint: USDC,
};
const [pumpGlobal, ammGlobal] = await getMany([named.pump_global, named.amm_global_config]);
const g = Buffer.from(pumpGlobal.data[0], 'base64');
const a = Buffer.from(ammGlobal.data[0], 'base64');
// pump Global (after the 8-byte discriminator): initialized u8, authority 32, fee_recipient 32, 5×u64, withdraw_authority
// 32, enable_migrate u8, pool_migration_fee u64, creator_fee_basis_points u64, fee_recipients [32;7],
// set_creator_authority 32, admin_set_creator_authority 32, create_v2_enabled u8, whitelist_pda 32,
// reserved_fee_recipient 32, mayhem_mode_enabled u8, reserved_fee_recipients [32;7], is_cashback_enabled u8,
// buyback_fee_recipients [32;8], …
let o = 8 + 1 + 32;
const keyAt = (buf, off) => new PublicKey(buf.subarray(off, off + 32));
const feeRecipient = keyAt(g, o);
o += 32 + 8 * 5;
const withdrawAuthority = keyAt(g, o);
o += 32 + 1 + 8 + 8;
const feeRecipients = [feeRecipient];
for (let i = 0; i < 7; i++) feeRecipients.push(keyAt(g, o + 32 * i));
o += 32 * 7 + 32 + 32 + 1 + 32;
const reservedFeeRecipients = [keyAt(g, o)];
o += 32 + 1;
for (let i = 0; i < 7; i++) reservedFeeRecipients.push(keyAt(g, o + 32 * i));
o += 32 * 7 + 1;
const buybackFeeRecipients = [];
for (let i = 0; i < 8; i++) buybackFeeRecipients.push(keyAt(g, o + 32 * i));
// pump_amm GlobalConfig: admin 32, lp_fee u64, protocol_fee u64, disable_flags u8, protocol_fee_recipients [32;8],
// coin_creator_fee u64, admin_set_coin_creator_authority 32, whitelist_pda 32, reserved_fee_recipient 32,
// mayhem_mode_enabled u8, reserved_fee_recipients [32;7], is_cashback_enabled u8, buyback_fee_recipients [32;8], …
let q = 8 + 32 + 8 + 8 + 1;
const protocolFeeRecipients = [];
for (let i = 0; i < 8; i++) protocolFeeRecipients.push(keyAt(a, q + 32 * i));
q += 32 * 8 + 8 + 32 + 32;
const ammReserved = [keyAt(a, q)];
q += 32 + 1;
for (let i = 0; i < 7; i++) ammReserved.push(keyAt(a, q + 32 * i));
q += 32 * 7 + 1;
const ammBuyback = [];
for (let i = 0; i < 8; i++) ammBuyback.push(keyAt(a, q + 32 * i));

const wallets = [
  withdrawAuthority,
  ...feeRecipients,
  ...reservedFeeRecipients,
  ...buybackFeeRecipients,
  ...protocolFeeRecipients,
  ...ammReserved,
  ...ammBuyback,
];
const uniq = (xs) => [...new Map(xs.map((k) => [k.toBase58(), k])).values()];
const walletAtas = uniq(wallets).map((w) => ata(w, WSOL));
const all = uniq([...Object.values(named), ...wallets, ...walletAtas]);
const infos = await getMany(all);
const names = new Map(Object.entries(named).map(([k, v]) => [v.toBase58(), k]));
for (const w of uniq(wallets)) names.set(ata(w, WSOL).toBase58(), `wsol_ata_of_${w.toBase58()}`);
for (const w of uniq(wallets)) if (!names.has(w.toBase58())) names.set(w.toBase58(), 'fee_wallet');
let saved = 0;
for (let i = 0; i < all.length; i++) {
  const key = all[i].toBase58();
  const info = infos[i];
  if (!info) {
    manifest.accounts[key] = { name: names.get(key), missing: true };
    continue;
  }
  const json = {
    pubkey: key,
    account: {
      lamports: info.lamports,
      data: info.data,
      owner: info.owner,
      executable: info.executable,
      rentEpoch: 0,
      space: Buffer.from(info.data[0], 'base64').length,
    },
  };
  writeFileSync(join(out, 'accounts', `${key}.json`), JSON.stringify(json));
  manifest.accounts[key] = { name: names.get(key), owner: info.owner, bytes: json.account.space, lamports: info.lamports };
  saved++;
}
manifest.roles = {
  feeRecipients: feeRecipients.map(String),
  reservedFeeRecipients: reservedFeeRecipients.map(String),
  buybackFeeRecipients: buybackFeeRecipients.map(String),
  withdrawAuthority: withdrawAuthority.toBase58(),
  ammProtocolFeeRecipients: protocolFeeRecipients.map(String),
  ammReservedFeeRecipients: ammReserved.map(String),
  ammBuybackFeeRecipients: ammBuyback.map(String),
};
manifest.named = Object.fromEntries(Object.entries(named).map(([k, v]) => [k, v.toBase58()]));
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`saved ${saved} accounts (${all.length - saved} missing) at slot ${slot}`);
