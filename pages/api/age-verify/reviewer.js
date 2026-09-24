import crypto from 'crypto';
import { checkRateLimit, clearFailures, clientIp, recordFailure } from '../../../lib/rate-limit';
import {
  AGE_VERIFIED_COOKIE_NAME,
  ageVerificationSecret,
  bypassMaxAgeSeconds,
  createBypassAgeVerificationToken,
} from '../../../lib/age-verification';
import { safeRedirectPath } from '../../../lib/safe-redirect';

/**
 * External-reviewer bypass for the state age-verification block.
 *
 * Same mechanism as owner.js (see that file's header for the full design
 * rationale -- this is a copy, not a reimplementation, deliberately kept a
 * separate endpoint+key rather than added as a second accepted value on
 * owner.js): payment processors doing pre-onboarding review (CCBill, Epoch,
 * Segpay, Vendo -- see MEMORY.md) all require a live, working site with
 * real content before they'll even look at an application, but they are not
 * fans and should not have to pass AgeChecker to review a merchant
 * application. This link sets the same signed cookie a real verification
 * would, no age gate, no signup, no login.
 *
 * REVIEWER_ACCESS_KEY is its own env var, separate from OWNER_ACCESS_KEY,
 * on purpose:
 *  - It can be rotated or removed the moment a review is done without
 *    touching the owner's own daily-use bypass -- and doing so revokes every
 *    cookie this link already issued, on the next request (the token carries
 *    a keyed fingerprint of the key that minted it; see
 *    createBypassAgeVerificationToken in lib/age-verification.js).
 *  - The cookie lasts 14 days, not the 180 a real verification gets: a
 *    review takes days, and the bypass should not outlive it by months.
 *  - `via: 'reviewer'` in the token distinguishes it from an owner bypass in
 *    a decoded token, so a leaked link's use is attributable to the right
 *    audience.
 *  - It should be a long, random value (not a memorable passphrase like the
 *    owner's) -- it's handed to a third party, not typed from memory:
 *      node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
 *
 * BE HONEST ABOUT WHAT THIS IS, same as owner.js: it is a hole in a legal
 * compliance control, handed to someone outside the company. Share the link
 * only with the specific reviewer who needs it, over a channel that isn't
 * public, and rotate REVIEWER_ACCESS_KEY once the review is done rather than
 * leaving a standing bypass live indefinitely.
 *
 * Cookies are host-scoped (see owner.js) -- a link on joinonlyone.com does
 * nothing for shoponeonly.com or any other mirror. Give the reviewer a
 * separate link per domain they need to see.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 8;

export default async function handler(req, res) {
  const bucket = `reviewer-access:ip:${clientIp(req)}`;
  const { limited } = checkRateLimit(bucket, { limit: MAX_FAILURES_PER_IP, windowMs: WINDOW_MS });
  if (limited) {
    return res.status(404).json({ error: 'Not found' });
  }

  const expected = process.env.REVIEWER_ACCESS_KEY;

  // No key configured means no bypass exists. 404, not 401, so a deployment
  // without one doesn't advertise that this endpoint is a thing.
  if (!expected) {
    return res.status(404).json({ error: 'Not found' });
  }

  const provided = typeof req.query.key === 'string' ? req.query.key : '';
  if (!provided) {
    recordFailure(bucket, { limit: MAX_FAILURES_PER_IP, windowMs: WINDOW_MS });
    return res.status(404).json({ error: 'Not found' });
  }

  const digest = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest();
  if (!crypto.timingSafeEqual(digest(provided), digest(expected))) {
    console.warn(`[reviewer-access] rejected bypass attempt from ${req.headers['x-forwarded-for'] || 'unknown'}`);
    recordFailure(bucket, { limit: MAX_FAILURES_PER_IP, windowMs: WINDOW_MS });
    return res.status(404).json({ error: 'Not found' });
  }

  clearFailures(bucket);

  const token = await createBypassAgeVerificationToken(ageVerificationSecret(), 'reviewer');
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AGE_VERIFIED_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${bypassMaxAgeSeconds('reviewer')}${secure}`);
  console.warn(`[reviewer-access] bypass granted on host ${req.headers.host || 'unknown'}`);

  // Same-origin only, via the shared resolver: a prefix check here once
  // passed "/\t/evil.com", which URL parsing turns into "//evil.com".
  const next = safeRedirectPath(req.query.next, '/home');
  res.writeHead(302, { Location: next });
  return res.end();
}
