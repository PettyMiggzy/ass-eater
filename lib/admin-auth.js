import crypto from 'crypto';
import { checkRateLimit, clearFailures, clientIp, clientNetwork, recordFailure } from './rate-limit';

// Every /api/admin/* endpoint authenticates with the same single shared key,
// sent in an x-admin-key header. Each one used to compare it with `===`,
// which stops at the first differing byte -- the timing difference that
// leaks is small, but this is the one credential guarding every admin
// action (editing or deleting any creator, wiping the roster, resolving
// legally-clocked takedown requests), so it isn't one worth leaving
// guessable a byte at a time.
//
// Both sides are hashed to a fixed 32 bytes before comparing: timingSafeEqual
// throws outright on differently-sized buffers, and the key's own length is
// itself something not worth leaking.

// A timing-safe compare only stops the key being recovered a byte at a time;
// on its own it does nothing about guessing the whole thing. Every admin
// route answers 401-or-200 to a bare request (pages/admin/index.js uses
// /api/admin/creators as exactly that unlock check), so without a limit the
// key is a free, parallelisable guessing oracle. Counted per IP: there is
// only one key, so a per-credential bucket would be a single global one that
// anyone could hold shut against the real admin.
//
// Same honest caveat as the login route -- lib/rate-limit.js's counters live
// in one serverless instance's memory, so this is a speed bump against cheap
// guessing, not a hard lockout. Read that file before trusting it. The check
// deliberately runs BEFORE the key comparison: limiting only failures that
// got as far as being compared would never block anything, since every guess
// is a failure.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 10;

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function isAdminRequest(req) {
  const expected = process.env.ADMIN_UPLOAD_KEY;
  // No key configured means nobody is an admin -- same as the old inline
  // checks (nothing could ever `===` an undefined env var), spelled out
  // here so a missing env var can't be matched by a caller who simply
  // sends the string "undefined".
  if (!expected) return false;
  const provided = req.headers['x-admin-key'];
  if (typeof provided !== 'string' || !provided) return false;
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

/**
 * Returns true when the caller holds the admin key. Otherwise it has already
 * sent the exact same 401 every admin endpoint used to send inline (or a 429
 * once this IP has burned through its failure budget), and the handler must
 * `return` immediately without doing anything else.
 */
export function requireAdminKey(req, res) {
  const bucket = `admin:ip:${clientNetwork(req)}`;
  const { limited, retryAfterSeconds } = checkRateLimit(bucket, { limit: MAX_FAILURES_PER_IP, windowMs: WINDOW_MS });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ error: 'Too many failed admin attempts. Please wait a few minutes and try again.' });
    return false;
  }

  if (isAdminRequest(req)) {
    clearFailures(bucket);
    return true;
  }

  recordFailure(bucket, { limit: MAX_FAILURES_PER_IP, windowMs: WINDOW_MS });
  // Nothing else records these, so without this line a sustained run at the
  // admin key leaves no trace anywhere. The attempted value is deliberately
  // NOT logged: a near-miss guess in the runtime log is most of a credential.
  console.warn(`[admin-auth] rejected admin request from ${clientIp(req)} for ${req.method} ${req.url}`);
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}
