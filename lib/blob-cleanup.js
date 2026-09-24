import { del } from '@vercel/blob';
import { query } from './db';

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
 * it used to be logged and then forgotten.
 *
 * Returns { deleted: string[], failed: string[] } of pathnames.
 */
export async function deleteMediaQuietly(items) {
  const list = Array.isArray(items) ? items : [items];
  const pathnames = [];
  for (const item of list) {
    const p = blobPathnameFromSrc(typeof item === 'string' ? item : item && item.src);
    if (p && !pathnames.includes(p)) pathnames.push(p);
  }
  const result = { deleted: [], failed: [] };
  if (!pathnames.length) return result;
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('[blob-cleanup] BLOB_READ_WRITE_TOKEN not set; could not delete', pathnames);
    result.failed.push(...pathnames);
    await recordFailures(result.failed);
    return result;
  }
  // del() takes pathnames or URLs; one call per file so a single bad entry
  // cannot make the whole batch fail silently.
  for (const p of pathnames) {
    try {
      await del(p);
      result.deleted.push(p);
    } catch (err) {
      console.error('[blob-cleanup] failed to delete', p, err && err.message);
      result.failed.push(p);
    }
  }
  await recordFailures(result.failed);
  return result;
}

// Only pathnames this app issues (lib/media.js's layout) are recorded for the
// sweep to retry; anything else was never ours to manage by path.
const OUR_PATH_RE = /^(avatars|gallery|listings)\//;

async function recordFailures(pathnames) {
  const ours = pathnames.filter((p) => OUR_PATH_RE.test(p));
  if (!ours.length) return;
  try {
    await query(
      `insert into media_uploads (pathname, reason)
         select p, 'delete_failed' from unnest($1::text[]) as p
         on conflict (pathname) do update set reason = 'delete_failed', created_at = now()`,
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
