import { defineConfig } from 'tsup';

// One ESM file + one .d.ts. @solana/web3.js and buffer stay external so the app and the server use their own copy.
export default defineConfig({
  entry: { index: 'client/src/index.ts' },
  outDir: 'client/dist',
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  external: ['@solana/web3.js', 'buffer'],
  tsconfig: 'client/tsconfig.json',
});
