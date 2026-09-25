/**
 * Durable delivery of site -> server/ standing messages (server-only).
 *
 * A ban, suspension, reinstatement or deletion decided on this site has to
 * reach the account on server/ (api.joinonlyone.com), or that account keeps
 * renewing subscriptions and taking payouts. The push used to be one fetch
 * with an 8-second timeout whose only failure handling was a console.error:
 * a timeout, a 5xx, a 429 or the droplet being down lost the message for
 * good, and a deleted creator has no site login left to bridge with ever
 * again. So a push is now a ROW first:
 *
 *   server_standing_pushes (lib/db.js), keyed by site user id. Written in the
 *   same transaction as the change where the caller has one (NCII resolve,
 *   account moderation, creator/fan deletion), otherwise straight after it.
 *   A newer decision for the same uid REPLACES an older undelivered one --
 *   only the latest standing matters.
 *
 * deliverStandingPushes() sends due rows and deletes a row only on a 2xx
 * whose stamp still matches (a newer decision written meanwhile survives);
 * anything else is retried with exponential backoff (1 min .. 6 h). It runs
 * right after each admin change for the uids that changed, from the daily
 * cron (/api/cron/maintenance) and on demand from the admin panel
 * (/api/admin/standing-pushes), which also lists what is still undelivered.
 *
 * Every message carries `standingAt` (ms epoch: when the site decided it),
 * signed inside the token and repeated in the request body, so server/ can
 * ignore a message older than the last one it applied -- a late retry or an
 * exchange token minted just before a suspension can never undo it
 * (server/src/lib/bridge.ts claimStanding). Also `role` ('FAN' | 'CREATOR':
 * whose standing it is) and, for a creator suspension, `suspendedUntil`
 * (ms epoch) so server/ can lift a suspension that lapses on its own here.
 *
 * Nothing is queued while BRIDGE_SECRET is unset: then there is no server/ to
 * tell, and an account that bridges later is provisioned with its standing
 * at that moment.
 */
import { query } from './db';
import { mintBridgeStatusToken } from './bridge-token';

const API_BASE = process.env.SERVER_API_URL || 'https://api.joinonlyone.com';
const TIMEOUT_MS = 8_000;
const LEASE_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

export const SITE_STANDINGS = ['active', 'pending', 'suspended', 'banned'];

export function bridgeConfigured() {
  return !!process.env.BRIDGE_SECRET;
}

/**
 * Queues the latest standing for each entry ({ uid, status, role, suspendedUntil? }),
 * on `client` when given. Throws on a database error: a caller holding a
 * transaction should roll back rather than commit a change nobody will hear
 * about. Returns the number queued (0 when the bridge is not configured).
 */
export async function enqueueStandingPushes(entries, client = null) {
  if (!bridgeConfigured()) return 0;
  const list = (Array.isArray(entries) ? entries : [entries]).filter((e) => e && e.uid !== null && e.uid !== undefined && String(e.uid) !== '');
  if (!list.length) return 0;
  const runner = client || { query };
  const now = Date.now();
  for (const e of list) {
    const status = SITE_STANDINGS.includes(e.status) ? e.status : 'banned';
    const role = e.role === 'FAN' ? 'FAN' : 'CREATOR';
    const until = e.suspendedUntil ? Date.parse(e.suspendedUntil) : NaN;
    await runner.query(
      `insert into server_standing_pushes (uid, status, role, standing_at, suspended_until, attempts, next_at, last_error)
         values ($1, $2, $3, $4, $5, 0, now(), null)
       on conflict (uid) do update
         set status = excluded.status, role = excluded.role,
             standing_at = greatest(server_standing_pushes.standing_at, excluded.standing_at),
             suspended_until = excluded.suspended_until,
             attempts = 0, next_at = now(), last_error = null, updated_at = now()`,
      [String(e.uid), status, role, now, Number.isFinite(until) ? until : null],
    );
  }
  return list.length;
}

function backoffMs(attempts) {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts));
}

