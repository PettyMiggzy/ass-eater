import { createHash } from 'crypto';

/**
 * GoPlus's real auth flow (confirmed against their own docs, not guessed):
 * app_key/app_secret are free from their developer console (no paid plan --
 * the earlier assumption that this needed a purchased API key was wrong),
 * but they aren't used directly as a bearer token. You exchange them for a
 * short-lived access_token via POST /api/v1/token, signed as
 * sha1(app_key + time + app_secret), and that token is what goes in the
 * Authorization header on the actual API calls.
 *
 * Cached in memory per server instance -- a fresh token per checkout
 * request would work too, but this endpoint is called on every "run a
 * safety check" click, and there's no reason to mint a new short-lived
 * token for each one when the last one hasn't expired.
 */
let cached = null; // { token, expiresAt }

export async function getGoplusAccessToken() {
  const appKey = process.env.GOPLUS_APP_KEY;
  const appSecret = process.env.GOPLUS_APP_SECRET;
  if (!appKey || !appSecret) return null;

  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.token;
  }

  const time = Math.floor(Date.now() / 1000);
  const sign = createHash('sha1').update(`${appKey}${time}${appSecret}`).digest('hex');

  const res = await fetch('https://api.gopluslabs.io/api/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_key: appKey, sign, time }),
  });
  const body = await res.json();
  if (!res.ok || body.code !== 1 || !body.result?.access_token) {
    cached = null;
    throw new Error(body.message || 'Could not obtain a GoPlus access token');
  }

  cached = {
    token: body.result.access_token,
    expiresAt: Date.now() + (body.result.expires_in || 0) * 1000,
  };
  return cached.token;
}
