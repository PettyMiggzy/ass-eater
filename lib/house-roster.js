/**
 * The AI "house" model roster (server-only): sale-image registry, install,
 * status and removal.
 *
 * OnlyOne sells AI-generated photo sets of eight fictional adult characters
 * (data/house-roster.js) under house creator records -- `house: true`,
 * `aiModel: true`, no login and no payee. A house sale is 100% platform
 * revenue: the fan's credits are debited and no user is credited
 * (chargeHouseSale in lib/credits-store.js, called by lib/orders-store.js).
 *
 * The SOLD images (six per model, "slots" 1..6) are made by the owner and
 * uploaded through /admin (POST /api/admin/house-sale-image ->
 * saveHouseSaleImage). They are never committed to git and never under
 * public/: each upload goes straight to the PRIVATE Blob store at
 * house-sale/<slug>/<n>/<uuid>.<ext> -- a "master" pathname that
 * lib/media.js parseMediaPathname does not recognise, so /api/media serves it
 * to nobody (an admin views it through the admin-key route) and the orphan
 * sweep, which only ever claims media_uploads rows, never touches it. The
 * slot is recorded in app_meta ('house_sale_image:<slug>:<n>' ->
 * { slug, n, pathname, uploadedAt, bytes, contentType, previous }).
 * Re-uploading a slot writes a NEW master and records the old one under
 * `previous`; no master is ever deleted.
 *
 * The public images (avatar, cover, free-1, free-2) stay as files in the
 * repo under public/images/house/<slug>/.
 *
 * installHouseRoster() is idempotent and resumable, keyed by slug. It works
 * per model: a model is READY once all six slots are registered and its four
 * public files exist, and only ready models are installed -- so the owner can
 * go live one model at a time (`slug` limits the run to one model). For each
 * ready model it
 *   1. upserts the creator (found by data.houseSlug), active and visible,
 *      avatar/cover under /images/house/<slug>/;
 *   2. upserts five listings (found by data.houseSlug + data.houseKey),
 *      created OFF SALE (status 'removed', houseRemoved, houseIncomplete),
 *      and copies each listing's sale images from their masters into the
 *      normal listings/<creatorId>/<listingId>/<uuid>.<ext> pathnames -- so
 *      /api/media serves them only to admins and buyers with a paid digital
 *      order, exactly like any creator's listing. Every listing holds its own
 *      copy, tagged with the master it came from (`houseSource`). A copy of
 *      the current master is never made twice; a copy of a REPLACED master is
 *      swapped for a copy of the new one in one locked update, and the old
 *      copy moves to retainedMedia (removedAt) when anyone has bought the
 *      listing -- buyers keep what they paid for, and /api/media keeps
 *      serving it to them -- or is deleted when nobody has. A listing goes on
 *      sale only in the step that sees EVERY one of its plan's images
 *      attached (activateHouseListing), so a buyer can never pay for a bundle
 *      that is still partly copied.
 *   It stops at `timeBudgetMs` and reports { done: false }; calling it again
 *   continues where it stopped. Nothing is ever duplicated: each creator and
 *   each listing is found-or-created under a per-slug advisory lock, and a
 *   lease in app_meta ('house_roster_install_lease') keeps two installs from
 *   copying the same image twice.
 *
 * removeHouseRoster() hides the models (houseHidden -- isPubliclyVisible
 * returns false, so browse, profile and checkout all drop them) and takes
 * their ACTIVE listings off sale (status 'removed', houseRemoved: true). It
 * never deletes an order, a listing or a file: buyers keep what they paid for
 * (the media route serves a buyer regardless of listing status). Installing
 * again reverses it (for the models that are installed again).
 *
 * House models skip the §2257 go-live gate in pages/api/admin/profile.js on
 * purpose: they depict no real person, so there is no performer to hold a
 * record for. The install sets their status directly; that gate still applies
 * if an admin edits one through the normal creator editor.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { put, copy } from '@vercel/blob';
import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import {
  HOUSE_MODELS,
  HOUSE_LISTINGS,
  HOUSE_SALE_IMAGE_COUNT,
  HOUSE_SALE_SLOT_COUNT,
  isHouseClipSlot,
  houseBio,
  houseListingTitle,
  houseListingDescription,
  houseAvatarSrc,
  houseCoverSrc,
  housePublicImageSrcs,
  houseGallery,
} from '../data/house-roster';
import { sanitizeTags, sanitizeCategories, LISTING_LIMITS } from './creator-status';
import { newMediaPathname, mediaSrc, recordPendingMediaPath, blobConfigured } from './media';
import { addListingMediaForOwner, listingHasPaidDigitalOrders, MEDIA_CAP_EXCEEDED, LISTING_NOT_EDITABLE } from './listings-store';
import { lockListingsWithFiles, listingFileItems } from './media-locks';
import { lockMediaForFinalize } from './media-refs';
import { recordPendingDeletions, deleteMediaQuietly } from './blob-cleanup';
import { normalizeContentType } from './upload-guard';
import { getCreators } from './creators-store';

export const HOUSE_INSTALL_LEASE_KEY = 'house_roster_install_lease';
const LEASE_MS = 3 * 60 * 1000;

export const HOUSE_ERRORS = Object.freeze({
  INSTALL_BUSY: 'house_install_busy',
  BLOB_UNCONFIGURED: 'house_blob_unconfigured',
  IMAGES_MISSING: 'house_images_missing',
  BAD_SLOT: 'house_bad_slot',
  BAD_IMAGE: 'house_bad_image',
  IMAGE_TOO_LARGE: 'house_image_too_large',
  SLOT_EMPTY: 'house_slot_empty',
});

function houseError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

// ---------------------------------------------------------------------------
// Sale-image registry (the owner's uploads, private Blob masters)
// ---------------------------------------------------------------------------

/** The only types a sale image may be. No GIF/AVIF: these are sold photos, kept to the three every browser draws. */
export const HOUSE_SALE_IMAGE_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
/** The only type a sale video clip (slots 7-9) may be: MP4 plays everywhere. */
export const HOUSE_SALE_CLIP_TYPES = Object.freeze({ 'video/mp4': 'mp4' });

