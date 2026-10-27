// Copies the program builder's built client and keeper into server/vendor/ (what a deploy ships with the server):
//   flipfee/program/client/{package.json, README.md, idl/, dist/}  → vendor/flipfee-client/
//   flipfee/program/keeper/{package.json, dist/}                    → vendor/flipfee-keeper/
// Their imports of @solana/web3.js and buffer then resolve from the server's own node_modules. Build them first
// (in flipfee/program: npm run build:client, npm run build:keeper). Read-only on the program tree.
//   npm run vendor
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const program = resolve(root, '..', 'program');
const out = join(root, 'vendor');

function copy(from, to, parts) {
  if (!existsSync(join(from, 'dist'))) {
    console.log(`skip ${from}: no dist/ (build it in flipfee/program first)`);
    return false;
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const p of parts) if (existsSync(join(from, p))) cpSync(join(from, p), join(to, p), { recursive: true });
  console.log(`copied ${from} → ${to}`);
  return true;
}

// a hash of every file of a directory (a build split into chunks changes in its chunks)
const sha = (f) => {
  if (!existsSync(f)) return null;
  const h = createHash('sha256');
  const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).sort().forEach((x) => walk(join(p, x))) : h.update(readFileSync(p)));
  walk(f);
  return h.digest('hex').slice(0, 16);
};
const manifest = { copiedAt: new Date().toISOString() };
if (copy(join(program, 'client'), join(out, 'flipfee-client'), ['package.json', 'README.md', 'idl', 'dist'])) manifest.client = { dist: sha(join(out, 'flipfee-client', 'dist')), idl: sha(join(out, 'flipfee-client', 'idl', 'flipfee.json')) };
if (copy(join(program, 'keeper'), join(out, 'flipfee-keeper'), ['package.json', 'README.md', 'dist'])) manifest.keeper = { dist: sha(join(out, 'flipfee-keeper', 'dist')) };
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(JSON.stringify(manifest));
