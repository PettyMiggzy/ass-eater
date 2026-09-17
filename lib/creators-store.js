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

// `knownGallery` is a snapshot the client captured when it STARTED this
// upload -- if a second upload started before the first one's response
// came back, that snapshot is stale (missing the first upload's item),
// and appending to it here would silently overwrite/drop it. Always
// build on the gallery this call just fetched fresh from storage; the
// client's snapshot is only a last-resort fallback if the server record
// somehow has no gallery at all.
export async function addGalleryItem(creatorId, item, knownGallery) {
  const list = await getCreators();
  const idx = list.findIndex((c) => String(c.id) === String(creatorId));
  if (idx === -1) throw new Error('Creator not found');
  const creator = { ...list[idx] };
  const base = Array.isArray(creator.gallery) ? creator.gallery : Array.isArray(knownGallery) ? knownGallery : [];
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

// See addGalleryItem's comment -- same reasoning, always delete against
// the freshly-fetched gallery, not a client snapshot that may be stale.
export async function removeGalleryItem(creatorId, index, knownGallery) {
  const list = await getCreators();
  const idx = list.findIndex((c) => String(c.id) === String(creatorId));
  if (idx === -1) throw new Error('Creator not found');
  const creator = { ...list[idx] };
  const gallery = Array.isArray(creator.gallery) ? [...creator.gallery] : Array.isArray(knownGallery) ? [...knownGallery] : [];
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

// Fields that must never reach a public page's props/HTML -- payout details
// and a pending applicant's private contact email. Anything returned from
// getCreators() is a raw internal record; every public-facing page/API must
// pass creators through this before sending them to the client.
const PRIVATE_CREATOR_FIELDS = ['walletAddress', 'payoutMethod', 'contactEmail'];

export function toPublicCreator(creator) {
  if (!creator) return creator;
  const pub = { ...creator };
  for (const key of PRIVATE_CREATOR_FIELDS) delete pub[key];
  return pub;
}

const SUSPENSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Confirmed-content-violation enforcement ladder (decided 2026-09-17): the
 * first confirmed violation (currently: a non-consensual/deepfake report an
 * admin reviews and confirms) gets a 30-day suspension; a second gets a
 * permanent ban. "Forfeit funds owed" is a real, separate step that only
 * has something to act on once a custodial balance exists -- this live
 * site's payments are direct wallet-to-wallet transfers with no
 * platform-held balance (see Terms of Service Section 5), so a ban here
 * has no funds of the platform's to seize. The equivalent needs building
 * into server/'s ledger once that stack is the one taking payments.
 */
export async function applyContentViolation(creatorId) {
  const list = await getCreators();
  const idx = list.findIndex((c) => String(c.id) === String(creatorId));
  if (idx === -1) throw new Error('Creator not found');
  const count = (Number(list[idx].contentViolationCount) || 0) + 1;
  const updated = [...list];
  updated[idx] =
    count >= 2
      ? { ...list[idx], contentViolationCount: count, status: 'banned', suspendedUntil: null }
      : {
          ...list[idx],
          contentViolationCount: count,
          status: 'suspended',
          suspendedUntil: new Date(Date.now() + SUSPENSION_MS).toISOString(),
        };
  await saveCreators(updated);
  return updated[idx];
}

// A suspension lifts itself once suspendedUntil passes -- there's no cron
// job un-suspending anyone, every check just compares against the clock.
// Use this (not creator.status directly) anywhere enforcement or public
// visibility depends on whether a creator is currently in good standing.
export function effectiveCreatorStatus(creator) {
  if (!creator) return creator?.status;
  if (creator.status === 'suspended' && creator.suspendedUntil && new Date(creator.suspendedUntil) <= new Date()) {
    return 'active';
  }
  return creator.status;
}

export function isPubliclyVisible(creator) {
  const status = effectiveCreatorStatus(creator);
  return status !== 'pending' && status !== 'suspended' && status !== 'banned';
}