async function sendOne(row, fetchImpl) {
  const standingAt = Number(row.standing_at);
  const token = mintBridgeStatusToken(row.uid, row.status, {
    role: row.role,
    standingAt,
    suspendedUntil: row.suspended_until !== null && row.suspended_until !== undefined ? Number(row.suspended_until) : null,
  });
  const res = await fetchImpl(`${API_BASE}/auth/bridge/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, standingAt }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res;
}

/**
 * Delivers due pushes (or, with `uids`, those uids' pushes now regardless of
 * backoff). Never throws. Returns { sent, failed, remaining }.
 * `onDelivered(uid)` lets lib/server-api.js drop its cached access tokens.
 */
export async function deliverStandingPushes({ uids = null, limit = 50, fetchImpl = globalThis.fetch, onDelivered = null } = {}) {
  const summary = { sent: 0, failed: 0, remaining: 0 };
  if (!bridgeConfigured()) return summary;
  let rows;
  try {
    // Lease the rows (push next_at out) so two deliverers never send the
    // same one at the same time; a lease abandoned by a killed function just
    // expires.
    ({ rows } = await query(
      `update server_standing_pushes
          set next_at = now() + ($3::bigint * interval '1 millisecond')
        where uid in (
                select uid from server_standing_pushes
                 where ($1::text[] is null and next_at <= now()) or uid = any($1::text[])
                 order by next_at
                 limit $2
                 for update skip locked)
        returning uid, status, role, standing_at, suspended_until, attempts`,
      [uids ? uids.map(String) : null, Math.max(1, Math.min(Number(limit) || 50, 500)), LEASE_MS],
    ));
  } catch (err) {
    console.error('[standing-outbox] could not lease pushes', err && err.message);
    return summary;
  }
  for (const row of rows) {
    let failure = null;
    try {
      const res = await sendOne(row, fetchImpl);
      if (!res.ok) failure = `http_${res.status}`;
    } catch (err) {
      failure = err && err.name === 'TimeoutError' ? 'timeout' : 'network';
    }
    try {
      if (!failure) {
        // Only this exact decision: a newer one queued meanwhile stays.
        await query('delete from server_standing_pushes where uid = $1 and standing_at = $2 and status = $3', [row.uid, row.standing_at, row.status]);
        summary.sent++;
        if (onDelivered) onDelivered(row.uid);
      } else {
        await query(
          `update server_standing_pushes
              set attempts = attempts + 1, last_error = $2,
                  next_at = now() + ($3::bigint * interval '1 millisecond'), updated_at = now()
            where uid = $1 and standing_at = $4`,
          [row.uid, failure, backoffMs(row.attempts), row.standing_at],
        );
        summary.failed++;
        console.error(`[standing-outbox] push for site user ${row.uid} failed (${failure}); will retry.`);
      }
    } catch (err) {
      console.error('[standing-outbox] could not record push outcome', row.uid, err && err.message);
    }
  }
  try {
    const { rows: left } = await query('select count(*)::int as n from server_standing_pushes');
    summary.remaining = left[0]?.n || 0;
  } catch {
    // the count is informational
  }
  return summary;
}

/** Undelivered pushes, oldest first, for the admin panel. */
export async function listPendingStandingPushes(limit = 200) {
  const { rows } = await query(
    `select uid, status, role, standing_at, suspended_until, attempts, next_at, last_error, created_at, updated_at
       from server_standing_pushes
      order by created_at
      limit $1`,
    [Math.max(1, Math.min(Number(limit) || 200, 1000))],
  );
  return rows.map((r) => ({
    uid: r.uid,
    status: r.status,
    role: r.role,
    standingAt: new Date(Number(r.standing_at)).toISOString(),
    suspendedUntil: r.suspended_until ? new Date(Number(r.suspended_until)).toISOString() : null,
    attempts: r.attempts,
    nextAttemptAt: r.next_at,
    lastError: r.last_error,
    queuedAt: r.created_at,
  }));
}