/** The accepted types for slot `n`: clips take MP4, photos take the three image types. */
export function saleTypesForSlot(n) {
  return isHouseClipSlot(n) ? HOUSE_SALE_CLIP_TYPES : HOUSE_SALE_IMAGE_TYPES;
}

/**
 * One sale image travels through a function body (POST
 * /api/admin/house-sale-image), and Vercel refuses any body over 4.5MB before
 * the handler runs -- with a non-JSON 413. 4MB keeps every accepted upload
 * under that, so an over-size file always gets this app's own clear refusal.
 */
export const HOUSE_SALE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

const REGISTRY_PREFIX = 'house_sale_image:';
const MASTER_PATH_RE = /^house-sale\/[a-z0-9-]{1,64}\/[1-9]\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp4)$/;

export function houseModelBySlug(slug) {
  return typeof slug === 'string' ? HOUSE_MODELS.find((m) => m.slug === slug) || null : null;
}

/**
 * Validates a (slug, n) slot from a request. `n` may be a number or a decimal
 * string. Returns { model, n }; throws BAD_SLOT (400) otherwise.
 */
export function parseHouseSaleSlot(slug, n) {
  const model = houseModelBySlug(slug);
  const num = typeof n === 'number' ? n : typeof n === 'string' && /^[0-9]{1,2}$/.test(n) ? Number(n) : NaN;
  if (!model || !Number.isInteger(num) || num < 1 || num > HOUSE_SALE_SLOT_COUNT) {
    throw houseError(HOUSE_ERRORS.BAD_SLOT, `Pick one of the house models and a slot from 1 to ${HOUSE_SALE_SLOT_COUNT} (1-${HOUSE_SALE_IMAGE_COUNT} photos, ${HOUSE_SALE_IMAGE_COUNT + 1}-${HOUSE_SALE_SLOT_COUNT} videos).`, 400);
  }
  return { model, n: num };
}

/** The real image type from the file's first bytes, or null. Never trusts the declared type alone. */
export function sniffImageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  // ISO base media: a 'ftyp' box first, with an MP4-family brand.
  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp' && /^(isom|iso[2-9]|mp4[12]|avc1|mp42|M4V |dash)/.test(bytes.subarray(8, 12).toString('latin1'))) return 'video/mp4';
  return null;
}

function slotKey(slug, n) {
  return `${REGISTRY_PREFIX}${slug}:${n}`;
}

