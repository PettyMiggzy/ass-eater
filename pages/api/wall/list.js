import { getWallPostsForCreator } from '../../../lib/wall-store';
import { getCreatorById } from '../../../lib/creators-store';
import { isPubliclyVisible } from '../../../lib/creator-status';

// Unauthenticated -- same rule as marketplace/list.js: never resolved
// against a creator the public can't see. Without this, a pending,
// suspended or permanently banned creator's wall (author names included --
// displayNameFor() shows a real creator name or an opted-in fan's real
// username, not just anonymous ids) stayed readable here even after the
// creator was hidden from every page/other endpoint that already checks
// isPubliclyVisible().
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { creatorId } = req.query;
  if (!creatorId) return res.status(400).json({ error: 'Missing creatorId' });

  const creator = await getCreatorById(creatorId);
  if (!creator || !isPubliclyVisible(creator)) {
    return res.status(200).json({ posts: [] });
  }

  const posts = await getWallPostsForCreator(creatorId);
  return res.status(200).json({ posts });
}
