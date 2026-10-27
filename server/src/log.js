// One line per action: time, action, then key=value pairs. Keys and secrets never reach this function; URLs pass
// through redact() first (a Helius URL carries its api key in the query string).
const quiet = () => process.env.LOG_QUIET === '1';

export function log(action, fields = {}) {
  if (quiet()) return;
  const parts = [new Date().toISOString(), action];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}=${typeof v === 'bigint' ? v.toString() : String(v).replace(/\s+/g, '_')}`);
  }
  console.log(parts.join(' '));
}

export function logError(action, err, fields = {}) {
  const msg = redactText(String(err?.shortMessage || err?.message || err).split('\n')[0]).slice(0, 240);
  log(action, { ...fields, error: msg });
}

/** A URL without its query string and credentials (api keys live there). */
export function redact(url) {
  try {
    const u = new URL(String(url));
    u.username = '';
    u.password = '';
    const hadQuery = !!u.search;
    u.search = '';
    return u.toString() + (hadQuery ? '?…' : '');
  } catch {
    return '(bad url)';
  }
}

/** Strips query strings and api-key-looking parts from free text (error messages can quote a URL). */
export function redactText(s) {
  return String(s)
    .replace(/(https?|wss?):\/\/[^\s"')]+/g, (m) => redact(m))
    .replace(/api[-_]?key=[^&\s"']+/gi, 'api-key=…');
}
