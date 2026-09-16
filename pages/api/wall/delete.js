import { getSessionUserId } from '../../../lib/session';
import { findUserById } from '../../../lib/users-store';
import { deleteWallPost, getWallPosts } from '../../../lib/wall-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = getSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Not logged in' });

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing comment id' });

  const posts = await getWallPosts();
  const post = posts.find((p) => String(p.id) === String(id));
  if (!post) return res.status(404).json({ error: 'Comment not found' });

  const user = await findUserById(uid);
  const isWallOwner = user?.role === 'creator' && String(user.creatorId) === String(post.creatorId);

  try {
    await deleteWallPost(id, uid, { isWallOwner });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
}
