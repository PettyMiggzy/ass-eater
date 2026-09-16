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
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return seedCreators;
  return res.json();
}

export async function saveCreators(creatorsList) {
  const blob = await put(MANIFEST_PATH, JSON.stringify(creatorsList, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return blob;
}

export async function addGalleryItem(creatorId, item, knownGallery) {
  const list = await getCreators();
  const idx = list.findIndex((c) => String(c.id) === String(creatorId));
  if (idx === -1) throw new Error('Creator not found');
  const creator = { ...list[idx] };
  const base = Array.isArray(knownGallery) ? knownGallery : creator.gallery || [];
  creator.gallery = [...base, item];
  creator.media = creator.gallery.length;
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

const SOCIAL_HANDLE_KEYS = ['twitter', 'instagram', 'tiktok', 'reddit'];

// Plain links only -- no OAuth/API integration with any social platform.
// Handles are stored bare (no @, no full URL) and the display URL is built
// from a fixed, trusted base on our side, so a creator pasting a full URL
// or a "javascript:" string can never end up as a raw href.
export function sanitizeSocials(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const key of SOCIAL_HANDLE_KEYS) {
    const raw = input[key];
    if (typeof raw !== 'string') continue;
    const handle = raw.trim().replace(/^https?:\/\/[^/]+\//i, '').replace(/^@/, '').replace(/\/+$/, '');
    if (handle) out[key] = handle.slice(0, 50);
  }
  if (typeof input.website === 'string') {
    const site = input.website.trim();
    if (/^https:\/\/[^\s]+$/i.test(site)) out.website = site.slice(0, 200);
  }
  return out;
}

const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 24;

/**
 * Accepts either a comma-separated string (what the dashboard's tag input
 * sends) or an array, and normalizes either into a clean, deduped,
 * lowercase array -- so creators can be found by what they're actually
 * about ("cosplay", "gym", "asmr", ...) via /search?tag=.
 */
export function sanitizeTags(input) {
  const raw = typeof input === 'string' ? input.split(',') : Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
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

export async function removeGalleryItem(creatorId, index, knownGallery) {
  const list = await getCreators();
  const idx = list.findIndex((c) => String(c.id) === String(creatorId));
  if (idx === -1) throw new Error('Creator not found');
  const creator = { ...list[idx] };
  const gallery = Array.isArray(knownGallery) ? [...knownGallery] : [...(creator.gallery || [])];
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
