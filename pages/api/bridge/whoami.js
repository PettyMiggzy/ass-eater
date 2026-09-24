import { getSessionUser } from '../../../lib/session';
import { callServerApi } from '../../../lib/server-api';
import { consumeAttempt } from '../../../lib/rate-limit';

// Proof-of-concept for the Next.js <-> OnlyOne API bridge. Calls the
// server/ stack's GET /referral (an existing authenticated route with no
// side effects) on behalf of the logged-in Next.js user, proving the whole
// chain works end to end: real session here -> minted bridge assertion ->
// verified + auto-provisioned on server/ -> real authenticated response.
//
// Not meant to stay as a product feature -- delete once a real
// server/-backed feature (DMs, subscribe, VIP, live) exists and proves the
// same chain on its own.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Log in first' });

  // Every call here can reach the API's /auth/bridge; keep one user from
  // spending the site's shared allowance there.
  const limit = consumeAttempt(`bridge-whoami:${user.id}`, { limit: 20, windowMs: 10 * 60 * 1000 });
  if (limit.limited) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
  }

  try {
    const { status, data } = await callServerApi(user, 'GET', '/auth/referral');
    return res.status(status).json(data);
  } catch (err) {
    console.error('bridge/whoami', err);
    if (err?.status === 403) return res.status(403).json({ error: 'Your account cannot use this feature right now.' });
    return res.status(502).json({ error: 'Could not reach the OnlyOne API.' });
  }
}
