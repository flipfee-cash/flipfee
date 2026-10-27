// Playwright for the scripts: playwright-core + Chrome for Testing (PLAYWRIGHT_FROM points at a package.json
// that has playwright-core; CHROME at the browser binary).
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';

const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
export const { chromium } = require('playwright-core');

function findChrome() {
  const base = (process.env.PLAYWRIGHT_BROWSERS_PATH || `${process.env.HOME}/Library/Caches/ms-playwright`) + '/';
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    const p = `${base}${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    if (existsSync(p)) return p;
  }
  return undefined;
}
export const CHROME = process.env.CHROME || findChrome();
export const launch = (o = {}) => chromium.launch({ executablePath: CHROME, ...o });
