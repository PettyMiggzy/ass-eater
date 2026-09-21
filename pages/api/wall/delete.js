import { getSessionUser } from '../../../lib/session';
import { deleteWallPost, getWallPosts } from '../../../lib/wall-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const uid = user.id;

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing comment id' });

  const posts = await getWallPosts();
  const post = posts.find((p) => String(p.id) === String(id));
  if (!post) return res.status(404).json({ error: 'Comment not found' });

  const isWallOwner = user?.role === 'creator' && String(user.creatorId) === String(post.creatorId);

  try {
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
