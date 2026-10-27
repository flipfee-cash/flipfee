// Unit tests of the keeper's decision: which coins need a sweep, a distribute, a crank. Run: npm run test:keeper
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PublicKey } from '@solana/web3.js';

import { planCoin } from '../dist/index.js';

const K = (n) => new PublicKey(new Uint8Array(32).fill(n));
const RENT = 650_240n;
const coin = (over = {}) => ({
  mint: K(1), owner: K(2), bump: 255, vaultBump: 254, price: 10_000_000n, maxAhead: 86_400, paused: false,
  lastSync: 1_000, ownerOwed: 0n, credited: 0n, windows: [], feesIn: 0n, sales: 0n, hoursSold: 0, paidOut: 0n, ...over,
});
const state = (over = {}) => ({ now: 1_060, vaultLamports: RENT, pumpVaultLamports: RENT, ammPending: 0n, rentMin: RENT, minPending: 10_000n, ...over });

test('nothing to do: skipped', () => {
  assert.deepEqual(planCoin(coin(), state()), { sweep: false, distribute: false, crank: false, why: [] });
  // pump fees below the threshold wait
  assert.equal(planCoin(coin(), state({ pumpVaultLamports: RENT + 9_999n })).crank, false);
  // no pump creator vault yet (no trade since joining)
  assert.equal(planCoin(coin(), state({ pumpVaultLamports: 0n })).crank, false);
});

test('pump fees waiting: distribute + crank', () => {
  const p = planCoin(coin(), state({ pumpVaultLamports: RENT + 10_000n }));
  assert.deepEqual([p.sweep, p.distribute, p.crank], [false, true, true]);
});

test('AMM fees waiting (graduated): sweep + distribute + crank, whatever the amount', () => {
  const p = planCoin(coin(), state({ ammPending: 1n }));
  assert.deepEqual([p.sweep, p.distribute, p.crank], [true, true, true]);
});

test('money already in the vault or owed: crank without pump calls', () => {
  let p = planCoin(coin(), state({ vaultLamports: RENT + 5n }));
  assert.deepEqual([p.sweep, p.distribute, p.crank], [false, false, true]);
  p = planCoin(coin({ credited: 7n, ownerOwed: 7n }), state({ vaultLamports: RENT + 7n }));
  assert.deepEqual([p.distribute, p.crank], [false, true]);
});

test('window edges and finished windows trigger a crank', () => {
  const w = (start, end, owed = 0n) => ({ holder: K(9), start, end, owed, earned: 0n });
  // a window started since the last sync
  assert.equal(planCoin(coin({ windows: [w(1_030, 4_630)] }), state()).crank, true);
  // a window ended since the last sync
  assert.equal(planCoin(coin({ lastSync: 4_000, windows: [w(1_030, 4_630)] }), state({ now: 4_700 })).crank, true);
  // a live window with nothing new: skipped
  assert.equal(planCoin(coin({ lastSync: 1_040, windows: [w(1_030, 4_630)] }), state()).crank, false);
  // an ended, paid window waiting to be dropped
  assert.equal(planCoin(coin({ lastSync: 5_000, windows: [w(1_030, 4_630)] }), state({ now: 5_010 })).crank, true);
});
