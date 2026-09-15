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
    token: process.env.BLOB_READ_WRITE_TOKEN,
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

export async function updateCreatorProfile(creatorId, fields) {
  const list = await getCreators();
  const idx = list.findIndex((c) => String(c.id) === String(creatorId));
  if (idx === -1) throw new Error('Creator not found');
  const updated = [...list];
  updated[idx] = { ...updated[idx], ...fields };
  await saveCreators(updated);
  return updated[idx];
}

export async function setCreatorAvatar(creatorId, url) {
  return updateCreatorProfile(creatorId, { img: url });
}

export async function removeGalleryItem(creatorId, index) {
  const list = await getCreators();
  const idx = list.findIndex((c) => String(c.id) === String(creatorId));
  if (idx === -1) throw new Error('Creator not found');
  const creator = { ...list[idx] };
  const gallery = [...(creator.gallery || [])];
  gallery.splice(index, 1);
  creator.gallery = gallery;
  creator.media = gallery.length;
  const updated = [...list];
  updated[idx] = creator;
  await saveCreators(updated);
  return creator;
}

export async function createCreator(profile) {
  const list = await getCreators();
  const nextId = Math.max(0, ...list.map((c) => Number(c.id) || 0)) + 1;
  const newCreator = {
    id: nextId,
    name: 'New Model',
    handle: '@newmodel',
    img: '/images/mascot.png',
    video: null,
    subs: '0',
    price: '1M $ONLYASS',
    locked: true,
    trending: false,
    bio: '',
    posts: 0,
    media: 0,
    likes: '0',
    gallery: [],
    ...profile,
  };
  const updated = [...list, newCreator];
  await saveCreators(updated);
  return newCreator;
}

export async function deleteCreator(creatorId) {
  const list = await getCreators();
  const updated = list.filter((c) => String(c.id) !== String(creatorId));
  await saveCreators(updated);
  return updated;
}
