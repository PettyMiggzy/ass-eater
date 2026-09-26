import crypto from 'crypto';
import { query } from './db';

/**
 * Shared, Postgres-backed counters for the login brakes (pages/api/auth/login.js).
 *
 * Why not lib/rate-limit.js's in-memory map (round-10 gates-token#1): that map
 * lives in one serverless instance, so every instance had its own login
 * budget, and it is capped by key count -- anyone could flood a cheap public
 * endpoint with fresh keys from a routed IPv6 /48 and evict the login's
 * per-account counter and dirty markers, resetting the bound on guesses per
 * account. These rows are shared by every instance and nothing else writes
 * them, so nothing can push them out.
 *
 * The cost is a database round trip on login, which already needs the database
 * to look the account up; the brakes are counted in a few small statements
 * before the bcrypt compare (the host's budgets first, so a refused host never
 * touches an account row) and settled in one or two after it. Every statement
 * that locks more than one row locks them in sorted key order.
 *
 * Every counter is a fixed window: reset to 1 when the window has passed,
 * otherwise incremented. Keys are SHA-256 digests of the logical key, so a
 * typed identifier (which may be someone's password pasted in the wrong
 * field) is never stored.
 */

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function keyDigest(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

function retryAfterSeconds(windowStart, windowMs) {
  const end = new Date(windowStart).getTime() + windowMs;
  return Math.max(1, Math.ceil((end - Date.now()) / 1000));
}

/**
 * Counts one attempt against each `{ key, limit }` in ONE atomic statement and
 * reports, per key, how many attempts were already counted before this one
 * and whether this one is over the limit.
 *
 * Every call increments every key, with no cap. That is what makes
 * `releaseLoginAttempts()` safe to call on a refused attempt: each release
 * undoes an increment that really happened. (A cap at limit + 1 meant a knock
 * on a saturated bucket was refused WITHOUT being counted, and releasing it
 * anyway took off an attempt someone else had made -- under a parallel burst
 * the counter drifted below the real number of compares and let extra
 * guesses through; round-10 fix-up.) The window is fixed, so knocking on a
 * saturated bucket still cannot slide it forward, and a refused knock is
 * released straight away, so the count stays at the number of attempts that
 * were actually let through (plus any in flight).
 *
 * Atomic per row, so a parallel burst cannot all read "under the limit" while
 * the others are still awaiting bcrypt -- the check-then-act race the old
 * in-memory consumeAttempt existed to close.
 */
export async function consumeLoginAttempts(entries, { windowMs = LOGIN_WINDOW_MS } = {}) {
  if (!entries.length) return {};
  const digests = entries.map((e) => keyDigest(e.key));
  // One upsert cannot touch the same row twice, and rows are locked in the
  // order given -- so keys must be distinct, and are sent sorted so two
  // concurrent logins never take the same rows in opposite orders.
  if (new Set(digests).size !== digests.length) throw new Error('consumeLoginAttempts: duplicate key');
  const order = digests.map((d, i) => i).sort((x, y) => (digests[x] < digests[y] ? -1 : 1));
  const sortedDigests = order.map((i) => digests[i]);
  const { rows } = await query(
    `insert into login_attempts as a (key, window_start, attempts)
       select k, now(), 1 from unnest($1::text[]) as k
     on conflict (key) do update set
       window_start = case when a.window_start <= now() - make_interval(secs => $2::double precision / 1000)
                           then now() else a.window_start end,
       attempts     = case when a.window_start <= now() - make_interval(secs => $2::double precision / 1000)
                           then 1 else a.attempts + 1 end
     returning key, attempts, window_start`,
    [sortedDigests, windowMs],
  );
  const byDigest = new Map(rows.map((r) => [r.key, r]));
  const out = {};
  entries.forEach((e, i) => {
    const row = byDigest.get(digests[i]);
    const attempts = Number(row?.attempts || 1);
    out[e.name || e.key] = {
      key: e.key,
      limit: e.limit,
      prior: attempts - 1,
      limited: attempts > e.limit,
      retryAfterSeconds: row ? retryAfterSeconds(row.window_start, windowMs) : 1,
    };
  });
  return out;
}

/**
 * Takes one counted attempt back off each key (never below zero, and only
 * inside the current window). Used for a request that turned out not to be
 * what the bucket limits: a refused attempt, or a successful login against a
 * bucket that exists to count failures.
 */
export async function releaseLoginAttempts(keys, { windowMs = LOGIN_WINDOW_MS } = {}) {
  const list = keys.filter(Boolean);
  if (!list.length) return;
  // Rows are locked in sorted key order (the CTE's ORDER BY ... FOR UPDATE),
  // the same order consumeLoginAttempts takes them in. A bare
  // `update ... where key = any($1)` locks in scan order, so a release racing
  // a consume on the same rows could take them in opposite orders and
  // deadlock -- a 500 for the consume, or a lost release leaving a phantom
  // attempt on the counter (round-11 gates-token#2).
  await query(
    `with t as (
       select key from login_attempts
        where key = any($1::text[])
          and window_start > now() - make_interval(secs => $2::double precision / 1000)
        order by key
        for update
     )
     update login_attempts a set attempts = greatest(a.attempts - 1, 0)
       from t where a.key = t.key`,
    [[...new Set(list.map(keyDigest))], windowMs],
  );
}

/**
 * Current in-window count for each key (0 when absent or expired). Counts
 * nothing. Used for the marker keys, which are written with markLoginFailure.
 */
export async function readLoginCounters(keys, { windowMs = LOGIN_WINDOW_MS } = {}) {
  const list = keys.filter(Boolean);
  const out = Object.fromEntries(list.map((k) => [k, 0]));
  if (!list.length) return out;
  const digests = list.map(keyDigest);
  const { rows } = await query(
    `select key, attempts from login_attempts
      where key = any($1::text[])
        and window_start > now() - make_interval(secs => $2::double precision / 1000)`,
    [digests, windowMs],
  );
  const byDigest = new Map(rows.map((r) => [r.key, Number(r.attempts)]));
  list.forEach((k, i) => { out[k] = byDigest.get(digests[i]) || 0; });
  return out;
}

/**
 * Records one failure against a marker key and returns its in-window count
 * AFTER this failure (1 means this is the first one in the window). Atomic per
 * row: of any number of parallel failures, exactly one sees 1 -- which is what
 * lets the caller count a /64 towards its /48 only once, decided after the
 * write rather than from a snapshot read before the bcrypt compare.
 */
export async function markLoginFailure(key, { windowMs = LOGIN_WINDOW_MS } = {}) {
  if (!key) return 0;
  const out = await consumeLoginAttempts([{ key, limit: Number.MAX_SAFE_INTEGER }], { windowMs });
  return out[key].prior + 1;
}

/** Deletes the given keys outright (a successful login's clean slate). */
export async function clearLoginCounters(keys) {
  const list = keys.filter(Boolean);
  if (!list.length) return;
  // Locked in sorted key order first, for the same reason as the release above.
  await query(
    `with t as (select key from login_attempts where key = any($1::text[]) order by key for update)
     delete from login_attempts a using t where a.key = t.key`,
    [list.map(keyDigest)],
  );
}

/**
 * Best-effort housekeeping: drops rows whose window ended long ago. Called
 * from the login route now and then rather than on a schedule; a failure here
 * is logged and ignored.
 */
export async function pruneLoginAttempts({ olderThanMs = 2 * LOGIN_WINDOW_MS } = {}) {
  try {
    await query(
      `delete from login_attempts where window_start < now() - make_interval(secs => $1::double precision / 1000)`,
      [olderThanMs],
    );
  } catch (err) {
    console.error('[login-guard] prune failed:', err?.message || err);
  }
}
