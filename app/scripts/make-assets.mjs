#!/usr/bin/env node
// Renders public/og.png (1200×630), the PNG icons and site.webmanifest from HTML with the app's own fonts and tiles.
//   node scripts/make-assets.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './pw.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
const font = (p) => 'data:font/woff2;base64,' + readFileSync(APP + 'node_modules/@fontsource-variable/' + p).toString('base64');
const MONO = font('martian-mono/files/martian-mono-latin-standard-normal.woff2');
const SANS = font('archivo/files/archivo-latin-standard-normal.woff2');
// the lines come from src/copy.ts (the og image says what the page says)
const src = readFileSync(APP + 'src/copy.ts', 'utf8');
const pick = (k) => new RegExp(`${k}: '([^']+)'`).exec(src)[1].replace(/’/g, '’');
const trader = pick('trader');
const traderSub = pick('traderSub');
const line = pick('line');

const css = `
@font-face{font-family:M;src:url(${MONO});font-weight:100 800;font-stretch:75% 112.5%}
@font-face{font-family:A;src:url(${SANS});font-weight:100 900;font-stretch:62% 125%}
*{box-sizing:border-box}html,body{margin:0}
body{background:#0a0b0a;background-image:radial-gradient(90% 70% at 30% -10%,rgba(239,235,225,.06),transparent 70%),radial-gradient(circle at 1px 1px,rgba(239,235,225,.06) .8px,transparent 1.2px);background-size:100% 100%,8px 8px;color:#efebe1;font-family:A}
.t{display:inline-flex;gap:6px}.c{position:relative;width:var(--w);height:var(--h);border-radius:calc(var(--h)*.11);background:linear-gradient(#262a27 0 50%,#1c1f1d 50%);display:grid;place-items:center;font:700 var(--f)/1 M;font-stretch:75%;color:var(--ink,#efebe1);box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 2px 0 #000}
.c::after{content:"";position:absolute;left:0;right:0;top:50%;height:2px;margin-top:-1px;background:#050605}
`;

const og = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body{width:1200px;height:630px;padding:70px 80px;display:flex;flex-direction:column;justify-content:space-between}
.mark{display:flex;align-items:center;gap:18px}.cash{font:700 44px M;font-stretch:75%;color:#7ee28c}
h1{margin:0;font:780 60px/1.04 A;font-stretch:86%;letter-spacing:-.025em;max-width:1060px}h1 span{display:block;color:#7ee28c;margin-top:8px}
.row{display:flex;align-items:flex-end;justify-content:space-between}.line{font:700 26px M;font-stretch:75%;color:#8b9088}
.num{display:flex;align-items:center;gap:14px}.num i{font:700 34px M;font-stretch:75%;color:#7ee28c;font-style:normal}
</style></head><body>
<div class="mark"><span class="t" style="--w:64px;--h:92px;--f:62px">${'FLIPFEE'.split('').map((c) => `<span class="c">${c}</span>`).join('')}</span><span class="cash">.cash</span></div>
<h1>${trader}<span>${traderSub}</span></h1>
<div class="row"><span class="line">${line}</span><span class="num"><span class="t" style="--w:46px;--h:66px;--f:44px;--ink:#7ee28c">${'+0.184'.split('').map((c) => `<span class="c">${c}</span>`).join('')}</span><i>SOL</i></span></div>
</body></html>`;

const icon = (size, pad = 0.12) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body{width:${size}px;height:${size}px;display:grid;place-items:center;background:#0a0b0a;border-radius:0}
</style></head><body><span class="t"><span class="c" style="--w:${Math.round(size * (1 - pad * 2) * 0.72)}px;--h:${Math.round(size * (1 - pad * 2))}px;--f:${Math.round(size * 0.66)}px;--ink:#7ee28c">F</span></span></body></html>`;

const b = await launch();
const shot = async (html, w, h, out) => {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(html, { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(150);
  await p.screenshot({ path: APP + 'public/' + out, omitBackground: false });
  await p.close();
  console.log('public/' + out);
};
await shot(og, 1200, 630, 'og.png');
await shot(icon(180), 180, 180, 'apple-touch-icon.png');
await shot(icon(192), 192, 192, 'icon-192.png');
await shot(icon(512), 512, 512, 'icon-512.png');
await shot(icon(32, 0.06), 32, 32, 'favicon-32.png');
await b.close();
writeFileSync(
  APP + 'public/site.webmanifest',
  JSON.stringify(
    {
      name: 'flipfee',
      short_name: 'flipfee',
      description: `${trader} ${traderSub}`,
      start_url: '/',
      display: 'standalone',
      background_color: '#0a0b0a',
      theme_color: '#0a0b0a',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log('public/site.webmanifest');
