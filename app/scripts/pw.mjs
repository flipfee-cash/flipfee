// Playwright from the shared install (like peek-sol's smoke): playwright-core + Chrome for Testing.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';

const require = createRequire('/Users/ettrq/lp1/pickaxe/package.json');
export const { chromium } = require('playwright-core');

function findChrome() {
  const base = '/Users/ettrq/Library/Caches/ms-playwright/';
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    const p = `${base}${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    if (existsSync(p)) return p;
  }
  return undefined;
}
export const CHROME = process.env.CHROME || findChrome();
export const launch = (o = {}) => chromium.launch({ executablePath: CHROME, ...o });
