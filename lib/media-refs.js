/**
 * Media reference checks and the finalize lock (server-only).
 *
 * Imported by the stores (lib/creators-store.js, lib/listings-store.js) as
 * well as lib/media.js, so it depends on nothing but the database and the
 * src parser -- lib/media.js pulls in the session module, which the stores
 * must not.
 */
import { query } from './db';
import { blobPathnameFromSrc } from './blob-cleanup';

const MEDIA_PREFIX = '/api/media/';
const OUR_PATH_RE = /^(avatars|gallery|listings)\//;

/**
 * The subset of `pathnames` some record still points at: a creator's avatar,
 * hero video or gallery, or a listing's media / retainedMedia -- except a
 * listing whose files were deliberately deleted (mediaDeletedAt), whose srcs
 * are kept only as history.
 */
export async function referencedMediaPaths(pathnames, client = null) {
  const list = (Array.isArray(pathnames) ? pathnames : []).filter((p) => typeof p === 'string' && p);
  if (!list.length) return new Set();
  const { rows } = await (client || { query }).query(
    `select p.pathname
       from unnest($1::text[]) as p(pathname)
      where exists (
              select 1 from creators c
               where c.data->>'img' = $2 || p.pathname
                  or c.data->>'video' = $2 || p.pathname
                  or coalesce(c.data->'gallery', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('src', $2 || p.pathname)))
         or exists (
              select 1 from listings l
               where not (l.data ? 'mediaDeletedAt')
                 and (coalesce(l.data->'media', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('src', $2 || p.pathname))
                      or coalesce(l.data->'retainedMedia', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('src', $2 || p.pathname))))`,
    [list, MEDIA_PREFIX],
  );
  return new Set(rows.map((r) => r.pathname));
}

export const MEDIA_UPLOAD_EXPIRED = 'media_upload_expired';
export const MEDIA_UPLOAD_EXPIRED_MESSAGE = 'That upload expired before it was saved. Please upload the file again.';

/**
 * Serialises a finalize (a record about to start pointing at an uploaded
 * file) against the orphan sweep and every locked deletion. Call it on the
 * transaction that writes the reference, BEFORE the write:
 *
 *   - takes the per-file advisory lock ('media-file:<pathname>') the sweep,
 *     deleteMediaQuietly, deleteUnfinalizedUpload and preserveMedia take;
 *   - then refuses a file this app already deleted (media_reaped, written in
 *     the same locked transaction as every delete: the orphan sweep,
 *     deleteUnfinalizedUpload and deleteMediaQuietly) with
 *     MEDIA_UPLOAD_EXPIRED, rather than recording a reference to nothing.
 *
 * The sweep used to decide "unreferenced" once for its whole batch, outside
 * the lock, and a finalize landing after the one-hour mark (an admin retrying
 * the same upload after fixing a co-performer id) got its file deleted right
 * after the reference committed.
 *
 * Returns the pathname (or null for a src that is not one of our files --
 * a placeholder or seed image needs no lock). The upload's 'token' row is left
 * for the sweep, which re-checks references under this same lock and forgets
 * a referenced file.
 */
export async function lockMediaForFinalize(client, src) {
  const pathname = blobPathnameFromSrc(src);
  if (!pathname || !OUR_PATH_RE.test(pathname)) return null;
  await client.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [pathname]);
  const { rows } = await client.query('select 1 from media_reaped where pathname = $1', [pathname]);
  if (rows.length) throw Object.assign(new Error(MEDIA_UPLOAD_EXPIRED_MESSAGE), { code: MEDIA_UPLOAD_EXPIRED });
  return pathname;
}

/**
 * Records that `pathname` was deleted, on the transaction holding its
 * advisory lock (the one the delete ran under).
 */
export async function recordReaped(client, pathname) {
  if (!pathname) return;
  await client.query('insert into media_reaped (pathname) values ($1) on conflict do nothing', [pathname]);
}

