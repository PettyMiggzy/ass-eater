import { del } from '@vercel/blob';
import { query, withTransaction } from './db';

/**
 * Deletes stored media files that belong to this site's Blob store, quietly.
 *
 * Removing a gallery item, replacing an avatar, taking a listing down or
 * resolving a takedown request used to drop the reference from the database
 * and leave the file itself in the store forever. For a TAKE IT DOWN Act
 * removal that is the one outcome that must not happen: the record says
 * "removed" while the file is still there. Every removal path calls this.
 *
 * Accepts any mix of:
 *   - media src strings as stored in records: '/api/media/<pathname>'
 *   - legacy absolute Blob URLs ('https://<store>.<access>.blob.vercel-storage.com/<pathname>')
 *   - objects with a `src` (gallery/listing media items)
 * Anything else -- seed images under /images/, external URLs, blanks -- is
 * ignored: those are not ours to delete, and guessing would be worse.
 *
 * Never throws. A cleanup failure must not roll back the moderation action
 * that triggered it (the reference is already gone, which is what hides the
 * file from the site); it is logged loudly AND recorded in media_uploads
 * (reason 'delete_failed'), so lib/media.js sweepOrphanedMedia retries it --
 * it used to be logged and then forgotten. Callers that remove a reference in
 * a transaction also record the files with recordPendingDeletions() on that
 * transaction first, so even a deletion that never gets to run (a throw or a
 * timeout after the commit) is retried.
 *
 * Files held as preserved evidence (lib/media-preservation.js, a POSSIBLE
 * MINOR report) are never deleted here; they come back in `preserved`.
 * Files on a report HOLD (media_holds -- a possible-minor report still open)
 * are not deleted either; they come back in `held`, and stay recorded
 * ('delete_pending') so the orphan sweep deletes them once the hold is
 * released, if nothing references them by then.
 *
 * Returns { deleted, failed, preserved, held } -- arrays of pathnames.
 * `deleteFile` is injectable for tests.
 */
export async function deleteMediaQuietly(items, { deleteFile = del } = {}) {
  const result = { deleted: [], failed: [], preserved: [], held: [] };
  let pathnames = mediaPathnames(items);
  if (!pathnames.length) return result;
  // Preserved evidence (lib/media-preservation.js) is never deleted, by any
  // path. If the lookup itself fails, nothing is deleted: a quarantined file
  // must not be destroyed because the database hiccuped. Every caller has
  // recorded its files ('delete_pending') first, so the sweep retries them.
  try {
    const kept = await preservedAmong(pathnames);
    if (kept.size) {
      result.preserved.push(...pathnames.filter((p) => kept.has(p)));
      pathnames = pathnames.filter((p) => !kept.has(p));
    }
    const held = await heldAmong(pathnames);
    if (held.size) {
      result.held.push(...pathnames.filter((p) => held.has(p)));
      pathnames = pathnames.filter((p) => !held.has(p));
      await recordHeld(result.held);
    }
  } catch (err) {
    console.error('[blob-cleanup] could not check preserved media; deleting nothing', pathnames, err && err.message);
    result.failed.push(...pathnames);
    await recordFailures(result.failed);
    return result;
  }
  if (!pathnames.length) return result;
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('[blob-cleanup] BLOB_READ_WRITE_TOKEN not set; could not delete', pathnames);
    result.failed.push(...pathnames);
    await recordFailures(result.failed);
    return result;
  }
  // del() takes pathnames or URLs; one call per file so a single bad entry
  // cannot make the whole batch fail silently. A few at a time: a deleted
  // creator can have 200+ files, and strictly sequential calls ran past the
  // function's time limit.
  //
  // Each delete runs under the per-file advisory lock preserveMedia and
  // holdMediaForReport take (and the orphan sweep deletes under), with the
  // preservation and the hold RE-CHECKED inside it. The checks above ran
  // without the lock, so a quarantine or report hold committing between them
  // and del() used to lose the file anyway -- evidence destroyed. Now a
  // preservation/hold either commits first (and is seen here) or waits for
  // this delete to finish. If the locked check itself fails, nothing is
  // deleted (the file is recorded 'delete_failed' for the sweep, which checks
  // again under the same lock).
  let next = 0;
  const lateHeld = [];
  const worker = async () => {
    while (next < pathnames.length) {
      const p = pathnames[next++];
      let outcome;
      try {
        outcome = await withTransaction(async (client) => {
          await client.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [p]);
          const { rows } = await client.query(
            `select 'preserved' as why from media_preservations where pathname = $1
              union all
             select 'held' from media_holds where pathname = $1
              limit 1`,
            [p],
          );
          if (rows.length) return rows[0].why;
          try {
            await deleteFile(p);
            // Tombstone, under the same lock (lib/media-refs.js): a finalize
            // replayed later must not reference a file that is gone.
            await client.query('insert into media_reaped (pathname) values ($1) on conflict do nothing', [p]);
            return 'deleted';
          } catch (err) {
            console.error('[blob-cleanup] failed to delete', p, err && err.message);
            return 'failed';
          }
        });
      } catch (err) {
        console.error('[blob-cleanup] could not lock/check before deleting; deleting nothing', p, err && err.message);
        outcome = 'failed';
      }
      if (outcome === 'deleted') result.deleted.push(p);
      else if (outcome === 'preserved') result.preserved.push(p);
      else if (outcome === 'held') {
        result.held.push(p);
        lateHeld.push(p);
      } else result.failed.push(p);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, pathnames.length) }, worker));
  if (lateHeld.length) await recordHeld(lateHeld);
  await recordFailures(result.failed);
  await forgetDeleted(result.deleted);
  return result;
}

