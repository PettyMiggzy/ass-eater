import { put, head } from '@vercel/blob';

const MANIFEST_PATH = 'data/listings.json';

async function fetchManifestUrl() {
  try {
    const info = await head(MANIFEST_PATH);
    return info.url;
  } catch {
    return null;
  }
}

export async function getListings() {
  const url = await fetchManifestUrl();
  if (!url) return [];
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return [];
  return res.json();
}

export async function saveListings(list) {
  return put(MANIFEST_PATH, JSON.stringify(list, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

export async function createListing(creatorId, fields) {
  const list = await getListings();
  const nextId = Math.max(0, ...list.map((l) => Number(l.id) || 0)) + 1;
  const listing = {
    id: nextId,
    creatorId,
    title: fields.title,
    description: fields.description || '',
    priceCents: fields.priceCents,
    unlimited: !!fields.unlimited,
    media: fields.media || [],
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  await saveListings([...list, listing]);
  return listing;
}

export async function addListingMedia(listingId, item, knownMedia) {
  const list = await getListings();
  const idx = list.findIndex((l) => String(l.id) === String(listingId));
  if (idx === -1) throw new Error('Listing not found');
  const listing = { ...list[idx] };
  const base = Array.isArray(knownMedia) ? knownMedia : listing.media || [];
  listing.media = [...base, item];
  const updated = [...list];
  updated[idx] = listing;
  await saveListings(updated);
  return listing;
}

export async function updateListing(listingId, creatorId, fields) {
  const list = await getListings();
  const idx = list.findIndex((l) => String(l.id) === String(listingId) && String(l.creatorId) === String(creatorId));
  if (idx === -1) throw new Error('Listing not found');
  const updated = [...list];
  updated[idx] = { ...updated[idx], ...fields };
  await saveListings(updated);
  return updated[idx];
}

export function findListing(list, id) {
  return list.find((l) => String(l.id) === String(id)) || null;
}
