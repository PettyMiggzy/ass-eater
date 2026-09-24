// Same-origin post-action redirects (?next=), for the login page and the
// owner/reviewer bypass routes.
//
// Prefix checks are not enough and have already failed once here: the old
// rule was "starts with / but not // or /\", which passed "/\t/evil.com".
// URL parsing (the browser's, and Next's router, which resolves with
// new URL()) strips ASCII tab and newline, turning that into "//evil.com" --
// a protocol-relative link off the site. So this does two things, either of
// which alone would have stopped it:
//   1. refuses any control character or backslash anywhere in the value;
//   2. resolves the value against a fixed dummy origin and keeps it only if
//      it is still on that origin, returning the NORMALISED path rather than
//      the raw string, so what gets navigated to is exactly what was checked.
//
// Pure, no Node or browser APIs beyond URL -- safe in pages and API routes.

const BASE = 'https://same-origin.invalid';
const MAX_LENGTH = 2048;

export function safeRedirectPath(raw, fallback) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_LENGTH) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\\]/.test(raw)) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  let url;
  try {
    url = new URL(raw, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;
  const path = url.pathname + url.search + url.hash;
  // Belt to the braces above: whatever came out must still be a single-slash
  // absolute path.
  if (!path.startsWith('/') || path.startsWith('//')) return fallback;
  return path;
}
