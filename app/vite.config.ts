import { defineConfig } from 'vite';
import type { PluginOption, ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixturePlugin } from './dev/fixturePlugin.ts';

/**
 * The app reads only the real API (`/api`, DESIGN.md §2.2).
 *   npm run dev          /api → the flipfee server on 127.0.0.1:5295 (FLIPFEE_API overrides)
 *   npm run dev:fixture  /api → a synthetic world (dev/fixturePlugin.ts; dev server only) with a fake RPC at /fx/rpc
 *   npm run preview      the production build with /api → the real server
 * The fixture never reaches a build: the plugin is `apply: 'serve'`, `__FF_FIXTURE__` is false in a build, and nothing
 * in src/ imports dev/.
 *
 * Transactions use the program builder's TS client (../program/client/dist, built by `npm run build:client` in
 * flipfee/program), bundled in its own chunk that loads when a transaction starts. Without that build the app still
 * builds; Buy and Connect then say "You can buy soon."
 */
const API = process.env.FLIPFEE_API || 'http://127.0.0.1:5295';
const FIXTURE = process.env.FLIPFEE_FIXTURE === '1';
const CLIENT_DIST = fileURLToPath(new URL('../program/client/dist/index.js', import.meta.url));
const HAS_CLIENT = existsSync(CLIENT_DIST);

const proxy: Record<string, ProxyOptions> = {
  '/api': {
    target: API,
    changeOrigin: !!process.env.FLIPFEE_API,
    // SSE: keep the stream open and unbuffered
    timeout: 0,
    proxyTimeout: 0,
    configure: (p) => {
      p.on('proxyRes', (res) => {
        if (String(res.headers['content-type'] || '').includes('text/event-stream')) {
          res.headers['cache-control'] = 'no-cache, no-transform';
          res.headers['x-accel-buffering'] = 'no';
        }
      });
    },
  },
};

export default defineConfig(({ command }) => {
  const fixture = command === 'serve' && FIXTURE;
  const plugins: PluginOption[] = [react()];
  if (fixture) plugins.push(fixturePlugin());
  return {
    base: '/',
    define: {
      __FF_FIXTURE__: JSON.stringify(fixture),
      __FF_CLIENT__: JSON.stringify(HAS_CLIENT),
    },
    plugins,
    resolve: {
      alias: HAS_CLIENT ? { 'flipfee-client': CLIENT_DIST } : ({} as Record<string, string>),
      // the client's own imports resolve to the app's copy (one web3.js in the bundle)
      dedupe: ['@solana/web3.js', 'buffer'],
    },
    server: { port: 5197, strictPort: true, host: '127.0.0.1', proxy: fixture ? undefined : proxy, fs: { allow: ['..'] } },
    preview: { port: 5198, strictPort: true, host: '127.0.0.1', proxy },
    build: {
      target: 'es2022',
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 700,
    },
  };
});
