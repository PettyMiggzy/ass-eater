import crypto from 'crypto';

// Every /api/admin/* endpoint authenticates with the same single shared key,
// sent in an x-admin-key header. Each one used to compare it with `===`,
// which stops at the first differing byte -- the timing difference that
// leaks is small, but this is the one credential guarding every admin
// action (editing or deleting any creator, wiping the roster, resolving
// legally-clocked takedown requests), so it isn't one worth leaving
// guessable a byte at a time.
//
// Both sides are hashed to a fixed 32 bytes before comparing: timingSafeEqual
// throws outright on differently-sized buffers, and the key's own length is
// itself something not worth leaking.

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function isAdminRequest(req) {
  const expected = process.env.ADMIN_UPLOAD_KEY;
  // No key configured means nobody is an admin -- same as the old inline
  // checks (nothing could ever `===` an undefined env var), spelled out
  // here so a missing env var can't be matched by a caller who simply
  // sends the string "undefined".
  if (!expected) return false;
  const provided = req.headers['x-admin-key'];
  if (typeof provided !== 'string' || !provided) return false;
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

/**
 * Returns true when the caller holds the admin key. Otherwise it has already
 * sent the exact same 401 every admin endpoint used to send inline, and the
 * handler must `return` immediately without doing anything else.
 */
export function requireAdminKey(req, res) {
  if (isAdminRequest(req)) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}
