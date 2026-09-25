/**
 * Private media pipeline (server-only).
 *
 * The Blob store is PRIVATE. Nothing uploaded by a creator is reachable at a
 * public URL any more: a stored media `src` is `/api/media/<pathname>`, and
 * that route (pages/api/media/[...path].js) decides per request whether the
 * viewer is entitled to the file before redirecting to a short-lived
 * presigned URL. Before this, every gallery photo, avatar and PAID listing
 * file lived at a permanent public URL that was shipped in page props, so
 * "removing" something (a takedown, a deleted gallery item) left it live, and
 * a CSS blur was the only thing between a visitor and paid content.
 *
 * Upload flow (the browser never sends file bytes through a function body --
 * Vercel caps those at 4.5MB):
 *   1. POST /api/media/upload-token { purpose, contentType, size, listingId?, creatorId? }
 *      -> { pathname, clientToken, contentType, maxBytes, validUntil }
 *      The pathname is chosen HERE (random uuid + an extension derived from
 *      the allowlisted type), so the upload's own file name is never used
 *      anywhere -- names with non-Latin-1 characters (every macOS screenshot)
 *      used to throw in fetch() before the request was even sent.
 *   2. Browser: put(pathname, file, { access: 'private', token: clientToken,
 *      contentType, multipart: file.size > 5MB }) from '@vercel/blob/client'.
 *   3. POST the finalize route with JSON { pathname, ... }. Finalize checks the
 *      pathname is inside the caller's own prefix, head()s the real stored
 *      type/size, deletes the blob if either is out of bounds, enforces caps
 *      against fresh server state, then records the src.
 * No onUploadCompleted callback is used: Vercel's callback request would hit
 * proxy.js's geoblock/age gate.
 */
import crypto from 'crypto';
import { Readable, pipeline } from 'stream';
import { head, get, del, issueSignedToken, presignUrl, BlobNotFoundError } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { query, withTransaction } from './db';
import { parseCookies } from './session';
import { ageVerificationSecret } from './age-verification';
import { extensionFor, maxBytesFor, mediaKindFor, normalizeContentType } from './upload-guard';
import { isMediaPreserved } from './media-preservation';
import { referencedMediaPaths, recordReaped } from './media-refs';

export const MEDIA_PREFIX = '/api/media/';

// ---------------------------------------------------------------------------
// Pathnames
// ---------------------------------------------------------------------------

const PURPOSE_DIRS = { avatar: 'avatars', gallery: 'gallery', listing: 'listings' };
const ID_RE = '[0-9A-Za-z_-]{1,64}';
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EXT_RE = '(jpg|png|webp|gif|avif|heic|heif|mp4|mov|webm)';
const CREATOR_MEDIA_RE = new RegExp(`^(avatars|gallery)/(${ID_RE})/(${UUID_RE})\\.${EXT_RE}$`);
const LISTING_MEDIA_RE = new RegExp(`^listings/(${ID_RE})/([0-9]{1,18})/(${UUID_RE})\\.${EXT_RE}$`);

/** A fresh, server-chosen pathname for one upload. Never derived from the file's own name. */
export function newMediaPathname({ purpose, creatorId, listingId, contentType }) {
  const dir = PURPOSE_DIRS[purpose];
  const ext = extensionFor(contentType);
  const cid = String(creatorId ?? '');
  if (!dir || !ext || !new RegExp(`^${ID_RE}$`).test(cid)) return null;
  const file = `${crypto.randomUUID()}.${ext}`;
  if (purpose === 'listing') {
    const lid = String(listingId ?? '');
    if (!/^[0-9]{1,18}$/.test(lid)) return null;
    return `${dir}/${cid}/${lid}/${file}`;
  }
  return `${dir}/${cid}/${file}`;
}

/**
 * Parses a media pathname into { purpose, creatorId, listingId? }, or null
 * when it is not one this app issues. Strict on purpose: the media route
 * serves nothing it cannot attribute to an owner.
 */
