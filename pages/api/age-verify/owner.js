import crypto from 'crypto';
import { checkRateLimit, clearFailures, clientIp, recordFailure } from '../../../lib/rate-limit';
import { AGE_VERIFIED_COOKIE_NAME, ageVerificationSecret, createAgeVerificationToken } from '../../../lib/age-verification';

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
 *  - Rotate it if it is ever pasted somewhere shared. Rotating instantly
 *    invalidates nothing already issued (the cookie is a normal 180-day
 *    age-verification cookie), so treat rotation as "stop new uses", not
 *    "revoke past ones".
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
// does not make a weak key safe; it makes a moderate key defensible.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 8;

export default async function handler(req, res) {
  const bucket = `owner-access:ip:${clientIp(req)}`;
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

  // `via` records how this cookie was obtained, so a future reader of a
  // decoded token can tell an owner bypass from a real AgeChecker pass.
  const token = await createAgeVerificationToken(ageVerificationSecret(), { via: 'owner' });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AGE_VERIFIED_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 180}${secure}`);
  console.warn(`[owner-access] bypass granted on host ${req.headers.host || 'unknown'}`);

  // "//evil.com" and "/\evil.com" both start with "/" and both are resolved
  // by browsers as a protocol-relative URL to another origin, so
  // startsWith('/') alone was an open redirect out of the site.
  const requested = typeof req.query.next === 'string' ? req.query.next : '';
  const safeNext = requested.startsWith('/') && !requested.startsWith('//') && !requested.startsWith('/\\');
  const next = safeNext ? requested : '/home';
  res.writeHead(302, { Location: next });
  return res.end();
}
