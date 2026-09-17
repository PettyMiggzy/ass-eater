/**
 * Best-effort in-memory rate limiting, currently used by the login route.
 *
 * HONEST LIMITS -- read this before trusting it. The counters live in one
 * serverless instance's memory. Vercel runs as many instances as it likes
 * and recycles them freely, so an attacker with enough parallelism (or
 * enough patience to wait out a cold start) gets a fresh budget on each
 * new instance. This is NOT a guarantee that N attempts is all anyone
 * gets; treat it as a speed bump that stops cheap single-host password
 * spraying, not as a hard lockout.
 *
 * The real fix is a shared counter store (Upstash / Vercel KV / Redis) --
 * none is configured on this stack. Deliberately NOT built on
 * lib/blob-json-store.js, the one durable store the live site does have:
 * that's a whole-file read-modify-write against Vercel Blob, so every
 * failed login would become a read plus a conditional write of one shared
 * file, which is slowest and most contended exactly when it is under
 * attack (and a losing write just retries, amplifying it). When a real
 * shared counter exists, swap this module's internals out -- don't bolt
 * the blob store onto it.
 */

// key -> ascending timestamps (ms) of recent failed attempts.
const failures = new Map();

// Bounded so a spray across many distinct keys can't grow this without
// limit. When the cap is hit the least-recently-active keys go first, which
// keeps whoever is actively hammering us tracked.
const MAX_TRACKED_KEYS = 10000;

function recentHits(key, now, windowMs) {
  const hits = failures.get(key);
  if (!hits) return [];
  return hits.filter((t) => now - t < windowMs);
}

function evictIfNeeded() {
  if (failures.size <= MAX_TRACKED_KEYS) return;
  const byLastSeen = [...failures.entries()].sort((a, b) => a[1][a[1].length - 1] - b[1][b[1].length - 1]);
  for (const [key] of byLastSeen.slice(0, failures.size - MAX_TRACKED_KEYS)) failures.delete(key);
}

/**
 * Read-only check: is this key over `limit` failures inside `windowMs`?
 * Returns `retryAfterSeconds` (>= 1 when limited) for a Retry-After header.
 */
export function checkRateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  const hits = recentHits(key, now, windowMs);
  if (hits.length === 0) failures.delete(key);
  else failures.set(key, hits);

  if (hits.length < limit) return { limited: false, retryAfterSeconds: 0 };
  return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000)) };
}

export function recordFailure(key, { limit, windowMs }) {
  const now = Date.now();
  const hits = recentHits(key, now, windowMs);
  hits.push(now);
  // Only the most recent `limit` timestamps can ever matter to
  // checkRateLimit, so don't accumulate more than that per key.
  failures.set(key, hits.slice(-limit));
  evictIfNeeded();
}

export function clearFailures(key) {
  failures.delete(key);
}

/**
 * Vercel's edge sets x-real-ip (and prepends the client to
 * x-forwarded-for) on every request, so these are the real client address
 * in production rather than something the caller chose. Locally they're
 * absent and we fall back to the socket.
 *
 * If a header ever were spoofable, the damage is limited: it only lets
 * someone dodge the per-IP bucket. The per-account bucket is keyed on the
 * login identifier being guessed, which an attacker can't vary without
 * also giving up on the account they're trying to break into.
 */
export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return String(req.headers['x-real-ip'] || '') || forwarded || req.socket?.remoteAddress || 'unknown';
}
