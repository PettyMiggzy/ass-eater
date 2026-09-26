import { refuseMalformedText } from '../../../lib/field-validation';
import { getWallPageForCreator, toPublicWallPost, wallBlockFlagsFor } from '../../../lib/wall-store';
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
// `mine` flag for the viewer's own comments. For the wall's owner only, each
// post also carries `authorBlocked` (whether the owner has blocked its
// author -- lib/wall-store.js wallBlockFlagsFor).
//
// GET ?creatorId=<id>&before=<postId>&limit=<n> -- one page, newest first
// (see lib/wall-store.js getWallPageForCreator). Answers
// { posts, hasMore, nextBefore }; pass nextBefore back as `before` for the
// next (older) page. It used to return the whole wall in one response.
export default async function handler(req, res) {
  // NUL / half an emoji in a query value is a 400, never a 500 from pg (round-11 fix-up).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { creatorId, before, limit } = req.query;
  if (typeof creatorId !== 'string' || !creatorId.trim()) return res.status(400).json({ error: 'Missing creatorId' });
  const empty = { posts: [], hasMore: false, nextBefore: null };

  try {
    const [creator, viewer] = await Promise.all([getCreatorById(creatorId), getSessionUser(req)]);
    if (!creator) return res.status(200).json(empty);

    const isOwner = !!viewer?.creatorId && String(viewer.creatorId) === String(creator.id);
    const visible = isPubliclyVisible(creator) || (isOwner && effectiveCreatorStatus(creator) !== 'banned');
    if (!visible) return res.status(200).json(empty);

    const page = await getWallPageForCreator(creator.id, {
      before: typeof before === 'string' ? before : null,
      limit: typeof limit === 'string' ? limit : undefined,
    });
    // The wall's owner also learns, per comment, whether they have blocked
    // its author (authorBlocked) -- so the wall can offer Unblock after a
    // reload. Nobody else gets the flag, and nobody gets the author's id.
    const flags = isOwner ? await wallBlockFlagsFor(viewer.id, page.posts) : null;
    return res.status(200).json({
      posts: page.posts.map((p) => toPublicWallPost(p, viewer?.id ?? null, flags ? { authorBlocked: flags.get(String(p.id)) === true } : {})),
      hasMore: page.hasMore,
      nextBefore: page.nextBefore,
    });
  } catch (err) {
    console.error('[wall/list] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