/** A registry value is used only if it is one this module wrote (a master pathname for that very slot). */
function validSlotRecord(v, slug, n) {
  return !!v && typeof v === 'object' && v.slug === slug && Number(v.n) === n
    && typeof v.pathname === 'string' && MASTER_PATH_RE.test(v.pathname)
    && v.pathname.startsWith(`house-sale/${slug}/${n}/`)
    && !!saleTypesForSlot(n)[normalizeContentType(v.contentType)];
}

/** Default uploader: a private Blob put at the server-chosen pathname. Injectable for tests. */
export async function uploadToPrivateBlob(pathname, bytes, contentType) {
  await put(pathname, bytes, {
    access: 'private',
    contentType,
    addRandomSuffix: false,
    allowOverwrite: false,
  });
}

/** Default copier: master -> a listing's own pathname, inside the private store. Injectable for tests. */
export async function copyPrivateBlob(fromPathname, toPathname, contentType) {
  await copy(fromPathname, toPathname, {
    access: 'private',
    contentType,
    addRandomSuffix: false,
    allowOverwrite: false,
  });
}

/**
 * Stores one owner-made sale image for (slug, n): checks the slot, the
 * declared type (jpeg/png/webp), that the bytes really ARE that type, and the
 * size; uploads a new private master; then records it, replacing the slot.
 * The replaced master is kept (recorded in `previous`), never deleted --
 * listings keep their own copies anyway, and the next install swaps them.
 * Returns the public slot record { slug, n, bytes, contentType, uploadedAt, replaced }.
 */
export async function saveHouseSaleImage({ slug, n, bytes, contentType, uploadImage = uploadToPrivateBlob }) {
  const slot = parseHouseSaleSlot(slug, n);
  const type = normalizeContentType(contentType);
  const clip = isHouseClipSlot(slot.n);
  const types = saleTypesForSlot(slot.n);
  if (!type || !types[type]) {
    throw houseError(HOUSE_ERRORS.BAD_IMAGE, clip ? 'Video slots take an MP4 file.' : 'Sale images must be a JPEG, PNG or WebP photo.', 415);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw houseError(HOUSE_ERRORS.BAD_IMAGE, 'The upload was empty.', 400);
  }
  if (bytes.length > HOUSE_SALE_IMAGE_MAX_BYTES) {
    throw houseError(HOUSE_ERRORS.IMAGE_TOO_LARGE, `That file is too large (${HOUSE_SALE_IMAGE_MAX_BYTES / (1024 * 1024)}MB maximum). ${clip ? 'Export the video at a lower bitrate.' : 'Export it as a JPEG at a lower quality.'}`, 413);
  }
  if (sniffImageType(bytes) !== type) {
    throw houseError(HOUSE_ERRORS.BAD_IMAGE, clip ? 'That file is not an MP4 video. Export it again as MP4.' : 'That file is not the image type it says it is. Export it again as a JPEG, PNG or WebP.', 415);
  }
  const pathname = `house-sale/${slot.model.slug}/${slot.n}/${crypto.randomUUID()}.${types[type]}`;
  await uploadImage(pathname, bytes, type);
  const record = {
    slug: slot.model.slug,
    n: slot.n,
    pathname,
    uploadedAt: new Date().toISOString(),
    bytes: bytes.length,
    contentType: type,
  };
  const replaced = await withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [slotKey(slot.model.slug, slot.n)]);
    const { rows } = await client.query('select value from app_meta where key = $1 for update', [slotKey(slot.model.slug, slot.n)]);
    const cur = rows.length ? rows[0].value : null;
    const previous = cur && Array.isArray(cur.previous) ? [...cur.previous] : [];
    if (validSlotRecord(cur, slot.model.slug, slot.n)) {
      previous.push({ pathname: cur.pathname, uploadedAt: cur.uploadedAt, bytes: cur.bytes, contentType: cur.contentType, replacedAt: record.uploadedAt });
    }
    await client.query(
      `insert into app_meta (key, value) values ($1, $2::jsonb)
         on conflict (key) do update set value = excluded.value, created_at = now()`,
      [slotKey(slot.model.slug, slot.n), JSON.stringify({ ...record, previous })],
    );
    return !!cur;
  });
  return { slug: record.slug, n: record.n, bytes: record.bytes, contentType: record.contentType, uploadedAt: record.uploadedAt, replaced };
}