export function parseMediaPathname(pathname) {
  if (typeof pathname !== 'string' || pathname.length > 256) return null;
  let m = CREATOR_MEDIA_RE.exec(pathname);
  if (m) return { purpose: m[1] === 'avatars' ? 'avatar' : 'gallery', creatorId: m[2], pathname };
  m = LISTING_MEDIA_RE.exec(pathname);
  if (m) return { purpose: 'listing', creatorId: m[1], listingId: m[2], pathname };
  return null;
}

export function mediaSrc(pathname) {
  return `${MEDIA_PREFIX}${pathname}`;
}

/** The pathname a stored src points at if it is one of OUR media srcs, else null. */
export function pathnameFromMediaSrc(src) {
  if (typeof src !== 'string' || !src.startsWith(MEDIA_PREFIX)) return null;
  const rest = src.slice(MEDIA_PREFIX.length);
  return parseMediaPathname(rest) ? rest : null;
}

// ---------------------------------------------------------------------------
// Upload tokens + finalize verification
// ---------------------------------------------------------------------------

/**
 * Gallery slots. Bumped way up from the original 4/10 -- creators bringing an
 * existing back-catalog need real headroom. Still capped, since storage cost
 * scales with what is uploaded. Always computed from the FRESH creator record,
 * never from anything the client sends.
 */
export const FREE_GALLERY_SLOTS = 50;
export const PREMIUM_GALLERY_SLOTS = 200;
export function galleryLimitFor(creator) {
  return creator && creator.premium ? PREMIUM_GALLERY_SLOTS : FREE_GALLERY_SLOTS;
}

export function blobConfigured() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

const UPLOAD_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Client token for exactly one pathname and exactly one content type. With
 * addRandomSuffix and allowOverwrite both off and a random pathname, a token
 * is single-use in practice: it can write that one new file and nothing else.
 */
export async function issueUploadToken({ pathname, contentType, maxBytes }) {
  const validUntil = Date.now() + UPLOAD_TOKEN_TTL_MS;
  const clientToken = await generateClientTokenFromReadWriteToken({
    token: process.env.BLOB_READ_WRITE_TOKEN,
    pathname,
    allowedContentTypes: [contentType],
    maximumSizeInBytes: maxBytes,
    validUntil,
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  return { clientToken, validUntil };
}

export class MediaRejected extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.code = 'MEDIA_REJECTED';
  }
}

/**
 * Checks an uploaded blob really is what the token allowed. On any mismatch
 * the blob is deleted -- only if it is still an unfinalized upload, see
 * deleteUnfinalizedUpload -- and MediaRejected is thrown with a user-safe
 * message. Returns { contentType, size, kind }.
 */
export async function verifyUploadedBlob(pathname, purpose) {
  let meta;
  try {
    meta = await head(pathname);
  } catch (err) {
    // The browser never finished (or never started) the upload. instanceof,
    // not err.name: @vercel/blob's error classes all report name "Error".
    if (err instanceof BlobNotFoundError) {
      throw new MediaRejected('That upload could not be found. Please try again.', 404);
    }
    throw err;
  }
  const contentType = normalizeContentType(meta.contentType);
  const kind = mediaKindFor(purpose, contentType);
  const size = Number(meta.size);
  if (!kind || !Number.isFinite(size) || size <= 0 || size > maxBytesFor(purpose, contentType)) {
    await deleteUnfinalizedUpload(pathname);
    throw new MediaRejected('That file type or size is not accepted.');
  }
  return { contentType, size, kind };
}

/**
 * The ONLY delete a finalize route may do: throws away the file a finalize
 * request just refused (a missing §2257 answer, a full gallery, a listing that
 * can no longer be edited, a wrong type or size) -- and only if it really is
 * still an upload nobody has finalized.
 *
 * Finalize routes used to del() the posted pathname outright, and the only
 * check on it was that it sat in the caller's own prefix. Any file a creator
 * could name was therefore deletable by posting it back with a bad
 * attestation: a listing file buyers had paid for (sold listings and
 * retainedMedia included, which every other path deliberately keeps), or a
 * file quarantined as possible-minor evidence before its move to evidence/.
 *
 * Now, under the same per-file advisory lock the orphan sweep deletes under
 * and preserveMedia/holdMediaForReport take, the file is deleted only when ALL
 * of these hold:
 *   - it has a media_uploads row with reason 'token' (issued by
 *     /api/media/upload-token and never reaped or re-purposed),
 *   - no creator or listing references it (referencedMediaPaths),
 *   - it is not preserved evidence and not on a report hold.
 * Anything else is left alone and the finalize just answers its error; an
 * abandoned upload is reaped by the sweep an hour later anyway. `deleteFile`
 * is injectable for tests.
 *
 * Never throws. Returns 'deleted' | 'kept' | 'failed'.
 */
