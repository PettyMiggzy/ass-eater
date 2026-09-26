/**
 * Best-effort in-memory rate limiting for the cheap endpoints (waitlist,
 * nonces, reports, uploads) and the admin/bypass-key failure brakes.
 *
 * HONEST LIMITS -- read this before trusting it. The counters live in one
 * serverless instance's memory. Vercel runs as many instances as it likes
 * and recycles them freely, so an attacker with enough parallelism (or
 * enough patience to wait out a cold start) gets a fresh budget on each
 * new instance. This is NOT a guarantee that N attempts is all anyone
 * gets; treat it as a speed bump that stops cheap single-host abuse, not
 * as a hard lockout.
 *
 * The LOGIN brakes are not here any more: they are shared Postgres counters
 * (lib/login-guard.js), because in this map one instance's budget was not
 * another's and a flood of cheap requests could evict them (round-10
 * gates-token#1). The bypass links also have a shared global budget
 * (lib/bypass-guard.js).
 */

// key -> { hits: ascending timestamps (ms) of recent counted attempts,
//          limit, windowMs }. Map order is recency order: every write deletes
// and re-inserts its key, so the first entries are the least recently hit.
const counters = new Map();
// The failure brakes (admin key, bypass keys, wallet access) get a map of
// their own, written only by a real failed credential check, so a flood of
// cheap requests to the per-request limiters above can never push them out.
const failureMarks = new Map();

// Bounded so a spray across many distinct keys can't grow memory without
// limit. When the cap is hit, the least recently hit keys that are NOT
// currently saturated go first -- a saturated key is a brake doing its job,
// and evicting it would hand the host it brakes a fresh budget. Only when a
// map is full of saturated keys past HARD_CAP does the oldest go regardless.
const MAX_TRACKED_KEYS = 10000;
const HARD_CAP = 2 * MAX_TRACKED_KEYS;
// How far into the map one eviction pass looks for something evictable, so
// an overflow costs a bounded scan rather than a full sort.
const EVICT_SCAN = 256;

function liveHits(entry, now) {
  if (!entry) return [];
  return entry.hits.filter((t) => now - t < entry.windowMs);
}

function put(map, key, entry) {
  map.delete(key);
  map.set(key, entry);
  evictIfNeeded(map);
}

function evictIfNeeded(map) {
  if (map.size <= MAX_TRACKED_KEYS) return;
  const now = Date.now();
  let scanned = 0;
  for (const [key, entry] of map) {
    if (map.size <= MAX_TRACKED_KEYS || scanned++ >= EVICT_SCAN) break;
    const hits = liveHits(entry, now);
    if (hits.length < entry.limit) map.delete(key);
  }
  while (map.size > HARD_CAP) map.delete(map.keys().next().value);
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
  const hits = liveHits(counters.get(key), now);

  if (hits.length >= limit) {
    // Deliberately does NOT record the rejected attempt. Pushing a
    // timestamp here would slide the window forward on every knock, so
    // anyone willing to keep knocking could hold a bucket saturated
    // forever instead of it aging out.
    put(counters, key, { hits, limit, windowMs });
    return { limited: true, retryAfterSeconds: retryAfterSecondsFor(hits, now, windowMs) };
  }

  hits.push(now);
  put(counters, key, { hits: hits.slice(-limit), limit, windowMs });
  return { limited: false, retryAfterSeconds: 0 };
}

/**
 * consumeAttempt for an unauthenticated endpoint keyed by client network: one
 * bucket per IPv6 /64 (IPv4: per address) and a second, more generous one per
 * IPv6 /48, so one routed allocation cannot mint thousands of per-/64 budgets
 * (or thousands of keys in this map) -- the same shape signup already used.
 * A request refused by the /48 gives its /64 slot back.
 */
export function consumeNetworkAttempt(req, prefix, { limit, networkLimit, windowMs }) {
  const ip = clientNetwork(req);
  const net = clientNetworkCoarse(req);
  const ipKey = `${prefix}:ip:${ip}`;
  const perIp = consumeAttempt(ipKey, { limit, windowMs });
  if (perIp.limited || net === ip) return perIp;
  const perNet = consumeAttempt(`${prefix}:net:${net}`, { limit: networkLimit, windowMs });
  if (perNet.limited) refundAttempt(ipKey);
  return perNet;
}

/**
 * Read-only peek: is this key over `limit` hits inside `windowMs`? Counts
 * nothing. Used for the failure-marker keys, which are written explicitly
 * with recordFailure() rather than counted per request.
 */
export function checkRateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  const hits = liveHits(failureMarks.get(key), now);
  if (hits.length === 0) failureMarks.delete(key);

  if (hits.length < limit) return { limited: false, retryAfterSeconds: 0 };
  return { limited: true, retryAfterSeconds: retryAfterSecondsFor(hits, now, windowMs) };
}

export function recordFailure(key, { limit, windowMs }) {
  const now = Date.now();
  const hits = liveHits(failureMarks.get(key), now);
  hits.push(now);
  // Only the most recent `limit` timestamps can ever matter to
  // checkRateLimit, so don't accumulate more than that per key.
  put(failureMarks, key, { hits: hits.slice(-limit), limit, windowMs });
}

export function clearFailures(key) {
  failureMarks.delete(key);
}

/**
 * Takes back ONE counted attempt from `key` (the most recent), for a request
 * that turned out not to be what the bucket limits. Only one: clearing the
 * whole bucket on success let a host holding any valid account reset it after
 * every few failed guesses and spray without limit.
 */
export function refundAttempt(key) {
  const entry = counters.get(key);
  if (!entry || !entry.hits.length) return;
  entry.hits.pop();
  if (!entry.hits.length) counters.delete(key);
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
