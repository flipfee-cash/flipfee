#!/usr/bin/env node
// Motion budget (DESIGN.md §1.7: 60 fps on a mid phone): the live board at 390 px with the CPU slowed 4× (Chrome
// DevTools' "mid-tier mobile"), 12 s of trades, flips, chips and dots. Reports frame times and long tasks.
//   node scripts/perf.mjs [base=http://127.0.0.1:5197] [--rate=4]
import { launch } from './pw.mjs';

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith('http')) || 'http://127.0.0.1:5197';
const RATE = Number((args.find((a) => a.startsWith('--rate=')) || '--rate=4').slice(7));

const b = await launch();
const out = {};
for (const [label, phone] of [
  ['phone', true],
  ['desk', false],
]) {
  const ctx = await b.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=counter-total]', { timeout: 10000 });
  await page.waitForTimeout(1500);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: phone ? RATE : 1 });
  const r = await page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const frames = [];
        const longs = [];
        let last = performance.now();
        const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => longs.push(e.duration)));
        try {
          po.observe({ type: 'longtask', buffered: false });
        } catch {
          // older engines
        }
        const t0 = last;
        const flips0 = document.querySelectorAll('.fc').length;
        let flips = 0;
        const mo = new MutationObserver((m) => {
          for (const x of m) if (x.type === 'attributes' && x.target.classList?.contains('go')) flips++;
        });
        mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
        const step = (now) => {
          frames.push(now - last);
          last = now;
          if (now - t0 < ms) requestAnimationFrame(step);
          else {
            po.disconnect();
            mo.disconnect();
            const sorted = [...frames].sort((a, b) => a - b);
            const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
            resolve({
              seconds: ms / 1000,
              frames: frames.length,
              fps: +(frames.length / (ms / 1000)).toFixed(1),
              p50: +q(0.5).toFixed(1),
              p95: +q(0.95).toFixed(1),
              p99: +q(0.99).toFixed(1),
              over33ms: frames.filter((f) => f > 33.4).length,
              longTasks: longs.length,
              longestTask: Math.round(Math.max(0, ...longs)),
              tiles: flips0,
              flips,
              dots: document.querySelectorAll('.td').length,
            });
          }
        };
        requestAnimationFrame(step);
      }),
    12000,
  );
  out[label] = { cpu: phone ? `${RATE}× slower` : '1×', ...r };
  console.log(label, JSON.stringify(out[label]));
  await ctx.close();
}
await b.close();
