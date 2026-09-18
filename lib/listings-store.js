import { readJsonList, updateJsonList } from './blob-json-store';

const MANIFEST_PATH = 'data/listings.json';

export async function getListings() {
  return readJsonList(MANIFEST_PATH);
}

export async function createListing(creatorId, fields) {
  return updateJsonList(MANIFEST_PATH, (list) => {
    const nextId = Math.max(0, ...list.map((l) => Number(l.id) || 0)) + 1;
    const listing = {
      id: nextId,
      creatorId,
      title: fields.title,
      description: fields.description || '',
      priceCents: fields.priceCents,
      unlimited: !!fields.unlimited,
      media: fields.media || [],
      kind: fields.kind === 'physical' ? 'physical' : 'digital',
      shippingCents: fields.kind === 'physical' ? Number(fields.shippingCents) || 0 : 0,
      // Advisory only -- we don't integrate with any carrier, this just reminds the creator and tells the buyer. See MARKETPLACE_FULFILLMENT.md.
      signatureRequired: fields.kind === 'physical' && !!fields.signatureRequired,
      aiGenerated: !!fields.aiGenerated,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    return { next: [...list, listing], result: listing };
  });
}

// Same reasoning as creators-store.js's addGalleryItem: `knownMedia` is a
// client-captured snapshot that goes stale the moment a second upload
// starts before the first one's response lands, so it must never win over
// the media list this call just fetched fresh from storage.
export async function addListingMedia(listingId, item, knownMedia) {
  return updateJsonList(MANIFEST_PATH, (list) => {
    const idx = list.findIndex((l) => String(l.id) === String(listingId));
    if (idx === -1) throw new Error('Listing not found');
    const base = Array.isArray(list[idx].media) ? list[idx].media : Array.isArray(knownMedia) ? knownMedia : [];
    const listing = { ...list[idx], media: [...base, item] };
    const next = [...list];
    next[idx] = listing;
    return { next, result: listing };
  });
}

export async function updateListing(listingId, creatorId, fields) {
  return updateJsonList(MANIFEST_PATH, (list) => {
    const idx = list.findIndex((l) => String(l.id) === String(listingId) && String(l.creatorId) === String(creatorId));
    if (idx === -1) throw new Error('Listing not found');
    const updated = [...list];
    updated[idx] = { ...updated[idx], ...fields };
    return { next: updated, result: updated[idx] };
  });
}

/** Admin/moderation path -- marks a listing removed regardless of creator ownership (updateListing above requires it). */
export async function markListingRemoved(listingId) {
  return updateJsonList(MANIFEST_PATH, (list) => {
    const idx = list.findIndex((l) => String(l.id) === String(listingId));
    if (idx === -1) return { next: list, result: null };
    const updated = [...list];
    updated[idx] = { ...updated[idx], status: 'removed' };
    return { next: updated, result: updated[idx] };
  });
}

export function findListing(list, id) {
  return list.find((l) => String(l.id) === String(id)) || null;
}
