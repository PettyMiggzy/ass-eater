import { query, rowToRecord, rowsToRecords } from './db';
import { sanitizeTags } from './creator-status';
import { deleteMediaQuietly } from './blob-cleanup';
import { detectPaymentCircumvention } from './payment-circumvention-filter';

/**
 * Runs the payment-circumvention filter over tags exactly as they arrived
 * (before sanitizeTags strips punctuation), each tag on its own and all of
 * them joined -- tags render publicly as #chips, and "venmo @janedoe" or a
 * phone number split across two tags must be caught the same as in a title.
 * Returns null, or { reasons, snippet } for the first hit. Also used for
 * creator profile tags.
 */
export function findCircumventionInTags(input) {
  const raw = typeof input === 'string' ? input.split(',') : Array.isArray(input) ? input : [];
  const strings = raw.filter((t) => typeof t === 'string' && t.trim()).slice(0, 50);
  if (!strings.length) return null;
  for (const text of [...strings, strings.join(' '), sanitizeTags(strings).join(' ')]) {
    const check = detectPaymentCircumvention(text);
    if (check.flagged) return { reasons: check.reasons, snippet: text };
  }
  return null;
}

export async function getListings() {
  const { rows } = await query('select id, data from listings order by id');
  return rowsToRecords(rows);
}

export async function getListingById(listingId) {
  if (!/^[0-9]{1,18}$/.test(String(listingId ?? ''))) return null;
  const { rows } = await query('select id, data from listings where id = $1', [String(listingId)]);
  return rows.length ? rowToRecord(rows[0]) : null;
}

