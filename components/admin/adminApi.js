import { put } from '@vercel/blob/client';

/**
 * Client-side helpers for the admin panel (pages/admin/index.js).
 *
 * Everything here runs in the browser and only ever talks to our own admin
 * routes with the x-admin-key header -- never a key in a URL, which would
 * land in history and in every proxy log between here and Vercel.
 */

/**
 * Parses a response body defensively. Vercel's own 413 / 504 pages and a
 * crashed route are HTML, not JSON, and `await res.json()` on those throws a
 * SyntaxError whose message ("Unexpected token <") is what the admin used to
 * see instead of the real reason.
 */
export async function readJson(res) {
  try {
    const data = await res.json();
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** The human message for a failed response, whatever shape its body has. */
export function errorFrom(res, data, fallback) {
  if (data && typeof data.error === 'string' && data.error) return data.error;
  if (res.status === 413) return 'That file is too large.';
  if (res.status === 401 || res.status === 403) return 'The admin key was refused. Reload and unlock again.';
  if (res.status === 429) return 'Too many requests. Wait a few minutes and try again.';
  if (res.status >= 500) return 'The server had a problem. Please try again.';
  return fallback;
}

/**
 * The admin key exactly as it is sent. String.prototype.trim() also strips
 * NBSP (U+00A0) and BOM (U+FEFF), which fetch leaves on a header value (it only
 * strips spaces and tabs) -- a key pasted from a doc or chat with one of those
 * attached would otherwise pass the unlock check (which trims) and then be
 * refused on every later request, each refusal counting toward the per-IP
 * lockout in lib/admin-auth.js. Every header this panel sends goes through here.
 */
export function adminKeyHeader(adminKey) {
  return String(adminKey ?? '').trim();
}

/** POST JSON to an admin route. Returns { res, data } and never throws on a bad body. */
export async function adminPost(adminKey, url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-admin-key': adminKeyHeader(adminKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { res, data: await readJson(res) };
}

export async function adminGet(adminKey, url) {
  const res = await fetch(url, { headers: { 'x-admin-key': adminKeyHeader(adminKey) } });
  return { res, data: await readJson(res) };
}

/**
 * The media contract (lib/media.js): an admin upload on a creator's behalf is
 *   1. POST /api/media/upload-token with the admin key and { creatorId } --
 *      the SERVER picks the pathname (a uuid under that creator's prefix),
 *   2. the browser puts the file straight into the private Blob store with
 *      the one-pathname client token (no file bytes pass through a function,
 *      so Vercel's 4.5MB body limit no longer applies),
 *   3. a JSON finalize call records it (/api/admin/avatar or /api/admin/upload).
 * The file name never travels anywhere: a raw non-Latin-1 name in a header
 * (every macOS screenshot) used to make fetch throw before sending.
 *
 * purpose: 'avatar' | 'gallery'. Returns the finalize response body
 * ({ ok, creator, item? }). Throws an Error with a readable message.
 *
 * Every finalize -- gallery AND avatar -- must say whether anyone besides the
 * creator appears in the file (othersAppear: boolean); when true,
 * coPerformerRecordIds lists the §2257 record of every other person
 * (lib/performer-attestation.js). /api/admin/avatar refuses a finalize
 * without the answer and deletes the upload. Checked here BEFORE the token
 * is requested, so a missing answer doesn't leave an uploaded file behind
 * with nothing to finalize it.
 */
export async function adminUploadMedia({ adminKey, creatorId, purpose, file, aiGenerated = false, othersAppear, coPerformerRecordIds, onProgress }) {
  if (!file) throw new Error('No file selected.');
  if (purpose === 'gallery' || purpose === 'avatar') {
    if (othersAppear !== true && othersAppear !== false) {
      throw new Error('Say whether anyone besides this creator appears in the file before uploading.');
    }
    if (othersAppear && (!Array.isArray(coPerformerRecordIds) || !coPerformerRecordIds.length)) {
      throw new Error('Pick the §2257 record of every other person who appears.');
    }
  }
  const contentType = file.type || '';
  if (!contentType) throw new Error("That file's type couldn't be read. Use a JPEG, PNG, WebP, GIF, AVIF, MP4, MOV or WebM file.");
  // HEIC/HEIF (iPhone photos) can't be shown by Chrome, Firefox or Edge, so a
  // HEIC avatar or gallery item is a broken image for most visitors.
  if (/^image\/hei[cf]/i.test(contentType)) {
    throw new Error('HEIC photos (the iPhone default) don\'t display in most browsers. Export it as JPEG or PNG and upload that.');
  }

  const token = await adminPost(adminKey, '/api/media/upload-token', {
    purpose,
    contentType,
    size: file.size,
    creatorId: String(creatorId),
  });
  if (!token.res.ok) throw new Error(errorFrom(token.res, token.data, 'Could not start the upload.'));
  const { pathname, clientToken } = token.data;
  if (typeof pathname !== 'string' || typeof clientToken !== 'string') {
    throw new Error('Could not start the upload.');
  }

  try {
    await put(pathname, file, {
      access: 'private',
      token: clientToken,
      contentType: token.data.contentType || contentType,
      multipart: file.size > 5 * 1024 * 1024,
      onUploadProgress: onProgress ? ({ percentage }) => onProgress(percentage) : undefined,
    });
  } catch (err) {
    console.error('[admin upload] blob put failed:', err);
    throw new Error('The upload did not finish. Check your connection and try again.');
  }

  const finalizeUrl = purpose === 'avatar' ? '/api/admin/avatar' : '/api/admin/upload';
  const attestation = {
    othersAppear,
    ...(othersAppear ? { coPerformerRecordIds: coPerformerRecordIds.map(String) } : {}),
  };
  const body = purpose === 'avatar'
    ? { creatorId: String(creatorId), pathname, ...attestation }
    : { creatorId: String(creatorId), pathname, aiGenerated: aiGenerated === true, ...attestation };
  const done = await adminPost(adminKey, finalizeUrl, body);
  if (!done.res.ok || !done.data.creator) {
    throw new Error(errorFrom(done.res, done.data, 'The file uploaded but could not be saved to the profile.'));
  }
  return done.data;
}

/** "$12.34" from integer cents (null/NaN reads as $0.00). */
export function dollars(cents) {
  const n = Number(cents);
  return `$${(Number.isFinite(n) ? n / 100 : 0).toFixed(2)}`;
}

/**
 * One line per creator a delete refused, skipped or stranded -- the shape
 * lib/creators-store.js getCreatorObligations() returns.
 */
export function describeObligation(o, creators = []) {
  if (!o || typeof o !== 'object') return '';
  const known = creators.find((c) => String(c.id) === String(o.creatorId));
  const who = o.name || known?.name || `creator #${o.creatorId}`;
  const parts = [];
  if (Number(o.balanceCents) > 0) parts.push(`${dollars(o.balanceCents)} credit balance`);
  if (Number(o.pendingPayouts) > 0) parts.push(`${o.pendingPayouts} pending payout(s) totalling ${dollars(o.pendingPayoutCents)}`);
  // The count alone left the admin with no order numbers to close; the
  // creator's editor ("Their orders") and ACCOUNTS -> Orders list them.
  if (Number(o.pendingShipments) > 0) {
    parts.push(`${o.pendingShipments} paid order(s) not yet shipped (ACCOUNTS -> Orders, seller number ${o.creatorId}, lists them)`);
  }
  return `${who}: ${parts.length ? parts.join(', ') : 'no outstanding money or orders'}`;
}
