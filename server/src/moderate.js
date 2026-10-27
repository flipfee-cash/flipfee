// Hate slurs in text other people read. Call notes: refused when posted, hidden when read. Coin names and tickers:
// the word is masked, and feed events and AI picks skip the coin. Coin descriptions: dropped. Plain swearing stays
// (trench coin names use it a lot). Matching folds case, accents, look-alike letters and digits, and also reads the
// text with the separators removed, so "N.1.G.G.E.R" counts.

export const MASK = '•';

const LOOKALIKE = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i',
  ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g', α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't',
  0: 'o', 1: 'i', '!': 'i', '|': 'i', 3: 'e', 4: 'a', '@': 'a', 5: 's', $: 's', 6: 'g', 7: 't', 9: 'g',
};

// Found inside a word and in the text read without separators.
const ANYWHERE = [
  /n+i+g{2,}(?:e+r|a+|u+h|r+)/, // the n-word, its plurals and spellings
  /f+a+g{2,}o+t/,
  /w+e+t+b+a+c+k/,
  /r+a+g+h+e+a+d/,
  /t+o+w+e+l+h+e+a+d/,
  /z+i+p+p+e+r+h+e+a+d/,
  /p+o+r+c+h+m+o+n+k+e+y/,
  /j+i+g+a+b+o+o/,
  /j+u+n+g+l+e+b+u+n+n+y/,
  /h+e+i+l+h+i+t+l+e+r/,
  /s+i+e+g+h+e+i+l/,
  /h+o+l+o+h+o+a+x/,
  /g+a+s+t+h+e+j+e+w+s/,
];

// Whole words only: short ones that sit inside common words ("spice", "Pakistan").
const WORDS = new Set([
  'fag', 'fags', 'fagot', 'fagots', 'faggit', 'faggits', 'kike', 'kikes', 'kyke', 'kykes', 'spic', 'spics', 'spick',
  'spicks', 'chink', 'chinks', 'gook', 'gooks', 'beaner', 'beaners', 'tranny', 'trannies', 'dyke', 'dykes', 'paki',
  'pakis', 'wog', 'wogs', 'darkie', 'darkies', 'golliwog', 'golliwogs', 'heeb', 'heebs', 'hymie', 'hymies',
]);

// Real words that hold a slur's letters.
const INNOCENT = new Set([
  'snigger', 'sniggers', 'sniggered', 'sniggering', 'niggle', 'niggles', 'niggled', 'niggling', 'niggly', 'niggard',
  'niggards', 'niggardly',
]);

const fold = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/./gsu, (ch) => LOOKALIKE[ch] ?? ch);

/** True when the text holds a hate slur. */
export function hasSlur(text) {
  if (!text) return false;
  const words = fold(text)
    .split(/[^a-z]+/)
    .filter((w) => w && !INNOCENT.has(w));
  if (words.some((w) => WORDS.has(w) || ANYWHERE.some((re) => re.test(w)))) return true;
  const compact = words.join('');
  return ANYWHERE.some((re) => re.test(compact));
}

const dots = (s) => MASK.repeat(Math.min(8, Math.max(3, [...s].length)));

/** A coin name or ticker with each slur word masked; a slur spread over several words masks it all. */
export function maskSlurs(text) {
  const s = String(text ?? '');
  if (!hasSlur(s)) return s;
  const out = s.replace(/\S+/g, (w) => (hasSlur(w) ? dots(w) : w));
  return hasSlur(out) ? dots(s) : out;
}

export const isMasked = (s) => typeof s === 'string' && s.includes(MASK.repeat(3));

/** A coin ref or record whose name or ticker carries a slur (masked or raw): the feed and the AI skip it. */
export const badCoin = (coin) => !!coin && (isMasked(coin.symbol) || isMasked(coin.name) || hasSlur(coin.symbol) || hasSlur(coin.name));

/** A coin description fit to show, or null. */
export const cleanAbout = (s) => (typeof s === 'string' && s.trim() && !hasSlur(s) ? s : null);
