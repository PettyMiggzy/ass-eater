/**
 * Best-effort in-memory rate limiting, used by the login and signup routes.
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
 * none is configured on this stack. Deliberately NOT built on the site's
 * Postgres either: a failed login would become a database round trip on the
 * exact path that is hottest while under attack, which turns a
 * password-spray into a database-load problem as well as a login one. When
 * a real shared counter exists, swap this module's internals out.
 */

// key -> ascending timestamps (ms) of recent counted attempts.
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

function retryAfterSecondsFor(hits, now, windowMs) {
  return Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000));
}

/**
 * Check and count one attempt against `key` in a single step, and say
 * whether it is over the limit.
 *
 * This has to be one step, not checkRateLimit() followed later by
 * recordFailure(). A caller that checks first, awaits something slow (a
 * bcrypt compare), and only counts afterwards has a check-then-act race:
 * every request in a parallel burst reads the same count of zero while the
 * others are still awaiting, so a single Promise.all of a few hundred
 * requests sails through a limit of 10. Node runs this function to
 * completion without interleaving, so counting here is the fix.
 */
export function consumeAttempt(key, { limit, windowMs }) {
  const now = Date.now();
  const hits = recentHits(key, now, windowMs);

  if (hits.length >= limit) {
    // Deliberately does NOT record the rejected attempt. Pushing a
    // timestamp here would slide the window forward on every knock, so
    // anyone willing to keep knocking could hold a bucket saturated
    // forever instead of it aging out.
    failures.set(key, hits);
    return { limited: true, retryAfterSeconds: retryAfterSecondsFor(hits, now, windowMs) };
  }

  hits.push(now);
  failures.set(key, hits.slice(-limit));
  evictIfNeeded();
  return { limited: false, retryAfterSeconds: 0 };
}

/**
 * Read-only peek: is this key over `limit` hits inside `windowMs`? Counts
 * nothing. Used for marker keys that are written explicitly with
 * recordFailure() rather than counted per request.
 */
export function checkRateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  const hits = recentHits(key, now, windowMs);
  if (hits.length === 0) failures.delete(key);
  else failures.set(key, hits);

  if (hits.length < limit) return { limited: false, retryAfterSeconds: 0 };
  return { limited: true, retryAfterSeconds: retryAfterSecondsFor(hits, now, windowMs) };
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
 * Takes back ONE counted attempt from `key` (the most recent), for a request
 * that turned out not to be what the bucket limits -- a successful login
 * against a per-IP bucket that exists to cap failures. Only one: clearing the
 * whole bucket on success let a host holding any valid account reset it after
 * every few failed guesses and spray passwords without limit.
 */
export function refundAttempt(key) {
  const hits = failures.get(key);
  if (!hits || !hits.length) return;
  hits.pop();
  if (hits.length) failures.set(key, hits);
  else failures.delete(key);
}

/**
 * Vercel's edge sets x-real-ip (and prepends the client to
 * x-forwarded-for) on every request, so these are the real client address
 * in production rather than something the caller chose.
 *
 * Off Vercel there is no such edge in front of us and both headers are
 * just request headers the caller typed, so trusting them would let anyone
 * mint a fresh per-IP bucket per request and erase the per-IP limit
 * entirely. Outside Vercel we therefore use the socket address only. This
 * matters for a fork or a self-hosted mirror of this site, not just for
 * local dev.
 */
export function clientIp(req) {
  if (!process.env.VERCEL) return req.socket?.remoteAddress || 'unknown';
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return String(req.headers['x-real-ip'] || '') || forwarded || req.socket?.remoteAddress || 'unknown';
}

/**
 * The client's address as a rate-limit BUCKET: an IPv4 address as is, an IPv6
 * address truncated to its /64. One IPv6 customer (a VPS, a home line) is
 * routed a whole /64 and can source requests from any of its 2^64 addresses,
 * so a per-/128 bucket lets them mint a fresh budget per request. Use this for
 * limits that exist to bound guessing (the bypass keys); clientIp() stays the
 * exact address for logging.
 */
export function clientNetwork(req) {
  return networkBucket(clientIp(req));
}

/**
 * A COARSER bucket for IPv6: the /48. One party is routinely handed far more
 * than a /64 -- tunnelbroker gives anyone a free routed /48 (65,536 /64s),
 * VPS hosts a /56 on request -- so a /64 bucket still let address space buy
 * budget linearly (round-9 gates-token#0). Used as a SECOND, more generous
 * brake next to the /64 one, never instead of it: a mobile carrier puts many
 * subscribers inside one /48, so a tight /48 limit would throttle real users.
 * IPv4 comes back as is.
 */
export function clientNetworkCoarse(req) {
  return networkBucketCoarse(clientIp(req));
}

export function networkBucketCoarse(ip) {
  const fine = networkBucket(ip);
  if (!fine.endsWith('::/64')) return fine;
  return `${fine.slice(0, -'::/64'.length).split(':').slice(0, 3).join(':')}::/48`;
}

export function networkBucket(ip) {
  let addr = String(ip || 'unknown').trim().toLowerCase();
  // IPv4-mapped IPv6 ("::ffff:1.2.3.4") is really the IPv4 address.
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  if (!addr.includes(':')) return addr;
  addr = addr.replace(/%.*$/, ''); // zone id
  const [head, tail = ''] = addr.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = addr.includes('::') && tail ? tail.split(':') : [];
  // A trailing embedded IPv4 counts as two groups; it only ever sits in the
  // low 64 bits, which are dropped anyway.
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  const groups = addr.includes('::') ? [...headParts, ...Array(missing).fill('0'), ...tailParts] : headParts;
  const prefix = groups.slice(0, 4).map((g) => (g || '0').replace(/^0+(?=.)/, ''));
  while (prefix.length < 4) prefix.push('0');
  return `${prefix.join(':')}::/64`;
}
