// Phones without Phantom in the browser: open this page inside Phantom's in-app browser.
export function isPhoneDevice(): boolean {
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua) && 'ontouchend' in document);
}

/** Phantom's universal link: https://phantom.app/ul/browse/<encoded url>?ref=<encoded origin> */
export function phantomBrowseLink(page = window.location.href): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(page)}?ref=${encodeURIComponent(window.location.origin)}`;
}

/** Desktop without the extension. */
export const PHANTOM_GET = 'https://phantom.com/download';
