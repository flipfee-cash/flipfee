#!/usr/bin/env node
/**
 * Copy checker for flipfee's UI text.
 * Usage: node scripts/copycheck.mjs src/copy.ts [more files...]
 *
 * Checks every user-facing string literal:
 *  - reading level: Flesch-Kincaid grade per sentence (technical terms count as 1 syllable)
 *  - banned words: negations, contrasts, hype
 *  - exclamation marks
 * Exit code 1 when a rule fails, so `npm run copy` can gate a build.
 */
import { readFileSync } from 'node:fs';

const MAX_SENTENCE_GRADE = 4.0; // a single sentence may reach grade 4
const MAX_AVG_GRADE = 3.0;      // the average must stay at grade 3 or below

// Technical terms and names: allowed, and counted as one syllable.
const TECH = new Set([
  'sol', 'usd', 'usdc', 'token', 'tokens', 'bonding', 'curve', 'market', 'cap', 'mcap', 'chain', 'onchain', 'wallet', 'wallets',
  'creator', 'creators', 'hourly', 'holder', 'holders', 'percent', 'minute', 'ticker', 'graduated', 'graduate', 'liquidity',
  'pool', 'pools', 'fee', 'fees', 'payout', 'payouts', 'volume', 'return', 'returns', 'dev', 'devs', 'ca', 'phantom',
  'pump', 'pumpswap', 'solscan', 'dexscreener', 'flipfee', 'vault', 'backtest', 'median', 'crank', 'keeper', 'x',
]);

// Strings chosen word for word: the reading-level check skips them (banned words and "!" still apply).
const APPROVED = new Set([
  'and tradable on flipfee',
  'Flip fees into cash.',
]);

const BANNED = [
  // negations
  'no', 'not', 'never', 'none', 'nothing', 'nobody', 'nowhere', 'without', 'neither', 'nor', 'cannot',
  "don't", "doesn't", "isn't", "aren't", "can't", "won't", "wasn't", "weren't", "didn't", "haven't", "hasn't", "shouldn't",
  // contrasts
  'but', 'however', 'although', 'though', 'instead', 'unlike', 'rather', 'whereas', 'yet',
  // hype
  'moon', 'mooning', 'rocket', 'lfg', 'insane', '100x', '1000x', 'wagmi', 'gm', 'ape', 'aping', 'degen', 'pump', 'pumping',
];

function extractStrings(src) {
  const out = [];
  // strip comments
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(code))) {
    let s = m[2].replace(/\$\{[^}]*\}/g, '12').replace(/\\n/g, ' ').trim();
    if (!/[a-z]{2,}/i.test(s)) continue;          // skip symbols, numbers, keys
    if (/^[a-z0-9_.:/#-]+$/.test(s) && !/\s/.test(s)) continue; // skip ids, routes, css tokens
    out.push(s);
  }
  return out;
}

function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (TECH.has(w)) return 1;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

function grade(sentence) {
  const words = sentence.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length === 0) return 0;
  const syl = words.reduce((a, w) => a + syllables(w), 0);
  // One sentence at a time: FK grade.
  return 0.39 * words.length + 11.8 * (syl / words.length) - 15.59;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node copycheck.mjs <file.ts> [...]');
  process.exit(2);
}

let fail = false;
const grades = [];
for (const f of files) {
  const strings = extractStrings(readFileSync(f, 'utf8'));
  for (const s of strings) {
    const lower = s.toLowerCase();
    const words = lower.split(/[^a-z0-9'&]+/).filter(Boolean);
    const banned = words.filter((w) => BANNED.includes(w));
    if (banned.length) {
      fail = true;
      console.log(`BANNED  ${JSON.stringify(banned)}  "${s}"`);
    }
    if ((s.match(/!/g) || []).length > 0) {
      fail = true; // the brief allows zero exclamation marks
      console.log(`EXCLAIM "${s}"`);
    }
    if (APPROVED.has(s)) continue;
    for (const sent of s.split(/(?<=[.?!])\s+/)) {
      if (sent.split(/\s+/).length < 3) continue; // labels and buttons are fine
      const g = grade(sent);
      grades.push(g);
      if (g > MAX_SENTENCE_GRADE) {
        fail = true;
        console.log(`GRADE ${g.toFixed(1)}  "${sent}"`);
      }
    }
  }
}
const avg = grades.length ? grades.reduce((a, b) => a + b, 0) / grades.length : 0;
console.log(`\n${grades.length} sentences · average grade ${avg.toFixed(2)} (limit ${MAX_AVG_GRADE})`);
if (avg > MAX_AVG_GRADE) fail = true;
console.log(fail ? 'COPY CHECK: FAIL' : 'COPY CHECK: PASS');
process.exit(fail ? 1 : 0);
