import { defineConfig } from 'tsup';

// Node ESM: dist/index.js (createKeeper, for the server) and dist/cli.js. The client source is bundled in;
// @solana/web3.js and buffer stay external (the host's copy).
export default defineConfig({
  entry: { index: 'keeper/src/index.ts', cli: 'keeper/src/cli.ts' },
  outDir: 'keeper/dist',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: { entry: { index: 'keeper/src/index.ts' } },
  clean: true,
  sourcemap: false,
  splitting: true,
  treeshake: true,
  external: ['@solana/web3.js', 'buffer'],
  tsconfig: 'keeper/tsconfig.json',
});
