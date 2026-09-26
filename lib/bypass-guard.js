import { query } from './db';

/**
 * Global guessing budget for the age-gate bypass links
 * (pages/api/age-verify/owner.js and reviewer.js).
 *
 * The per-IP limit those routes also apply (lib/rate-limit.js) is a speed bump
 * only: its counters live in one serverless instance's memory, and a host with
 * a routed IPv6 /64 has 2^64 source addresses to rotate through. With nothing
 * else, a name-plus-digits key falls to a dictionary in hours. This budget is
 * per ENDPOINT, counted in Postgres so every instance shares it, and it counts
 * every key attempt from anyone: once the window's budget is spent, every
 * attempt is refused -- the correct key included -- until the window rolls
 * over. That is the point. It bounds the whole internet to BUDGET guesses per
 * window, trading a leaked bypass for a lockout.
 *
 * THE COST, stated plainly: the lockout is not "minutes". The endpoint paths
 * are public in the repo, so anyone can send BUDGET junk requests every window
 * and keep BOTH bypass links refused -- the right key included -- for as long
 * as they bother, at a cost of about 100 requests an hour. The owner still has
 * the wallet door (/owner). A payment-processor reviewer has nothing else: if
 * a review coincides with such an attack, their link will not work until it
 * stops. Exhausting a window is logged as an error (below) so it is noticed.
 * Accepted deliberately: raising the budget, or exempting the right key while
 * it is spent, would bring back the guessing oracle this exists to remove.
 *
 * Low traffic by design: only a request that actually presents a key to a
 * configured bypass touches this table, so the "no Postgres on the login hot
 * path" reasoning in lib/rate-limit.js does not apply here.
 */

export const BYPASS_WINDOW_MS = 15 * 60 * 1000;
// Generous for a human mistyping on a phone, tiny for a dictionary: 25 per 15
// minutes is 2,400 guesses a day across the entire internet.
export const BYPASS_GLOBAL_BUDGET = 25;

/**
 * Counts one key attempt against `endpoint` and says whether it may be
 * evaluated. One atomic statement (fixed window: reset when the window has
 * passed, otherwise increment), so a parallel burst cannot all read "under
 * budget" before any of them is counted.
 *
 * Fails CLOSED: if the counter cannot be read, the attempt is refused. A
 * database hiccup costs the owner a retry; failing open would turn every
 * outage into an unlimited guessing window.
 */
export async function consumeBypassAttempt(endpoint, { budget = BYPASS_GLOBAL_BUDGET, windowMs = BYPASS_WINDOW_MS } = {}) {
  try {
    const { rows } = await query(
      `insert into bypass_key_attempts as b (endpoint, window_start, attempts)
         values ($1, now(), 1)
       on conflict (endpoint) do update set
         window_start = case when b.window_start <= now() - make_interval(secs => $2::double precision / 1000)
                             then now() else b.window_start end,
         attempts     = case when b.window_start <= now() - make_interval(secs => $2::double precision / 1000)
                             then 1 else b.attempts + 1 end
       returning attempts`,
      [String(endpoint), windowMs],
    );
    const attempts = Number(rows[0].attempts);
    // Log once per window, on the first refused attempt: a spent budget is
    // either a dictionary attack or someone locking the bypass links out.
    if (attempts === budget + 1) {
      console.error(`[bypass-guard] global guessing budget for "${endpoint}" spent (${budget} attempts in the window) -- bypass links refused until it rolls over`);
    }
    return { allowed: attempts <= budget };
  } catch (err) {
    console.error('[bypass-guard] counter unavailable, refusing attempt:', err?.message || err);
    return { allowed: false };
  }
}

/**
 * Hands back the attempt a CORRECT key consumed, so the owner's own successful
 * visits don't eat into the budget. Never below zero. Best-effort.
 */
export async function refundBypassAttempt(endpoint) {
  try {
    await query(
      `update bypass_key_attempts set attempts = greatest(attempts - 1, 0) where endpoint = $1`,
      [String(endpoint)],
    );
  } catch (err) {
    console.error('[bypass-guard] refund failed:', err?.message || err);
  }
}
