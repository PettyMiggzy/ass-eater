/**
 * The AI "house" model roster (server-only): install, status and removal.
 *
 * OnlyOne sells AI-generated photo sets of eight fictional adult characters
 * (data/house-roster.js) under house creator records -- `house: true`,
 * `aiModel: true`, no login and no payee. A house sale is 100% platform
 * revenue: the fan's credits are debited and no user is credited
 * (chargeHouseSale in lib/credits-store.js, called by lib/orders-store.js).
 *
 * installHouseRoster() is idempotent and resumable, keyed by slug:
 *   1. upserts the eight creators (found by data.houseSlug), active and
 *      visible, avatar/cover under /images/house/<slug>/;
 *   2. upserts five listings per model (found by data.houseSlug +
 *      data.houseKey), created OFF SALE (status 'removed', houseRemoved,
 *      houseIncomplete), and uploads each listing's sale images from
 *      data/house-media/<slug>/ to the PRIVATE Blob store at the normal
 *      listings/<creatorId>/<listingId>/<uuid>.jpg pathnames -- so
 *      /api/media serves them only to admins and buyers with a paid digital
 *      order, exactly like any creator's listing. A media item already on the
 *      listing (matched by data.houseImage) is never uploaded again. A
 *      listing goes on sale only in the step that sees EVERY one of its
 *      plan's images attached (activateHouseListing), so a buyer can never
 *      pay for a bundle that is still partly uploaded -- an install that stops
 *      mid-way, or never resumes, leaves the incomplete listing off sale.
 *   It stops at `timeBudgetMs` and reports { done: false }; calling it again
 *   continues where it stopped. Nothing is ever duplicated: each creator and
 *   each listing is found-or-created under a per-slug advisory lock, and a
 *   lease in app_meta ('house_roster_install_lease') keeps two installs from
 *   uploading the same image twice.
 *
 * removeHouseRoster() hides the models (houseHidden -- isPubliclyVisible
 * returns false, so browse, profile and checkout all drop them) and takes
 * their ACTIVE listings off sale (status 'removed', houseRemoved: true). It
 * never deletes an order, a listing or a file: buyers keep what they paid for
 * (the media route serves a buyer regardless of listing status). Installing
 * again reverses it.
 *
 * House models skip the §2257 go-live gate in pages/api/admin/profile.js on
 * purpose: they depict no real person, so there is no performer to hold a
 * record for. The install sets their status directly; that gate still applies
 * if an admin edits one through the normal creator editor.
 */
