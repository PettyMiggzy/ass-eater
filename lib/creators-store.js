import { put, head } from '@vercel/blob';
import { creators as seedCreators } from '../data/creators';

const MANIFEST_PATH = 'data/creators.json';

async function fetchManifestUrl() {
  try {
    const info = await head(MANIFEST_PATH);
    return info.url;
  } catch {
    return null;
  }
}

export async function getCreators() {
  const url = await fetchManifestUrl();
  if (!url) {
    return seedCreators;
  }
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return seedCreators;
  return res.json();
}

export async function saveCreators(creatorsList) {
  const blob = await put(MANIFEST_PATH, JSON.stringify(creatorsList, null, 2), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
  });
  return blob;
}

export async function addGalleryItem(creatorId, item) {
  const list = await getCreators();
  const idx = list.findIndex((c) => String(c.id) === String(creatorId));
  if (idx === -1) throw new Error('Creator not found');
  const creator = { ...list[idx] };
  creator.gallery = [...(creator.gallery || []), item];
  const updated = [...list];
  updated[idx] = creator;
  await saveCreators(updated);
  return creator;
}

export async function addPendingCreator(profile) {
  const list = await getCreators();
  const nextId = Math.max(0, ...list.map((c) => Number(c.id) || 0)) + 1;
  const newCreator = {
    id: nextId,
    status: 'pending',
    locked: true,
    trending: false,
    subs: '0',
    posts: 0,
    media: profile.gallery?.length || 0,
    likes: '0',
    ...profile,
  };
  const updated = [...list, newCreator];
  await saveCreators(updated);
  return newCreator;
}
