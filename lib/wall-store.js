import { put, head } from '@vercel/blob';

const MANIFEST_PATH = 'data/wall-posts.json';
const MAX_TEXT_LENGTH = 500;

async function fetchManifestUrl() {
  try {
    const info = await head(MANIFEST_PATH);
    return info.url;
  } catch {
    return null;
  }
}

export async function getWallPosts() {
  const url = await fetchManifestUrl();
  if (!url) return [];
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return [];
  return res.json();
}

async function saveWallPosts(list) {
  return put(MANIFEST_PATH, JSON.stringify(list, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
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
  const list = await getWallPosts();
  const nextId = Math.max(0, ...list.map((p) => Number(p.id) || 0)) + 1;
  const entry = {
    id: nextId,
    creatorId,
    authorId,
    authorName: String(authorName || 'Someone').slice(0, 60),
    text: trimmed.slice(0, MAX_TEXT_LENGTH),
    createdAt: new Date().toISOString(),
  };
  await saveWallPosts([...list, entry]);
  return entry;
}

/** Deleting is allowed for the comment's own author, or the creator whose wall it's on -- same as an IG/FB page owner moderating their own comments. Platform admins can go further via the existing report/ban tooling. */
export async function deleteWallPost(id, requesterId, { isWallOwner } = {}) {
  const list = await getWallPosts();
  const post = list.find((p) => String(p.id) === String(id));
  if (!post) throw new Error('Comment not found');
  if (String(post.authorId) !== String(requesterId) && !isWallOwner) {
    throw new Error('Not authorized to delete this comment');
  }
  await saveWallPosts(list.filter((p) => String(p.id) !== String(id)));
  return true;
}
