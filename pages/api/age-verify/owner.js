import crypto from 'crypto';
import { checkRateLimit, clearFailures, clientNetwork, recordFailure } from '../../../lib/rate-limit';
import { consumeBypassAttempt, refundBypassAttempt } from '../../../lib/bypass-guard';
import {
  AGE_VERIFIED_COOKIE_NAME,
  ageVerificationSecret,
  bypassMaxAgeSeconds,
  createBypassAgeVerificationToken,
} from '../../../lib/age-verification';
import { safeRedirectPath } from '../../../lib/safe-redirect';

/**
 * Owner bypass for the state age-verification block.
 *
 * The site owner lives in one of the 27 blocked states, so every fresh
 * browser, private window, new device and NEW DOMAIN makes him run a real
 * AgeChecker verification to look at his own site. Cookies are host-scoped,
 * so verifying on www.onlyass.fun does nothing for onlyass.fun,
 * onlyone1.fun or onlyass.shop -- that is a browser rule, not a bug, and it
 * is why this keeps happening rather than being a one-off.
 *
 * Visiting /api/age-verify/owner?key=<OWNER_ACCESS_KEY> sets the same signed
 * cookie a real verification would, on whichever domain it was called from,
 * and sends him to the site. Once per domain, good for 180 days.
 *
 * BE HONEST ABOUT WHAT THIS IS. It is a hole in a legal compliance control.
 * Anyone holding that URL skips the check that exists because 27 states
 * require it, and URLs leak -- browser history, a shared screen, a referrer
 * header, a synced bookmark. It is deliberate and it is the owner's call,
 * but it is not free:
 *
 *  - OWNER_ACCESS_KEY must be set as a Secret in Vercel, and must have real
 *    entropy. A long random value is safest:
 *      node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
 *    A memorable passphrase is acceptable ONLY if it is long and not
 *    guessable from anything about the owner -- a first name plus two digits
 *    is in every cracking dictionary's shape list, and this endpoint is a
 *    hole in a control that 27 states require by law. The per-IP budget below
 *    helps; it does not substitute for entropy.
 *  - It is NOT set anywhere by default. With the env var unset this endpoint
 *    404s, so a fork or preview deployment that doesn't inherit it has no
 *    bypass at all rather than a guessable one.
 *  - Rotate it if it is ever pasted somewhere shared -- and never write its
 *    value into this repo, MEMORY.md or a commit message. Rotating (or
 *    unsetting) it now REVOKES every cookie it minted, on the next request:
 *    the token carries a keyed fingerprint of the key that issued it and
 *    lib/age-verification.js refuses it once that no longer matches the
 *    configured OWNER_ACCESS_KEY. The owner re-opens this link once per
 *    domain after a rotation.
 *  - Don't hand it to creators or testers. Anyone who needs real access
 *    should verify properly; that is the point of the control.
 */
// Guessing budget. This endpoint answers 404-or-302 to a bare request, which
// makes it a free oracle for anyone trying keys -- and unlike the admin panel
// it had no limit at all, so the only thing standing between a guesser and
// the age gate was the key's own length.
//
// That matters more now the key is a memorable one the owner can type rather
// than 43 random characters. Same honest caveat as lib/rate-limit.js's own
// header: these counters live in one serverless instance's memory, so this is
// a speed bump against cheap guessing from one host, NOT a hard lockout. It
// does not make a weak key safe; it makes a moderate key defensible. The
// per-client bucket is the /64 for IPv6 (one customer's whole routed prefix),
// not the exact address.
//
// The bound that actually holds is the GLOBAL budget in lib/bypass-guard.js:
// shared across every instance and every client address, and while it is
// spent all attempts are refused, the right key included. So the most keys
// anyone on the internet can try is BYPASS_GLOBAL_BUDGET per window.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 8;

export default async function handler(req, res) {
  const bucket = `owner-access:net:${clientNetwork(req)}`;
  const { limited } = checkRateLimit(bucket, { limit: MAX_FAILURES_PER_IP, windowMs: WINDOW_MS });
  if (limited) {
    // Still a 404, for the same reason every other failure here is: the
    // endpoint must not confirm it exists. A 429 would.
    return res.status(404).json({ error: 'Not found' });
  }

  const expected = process.env.OWNER_ACCESS_KEY;

  // No key configured means no bypass exists. 404 rather than 401 so the
  // endpoint doesn't advertise that a bypass is a thing on deployments that
  // don't have one.
  if (!expected) {
    return res.status(404).json({ error: 'Not found' });
  }

  const provided = typeof req.query.key === 'string' ? req.query.key : '';
  if (!provided) {
    recordFailure(bucket, { limit: MAX_FAILURES_PER_IP, windowMs: WINDOW_MS });
    return res.status(404).json({ error: 'Not found' });
  }

  // The GLOBAL budget (lib/bypass-guard.js), shared across instances and
  // client addresses. Counted before the key is compared, and while it is
  // spent even the right key is refused -- otherwise it would still be an
  // oracle, just a slower one.
  const { allowed } = await consumeBypassAttempt('owner');
  if (!allowed) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Hashed to a fixed length before comparing: timingSafeEqual throws on
  // mismatched sizes, and the key's length is itself not worth leaking.
  const digest = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest();
  if (!crypto.timingSafeEqual(digest(provided), digest(expected))) {
    // Deliberately not logging the attempted value -- a near-miss guess in a
    // runtime log is most of a credential.
    console.warn(`[owner-access] rejected bypass attempt from ${req.headers['x-forwarded-for'] || 'unknown'}`);
    recordFailure(bucket, { limit: MAX_FAILURES_PER_IP, windowMs: WINDOW_MS });
    return res.status(404).json({ error: 'Not found' });
  }

  // A correct key clears the budget, so the owner mistyping it a few times on
  // a phone never locks himself out of his own site.
  clearFailures(bucket);
  await refundBypassAttempt('owner');

  // `via` records how this cookie was obtained, so a future reader of a
  // decoded token can tell an owner bypass from a real AgeChecker pass, and
  // the embedded key fingerprint is what lets a key rotation revoke it.
  const token = await createBypassAgeVerificationToken(ageVerificationSecret(), 'owner');
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AGE_VERIFIED_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${bypassMaxAgeSeconds('owner')}${secure}`);
  console.warn(`[owner-access] bypass granted on host ${req.headers.host || 'unknown'}`);

  // Same-origin only, via the shared resolver: a prefix check here once
  // passed "/\t/evil.com", which URL parsing turns into "//evil.com".
  const next = safeRedirectPath(req.query.next, '/home');
  res.writeHead(302, { Location: next });
  return res.end();
}
