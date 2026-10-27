#!/usr/bin/env node
// Quick screenshots while building: node scripts/shot.mjs <path> <name> [--phone] [--wait=ms] [--cookie=fx=empty] [--full]
import { mkdirSync } from 'node:fs';
import { launch } from './pw.mjs';

const args = process.argv.slice(2);
const path = args.find((a) => a.startsWith('/')) || '/';
const name = args.filter((a) => !a.startsWith('-') && !a.startsWith('/'))[0] || 'shot';
const phone = args.includes('--phone');
const full = args.includes('--full');
const wait = Number((args.find((a) => a.startsWith('--wait=')) || '--wait=2500').slice(7));
const cookie = (args.find((a) => a.startsWith('--cookie=')) || '').slice(9);
const base = process.env.BASE || 'http://127.0.0.1:5197';
const out = new URL('../.shots/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const b = await launch();
const ctx = await b.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
if (cookie) {
  const [k, v] = cookie.split('=');
  await ctx.addCookies([{ name: k, value: v, url: base }]);
}
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await p.goto(base + path, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(wait);
await p.screenshot({ path: `${out}${name}.png`, fullPage: full });
console.log(`${out}${name}.png`, errs.length ? 'ERRORS: ' + errs.slice(0, 5).join(' | ') : 'no errors');
await b.close();
