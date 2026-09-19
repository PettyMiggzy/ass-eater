import crypto from 'crypto';

/**
 * A short, stable code identifying WHO was shown a piece of content.
 *
 * This is the honest half of "stop people stealing my content". Nothing on
 * the web can stop a screenshot (see components/ProtectedMedia.js for why),
 * so the useful question is not "can we prevent it" but "if it turns up
 * somewhere, can we tell whose screen it came off". A per-viewer mark makes
 * the answer yes, and knowing the answer is yes is most of the deterrent.
 *
 * Derived rather than random so there is nothing to store: the same viewer
 * always produces the same code, and an admin holding a leaked screenshot
 * recomputes the code for each suspect account until one matches. HMAC'd
 * with a purpose-bound key off the same root secret as sessions, so the code
 * cannot be forged by someone wanting to frame another account, and cannot
 * be reversed into a user id by someone who only has the screenshot.
 *
 * Server-only -- imports node:crypto. Compute it in getServerSideProps and
 * pass the string down; never import this from a component.
 */

const ROOT_SECRET =
  process.env.SESSION_SECRET ||
  process.env.ADMIN_UPLOAD_KEY ||
  (process.env.NODE_ENV === 'production' ? null : 'onlyone-dev-secret');
if (!ROOT_SECRET) {
  throw new Error('SESSION_SECRET (or ADMIN_UPLOAD_KEY) must be set in production -- refusing to derive viewer marks with no real secret.');
}
const SECRET = crypto.createHmac('sha256', ROOT_SECRET).update('oa:viewer-mark:v1').digest();

/**
 * @returns {string} e.g. "A3F9-21C4", or '' for a signed-out viewer (there
 * is nobody to identify, and inventing a code would imply otherwise).
 */
export function viewerMarkFor(userId) {
  if (!userId) return '';
  const hex = crypto.createHmac('sha256', SECRET).update(String(userId)).digest('hex').slice(0, 8).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/** True if this code belongs to this user. Deterministic, so this is the whole lookup. */
export function viewerMarkMatches(code, userId) {
  const expected = viewerMarkFor(userId);
  if (!expected || !code) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(code).toUpperCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