/** Every registered slot: { [slug]: { [n]: { pathname, bytes, contentType, uploadedAt } } }. */
export async function getHouseSaleImageRegistry() {
  const { rows } = await query(`select key, value from app_meta where key like $1`, [`${REGISTRY_PREFIX}%`]);
  const out = {};
  for (const m of HOUSE_MODELS) out[m.slug] = {};
  for (const r of rows) {
    const v = r.value;
    const model = houseModelBySlug(v && v.slug);
    const n = Number(v && v.n);
    if (!model || r.key !== slotKey(model.slug, n) || !validSlotRecord(v, model.slug, n)) continue;
    out[model.slug][n] = { pathname: v.pathname, bytes: Number(v.bytes) || 0, contentType: normalizeContentType(v.contentType), uploadedAt: v.uploadedAt || null };
  }
  return out;
}

/** The current master of one slot (for the admin "view" link), or null. */
export async function getHouseSaleImage(slug, n) {
  const slot = parseHouseSaleSlot(slug, n);
  const reg = await getHouseSaleImageRegistry();
  return reg[slot.model.slug][slot.n] || null;
}

function modelSaleReady(model, registry) {
  const slots = registry[model.slug] || {};
  for (let n = 1; n <= HOUSE_SALE_IMAGE_COUNT; n += 1) if (!slots[n]) return false;
  return true;
}

/** Whether every slot of every model (or of `slug` alone) is registered. */
export async function saleImagesDeployed(slug = null) {
  const registry = await getHouseSaleImageRegistry();
  const models = slug ? [parseHouseSaleSlot(slug, 1).model] : HOUSE_MODELS;
  return models.every((m) => modelSaleReady(m, registry));
}

/** The public/ file behind a site path like /images/house/<slug>/avatar.jpg. */
function publicFile(src) {
  return path.join(process.cwd(), 'public', ...String(src).split('/').filter(Boolean));
}

function modelPublicFiles(model) {
  return housePublicImageSrcs(model.slug).map((src) => ({ src, present: fs.existsSync(publicFile(src)) }));
}

/**
 * Whether every public avatar, cover and free preview is present
 * (public/images/house/) -- for every model, or for `slug` alone. The install
 * writes those paths into img, cover and the gallery, so a deployment without
 * them would publish profiles with broken images.
 */
export function profileImagesDeployed(slug = null) {
  const models = slug ? [parseHouseSaleSlot(slug, 1).model] : HOUSE_MODELS;
  return models.every((m) => modelPublicFiles(m).every((f) => f.present));
}

/** Both sets of images, for every model. */
export async function houseImagesDeployed() {
  return profileImagesDeployed() && (await saleImagesDeployed());
}

// ---------------------------------------------------------------------------
// Lease (keeps two installs from uploading the same image twice)
// ---------------------------------------------------------------------------

async function acquireLease(token) {
  const { rows } = await query(
    `insert into app_meta (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value, created_at = now()
         where (app_meta.value->>'until')::bigint < $3
     returning key`,
    [HOUSE_INSTALL_LEASE_KEY, JSON.stringify({ token, until: Date.now() + LEASE_MS }), Date.now()],
  );
  return rows.length > 0;
}

async function releaseLease(token) {
  await query(`delete from app_meta where key = $1 and value->>'token' = $2`, [HOUSE_INSTALL_LEASE_KEY, token]).catch(() => {});
}

// ---------------------------------------------------------------------------
// Creators and listings
// ---------------------------------------------------------------------------

function creatorFields(model) {
  return {
    name: model.name,
    handle: model.handle,
    bio: houseBio(model),
    img: houseAvatarSrc(model.slug),
    cover: houseCoverSrc(model.slug),
    video: null,
    // The house models sell photo sets in the marketplace; the profile itself
    // costs nothing to view.
    price: 'Free',
    locked: false,
    trending: false,
    premium: false,
    founding: false,
    seed: false,
    demo: false,
    house: true,
    aiModel: true,
    houseSlug: model.slug,
    houseHidden: false,
    status: 'active',
    tags: sanitizeTags(model.tags),
    categories: sanitizeCategories(model.categories),
    // The public teasers: the cover plus the free, fully clothed previews.
    // The sale sets are only ever sold (the admin-uploaded private masters,
    // copied into each listing -- see the module comment).
    gallery: houseGallery(model.slug),
  };
}

