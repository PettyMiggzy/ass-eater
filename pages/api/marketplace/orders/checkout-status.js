import { refuseMalformedText } from '../../../../lib/field-validation';
import { getVerifiedSessionUserId } from '../../../../lib/session';
import { isCheckoutKeyClaimed } from '../../../../lib/orders-store';
import { consumeAttempt } from '../../../../lib/rate-limit';

const WINDOW_MS = 60 * 1000;
const MAX_PER_USER = 30;

/**
 * GET /api/marketplace/orders/checkout-status?key=<idempotencyKey>
 * -> 200 { claimed: boolean }
 *
 * Read-only: did THIS signed-in buyer already commit a checkout under this
 * key? The cart asks it when a checkout's outcome is unknown (a lost
 * response, a 5xx) so it can confirm an earlier payment without the fan
 * having to press Pay again -- which a spent balance may no longer allow --
 * and so it never sends an old, possibly-committed key with a different cart.
 * Scoped to the caller's own account: another buyer's key always reads false.
 */
export default async function handler(req, res) {
  // NUL / half an emoji in a query value is a 400, never a 500 from pg (round-11 fix-up).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to check a checkout' });

  const { limited, retryAfterSeconds } = consumeAttempt(`checkout-status:user:${uid}`, {
    limit: MAX_PER_USER,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many requests -- try again in a moment.' });
  }

  const key = req.query?.key;
  if (typeof key !== 'string' || !key || key.length > 200) {
    return res.status(400).json({ error: 'Missing or invalid key' });
  }
  try {
    const claimed = await isCheckoutKeyClaimed(key, uid);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ claimed });
  } catch (err) {
    console.error('[marketplace/orders/checkout-status] lookup failed:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
