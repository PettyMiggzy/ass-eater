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
 * anything else is retried with exponential backoff (1 min .. 6 h). One
 * answer is kept but flagged rather than failed: a reinstatement of an
 * account a server/ ADMIN banned or suspended (409 ban_needs_server_admin /
 * suspension_needs_server_admin) -- the site can only lift a restriction the
 * site applied, so that row stays listed, retried every 6 h, until someone
 * lifts it on server/ too. It runs
 * right after each admin change for the uids that changed, from the daily
 * cron (/api/cron/maintenance) and on demand from the admin panel
 * (/api/admin/standing-pushes), which also lists what is still undelivered.
 *
 * Every message carries `standingAt` (ms epoch: when the site decided it, or
 * -- set when the row is leased for delivery -- a moment after that decision
 * committed, whichever is later),
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

/**
 * server/'s answers (409) to a reinstatement it will not apply: the account
 * is BANNED or SUSPENDED there by a server/ admin, and only a server/ admin
 * lifts that. A ban or suspension the SITE applied is lifted by the site's
 * reinstatement as usual.
 */
export const BAN_NEEDS_SERVER_ADMIN = 'ban_needs_server_admin';
export const SUSPENSION_NEEDS_SERVER_ADMIN = 'suspension_needs_server_admin';
const NEEDS_SERVER_ADMIN = new Set([BAN_NEEDS_SERVER_ADMIN, SUSPENSION_NEEDS_SERVER_ADMIN]);

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
             -- Every enqueue is a new decision, even one with the same status
             -- and stamp (a changed suspension end): a delivery that leased
             -- an older version must not delete or fail this one.
             version = server_standing_pushes.version + 1,
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
 * backoff). Never throws. Returns { sent, failed, remaining } plus
 * `needsServerAdmin` (a count, only when non-zero) for reinstatements
 * server/ refused because a server/ admin applied the ban.
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
    //
    // The lease also moves the row's stamp up to NOW (the database clock, read
    // at statement time): a leased row is visible, so its decision has
    // committed, and "the site's standing for this account is X as of now" is
    // true -- every newer decision REPLACES the row. The stamp used to be the
    // moment the decision was queued, INSIDE its transaction, before the
    // commit: an exchange token minted in between read the old standing but
    // carried a later stamp, so server/ applied it and then ignored this push
    // as older. A stamp at or after the commit cannot lose that race.
    ({ rows } = await query(
      `update server_standing_pushes
          set next_at = now() + ($3::bigint * interval '1 millisecond'),
              standing_at = greatest(standing_at, (extract(epoch from clock_timestamp()) * 1000)::bigint)
        where uid in (
                select uid from server_standing_pushes
                 where ($1::text[] is null and next_at <= now()) or uid = any($1::text[])
                 order by next_at
                 limit $2
                 for update skip locked)
        returning uid, status, role, standing_at, suspended_until, attempts, version`,
      [uids ? uids.map(String) : null, Math.max(1, Math.min(Number(limit) || 50, 500)), LEASE_MS],
    ));
  } catch (err) {
    console.error('[standing-outbox] could not lease pushes', err && err.message);
    return summary;
  }
  for (const row of rows) {
    let failure = null;
    let needsServerAdmin = false;
    try {
      const res = await sendOne(row, fetchImpl);
      if (!res.ok) failure = `http_${res.status}`;
      // server/ refuses to let the site lift a ban or suspension one of ITS
      // admins applied (409 ban_needs_server_admin /
      // suspension_needs_server_admin). That is not a delivery failure to
      // retry quickly -- nothing changes until someone on server/ looks the
      // account up with GET /admin/users/by-site-uid/<site uid> and runs POST
      // /admin/users/<that server id>/status -- but it is not delivered either:
      // the account is still restricted there. Keep the row, flagged, and retry
      // at the slowest cadence so it clears by itself once that is done.
      if (res.status === 409) {
        let body = null;
        try { body = await res.json(); } catch { /* not JSON: a plain 409 */ }
        const code = body && (NEEDS_SERVER_ADMIN.has(body.error) ? body.error : NEEDS_SERVER_ADMIN.has(body.applied) ? body.applied : null);
        if (code) {
          failure = code;
          needsServerAdmin = true;
        }
      }
    } catch (err) {
      failure = err && err.name === 'TimeoutError' ? 'timeout' : 'network';
    }
    try {
      if (!failure) {
        // Only this exact decision: a newer one queued meanwhile stays. Matched
        // on the row's version, bumped by every enqueue -- matching on
        // (standing_at, status) deleted a newer decision that kept the leased
        // stamp and status but changed the suspension's END, so server/ lifted
        // the account on the old date and nothing ever re-sent the new one.
        await query('delete from server_standing_pushes where uid = $1 and version = $2', [row.uid, row.version]);
        summary.sent++;
        if (onDelivered) onDelivered(row.uid);
      } else {
        await query(
          `update server_standing_pushes
              set attempts = attempts + 1, last_error = $2,
                  next_at = now() + ($3::bigint * interval '1 millisecond'), updated_at = now()
            where uid = $1 and version = $4`,
          [row.uid, failure, needsServerAdmin ? MAX_BACKOFF_MS : backoffMs(row.attempts), row.version],
        );
        summary.failed++;
        if (needsServerAdmin) {
          summary.needsServerAdmin = (summary.needsServerAdmin || 0) + 1;
          console.error(`[standing-outbox] site user ${row.uid} was reinstated here but is ${failure === BAN_NEEDS_SERVER_ADMIN ? 'BANNED' : 'SUSPENDED'} on server/ by a server/ admin; `
            + `lift it there: GET /admin/users/by-site-uid/${row.uid} on server/ for its server id, `
            + 'then POST /admin/users/<that server id>/status {"status":"ACTIVE"} (the site uid itself is a 404 there).');
        } else {
          console.error(`[standing-outbox] push for site user ${row.uid} failed (${failure}); will retry.`);
        }
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
    // Not a transport failure: server/ got it and refused to lift a ban or
    // suspension its own admin applied. Needs GET /admin/users/by-site-uid/<uid>
    // on server/ for the server id, then POST /admin/users/<server id>/status.
    needsServerAdmin: NEEDS_SERVER_ADMIN.has(r.last_error),
    queuedAt: r.created_at,
  }));
}
