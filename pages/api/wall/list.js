import { getWallPostsForCreator } from '../../../lib/wall-store';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { creatorId } = req.query;
  if (!creatorId) return res.status(400).json({ error: 'Missing creatorId' });

  const posts = await getWallPostsForCreator(creatorId);
  return res.status(200).json({ posts });
}
