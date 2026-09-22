import { mintBridgeToken } from './bridge-token';

// Server-only helper for calling the OnlyOne API (server/) on behalf of a
// logged-in user on this site. Deliberately keeps the server/ access token
// entirely server-side -- a Next.js API route calls this, gets back
// whatever DATA the target endpoint returns, and passes that on to the
// browser. The token itself never reaches client JS, avoiding the whole
// cross-domain-cookie/XSS surface a browser-held token would open up.
//
// No caching in this first version: every call mints a fresh bridge token
// and exchanges it for a fresh 15-minute server/ session. A few extra ms
// per request; fine until something calls this often enough to matter, at
// which point cache the exchanged token per Next.js session (keyed by its
// `sv` epoch so a logout invalidates the cache too) rather than guessing at
// that need now.

const API_BASE = process.env.SERVER_API_URL || 'https://api.joinonlyone.com';

async function exchangeBridgeToken(user) {
  const token = mintBridgeToken(user);
  const res = await fetch(`${API_BASE}/auth/bridge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`bridge exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json(); // { access, refresh }
}

/**
 * Calls an authenticated OnlyOne API endpoint as the given user.
 * `user` is the record getSessionUser() (lib/session.js) returns.
 * Returns { status, data } -- callers decide what a non-2xx means for them.
 */
export async function callServerApi(user, method, path, body) {
  const { access } = await exchangeBridgeToken(user);
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${access}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
