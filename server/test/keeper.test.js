// The keeper host (src/keeper.js): off by default; with KEEPER=1 it imports program/keeper's createKeeper, hands it
// the server's paced connection, the keeper key (read from its file, never printed), the program id, the interval and
// the priority fee, starts it, reports its lines in /health and stops it with the server.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { startKeeper } from '../src/keeper.js';

process.env.LOG_QUIET = '1';

function fakeKeeperDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ffkeeper-'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'flipfee-keeper', type: 'module', exports: { '.': { import: './dist/index.js' } } }));
  writeFileSync(
    join(dir, 'dist', 'index.js'),
    `export const calls = []; export function createKeeper(o) { calls.push(o); return { started: 0, stopped: 0, start() { this.started++; o.log('keeper started: test'); o.log('crank X failed: boom'); }, async stop() { this.stopped++; }, async tick() { return { coins: 0, acted: [], skipped: 0 }; } }; }`,
  );
  return dir;
}

test('KEEPER is off by default', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.keeperOn, false);
  assert.equal(loadConfig({ KEEPER: '1' }).keeperOn, true);
});

test('the host starts createKeeper with the server’s connection, key, program, interval and priority', async () => {
  const dir = fakeKeeperDir();
  const kp = Keypair.generate();
  const keyFile = join(dir, 'keeper.json');
  writeFileSync(keyFile, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  const conn = { fake: true };
  const cfg = { keeperKeypairFile: keyFile, keeperPath: [join(dir, 'missing'), dir], keeperIntervalMs: 30_000, keeperPriorityMicroLamports: 20_000 };
  const lines = [];
  const k = await startKeeper({ cfg, rpc: { connection: () => conn }, adapter: { programId: 'Prog111' }, log: (l) => lines.push(l) });
  const { calls } = await import(join(dir, 'dist', 'index.js'));
  assert.equal(calls.length, 1);
  const o = calls[0];
  assert.equal(o.connection, conn);
  assert.equal(o.payer.publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(o.programId, 'Prog111');
  assert.equal(o.intervalMs, 30_000);
  assert.equal(o.microLamports, 20_000);
  assert.equal(k.keeper.started, 1);
  const st = k.status();
  assert.equal(st.on, true);
  assert.equal(st.signer, kp.publicKey.toBase58());
  assert.equal(st.lines, 2);
  assert.equal(st.errors, 1);
  assert.ok(lines.includes('keeper keeper started: test'));
  assert.ok(!JSON.stringify(st).includes(String(kp.secretKey[0]) + ','), 'no key material in the status');
  await k.stop();
  assert.equal(k.keeper.stopped, 1);
});

test('without a key file the keeper refuses to start', async () => {
  await assert.rejects(startKeeper({ cfg: { keeperKeypairFile: '', keeperPath: [] }, rpc: {}, adapter: {}, log() {} }), /KEEPER_KEYPAIR_FILE/);
  await assert.rejects(startKeeper({ cfg: { keeperKeypairFile: '/nope/k.json', keeperPath: [] }, rpc: {}, adapter: {}, log() {} }), /missing file/);
});
