// Sign-In With Solana: the message format, the ed25519 check, single-use nonces, domain/URI/chain binding, sessions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Auth, buildMessage, parseMessage, STATEMENT } from '../src/auth.js';
import { Db } from '../src/db.js';

const SITE = 'https://flipfee.cash';
const DEV = 'http://127.0.0.1:5197';
const mk = (o = {}) => new Auth(new Db(':memory:'), { origins: [SITE], chainId: 'mainnet', ...o });
// in-memory throwaway keys for this test run only
const user = () => Keypair.generate();
const sign = (kp, text) => bs58.encode(nacl.sign.detached(Buffer.from(text, 'utf8'), kp.secretKey));

test('the message: Wallet Standard SIWS text, parsed back field by field', () => {
  const f = { domain: 'flipfee.cash', address: user().publicKey.toBase58(), statement: STATEMENT, uri: SITE, version: '1', chainId: 'mainnet', nonce: 'abc12345', issuedAt: '2026-10-05T00:00:00.000Z', expirationTime: '2026-10-05T00:10:00.000Z' };
  const text = buildMessage(f);
  assert.match(text, /^flipfee\.cash wants you to sign in with your Solana account:\n[1-9A-HJ-NP-Za-km-z]{32,44}\n\nSign in to flipfee\.\n/);
  assert.equal(STATEMENT, 'Sign in to flipfee.');
  assert.match(text, /\n\nURI: https:\/\/flipfee\.cash\nVersion: 1\nChain ID: mainnet\nNonce: abc12345\nIssued At: /);
  assert.deepEqual(parseMessage(text), f);
  assert.equal(parseMessage('evil text'), null);
  assert.equal(parseMessage(text.replace('Nonce:', 'Nonse:')), null, 'unknown field');
});

test('sign in once (signMessage flow, base58 signature), then the bearer token names the wallet', () => {
  const auth = mk();
  const kp = user();
  const a = kp.publicKey.toBase58();
  const { message, input } = auth.challenge(a, SITE);
  assert.equal(input.domain, 'flipfee.cash');
  assert.equal(input.chainId, 'mainnet');
  assert.equal(input.address, a);
  const s = auth.verify({ message, signature: sign(kp, message) });
  assert.equal(s.address, a);
  assert.equal(auth.session(`Bearer ${s.token}`), a);
  assert.ok(s.expiresAt > Date.now() + 23 * 3_600_000);
  assert.equal(auth.session('Bearer nope-nope-nope-nope-nope'), null);
  assert.equal(auth.session(undefined), null);
});

test('signIn flow: signedMessage bytes in base64 and a base64 signature', () => {
  const auth = mk();
  const kp = user();
  const { input } = auth.challenge(kp.publicKey.toBase58(), SITE);
  const text = buildMessage(input); // what the wallet builds from the input
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(text), kp.secretKey)).toString('base64');
  const s = auth.verify({ signedMessage: Buffer.from(text).toString('base64'), signature: sig, address: kp.publicKey.toBase58() });
  assert.equal(s.address, kp.publicKey.toBase58());
});

test('a nonce works once', () => {
  const auth = mk();
  const kp = user();
  const { message } = auth.challenge(kp.publicKey.toBase58(), SITE);
  const sig = sign(kp, message);
  auth.verify({ message, signature: sig });
  assert.throws(() => auth.verify({ message, signature: sig }), /expired/);
});

test('another wallet cannot use the message; an edited message fails', () => {
  const auth = mk();
  const kp = user();
  const other = user();
  const { message } = auth.challenge(kp.publicKey.toBase58(), SITE);
  assert.throws(() => auth.verify({ message, signature: sign(other, message) }), /bad signature/);
  for (const [from, to, why] of [
    ['flipfee.cash wants you', 'evil.example wants you', /sign-in domain/],
    [`URI: ${SITE}`, 'URI: https://evil.example', /sign-in uri/],
    ['Chain ID: mainnet', 'Chain ID: devnet', /sign-in chain/],
    ['Version: 1', 'Version: 2', /sign-in version/],
    [STATEMENT, 'Sign in to something else.', /sign-in text/],
  ]) {
    const k = user();
    const { message: m } = auth.challenge(k.publicKey.toBase58(), SITE);
    const edited = m.replace(from, to);
    assert.notEqual(edited, m);
    assert.throws(() => auth.verify({ message: edited, signature: sign(k, edited) }), why);
  }
  // the address line swapped for another wallet that signs: the nonce belongs to the first one
  const k1 = user();
  const k2 = user();
  const { message: m1 } = auth.challenge(k1.publicKey.toBase58(), SITE);
  const swapped = m1.replace(k1.publicKey.toBase58(), k2.publicKey.toBase58());
  assert.throws(() => auth.verify({ message: swapped, signature: sign(k2, swapped) }), /sign-in address/);
});

test('expired nonces and sessions', () => {
  const auth = mk();
  const kp = user();
  const { message, nonce } = auth.challenge(kp.publicKey.toBase58(), SITE);
  auth.db.run('UPDATE nonces SET expires_at = 1 WHERE nonce = ?', nonce);
  assert.throws(() => auth.verify({ message, signature: sign(kp, message) }), /expired/);
  const k2 = user();
  const c2 = auth.challenge(k2.publicKey.toBase58(), SITE);
  const s = auth.verify({ message: c2.message, signature: sign(k2, c2.message) });
  auth.db.run('UPDATE sessions SET expires_at = 1');
  assert.equal(auth.session(`Bearer ${s.token}`), null);
});

test('domain from config: flipfee.cash in production; the request origin among the allowed ones; localhost in dev', () => {
  const prod = mk();
  const a = user().publicKey.toBase58();
  assert.equal(parseMessage(prod.challenge(a, 'https://evil.example').message).domain, 'flipfee.cash', 'a foreign origin gets the canonical site');
  assert.equal(parseMessage(prod.challenge(a).message).domain, 'flipfee.cash');
  const dev = mk({ origins: [DEV], chainId: 'devnet', devAnyLocal: true });
  const m = parseMessage(dev.challenge(a, 'http://localhost:5197').message);
  assert.equal(m.domain, 'localhost:5197');
  assert.equal(m.uri, 'http://localhost:5197');
  assert.equal(m.chainId, 'devnet');
  assert.throws(() => prod.challenge('not-an-address', SITE), /bad address/);
  assert.throws(() => prod.verify({ message: 'x', signature: 'y' }), /bad/);
});
