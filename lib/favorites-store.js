import { put, head } from '@vercel/blob';

const MANIFEST_PATH = 'data/favorites.json';

async function fetchManifestUrl() {
  try {
    const info = await head(MANIFEST_PATH);
    return info.url;
  } catch {
    return null;
  }
}

/** One row per (fan, creator) pair -- simplest possible shape, easy to filter either direction. */
export async function getFavorites() {
  const url = await fetchManifestUrl();
  if (!url) return [];
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return [];
  return res.json();
}

async function saveFavorites(list) {
  return put(MANIFEST_PATH, JSON.stringify(list, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

export async function getFavoriteCreatorIds(fanId) {
  const list = await getFavorites();
  return list.filter((f) => String(f.fanId) === String(fanId)).map((f) => f.creatorId);
}

export async function isFavorite(fanId, creatorId) {
  const list = await getFavorites();
  return list.some((f) => String(f.fanId) === String(fanId) && String(f.creatorId) === String(creatorId));
}

/** Adding twice, or removing something never added, are both harmless no-ops -- the button on the page just toggles, it doesn't need to know which state it started in. */
export async function toggleFavorite(fanId, creatorId) {
  const list = await getFavorites();
  const already = list.some((f) => String(f.fanId) === String(fanId) && String(f.creatorId) === String(creatorId));
  const updated = already
    ? list.filter((f) => !(String(f.fanId) === String(fanId) && String(f.creatorId) === String(creatorId)))
    : [...list, { fanId, creatorId, createdAt: new Date().toISOString() }];
  await saveFavorites(updated);
  return { favorited: !already };
}
