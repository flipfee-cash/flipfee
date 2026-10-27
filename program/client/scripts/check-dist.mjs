// Sanity checks on the built bundle: it imports nothing but @solana/web3.js and buffer (so it runs in Node ESM
// and in a Vite browser build), and it uses no Node-only globals.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(join(here, '../dist/index.js'), 'utf8');
const imports = [...js.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
const allowed = new Set(['@solana/web3.js', 'buffer']);
const bad = imports.filter((i) => !allowed.has(i));
if (bad.length) throw new Error(`dist imports more than web3.js and buffer: ${bad.join(', ')}`);
for (const g of ['process.', 'require(', 'node:']) {
  if (js.includes(g)) throw new Error(`dist uses a Node-only API: ${g}`);
}
console.log(`dist ok: ${js.length} bytes, imports ${[...new Set(imports)].join(', ')}`);