// Each in-flight delete holds a pooled connection (the advisory lock is
// transaction-scoped), and lib/db.js keeps each instance's pool at 3 -- so at
// most 2, leaving one connection for everything else. A delete that cannot get
// a connection in time is recorded 'delete_failed' and finished by the sweep.
const DELETE_CONCURRENCY = 2;

/** The distinct store pathnames among `items` (srcs, URLs or `{ src }` objects). */
export function mediaPathnames(items) {
  const list = Array.isArray(items) ? items : [items];
  const pathnames = [];
  for (const item of list) {
    const p = blobPathnameFromSrc(typeof item === 'string' ? item : item && item.src);
    if (p && !pathnames.includes(p)) pathnames.push(p);
  }
  return pathnames;
}

/**
 * Records `items` as files about to be deleted (media_uploads, reason
 * 'delete_pending'). Call it with the TRANSACTION CLIENT of the change that
 * removes their last reference, then call deleteMediaQuietly after the
 * commit. If that post-commit deletion throws, times out or never runs, the
 * rows are still there and lib/media.js sweepOrphanedMedia deletes whatever
 * nothing references an hour later. Throws on failure, on purpose: the
 * removal should roll back rather than commit without its safety net.
 * Returns the recorded pathnames.
 */
export async function recordPendingDeletions(items, client) {
  let ours = mediaPathnames(items).filter((p) => OUR_PATH_RE.test(p));
  if (!ours.length) return ours;
  // Preserved evidence is never queued for deletion.
  const kept = await preservedAmong(ours, client);
  if (kept.size) ours = ours.filter((p) => !kept.has(p));
  if (!ours.length) return ours;
  await client.query(
    `insert into media_uploads (pathname, reason)
       select p, 'delete_pending' from unnest($1::text[]) as p
       on conflict (pathname) do update
         set reason = 'delete_pending', created_at = now(), claimed_at = null, claim_token = null`,
    [ours],
  );
  return ours;
}

// A file that is really gone needs no retry row. Best-effort: a leftover row
// only costs the sweep one del() that answers not-found.
async function forgetDeleted(pathnames) {
  if (!pathnames.length) return;
  try {
    await query('delete from media_uploads where pathname = any($1::text[])', [pathnames]);
  } catch (err) {
    console.error('[blob-cleanup] could not clear deleted paths', err && err.message);
  }
}

// Which of `pathnames` are preserved evidence (media_preservations, see
// lib/media-preservation.js -- queried directly here because that module
// imports this one). Throws on a database error; callers decide how to fail.
async function preservedAmong(pathnames, client = null) {
  if (!pathnames.length) return new Set();
  const runner = client || { query };
  const { rows } = await runner.query(
    'select pathname from media_preservations where pathname = any($1::text[])',
    [pathnames],
  );
  return new Set(rows.map((r) => r.pathname));
}

// Which of `pathnames` are on a report hold (media_holds, see
// lib/media-preservation.js holdMediaForReport). Throws on a database error.
async function heldAmong(pathnames, client = null) {
  if (!pathnames.length) return new Set();
  const runner = client || { query };
  const { rows } = await runner.query(
    'select distinct pathname from media_holds where pathname = any($1::text[])',
    [pathnames],
  );
  return new Set(rows.map((r) => r.pathname));
}

// A held file whose last reference is gone stays on the sweep's list, so it is
// deleted after the hold is released (the sweep re-checks references then).
// An existing row keeps its reason.
async function recordHeld(pathnames) {
  const ours = pathnames.filter((p) => OUR_PATH_RE.test(p));
  if (!ours.length) return;
  try {
    await query(
      `insert into media_uploads (pathname, reason)
         select p, 'delete_pending' from unnest($1::text[]) as p
         on conflict (pathname) do nothing`,
      [ours],
    );
  } catch (err) {
    console.error('[blob-cleanup] could not record held paths for a later sweep', ours, err && err.message);
  }
}

// Only pathnames this app issues (lib/media.js's layout) are recorded for the
// sweep to retry; anything else was never ours to manage by path.
const OUR_PATH_RE = /^(avatars|gallery|listings)\//;

async function recordFailures(pathnames) {
  const ours = pathnames.filter((p) => OUR_PATH_RE.test(p));
  if (!ours.length) return;
  try {
    // Preserved evidence is never put on the retry-deletion list.
    await query(
      `insert into media_uploads (pathname, reason)
         select p, 'delete_failed' from unnest($1::text[]) as p
          where not exists (select 1 from media_preservations mp where mp.pathname = p)
         on conflict (pathname) do update
           set reason = 'delete_failed', created_at = now(), claimed_at = null, claim_token = null`,
      [ours],
    );
  } catch (err) {
    console.error('[blob-cleanup] could not record failed deletions for retry', ours, err && err.message);
  }
}

const MEDIA_PREFIX = '/api/media/';

/**
 * The Blob pathname a stored src points at, or null if it is not a file in
 * our store. Exported for tests and for the media route.
 */
export function blobPathnameFromSrc(src) {
  if (typeof src !== 'string' || !src) return null;
  if (src.startsWith(MEDIA_PREFIX)) {
    const rest = src.slice(MEDIA_PREFIX.length).split(/[?#]/)[0];
    let decoded;
    try {
      decoded = rest.split('/').map(decodeURIComponent).join('/');
    } catch {
      return null;
    }
    return safePathname(decoded);
  }
  let url;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !/\.blob\.vercel-storage\.com$/.test(url.hostname)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    return null;
  }
  return safePathname(decoded);
}

function safePathname(p) {
  if (!p || p.length > 512) return null;
  if (p.startsWith('/') || p.includes('\\') || p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return null;
  }
  return p;
}
