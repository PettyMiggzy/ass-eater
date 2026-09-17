import { readJsonList, updateJsonList } from './blob-json-store';

const MANIFEST_PATH = 'data/favorites.json';

/** One row per (fan, creator) pair -- simplest possible shape, easy to filter either direction. */
export async function getFavorites() {
  return readJsonList(MANIFEST_PATH);
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
  return updateJsonList(MANIFEST_PATH, (list) => {
    const already = list.some((f) => String(f.fanId) === String(fanId) && String(f.creatorId) === String(creatorId));
    const next = already
      ? list.filter((f) => !(String(f.fanId) === String(fanId) && String(f.creatorId) === String(creatorId)))
      : [...list, { fanId, creatorId, createdAt: new Date().toISOString() }];
    return { next, result: { favorited: !already } };
  });
}
