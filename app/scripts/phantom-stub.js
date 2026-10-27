// TESTS ONLY. A stand-in for Phantom's injected provider (window.phantom.solana), injected by Playwright with
// addInitScript; the app never ships it. It holds an ed25519 key in WebCrypto: a fresh one, or the 32-byte seed the
// test sets as window.__ffStubSeed (base64) before this script runs (a funded key on the local validator).
// It does what flipfee calls on Phantom: connect (also onlyIfTrusted), disconnect, events (connect, disconnect,
// accountChanged), signMessage, signIn (when window.__ffStubSignIn is true), signTransaction and
// signAndSendTransaction (signs the app's web3.js transaction and sends it to window.__ffTestRpc, default the page's
// /fx/rpc fixture RPC). Counters live on window.__ffTestWallet. window.__ffStubReject = 'sign' | 'tx' makes the next
// request fail like a user saying no (code 4001).
(() => {
  if (!globalThis.crypto?.subtle || location.protocol === 'about:') return;
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = (bytes) => {
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    const d = [];
    for (let i = zeros; i < bytes.length; i++) {
      let c = bytes[i];
      for (let j = 0; j < d.length; j++) {
        c += d[j] << 8;
        d[j] = c % 58;
        c = (c / 58) | 0;
      }
      while (c) {
        d.push(c % 58);
        c = (c / 58) | 0;
      }
    }
    let s = '1'.repeat(zeros);
    for (let i = d.length - 1; i >= 0; i--) s += A[d[i]];
    return s;
  };
  const b58decode = (s) => {
    const bytes = [];
    for (const ch of s) {
      let carry = A.indexOf(ch);
      if (carry < 0) throw new Error('base58');
      for (let j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }
    for (const ch of s) {
      if (ch !== '1') break;
      bytes.push(0);
    }
    return Uint8Array.from(bytes.reverse());
  };
  const b64 = (u8) => {
    let s = '';
    for (const x of u8) s += String.fromCharCode(x);
    return btoa(s);
  };
  const reject = () => Object.assign(new Error('User rejected the request.'), { code: 4001 });

  let priv = null;
  let raw = new Uint8Array(32);
  let address = '';
  const ready = (async () => {
    const seed = window.__ffStubSeed;
    if (typeof seed === 'string' && seed) {
      const s = Uint8Array.from(atob(seed), (c) => c.charCodeAt(0));
      const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...s]);
      priv = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
      const jwk = await crypto.subtle.exportKey('jwk', priv);
      raw = Uint8Array.from(atob(jwk.x.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (jwk.x.length % 4)) % 4)), (c) => c.charCodeAt(0));
    } else {
      // one key per browser context: kept in localStorage so a reload is the same wallet (like Phantom)
      let kept = localStorage.getItem('__ffStubKey');
      if (!kept) {
        const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
        const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
        kept = JSON.stringify(jwk);
        localStorage.setItem('__ffStubKey', kept);
      }
      const jwk = JSON.parse(kept);
      priv = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, true, ['sign']);
      raw = Uint8Array.from(atob(jwk.x.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (jwk.x.length % 4)) % 4)), (c) => c.charCodeAt(0));
    }
    address = b58(raw);
    window.__ffTestWallet = { address, signed: 0, signIns: 0, txs: 0, sent: [], errors: [] };
  })();
  const sign = async (bytes) => new Uint8Array(await crypto.subtle.sign('Ed25519', priv, bytes));
  const pubkey = () => ({ toBase58: () => address, toString: () => address, toBytes: () => raw, equals: (o) => o?.toBase58?.() === address });

  const listeners = {};
  const emit = (ev, arg) => (listeners[ev] || []).forEach((fn) => fn(arg));
  const TRUST = '__ffStubTrusted';
  let connected = false;

  /** Signs the app's web3.js transaction (versioned or legacy) as our key; returns the serialized bytes. */
  async function signTx(tx) {
    if (tx && tx.message && typeof tx.message.serialize === 'function' && Array.isArray(tx.signatures)) {
      // VersionedTransaction
      const msg = tx.message.serialize();
      const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
      const i = keys.indexOf(address);
      if (i < 0 || i >= tx.message.header.numRequiredSignatures) throw new Error('stub: not a signer');
      tx.signatures[i] = await sign(msg);
      return tx.serialize();
    }
    if (tx && typeof tx.serializeMessage === 'function') {
      // legacy Transaction
      const msg = tx.serializeMessage();
      const sig = await sign(msg);
      tx.addSignature(tx.feePayer && tx.feePayer.toBase58() === address ? tx.feePayer : tx.signatures.find((s) => s.publicKey.toBase58() === address).publicKey, sig);
      return tx.serialize({ requireAllSignatures: true, verifySignatures: false });
    }
    throw new Error('stub: unknown transaction');
  }

  async function send(bytes) {
    const url = window.__ffTestRpc || location.origin + '/fx/rpc';
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64(bytes), { encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: false }] }) });
    const j = await r.json();
    if (j.error) {
      window.__ffTestWallet.errors.push(j.error.message);
      throw Object.assign(new Error(j.error.message), { code: j.error.code, logs: j.error.data?.logs ?? [] });
    }
    return j.result;
  }

  const solana = {
    isPhantom: true,
    get publicKey() {
      return connected ? pubkey() : null;
    },
    get isConnected() {
      return connected;
    },
    async connect(opts) {
      await ready;
      if (opts && opts.onlyIfTrusted && !connected && localStorage.getItem(TRUST) !== '1') throw reject();
      connected = true;
      localStorage.setItem(TRUST, '1');
      emit('connect', pubkey());
      return { publicKey: pubkey() };
    },
    async disconnect() {
      connected = false;
      localStorage.removeItem(TRUST);
      emit('disconnect');
    },
    async signMessage(message) {
      await ready;
      if (window.__ffStubReject === 'sign') {
        window.__ffStubReject = null;
        throw reject();
      }
      window.__ffTestWallet.signed++;
      return { signature: await sign(message), publicKey: pubkey() };
    },
    async signTransaction(tx) {
      await ready;
      await signTx(tx);
      return tx;
    },
    async signAndSendTransaction(tx) {
      await ready;
      if (window.__ffStubReject === 'tx') {
        window.__ffStubReject = null;
        throw reject();
      }
      const bytes = await signTx(tx);
      const sig = await send(bytes);
      window.__ffTestWallet.txs++;
      window.__ffTestWallet.sent.push(sig);
      return { signature: sig, publicKey: pubkey() };
    },
    async request({ method, params }) {
      await ready;
      if (method === 'connect') return solana.connect(params);
      if (method === 'disconnect') return solana.disconnect();
      if (method === 'signMessage') return solana.signMessage(params.message);
      throw new Error('stub: unsupported ' + method);
    },
    on(ev, fn) {
      (listeners[ev] ||= []).push(fn);
    },
    off(ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn);
    },
  };
  if (window.__ffStubSignIn) {
    solana.signIn = async (input) => {
      await ready;
      // the SIWS text, as Phantom writes it from the input (the server sends the same fields)
      let m = `${input.domain} wants you to sign in with your Solana account:\n${address}`;
      if (input.statement) m += `\n\n${input.statement}`;
      const f = [];
      if (input.uri) f.push(`URI: ${input.uri}`);
      if (input.version) f.push(`Version: ${input.version}`);
      if (input.chainId) f.push(`Chain ID: ${input.chainId}`);
      if (input.nonce) f.push(`Nonce: ${input.nonce}`);
      if (input.issuedAt) f.push(`Issued At: ${input.issuedAt}`);
      if (input.expirationTime) f.push(`Expiration Time: ${input.expirationTime}`);
      if (f.length) m += `\n\n${f.join('\n')}`;
      const bytes = new TextEncoder().encode(m);
      window.__ffTestWallet.signIns++;
      return { address: pubkey(), signedMessage: bytes, signature: await sign(bytes) };
    };
  }
  window.phantom = { solana };
  // for tests: switch accounts like Phantom does
  window.__ffStubAccountChanged = () => emit('accountChanged', pubkey());
  void b58decode;
})();
