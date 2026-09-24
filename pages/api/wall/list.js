import { getWallPostsForCreator, toPublicWallPost } from '../../../lib/wall-store';
import { getCreatorById } from '../../../lib/creators-store';
import { isPubliclyVisible, effectiveCreatorStatus } from '../../../lib/creator-status';
import { getSessionUser } from '../../../lib/session';

// Unauthenticated -- same rule as marketplace/list.js: never resolved
// against a creator the public can't see. Without this, a pending,
// suspended or permanently banned creator's wall (author names included --
// displayNameFor() shows a real creator name or an opted-in fan's real
// username, not just anonymous ids) stayed readable here even after the
// creator was hidden from every page/other endpoint that already checks
// isPubliclyVisible().
//
// One exception: the creator who owns the wall still sees it while their
// profile is pending or suspended (never once banned), matching what their
// own profile preview already server-renders -- otherwise posting a comment
// on their own wall made the whole wall appear to vanish.
//
// Posts come back as toPublicWallPost(): no commenter account ids, and a
// `mine` flag for the viewer's own comments.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { creatorId } = req.query;
  if (typeof creatorId !== 'string' || !creatorId.trim()) return res.status(400).json({ error: 'Missing creatorId' });

  try {
    const [creator, viewer] = await Promise.all([getCreatorById(creatorId), getSessionUser(req)]);
    if (!creator) return res.status(200).json({ posts: [] });

    const isOwner = !!viewer?.creatorId && String(viewer.creatorId) === String(creator.id);
    const visible = isPubliclyVisible(creator) || (isOwner && effectiveCreatorStatus(creator) !== 'banned');
    if (!visible) return res.status(200).json({ posts: [] });

    const posts = await getWallPostsForCreator(creator.id);
    return res.status(200).json({ posts: posts.map((p) => toPublicWallPost(p, viewer?.id ?? null)) });
  } catch (err) {
    console.error('[wall/list] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
