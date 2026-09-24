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
import { Readable } from 'stream';
import { head, get, del, issueSignedToken, presignUrl, BlobNotFoundError } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { query } from './db';
import { parseCookies } from './session';
import { ageVerificationSecret } from './age-verification';
import { extensionFor, maxBytesFor, mediaKindFor, normalizeContentType } from './upload-guard';

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
 * the blob is deleted and MediaRejected is thrown with a user-safe message.
 * Returns { contentType, size, kind }.
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
    await deleteBlobQuietly(pathname);
    throw new MediaRejected('That file type or size is not accepted.');
  }
  return { contentType, size, kind };
}

export async function deleteBlobQuietly(pathname) {
  try {
    await del(pathname);
  } catch (err) {
    console.error('[media] failed to delete rejected upload', pathname, err && err.message);
  }
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
 * through, so video seeking still works) if presigning is unavailable.
 */
export async function sendMedia(req, res, pathname) {
  res.setHeader('Cache-Control', 'private, no-store');
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
  const result = await get(pathname, { access: 'private', headers: range ? { Range: range } : undefined });
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
  Readable.fromWeb(result.stream).pipe(res);
}

/**
 * Does this viewer hold a paid DIGITAL order for this listing? Read-only
 * query against orders (lib/orders-store.js owns the row shape: listingId,
 * buyerId, kind, status).
 */
export async function buyerHasDigitalOrder(userId, listingId) {
  if (!userId || listingId == null) return false;
  const { rows } = await query(
    `select 1 from orders
      where data->>'buyerId' = $1
        and data->>'listingId' = $2
        and data->>'kind' = 'digital'
        and coalesce(data->>'status', '') in ('fulfilled', 'delivered')
      limit 1`,
    [String(userId), String(listingId)],
  );
  return rows.length > 0;
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

function adminKeyFingerprint() {
  const key = process.env.ADMIN_UPLOAD_KEY;
  if (!key) return null;
  return crypto.createHash('sha256').update(`oa:admin-media-key:${key}`).digest('hex').slice(0, 32);
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
    return !!kf && data.kf === kf;
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