export async function deleteUnfinalizedUpload(pathname, { deleteFile = del } = {}) {
  if (!parseMediaPathname(pathname)) return 'kept';
  try {
    return await withTransaction(async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [pathname]);
      const { rows: token } = await client.query(
        `select 1 from media_uploads where pathname = $1 and reason = 'token'`,
        [pathname],
      );
      if (!token.length) return 'kept';
      const { rows: guarded } = await client.query(
        `select 1 from media_preservations where pathname = $1
          union all
         select 1 from media_holds where pathname = $1
          limit 1`,
        [pathname],
      );
      if (guarded.length) return 'kept';
      if ((await referencedMediaPaths([pathname], client)).size) return 'kept';
      try {
        await deleteFile(pathname);
      } catch (err) {
        if (!(err instanceof BlobNotFoundError)) {
          // The 'token' row stays, so the sweep retries it.
          console.error('[media] failed to delete rejected upload', pathname, err && err.message);
          return 'failed';
        }
      }
      await client.query(`delete from media_uploads where pathname = $1 and reason = 'token'`, [pathname]);
      await recordReaped(client, pathname);
      return 'deleted';
    });
  } catch (err) {
    console.error('[media] could not check a rejected upload; left for the sweep', pathname, err && err.message);
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Orphaned uploads
// ---------------------------------------------------------------------------
// A token lets the browser write a file straight into the private store, and
// the file is only referenced once finalize succeeds. A closed tab, a dropped
// connection between put() and finalize, a finalize that 500s, or a token
// requested and never used for finalize all left a file nobody references,
// nobody is served, and nothing would ever delete -- adult content in storage
// with no record that it exists. So every issued pathname is written down
// (media_uploads, lib/db.js) BEFORE its token is handed out, failed deletions
// are written down too, and sweepOrphanedMedia() reaps whatever is still
// unreferenced (an unfinalized upload after an hour; a removal or failed
// deletion at once). It runs on a schedule (GET /api/cron/media-sweep, see
// vercel.json), opportunistically on every upload-token request (a small
// batch), and in full from POST /api/admin/media-sweep.

export const ORPHAN_AGE_MS = 60 * 60 * 1000;

/** Never throws: a bookkeeping failure must not fail the caller's real work. */
export async function recordPendingMediaPath(pathname, reason = 'token') {
  if (typeof pathname !== 'string' || !pathname) return false;
  try {
    await query(
      `insert into media_uploads (pathname, reason) values ($1, $2)
         on conflict (pathname) do update
           set reason = excluded.reason, created_at = now(), claimed_at = null, claim_token = null`,
      [pathname, reason],
    );
    return true;
  } catch (err) {
    console.error('[media] could not record pending media path', pathname, err && err.message);
    return false;
  }
}

/**
 * Files still waiting to be deleted (removals and failed deletions), for the
 * admin panel: a takedown whose file failed to delete must be visible, not
 * just logged.
 */
export async function pendingDeletionCounts() {
  const { rows } = await query(
    `select count(*) filter (where reason = 'delete_failed')::int as failed,
            count(*) filter (where reason = 'delete_pending')::int as pending,
            min(created_at) filter (where reason <> 'token') as oldest
       from media_uploads`,
  );
  return {
    deleteFailed: rows[0]?.failed || 0,
    deletePending: rows[0]?.pending || 0,
    oldestAt: rows[0]?.oldest ? new Date(rows[0].oldest).toISOString() : null,
  };
}

// referencedMediaPaths lives in lib/media-refs.js (the stores need it for
// the finalize lock without importing this module); re-exported here.
export { referencedMediaPaths };

/**
 * Reaps up to `limit` recorded pathnames: deletes each file that nothing
 * references, forgets each one that something does (it was finalized).
 *
 * `olderThanMs` applies to reason 'token' rows ONLY -- an upload that may
 * still be finishing needs its hour. 'delete_pending' / 'delete_failed' rows
 * are the removals and failed takedown deletions: they are safe to process at
 * once (the reference check below still runs) and must not wait. They used to
 * wait an hour like everything else, and recording a failure reset the clock,
 * so an admin pressing Sweep right after a takedown whose file failed to
 * delete got "0 checked". Preserved evidence (media_preservations, see
 * lib/media-preservation.js) is never claimed at all, and neither is a file
 * on a report hold (media_holds) -- its row stays until the hold is released.
 *
 * Rows are CLAIMED, not deleted, up front: stamped with this sweep's
 * claim_token (FOR UPDATE SKIP LOCKED, so two sweeps never claim the same
 * row), and each row is deleted only after its own outcome -- file deleted
 * (or already gone), or found referenced. It used to claim by deleting the
 * rows first, so a throw (a dropped connection in referencedMediaPaths) or a
 * timeout part-way through the del() calls lost every claimed path for good,
 * including failed takedown deletions whose only retry was that row. Now a
 * throw leaves the unprocessed rows in the table: this sweep releases its
 * claims on the way out, and a claim abandoned by a killed function goes
 * stale after CLAIM_STALE_MS and is picked up again. A file whose deletion
 * fails is re-recorded as 'delete_failed' and retried by a later sweep.
 *
 * `timeBudgetMs` stops early (releasing the rest) rather than letting a big
 * admin sweep be killed by the platform's duration limit.
 *
 * Returns { checked, deleted, kept, failed, remaining }.
 */
const CLAIM_STALE_MS = 15 * 60 * 1000;

export async function sweepOrphanedMedia({
  olderThanMs = ORPHAN_AGE_MS,
  limit = 50,
  deleteFile = del,
  timeBudgetMs = 45 * 1000,
} = {}) {
  const max = Math.max(1, Math.min(Number(limit) || 50, 500));
  const token = crypto.randomUUID();
  const startedAt = Date.now();
  const { rows } = await query(
    `update media_uploads
        set claimed_at = now(), claim_token = $3
      where pathname in (
              select pathname from media_uploads
               where (reason <> 'token' or created_at < now() - ($1::bigint * interval '1 millisecond'))
                 and (claimed_at is null or claimed_at < now() - ($4::bigint * interval '1 millisecond'))
                 and not exists (select 1 from media_preservations mp where mp.pathname = media_uploads.pathname)
                 and not exists (select 1 from media_holds mh where mh.pathname = media_uploads.pathname)
               order by created_at
               limit $2
               for update skip locked)
      returning pathname`,
    [Math.max(0, Math.floor(olderThanMs)), max, token, CLAIM_STALE_MS],
  );
  const claimed = rows.map((r) => r.pathname);
  const summary = { checked: 0, deleted: 0, kept: 0, failed: 0, remaining: 0 };
  if (!claimed.length) return summary;
  // Deletes this sweep's own row only: a writer that re-recorded the path
  // since (a removal committing just now) cleared the claim, and its row
  // must survive for the next sweep.
  const forget = (pathname) =>
    query('delete from media_uploads where pathname = $1 and claim_token = $2', [pathname, token]);
  try {
    const referenced = await referencedMediaPaths(claimed);
    for (const pathname of claimed) {
      if (Date.now() - startedAt > timeBudgetMs) break;
      summary.checked++;
      if (referenced.has(pathname)) {
        await forget(pathname);
        summary.kept++;
        continue;
      }
      // The delete runs under a per-file advisory lock that preserveMedia
      // (lib/media-preservation.js) takes too, with the claim and the
      // preservation re-checked inside it: a quarantine committed since the
      // claim is seen here, and one starting now waits for this delete to
      // finish rather than racing it. The claim alone is not a lock. An
      // advisory lock rather than a row lock, so a removal re-recording this
      // path meanwhile (recordPendingMediaPath) is never blocked by the sweep.
      const outcome = await withTransaction(async (client) => {
        await client.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [pathname]);
        const { rows: mine } = await client.query(
          'select 1 from media_uploads where pathname = $1 and claim_token = $2',
          [pathname, token],
        );
        if (!mine.length) return 'skipped';
        // References are re-checked HERE, under the lock, not just once for
        // the batch above: a finalize (lib/media-refs.js lockMediaForFinalize)
        // that committed since then is seen, and one starting now waits and
        // then finds this file's row gone.
        if ((await referencedMediaPaths([pathname], client)).size) return 'referenced';
        const { rows: kept } = await client.query('select 1 from media_preservations where pathname = $1', [pathname]);
        if (kept.length) return 'preserved';
        // On a report hold (a possible-minor report still open): not deleted,
        // and the row stays for a sweep after the hold is released.
        const { rows: held } = await client.query('select 1 from media_holds where pathname = $1 limit 1', [pathname]);
        if (held.length) return 'held';
        try {
          await deleteFile(pathname);
        } catch (err) {
          if (!(err instanceof BlobNotFoundError)) {
            // never uploaded, or already gone, is a success; anything else is not
            console.error('[media] sweep could not delete', pathname, err && err.message);
            return 'failed';
          }
        }
        // The row goes, and the tombstone lands, in the same commit as the
        // file: a finalize waiting on this lock then refuses
        // (lib/media-refs.js lockMediaForFinalize) instead of recording a
        // reference to a file that no longer exists.
        await client.query('delete from media_uploads where pathname = $1 and claim_token = $2', [pathname, token]);
        await recordReaped(client, pathname);
        return 'deleted';
      });
      if (outcome === 'failed') {
        summary.failed++;
        await recordPendingMediaPath(pathname, 'delete_failed');
        continue;
      }
      if (outcome === 'held') {
        // Keep the row (the finally releases this sweep's claim on it).
        summary.kept++;
        continue;
      }
      await forget(pathname);
      if (outcome === 'deleted') summary.deleted++;
      else summary.kept++;
    }
  } finally {
    // Whatever this sweep did not get to goes back to the queue now rather
    // than waiting out the stale-claim window. Best-effort: if even this
    // fails, the claims go stale on their own.
    try {
      const { rowCount } = await query(
        'update media_uploads set claimed_at = null, claim_token = null where claim_token = $1',
        [token],
      );
      summary.remaining = rowCount || 0;
    } catch (err) {
      console.error('[media] could not release sweep claims', err && err.message);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

const PRESIGN_TTL_MS = 10 * 60 * 1000;
const SIGNED_TOKEN_TTL_MS = 60 * 60 * 1000;
const SIGNED_TOKEN_MARGIN_MS = 15 * 60 * 1000;
let cachedSignedToken = null;

async function storeReadToken() {
  const now = Date.now();
  if (cachedSignedToken && cachedSignedToken.validUntil - SIGNED_TOKEN_MARGIN_MS > now) return cachedSignedToken;
  const issued = await issueSignedToken({ operations: ['get'], validUntil: now + SIGNED_TOKEN_TTL_MS });
  cachedSignedToken = issued;
  return issued;
}

/** A presigned GET URL valid for ~10 minutes, or throws. */
export async function presignedGetUrl(pathname) {
  const token = await storeReadToken();
  const validUntil = Math.min(Date.now() + PRESIGN_TTL_MS, token.validUntil);
  const { presignedUrl } = await presignUrl(token, { operation: 'get', pathname, access: 'private', validUntil });
  return presignedUrl;
}

/**
 * Sends the file for an already-authorized request: a 302 to a presigned URL,
 * falling back to streaming it through this function (with Range passed
 * through, so video seeking still works) if presigning is unavailable. A HEAD
 * request gets a 200 with the file's headers and no redirect. A preserved
 * (quarantined) file is a 404 whatever the caller was entitled to.
 */
export async function sendMedia(req, res, pathname) {
  res.setHeader('Cache-Control', 'private, no-store');
  // Preserved evidence (a POSSIBLE MINOR report) is served to nobody through
  // this route -- not the owner, not an admin media session. This is the one
  // function every /api/media response goes through, so the check lives
  // here. isMediaPreserved fails closed.
  if (await isMediaPreserved(pathname)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  // HEAD is answered here from the blob's metadata, never redirected: a
  // presigned URL is signed for ONE operation, and a GET-signed URL replayed
  // as HEAD is refused by the store, so every HEAD probe (link previewers,
  // players, download managers) of a file the viewer is entitled to failed.
  if (req.method === 'HEAD') {
    let meta;
    try {
      meta = await head(pathname);
    } catch (err) {
      if (!(err instanceof BlobNotFoundError)) throw err;
      res.statusCode = 404;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', normalizeContentType(meta.contentType) || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    if (Number.isFinite(Number(meta.size))) res.setHeader('Content-Length', String(Number(meta.size)));
    res.end();
    return;
  }
  try {
    const url = await presignedGetUrl(pathname);
    res.setHeader('Location', url);
    res.statusCode = 302;
    res.end();
    return;
  } catch (err) {
    console.warn('[media] presign failed, streaming instead:', err && err.message);
  }
  const range = typeof req.headers.range === 'string' ? req.headers.range : null;
  let result;
  try {
    result = await get(pathname, { access: 'private', headers: range ? { Range: range } : undefined });
  } catch (err) {
    // An unsatisfiable Range comes back from the store as a 416, which
    // @vercel/blob throws as a plain BlobError ("Failed to fetch blob: 416
    // ..."). Answer it as a 416 -- a seek past the end is not a server fault.
    if (range && /Failed to fetch blob: 416\b/.test(String(err && err.message))) {
      res.statusCode = 416;
      try {
        const meta = await head(pathname);
        if (Number.isFinite(Number(meta.size))) res.setHeader('Content-Range', `bytes */${Number(meta.size)}`);
      } catch {
        // size unknown: a bare 416 is still correct
      }
      res.end();
      return;
    }
    throw err;
  }
  if (!result || result.statusCode !== 200 || !result.stream) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  const contentRange = result.headers.get('content-range');
  res.statusCode = contentRange ? 206 : 200;
  res.setHeader('Content-Type', normalizeContentType(result.blob.contentType) || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');
  const len = result.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  if (contentRange) res.setHeader('Content-Range', contentRange);
  // pipeline(), not .pipe(): pipe() does not forward errors, so an upstream
  // reset mid-body (routine for video seeking) emitted 'error' on a Readable
  // with no listener -- an uncaught exception that took down the whole
  // function instance and every other response it was serving.
  pipeline(Readable.fromWeb(result.stream), res, (err) => {
    if (err) {
      console.error('[media] stream failed', pathname, err && err.message);
      res.destroy(err);
    }
  });
}

/**
 * Does this viewer hold a paid DIGITAL order for this listing? Read-only
 * query against orders (lib/orders-store.js owns the row shape: listingId,
 * buyerId, kind, status).
 */
export async function buyerHasDigitalOrder(userId, listingId) {
  return (await buyerFirstDigitalOrderAt(userId, listingId)) !== null;
}

/**
 * When this viewer FIRST placed a paid digital order for this listing (ms
 * since epoch), or null if they hold none. Items a creator removed from a
 * listing after someone bought it move to `retainedMedia` with a `removedAt`
 * (lib/listings-store.js removeListingMediaForOwner); only buyers whose order
 * predates that removal are still served them.
 */
export async function buyerFirstDigitalOrderAt(userId, listingId) {
  if (!userId || listingId == null) return null;
  const { rows } = await query(
    `select count(*)::int as n, min(data->>'createdAt') as first from orders
      where data->>'buyerId' = $1
        and data->>'listingId' = $2
        and data->>'kind' = 'digital'
        and coalesce(data->>'status', '') in ('fulfilled', 'delivered')`,
    [String(userId), String(listingId)],
  );
  if (!rows.length || !(rows[0].n > 0)) return null;
  const t = Date.parse(rows[0].first ?? '');
  // An order with no parseable createdAt still proves payment for the live
  // media; it just can't claim anything retained.
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Token-gate hook. A gated creator's gallery is served to a non-owner,
 * non-admin (the route checks those first) only when the viewer holds a valid
 * `oa_holder` pass AND the wallet's balance -- read by this server from its
 * own RPC (lib/holder-access.js), never reported by the client -- meets the
 * creator's threshold. Missing/forged/expired pass, verifier not configured,
 * or too few tokens all answer false: the safe default for a gate.
 * Imported lazily because lib/holder-access.js imports this module.
 */
export async function canViewGatedCreatorMedia(req, creator) {
  const { holderVerificationLive, verifiedHolderBalance } = await import('./holder-access');
  const { tokenGateDecision } = await import('./token-gate');
  if (!holderVerificationLive()) return false;
  const held = await verifiedHolderBalance(req);
  if (held === null) return false;
  return tokenGateDecision(creator, held).allowed === true;
}

// ---------------------------------------------------------------------------
// Admin media session cookie
// ---------------------------------------------------------------------------
// <img> and <video> cannot send the x-admin-key header, so the admin panel
// trades the key for a short-lived cookie scoped to /api/media only. Signed
// with its OWN key derived from the root secret (context oa:admin-media:v1)
// and stamped typ:'admin_media', so it can never be confused with a session
// or age-verification token (the same two-layer guard those tokens use). It
// also carries a fingerprint of the admin key that minted it: rotating
// ADMIN_UPLOAD_KEY invalidates every outstanding cookie.

export const ADMIN_MEDIA_COOKIE = 'oa_admin_media';
export const ADMIN_MEDIA_MAX_AGE_SECONDS = 2 * 60 * 60;

function adminMediaKey() {
  return crypto.createHmac('sha256', ageVerificationSecret()).update('oa:admin-media:v1').digest();
}

// The fingerprint sits in the READABLE half of the cookie, so it is an HMAC
// under the server-derived key, never a plain hash of the admin key: a plain
// sha256 of a memorable ADMIN_UPLOAD_KEY could be brute-forced offline from
// one leaked cookie (a shared HAR file, a devtools screenshot). Same
// construction as the owner/reviewer bypass fingerprints in
// lib/age-verification.js. (Changing it invalidated outstanding cookies once,
// which for a 2-hour cookie is just a re-login.)
function adminKeyFingerprint() {
  const key = process.env.ADMIN_UPLOAD_KEY;
  if (!key) return null;
  return crypto.createHmac('sha256', adminMediaKey()).update(`oa:admin-media-kf:${key}`).digest('base64url').slice(0, 22);
}

export function createAdminMediaToken(now = Date.now()) {
  const kf = adminKeyFingerprint();
  if (!kf) throw new Error('ADMIN_UPLOAD_KEY is not set');
  const payload = Buffer.from(
    JSON.stringify({ typ: 'admin_media', exp: now + ADMIN_MEDIA_MAX_AGE_SECONDS * 1000, kf }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', adminMediaKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyAdminMediaToken(token, now = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  try {
    const expected = crypto.createHmac('sha256', adminMediaKey()).update(payload).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.typ !== 'admin_media') return false;
    if (!(Number(data.exp) > now)) return false;
    const kf = adminKeyFingerprint();
    if (!kf || typeof data.kf !== 'string') return false;
    const a = Buffer.from(data.kf);
    const b = Buffer.from(kf);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function hasAdminMediaSession(req) {
  return verifyAdminMediaToken(parseCookies(req)[ADMIN_MEDIA_COOKIE]);
}

export function adminMediaCookieHeader(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${ADMIN_MEDIA_COOKIE}=${token}; Path=/api/media; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_MEDIA_MAX_AGE_SECONDS}${secure}`;
}

export function clearAdminMediaCookieHeader() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${ADMIN_MEDIA_COOKIE}=; Path=/api/media; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}