/** Find-or-create one house creator by slug, under a per-slug lock. Returns { creator, created }. */
export async function upsertHouseCreator(model) {
  const fields = creatorFields(model);
  return withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('house-roster:' || $1))`, [model.slug]);
    const { rows } = await client.query(
      `select id, data from creators where data->>'houseSlug' = $1 and coalesce((data->>'house')::boolean, false) order by id limit 1 for update`,
      [model.slug],
    );
    try {
      if (rows.length) {
        // A model an admin suspended or banned (a content report) stays that
        // way: re-installing refreshes its text and images, never its
        // moderation.
        const cur = rows[0].data || {};
        const patch = { ...fields };
        if (cur.status === 'banned' || cur.status === 'suspended') {
          delete patch.status;
        }
        const { rows: up } = await client.query(
          `update creators set data = data || $2::jsonb, updated_at = now() where id = $1 returning id, data`,
          [rows[0].id, JSON.stringify(patch)],
        );
        return { creator: rowToRecord(up[0]), created: false };
      }
      const { rows: ins } = await client.query(
        `insert into creators (id, data) values (nextval('creators_id_seq')::text, $1) returning id, data`,
        [JSON.stringify({ ...fields, createdAt: new Date().toISOString() })],
      );
      return { creator: rowToRecord(ins[0]), created: true };
    } catch (err) {
      // The partial unique index on handles: a real creator already took it.
      if (err && err.code === '23505') {
        throw houseError('house_handle_taken', `The handle ${model.handle} is already used by another creator, so ${model.name} could not be installed. Rename that creator's handle and install again.`);
      }
      throw err;
    }
  });
}

function listingFields(model, plan) {
  return {
    title: houseListingTitle(model, plan),
    description: houseListingDescription(model, plan),
    priceCents: plan.priceCents,
    unlimited: true,
    kind: 'digital',
    shippingCents: 0,
    signatureRequired: false,
    aiGenerated: true,
    tags: sanitizeTags(model.tags),
    houseSlug: model.slug,
    houseKey: plan.key,
  };
}

/**
 * Find-or-create one house listing (slug + key) for `creatorId`, under the
 * same per-slug lock. A NEW listing is created off sale (status 'removed',
 * houseRemoved, houseIncomplete): it goes on sale only through
 * activateHouseListing, once every image of its plan is attached. An existing
 * listing gets its text and price refreshed; one that is on sale but somehow
 * lacks any of its plan's images is taken back off sale. Returns the listing.
 */
