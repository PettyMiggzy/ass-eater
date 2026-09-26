import { getSessionUser } from '../../../lib/session';
import { deleteWallPost, getWallPostById } from '../../../lib/wall-store';
import { refuseMalformedText } from '../../../lib/field-validation';

export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const uid = user.id;

  // A string or number that is a positive integer, and nothing else. An
  // array like ["123"] stringifies to a valid id and used to reach the
  // bigint parameter raw, answering 500 (round-12 social#1).
  const rawId = (req.body || {}).id;
  if (rawId === undefined || rawId === null || rawId === '') {
    return res.status(400).json({ error: 'Missing comment id' });
  }
  if ((typeof rawId !== 'string' && typeof rawId !== 'number') || !/^[1-9]\d{0,17}$/.test(String(rawId))) {
    return res.status(400).json({ error: 'Invalid comment id' });
  }
  const id = String(rawId);

  try {
    // One row, and a malformed id is simply "not found" -- this used to read
    // every wall post on the platform to find one.
    const post = await getWallPostById(id);
    if (!post) return res.status(404).json({ error: 'Comment not found' });

    const isWallOwner = user?.role === 'creator' && String(user.creatorId) === String(post.creatorId);

    await deleteWallPost(id, uid, { isWallOwner });
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err.message === 'Not authorized to delete this comment' || err.message === 'Comment not found') {
      return res.status(err.message === 'Comment not found' ? 404 : 403).json({ error: err.message });
    }
    console.error('[wall/delete] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
