import { getVerifiedSessionUserId } from '../../../lib/session';
import { toggleFavorite } from '../../../lib/favorites-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to save creators' });

  const { creatorId } = req.body || {};
  if (!creatorId) return res.status(400).json({ error: 'Missing creatorId' });

  try {
    const result = await toggleFavorite(uid, creatorId);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    // toggleFavorite throws nothing of its own -- anything caught here is
    // an unexpected DB failure.
    console.error('[favorites/toggle] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