import fs from 'fs';
import path from 'path';
import { put } from '@vercel/blob';
import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import {
  HOUSE_MODELS,
  HOUSE_LISTINGS,
  HOUSE_SALE_IMAGE_COUNT,
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
import { addListingMediaForOwner, MEDIA_CAP_EXCEEDED } from './listings-store';
import { getCreators } from './creators-store';

export const HOUSE_INSTALL_LEASE_KEY = 'house_roster_install_lease';
const LEASE_MS = 3 * 60 * 1000;

export const HOUSE_ERRORS = Object.freeze({
  INSTALL_BUSY: 'house_install_busy',
  BLOB_UNCONFIGURED: 'house_blob_unconfigured',
  IMAGES_MISSING: 'house_images_missing',
});

function houseError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

/** Where the sale images are on disk (never under public/). */
export function houseMediaDir() {
  return path.join(process.cwd(), 'data', 'house-media');
}

export function saleImageFile(slug, n) {
  return path.join(houseMediaDir(), slug, `sale-${n}.jpg`);
}

/** Default image reader: the committed JPEG. Injectable for tests. */
export async function readSaleImageFromDisk(slug, n) {
  return fs.promises.readFile(saleImageFile(slug, n));
}

/** Default uploader: a private Blob put at the server-chosen pathname. Injectable for tests. */
export async function uploadToPrivateBlob(pathname, bytes) {
  await put(pathname, bytes, {
    access: 'private',
    contentType: 'image/jpeg',
    addRandomSuffix: false,
    allowOverwrite: false,
  });
}

/** Whether every sale image is present on disk (the deployment must include data/house-media/). */
export function saleImagesDeployed() {
  for (const m of HOUSE_MODELS) {
    for (let n = 1; n <= HOUSE_SALE_IMAGE_COUNT; n += 1) {
      if (!fs.existsSync(saleImageFile(m.slug, n))) return false;
    }
  }
  return true;
}

/** The public/ file behind a site path like /images/house/<slug>/avatar.jpg. */
function publicFile(src) {
  return path.join(process.cwd(), 'public', ...String(src).split('/').filter(Boolean));
}

/**
 * Whether every public avatar, cover and free preview is present
 * (public/images/house/). The install writes those paths into img, cover and
 * the gallery, so a deployment without them would publish profiles with
 * broken images.
 */
export function profileImagesDeployed() {
  return HOUSE_MODELS.every((m) => housePublicImageSrcs(m.slug).every((src) => fs.existsSync(publicFile(src))));
}

/** Both sets of files the install needs. */
export function houseImagesDeployed() {
  return saleImagesDeployed() && profileImagesDeployed();
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
    // The lingerie sets are only ever sold (data/house-media/, private Blob).
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

function mediaHasImage(listing, n) {
  return (Array.isArray(listing.media) ? listing.media : []).some((m) => m && m.houseImage === n);
}

/** Uploads one sale image into one listing, unless it is already there. Returns true when it uploaded. */
async function attachSaleImage(model, listing, n, { readImage, uploadImage }) {
  if (mediaHasImage(listing, n)) return false;
  const bytes = await readImage(model.slug, n);
  const pathname = newMediaPathname({ purpose: 'listing', creatorId: listing.creatorId, listingId: listing.id, contentType: 'image/jpeg' });
  if (!pathname) throw new Error(`Could not build a media pathname for listing ${listing.id}`);
  // Recorded before the upload, like /api/media/upload-token does: a file
  // whose reference never gets written (a crash here) is reaped by the orphan
  // sweep instead of sitting in storage with nothing pointing at it.
  if (!(await recordPendingMediaPath(pathname, 'token'))) throw new Error('Could not record the upload');
  await uploadImage(pathname, bytes);
  const item = {
    type: 'image',
    src: mediaSrc(pathname),
    // No blurred teaser: the public listing card shows the model's cover
    // instead (toPublicListing never ships a src; a null preview is valid).
    preview: null,
    aiGenerated: true,
    houseImage: n,
    // No performer: an AI-generated image of a fictional character.
    performers: { othersAppear: false, fictional: true, attestedAt: new Date().toISOString() },
  };
  try {
    await addListingMediaForOwner(listing.id, listing.creatorId, item, undefined, LISTING_LIMITS.maxMedia);
  } catch (err) {
    if (err.code === MEDIA_CAP_EXCEEDED) return false;
    throw err;
  }
  return true;
}

/**
 * Installs (or resumes installing) the roster. See the module comment.
 * Returns { done, uploaded, status }. Any other option (a legacy
 * `payeeEmail`) is ignored: house sales have no payee.
 */
export async function installHouseRoster({
  timeBudgetMs = 40_000,
  readImage = readSaleImageFromDisk,
  uploadImage = uploadToPrivateBlob,
  requireBlob = true,
  requireProfileImages = true,
} = {}) {
  const started = Date.now();
  if (requireBlob && !blobConfigured()) {
    throw houseError(HOUSE_ERRORS.BLOB_UNCONFIGURED, 'File storage is not configured, so the sale images cannot be uploaded.', 503);
  }
  if (readImage === readSaleImageFromDisk && !saleImagesDeployed()) {
    throw houseError(HOUSE_ERRORS.IMAGES_MISSING, 'The house sale images are not in this deployment (data/house-media/). Nothing was changed.', 500);
  }
  if (requireProfileImages && !profileImagesDeployed()) {
    throw houseError(HOUSE_ERRORS.IMAGES_MISSING, 'The house avatars and covers are not in this deployment (public/images/house/). Nothing was changed.', 500);
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
    outer: for (const model of HOUSE_MODELS) {
      const { creator } = await upsertHouseCreator(model);
      for (const plan of HOUSE_LISTINGS) {
        let listing = await upsertHouseListing(model, plan, creator.id);
        for (const n of plan.images) {
          if (mediaHasImage(listing, n)) continue;
          if (Date.now() - started > timeBudgetMs) {
            done = false;
            break outer;
          }
          if (await attachSaleImage(model, listing, n, { readImage, uploadImage })) uploaded += 1;
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
  return { done, uploaded, status: await getHouseRosterStatus() };
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

/** Install state for the admin panel: each model and how many of its images are in place. */
export async function getHouseRosterStatus() {
  const { rows: cRows } = await query(
    `select id, data from creators where coalesce((data->>'house')::boolean, false) order by id`,
  );
  const creators = rowsToRecords(cRows);
  const { rows: lRows } = creators.length
    ? await query(`select id, data from listings where data->>'creatorId' = any($1::text[])`, [creators.map((c) => String(c.id))])
    : { rows: [] };
  const listings = rowsToRecords(lRows);
  const expectedImages = HOUSE_LISTINGS.reduce((n, p) => n + p.images.length, 0);
  const models = HOUSE_MODELS.map((m) => {
    const c = creators.find((x) => x.houseSlug === m.slug) || null;
    const own = c ? listings.filter((l) => String(l.creatorId) === String(c.id) && l.houseSlug === m.slug) : [];
    const images = own.reduce((n, l) => n + (Array.isArray(l.media) ? l.media.filter((x) => x && x.houseImage).length : 0), 0);
    return {
      slug: m.slug,
      name: m.name,
      creatorId: c ? String(c.id) : null,
      hidden: !!(c && c.houseHidden),
      status: c ? c.status : null,
      listings: own.length,
      activeListings: own.filter((l) => l.status === 'active').length,
      images,
      expectedImages,
    };
  });
  const complete = models.every((m) => m.creatorId && m.listings === HOUSE_LISTINGS.length && m.images >= m.expectedImages);
  return {
    models,
    installed: models.some((m) => m.creatorId),
    complete,
    hidden: models.some((m) => m.creatorId) && models.filter((m) => m.creatorId).every((m) => m.hidden),
    imagesDeployed: houseImagesDeployed(),
  };
}
