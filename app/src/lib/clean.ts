// Launch names are user text. A few hateful slurs show up in real pump.fun tickers: the app masks them, and the
// quality toggle hides those coins. A short list on purpose (slurs only, not rude words or memes).
const SLURS = /n[i1!|][gq]{2,}(?:er|a|ah|uh|az|ers)?|f[a@4]gg?[o0]ts?|\bk[i1]kes?\b|\bch[i1]nks?\b|\bsp[i1]cs?\b|\btr[a@]nn(?:y|ies)\b|retard(?!ant)(?:ed|s)?/gi;

export function hasSlur(s: string | undefined | null): boolean {
  if (!s) return false;
  SLURS.lastIndex = 0;
  return SLURS.test(s);
}

export function maskSlurs(s: string): string {
  SLURS.lastIndex = 0;
  return s.replace(SLURS, (m) => m[0] + '•'.repeat(Math.max(2, m.length - 1)));
}