export async function createListing(creatorId, fields) {
  const listing = {
    creatorId,
    title: fields.title,
    description: fields.description || '',
    priceCents: fields.priceCents,
    unlimited: !!fields.unlimited,
    // Always empty at creation. Media is only ever added through the upload
    // finalize path (addListingMediaForOwner), which verifies each file is in
    // this creator's own private prefix -- accepting a media array here would
    // let a caller attach any URL at all.
    media: [],
    kind: fields.kind === 'physical' ? 'physical' : 'digital',
    shippingCents: fields.kind === 'physical' ? Number(fields.shippingCents) || 0 : 0,
    // Advisory only -- we don't integrate with any carrier, this just reminds the creator and tells the buyer. See MARKETPLACE_FULFILLMENT.md.
    signatureRequired: fields.kind === 'physical' && !!fields.signatureRequired,
    aiGenerated: !!fields.aiGenerated,
    // Same sanitizer and same shape as a creator's own profile tags
    // (lib/creator-status.js) -- a listing being honestly "feet" or "used"
    // content is exactly the same discovery problem tagging already solves
    // for creators, and reusing the sanitizer means one spelling rule
    // instead of two to keep in sync.
    tags: sanitizeTags(fields.tags),
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  const { rows } = await query('insert into listings (data) values ($1) returning id, data', [listing]);
  return rowToRecord(rows[0]);
}

/**
 * Appends one media item to a listing.
 *
 * `knownMedia` is a client-captured snapshot and is kept only as a
 * last-resort fallback for a listing whose stored media array is missing
 * entirely -- it must never win over what is actually stored, because it goes
 * stale the moment a second upload starts before the first one's response
 * lands. That staleness is what silently dropped uploads before.
 *
 * The append is done by the database rather than read-modify-write in
 * JavaScript, so two uploads landing together both survive.
 */
export async function addListingMedia(listingId, item, knownMedia) {
  const { rows } = await query(
    `update listings
        set data = jsonb_set(
              data,
              '{media}',
              case
                when jsonb_typeof(data->'media') = 'array' then data->'media'
                else $3::jsonb
              end || $2::jsonb
            ),
            updated_at = now()
      where id = $1
      returning id, data`,
    [listingId, JSON.stringify([item]), JSON.stringify(Array.isArray(knownMedia) ? knownMedia : [])],
  );
  if (!rows.length) throw new Error('Listing not found');
  return rowToRecord(rows[0]);
}

export const LISTING_SOLD = 'listing_sold';
export const LISTING_MODERATED = 'listing_moderated';

/**
 * Owner edit of a listing.
 *
 * Two status rules are enforced by this UPDATE's own WHERE clause, against the
 * row's CURRENT state at the moment of the write (the same atomicity pattern
 * as claimUniqueListing), not against a value the caller read earlier:
 *
 *   - 'sold' is TERMINAL. Any edit that touches `status` on a sold row matches
 *     nothing. Guarding only a direct sold->active flip was not enough: a
 *     creator could write sold->removed (allowed, it looked like a takedown)
 *     and then removed->active, and the one-of-a-kind item sold again.
 *     Non-status edits (fixing a typo in the title) are still allowed.
 *   - A listing removed by MODERATION (markListingRemoved, or a ban) carries
 *     `moderationRemoved: true` and can never be reactivated by its owner.
 */
export async function updateListing(listingId, creatorId, fields) {
  const touchesStatus = Object.prototype.hasOwnProperty.call(fields || {}, 'status');
  const reactivating = fields.status === 'active';
  const { rows } = await query(
    `update listings
        set data = data || $3::jsonb, updated_at = now()
      where id = $1 and data->>'creatorId' = $2
        ${touchesStatus ? "and coalesce(data->>'status', '') <> 'sold'" : ''}
        ${reactivating ? "and coalesce((data->>'moderationRemoved')::boolean, false) = false" : ''}
      returning id, data`,
    [listingId, String(creatorId), JSON.stringify(fields)],
  );
  if (rows.length) return rowToRecord(rows[0]);

  if (touchesStatus) {
    const { rows: owned } = await query(
      `select data->>'status' as status, coalesce((data->>'moderationRemoved')::boolean, false) as moderated
         from listings where id = $1 and data->>'creatorId' = $2`,
      [listingId, String(creatorId)],
    );
    if (owned.length && owned[0].status === 'sold') {
      throw Object.assign(new Error('This one-of-a-kind item has already sold and cannot be relisted.'), { code: LISTING_SOLD });
    }
    if (owned.length && reactivating && owned[0].moderated) {
      throw Object.assign(
        new Error('This listing was removed by moderation and cannot be relisted. Contact support if you believe that was a mistake.'),
        { code: LISTING_MODERATED },
      );
    }
  }
  throw new Error('Listing not found');
}

/**
 * Admin/moderation path -- marks a listing removed regardless of creator
 * ownership (updateListing above requires it), flags it as a moderation
 * removal so the owner cannot put it back up, and deletes its media files once
 * the change is committed. A takedown that only flipped the status left the
 * files in storage, which for a TAKE IT DOWN Act removal is the one outcome
 * that must not happen.
 */
export async function markListingRemoved(listingId) {
  const { rows } = await query(
    `update listings
        set data = data || jsonb_build_object('status', 'removed', 'moderationRemoved', true, 'mediaDeletedAt', $2::text),
            updated_at = now()
      where id = $1
      returning id, data`,
    [listingId, new Date().toISOString()],
  );
  if (!rows.length) return null;
  const listing = rowToRecord(rows[0]);
  await deleteMediaQuietly(listing.media || []);
  return listing;
}

/**
 * Takes every listing of one creator off sale (a ban, or the creator being
 * deleted) and deletes their media files after the change commits. Sold rows
 * keep their status -- 'sold' is terminal and is what an order points back to.
 * `moderation: true` also blocks the owner from ever relisting them.
 */
export async function removeListingsForCreator(creatorId, { moderation = false } = {}) {
  const { rows } = await query(
    `update listings
        set data = data
                   || jsonb_build_object('mediaDeletedAt', $3::text)
                   || case when coalesce(data->>'status', '') = 'sold' then '{}'::jsonb
                           else jsonb_build_object('status', 'removed') end
                   || case when $2::boolean then jsonb_build_object('moderationRemoved', true) else '{}'::jsonb end,
            updated_at = now()
      where data->>'creatorId' = $1
      returning id, data`,
    [String(creatorId), !!moderation, new Date().toISOString()],
  );
  const listings = rowsToRecords(rows);
  const cleanup = await deleteMediaQuietly(listings.flatMap((l) => (Array.isArray(l.media) ? l.media : [])));
  return { listings, cleanup };
}

/**
 * Atomically claims a one-of-a-kind ("unlimited: false") listing for sale --
 * marks it sold only if it is still active, in one guarded UPDATE. Two
 * buyers racing to check out the same listing can't both succeed: whichever
 * UPDATE lands first flips status to 'sold' and the loser's WHERE clause
 * matches nothing, so it returns false instead of silently letting a second
 * sale through. Call this INSIDE the same transaction as the charge, and
 * BEFORE it -- a listing that's already gone is caught before any money
 * moves, not after.
 *
 * Only call this for a listing you already know is `unlimited: false` --
 * calling it on an unlimited listing would "fail" (0 rows) even though
 * nothing is wrong, since unlimited listings are never meant to be claimed.
 */
export async function claimUniqueListing(listingId, client) {
  const { rows } = await client.query(
    `update listings
        set data = data || '{"status":"sold"}'::jsonb, updated_at = now()
      where id = $1
        and data->>'status' = 'active'
      returning id`,
    [listingId],
  );
  return rows.length > 0;
}

export function findListing(list, id) {
  return list.find((l) => String(l.id) === String(id)) || null;
}

export const MEDIA_CAP_EXCEEDED = 'media_cap_exceeded';
export const LISTING_NOT_EDITABLE = 'listing_not_editable';

/**
 * Appends one media item, but only for a listing this creator owns, only
 * while it is under `cap` items, and never to a sold or moderation-removed
 * listing.
 *
 * Ownership, the cap and the status are all conditions on the UPDATE itself
 * rather than checks performed against a value read earlier, so two uploads
 * racing cannot both pass a check at 9 items and land the listing at 11.
 * A finalize retried with the same src is a no-op (the item is not appended
 * twice) and returns the listing as it stands.
 *
 * Throws with `.code === MEDIA_CAP_EXCEEDED` when the listing is the
 * creator's but already full, `.code === LISTING_NOT_EDITABLE` when it is sold
 * or moderated, so the caller can answer 403 rather than 500.
 */
export async function addListingMediaForOwner(listingId, creatorId, item, knownMedia, cap) {
  const { rows } = await query(
    `update listings
        set data = jsonb_set(
              data,
              '{media}',
              case when jsonb_typeof(data->'media') = 'array' then data->'media' else $4::jsonb end || $3::jsonb
            ),
            updated_at = now()
      where id = $1
        and data->>'creatorId' = $2
        and coalesce(data->>'status', '') <> 'sold'
        and coalesce((data->>'moderationRemoved')::boolean, false) = false
        and not (case when jsonb_typeof(data->'media') = 'array' then data->'media' else '[]'::jsonb end
                 @> jsonb_build_array(jsonb_build_object('src', $6::text)))
        and jsonb_array_length(
              case when jsonb_typeof(data->'media') = 'array' then data->'media' else $4::jsonb end
            ) < $5
      returning id, data`,
    [
      listingId,
      String(creatorId),
      JSON.stringify([item]),
      JSON.stringify(Array.isArray(knownMedia) ? knownMedia : []),
      cap,
      String(item && item.src ? item.src : ''),
    ],
  );
  if (rows.length) return rowToRecord(rows[0]);

  // Nothing updated: work out why, for a listing they actually own.
  const { rows: owned } = await query(
    `select id, data from listings where id = $1 and data->>'creatorId' = $2`,
    [listingId, String(creatorId)],
  );
  if (!owned.length) throw new Error('Listing not found');
  const listing = rowToRecord(owned[0]);
  const media = Array.isArray(listing.media) ? listing.media : [];
  if (item && item.src && media.some((m) => m && m.src === item.src)) return listing;
  if (listing.status === 'sold' || listing.moderationRemoved) {
    throw Object.assign(new Error('This listing can no longer be edited'), { code: LISTING_NOT_EDITABLE });
  }
  if (media.length >= cap) {
    throw Object.assign(new Error('Listing media cap reached'), { code: MEDIA_CAP_EXCEEDED });
  }
  throw new Error('Listing not found');
}
