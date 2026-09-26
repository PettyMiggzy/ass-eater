/**
 * Cross-site request refusal for state-changing POST routes that do not rely
 * on a cookie the browser would withhold -- login and signup above all.
 *
 * SameSite=Lax stops a cross-site form from SENDING the victim's session
 * cookie, but login and signup need no cookie: they MINT one. A plain HTML
 * form posted from another site (application/x-www-form-urlencoded, which
 * Next's body parser accepts) signed the victim into an attacker-chosen
 * account, and every wallet deposit they made afterwards was credited to it
 * (round-14 gates-token#0).
 *
 * A request is refused when any of these holds:
 *   - Sec-Fetch-Site is 'cross-site' (every current browser sends it);
 *   - an Origin header is present and is not this request's own host
 *     (Host / X-Forwarded-Host), including the opaque "null" origin;
 *   - the body is a form encoding or text/plain -- the only content types a
 *     cross-site page can POST without a CORS preflight. The site's own
 *     callers (pages/login.js, pages/signup.js) always send application/json.
 * A request with neither Origin nor Sec-Fetch-Site (curl, server-to-server,
 * the test harness) is not a browser acting for a victim and is allowed.
 *
 * Pure apart from writing the 403: no database import.
 */

const SIMPLE_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

function headerValue(req, name) {
  const v = req?.headers?.[name];
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : '';
  return typeof v === 'string' ? v : '';
}

function ownHosts(req) {
  const hosts = new Set();
  for (const name of ['host', 'x-forwarded-host']) {
    for (const part of headerValue(req, name).split(',')) {
      const h = part.trim().toLowerCase();
      if (h) hosts.add(h);
    }
  }
  return hosts;
}

/** Why `req` is cross-site, or null when it is not. */
export function crossSiteReason(req) {
  const site = headerValue(req, 'sec-fetch-site').trim().toLowerCase();
  if (site === 'cross-site') return 'sec-fetch-site';
  const origin = headerValue(req, 'origin').trim();
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host.toLowerCase();
    } catch {
      host = null; // "null" and anything unparseable
    }
    if (!host || !ownHosts(req).has(host)) return 'origin';
  }
  const type = headerValue(req, 'content-type').split(';')[0].trim().toLowerCase();
  if (type && SIMPLE_CONTENT_TYPES.includes(type)) return 'content-type';
  return null;
}

/**
 * Answers 403 and returns true when `req` is cross-site (see above); returns
 * false and writes nothing otherwise.
 */
export function refuseCrossSite(req, res) {
  if (!crossSiteReason(req)) return false;
  res.status(403).json({ error: 'This request must come from the site itself. Reload the page and try again.' });
  return true;
}