export async function upsertHouseListing(model, plan, creatorId) {
  const fields = listingFields(model, plan);
  return withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('house-roster:' || $1))`, [model.slug]);
    const { rows } = await client.query(
      `select id, data from listings
        where data->>'houseSlug' = $1 and data->>'houseKey' = $2 and data->>'creatorId' = $3
        order by id limit 1 for update`,
      [model.slug, plan.key, String(creatorId)],
    );
    if (rows.length) {
      const cur = rowToRecord(rows[0]);
      const patch = { ...fields };
      if (cur.status === 'active' && !planComplete(cur, plan)) {
        patch.status = 'removed';
        patch.houseRemoved = true;
        patch.houseIncomplete = true;
      }
      const { rows: up } = await client.query(
        `update listings set data = data || $2::jsonb, updated_at = now() where id = $1 returning id, data`,
        [rows[0].id, JSON.stringify(patch)],
      );
      return rowToRecord(up[0]);
    }
    const { rows: ins } = await client.query(
      'insert into listings (data) values ($1) returning id, data',
      [JSON.stringify({
        ...fields,
        creatorId: String(creatorId),
        media: [],
        status: 'removed',
        houseRemoved: true,
        houseIncomplete: true,
        createdAt: new Date().toISOString(),
      })],
    );
    return rowToRecord(ins[0]);
  });
}

/** Whether `listing` holds every image its plan sells. */
export function planComplete(listing, plan) {
  return plan.images.every((n) => mediaHasImage(listing, n));
}

/**
 * Puts one house listing on sale -- only when every image of its plan is
 * attached, the listing was taken off sale by this module (houseRemoved, never
 * a MODERATION removal), and its model is not hidden. Checked on the locked
 * rows, so a concurrent "Remove house roster" or moderation action wins.
 * Returns true when the listing is (now) on sale.
 */
export async function activateHouseListing(listingId, plan) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('select id, data from listings where id = $1 for update', [listingId]);
    if (!rows.length) return false;
    const listing = rowToRecord(rows[0]);
    if (listing.status === 'active') return true;
    if (listing.houseRemoved !== true || listing.moderationRemoved || listing.status === 'sold') return false;
    if (!planComplete(listing, plan)) return false;
    const { rows: cRows } = await client.query('select data from creators where id = $1 for share', [String(listing.creatorId)]);
    const creator = cRows.length ? cRows[0].data || {} : null;
    if (!creator || creator.house !== true || creator.houseHidden === true) return false;
    await client.query(
      `update listings set data = data || '{"status": "active", "houseRemoved": false, "houseIncomplete": false}'::jsonb, updated_at = now()
        where id = $1`,
      [listingId],
    );
    return true;
  });
}

function mediaItemFor(listing, n) {
  return (Array.isArray(listing.media) ? listing.media : []).find((m) => m && m.houseImage === n) || null;
}

function mediaHasImage(listing, n) {
  return !!mediaItemFor(listing, n);
}

/** Whether the listing's copy of image `n` was made from the slot's CURRENT master. */
function copyIsCurrent(listing, n, slot) {
  const item = mediaItemFor(listing, n);
  return !!item && !!slot && item.houseSource === slot.pathname;
}

/**
 * Swaps the listing's copy of image `n` (src `oldSrc`) for `item` in one
 * locked update: files first, then the row (lib/media-locks.js order). The
 * old copy moves to retainedMedia with removedAt when anyone holds a paid
 * digital order for the listing (they keep it: /api/media serves a retained
 * item to buyers whose order predates its removal), otherwise it is deleted
 * after the commit. A sold or moderation-removed listing, or one whose item
 * changed meanwhile, is left alone (returns false; the unused new copy is
 * reaped by the orphan sweep).
 */
async function swapListingMedia(listingId, n, oldSrc, item) {
  const out = await withTransaction(async (client) => {
    const { rows } = await lockListingsWithFiles(client, { ids: [String(listingId)], extraItems: [item] });
    // Re-taken (a no-op) for its refusal of a file already reaped or quarantined.
    await lockMediaForFinalize(client, item.src);
    if (!rows.length) return { swapped: false };
    const current = rowToRecord(rows[0]);
    if (current.status === 'sold' || current.moderationRemoved || current.mediaDeletedAt) return { swapped: false };
    const media = Array.isArray(current.media) ? [...current.media] : [];
    const at = media.findIndex((m) => m && m.houseImage === n && m.src === oldSrc);
    if (at === -1) return { swapped: false };
    const old = media[at];
    media[at] = item;
    const patch = { media };
    const paid = await listingHasPaidDigitalOrders(current.id, client);
    if (paid) {
      patch.retainedMedia = [...(Array.isArray(current.retainedMedia) ? current.retainedMedia : []), { ...old, removedAt: new Date().toISOString() }];
    }
    const { rows: up } = await client.query(
      `update listings set data = data || $2::jsonb, updated_at = now() where id = $1 returning id, data`,
      [String(current.id), JSON.stringify(patch)],
    );
    const doomed = !paid && !listingFileItems(rowToRecord(up[0])).some((m) => m && m.src === old.src);
    if (doomed) await recordPendingDeletions(old, client);
    return { swapped: true, doomed: doomed ? old : null };
  });
  if (out.doomed) await deleteMediaQuietly(out.doomed);
  return out.swapped;
}

/**
 * Copies the current master of image `n` into one listing, unless that
 * listing already holds a copy of it. A copy of an older master is swapped.
 * Returns true when it copied.
 */
async function attachSaleImage(listing, n, slot, { copyImage }) {
  if (copyIsCurrent(listing, n, slot)) return false;
  const pathname = newMediaPathname({ purpose: 'listing', creatorId: listing.creatorId, listingId: listing.id, contentType: slot.contentType });
  if (!pathname) throw new Error(`Could not build a media pathname for listing ${listing.id}`);
  // Recorded before the copy, like /api/media/upload-token does: a file
  // whose reference never gets written (a crash here, a refused swap) is
  // reaped by the orphan sweep instead of sitting in storage with nothing
  // pointing at it.
  if (!(await recordPendingMediaPath(pathname, 'token'))) throw new Error('Could not record the upload');
  await copyImage(slot.pathname, pathname, slot.contentType);
  const item = {
    type: normalizeContentType(slot.contentType) === 'video/mp4' ? 'video' : 'image',
    src: mediaSrc(pathname),
    // No blurred teaser: the public listing card shows the model's cover
    // instead (toPublicListing never ships a src; a null preview is valid).
    preview: null,
    aiGenerated: true,
    houseImage: n,
    // The master this copy was made from; a re-uploaded slot differs.
    houseSource: slot.pathname,
    // No performer: an AI-generated image of a fictional character.
    performers: { othersAppear: false, fictional: true, attestedAt: new Date().toISOString() },
  };
  const existing = mediaItemFor(listing, n);
  if (existing) return swapListingMedia(listing.id, n, existing.src, item);
  try {
    await addListingMediaForOwner(listing.id, listing.creatorId, item, undefined, LISTING_LIMITS.maxMedia);
  } catch (err) {
    if (err.code === MEDIA_CAP_EXCEEDED || err.code === LISTING_NOT_EDITABLE) return false;
    throw err;
  }
  return true;
}

/** Which models an install may touch: all ready ones, or the one named. */
function readinessOf(model, registry, requireProfileImages) {
  const missingSlots = [];
  for (let n = 1; n <= HOUSE_SALE_IMAGE_COUNT; n += 1) if (!(registry[model.slug] || {})[n]) missingSlots.push(n);
  const missingFiles = requireProfileImages ? modelPublicFiles(model).filter((f) => !f.present).map((f) => f.src) : [];
  return { ready: !missingSlots.length && !missingFiles.length, missingSlots, missingFiles };
}

/**
 * Installs (or resumes installing) the roster -- every READY model, or only
 * `slug`. See the module comment. Returns { done, uploaded, installed,
 * skipped, status }: `uploaded` counts image copies made this call,
 * `installed` the slugs worked on, `skipped` the models left out because an
 * image is missing ({ slug, missingSlots, missingFiles }). Nothing is changed
 * when no model is ready (or the named one is not): IMAGES_MISSING. Any
 * other option (a legacy `payeeEmail`) is ignored: house sales have no payee.
 */
export async function installHouseRoster({
  slug = null,
  timeBudgetMs = 40_000,
  copyImage = copyPrivateBlob,
  requireBlob = true,
  requireProfileImages = true,
} = {}) {
  const started = Date.now();
  const targets = slug === null || slug === undefined ? HOUSE_MODELS : [parseHouseSaleSlot(slug, 1).model];
  if (requireBlob && !blobConfigured()) {
    throw houseError(HOUSE_ERRORS.BLOB_UNCONFIGURED, 'File storage is not configured, so the sale images cannot be copied.', 503);
  }
  const registry = await getHouseSaleImageRegistry();
  const ready = [];
  const skipped = [];
  for (const m of targets) {
    const r = readinessOf(m, registry, requireProfileImages);
    if (r.ready) ready.push(m);
    else skipped.push({ slug: m.slug, missingSlots: r.missingSlots, missingFiles: r.missingFiles });
  }
  if (!ready.length) {
    const which = targets.length === 1 ? `${targets[0].name} is` : 'No model is';
    throw houseError(HOUSE_ERRORS.IMAGES_MISSING, `${which} not ready: every model needs all ${HOUSE_SALE_IMAGE_COUNT} sale photos uploaded and its avatar, cover and free previews in public/images/house/. Nothing was changed.`, 409);
  }
  // House sales used to pay an owner-chosen payee login stored here; they are
  // platform revenue now, so a leftover row is cleared (it is read nowhere).
  await query(`delete from app_meta where key = 'house_payee_user_id'`);

  // Seeds the demo roster first if this database never had it (and moves the
  // id sequence past it), so a house model can never take a seed's id.
  await getCreators();

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (!(await acquireLease(token))) {
    throw houseError(HOUSE_ERRORS.INSTALL_BUSY, 'Another install is already running. Try again in a few minutes.');
  }
  let uploaded = 0;
  let done = true;
  try {
    outer: for (const model of ready) {
      const { creator } = await upsertHouseCreator(model);
      const slots = registry[model.slug];
      for (const plan of HOUSE_LISTINGS) {
        // A video listing waits for its clips: a model is ready with its six
        // photos, and each clip plan is added once its slots are uploaded.
        if (!plan.images.every((n) => slots[n])) continue;
        let listing = await upsertHouseListing(model, plan, creator.id);
        for (const n of plan.images) {
          if (copyIsCurrent(listing, n, slots[n])) continue;
          if (Date.now() - started > timeBudgetMs) {
            done = false;
            break outer;
          }
          if (await attachSaleImage(listing, n, slots[n], { copyImage })) uploaded += 1;
          const { rows } = await query('select id, data from listings where id = $1', [listing.id]);
          if (rows.length) listing = rowToRecord(rows[0]);
        }
        // On sale only now, with every image of the plan in place.
        await activateHouseListing(listing.id, plan);
      }
    }
  } finally {
    await releaseLease(token);
  }
  return { done, uploaded, installed: ready.map((m) => m.slug), skipped, status: await getHouseRosterStatus() };
}

/** Hides every house model and takes their active listings off sale. Never deletes anything. */
export async function removeHouseRoster() {
  return withTransaction(async (client) => {
    const { rows: hidden } = await client.query(
      `update creators set data = data || '{"houseHidden": true}'::jsonb, updated_at = now()
        where coalesce((data->>'house')::boolean, false)
        returning id`,
    );
    const ids = hidden.map((r) => String(r.id));
    const { rowCount } = ids.length
      ? await client.query(
        `update listings set data = data || '{"status": "removed", "houseRemoved": true}'::jsonb, updated_at = now()
          where data->>'creatorId' = any($1::text[]) and data->>'status' = 'active'`,
        [ids],
      )
      : { rowCount: 0 };
    return { hiddenCreators: ids.length, unlistedListings: rowCount };
  });
}

/**
 * Install state for the admin panel: per model, its six sale-photo slots
 * (filled or not -- never the image), its public files, whether it is ready
 * to install, and how much of it is installed.
 */
export async function getHouseRosterStatus() {
  const { rows: cRows } = await query(
    `select id, data from creators where coalesce((data->>'house')::boolean, false) order by id`,
  );
  const creators = rowsToRecords(cRows);
  const { rows: lRows } = creators.length
    ? await query(`select id, data from listings where data->>'creatorId' = any($1::text[])`, [creators.map((c) => String(c.id))])
    : { rows: [] };
  const listings = rowsToRecords(lRows);
  const registry = await getHouseSaleImageRegistry();
  const models = HOUSE_MODELS.map((m) => {
    const c = creators.find((x) => x.houseSlug === m.slug) || null;
    const own = c ? listings.filter((l) => String(l.creatorId) === String(c.id) && l.houseSlug === m.slug) : [];
    const slotsReg = registry[m.slug] || {};
    // Only plans whose slots are all uploaded are installed (clip plans wait for their clips).
    const plans = HOUSE_LISTINGS.filter((p) => p.images.every((n) => slotsReg[n]));
    const expectedImages = plans.reduce((n, p) => n + p.images.length, 0);
    const images = own.reduce((n, l) => n + (Array.isArray(l.media) ? l.media.filter((x) => x && x.houseImage).length : 0), 0);
    // Copies made from a master that has since been replaced: the next
    // install of this model swaps them.
    const staleImages = own.reduce((n, l) => n + (Array.isArray(l.media) ? l.media.filter((x) => x && x.houseImage && !(slotsReg[x.houseImage] && x.houseSource === slotsReg[x.houseImage].pathname)).length : 0), 0);
    const slots = [];
    for (let n = 1; n <= HOUSE_SALE_SLOT_COUNT; n += 1) {
      const r = slotsReg[n];
      const clip = isHouseClipSlot(n);
      slots.push(r ? { n, clip, filled: true, bytes: r.bytes, contentType: r.contentType, uploadedAt: r.uploadedAt } : { n, clip, filled: false });
    }
    const publicFiles = modelPublicFiles(m);
    return {
      slug: m.slug,
      name: m.name,
      creatorId: c ? String(c.id) : null,
      hidden: !!(c && c.houseHidden),
      status: c ? c.status : null,
      listings: own.length,
      activeListings: own.filter((l) => l.status === 'active').length,
      images,
      staleImages,
      expectedImages,
      expectedListings: plans.length,
      slots,
      publicFiles,
      // Ready = the six photos and the public files; clips are optional extras.
      ready: slots.every((x) => x.clip || x.filled) && publicFiles.every((f) => f.present),
    };
  });
  const complete = models.every((m) => m.creatorId && m.listings >= m.expectedListings && m.images >= m.expectedImages && m.staleImages === 0);
  return {
    models,
    installed: models.some((m) => m.creatorId),
    complete,
    hidden: models.some((m) => m.creatorId) && models.filter((m) => m.creatorId).every((m) => m.hidden),
    imagesDeployed: models.every((m) => m.ready),
    readyModels: models.filter((m) => m.ready).length,
    maxImageBytes: HOUSE_SALE_IMAGE_MAX_BYTES,
  };
}
