import { readJsonList, updateJsonList } from './blob-json-store';

const MANIFEST_PATH = 'data/wall-posts.json';
const MAX_TEXT_LENGTH = 500;

export async function getWallPosts() {
  return readJsonList(MANIFEST_PATH);
}

export async function getWallPostsForCreator(creatorId) {
  const list = await getWallPosts();
  return list
    .filter((p) => String(p.creatorId) === String(creatorId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function addWallPost({ creatorId, authorId, authorName, text }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Comment cannot be empty');
  return updateJsonList(MANIFEST_PATH, (list) => {
    const nextId = Math.max(0, ...list.map((p) => Number(p.id) || 0)) + 1;
    const entry = {
      id: nextId,
      creatorId,
      authorId,
      authorName: String(authorName || 'Someone').slice(0, 60),
      text: trimmed.slice(0, MAX_TEXT_LENGTH),
      createdAt: new Date().toISOString(),
    };
    return { next: [...list, entry], result: entry };
  });
}

/** Deleting is allowed for the comment's own author, or the creator whose wall it's on -- same as an IG/FB page owner moderating their own comments. Platform admins can go further via the existing report/ban tooling. */
export async function deleteWallPost(id, requesterId, { isWallOwner } = {}) {
  return updateJsonList(MANIFEST_PATH, (list) => {
    const post = list.find((p) => String(p.id) === String(id));
    if (!post) throw new Error('Comment not found');
    if (String(post.authorId) !== String(requesterId) && !isWallOwner) {
      throw new Error('Not authorized to delete this comment');
    }
    return { next: list.filter((p) => String(p.id) !== String(id)), result: true };
  });
}
