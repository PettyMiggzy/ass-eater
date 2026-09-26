import { getVerifiedSessionUserId } from '../../../lib/session';
import { toggleFavorite, normalizeFavoriteCreatorId, FAVORITE_CREATOR_NOT_FOUND } from '../../../lib/favorites-store';
import { consumeAttempt } from '../../../lib/rate-limit';
import { refuseMalformedText } from '../../../lib/field-validation';
import { AUTHOR_ACCOUNT_GONE } from '../../../lib/author-lock';

export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to save creators' });

  // A creator id is a positive integer (string or number); anything else --
  // an object, an array, a 3 KB string -- used to be stored as-is
  // (round-22 media#0 / social#0).
  const { creatorId } = req.body || {};
  const id = normalizeFavoriteCreatorId(creatorId);
  if (!id) return res.status(400).json({ error: 'Missing or invalid creatorId' });

  // Every other social write is throttled; this one wasn't.
  const { limited, retryAfterSeconds } = consumeAttempt(`favorites-toggle:user:${uid}`, {
    limit: 60,
    windowMs: 60 * 1000,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many changes. Give it a moment.' });
  }

  try {
    const result = await toggleFavorite(uid, id);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    // The account was deleted while this request was in flight.
    if (err.code === FAVORITE_CREATOR_NOT_FOUND) return res.status(404).json({ error: 'Creator not found' });
    if (err.code === AUTHOR_ACCOUNT_GONE) return res.status(401).json({ error: 'Your account no longer exists.' });
    // Anything else is an unexpected DB failure.
    console.error('[favorites/toggle] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
