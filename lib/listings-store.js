import { query, rowToRecord, rowsToRecords } from './db';
import { sanitizeTags } from './creator-status';

export async function getListings() {
  const { rows } = await query('select id, data from listings order by id');
  return rowsToRecords(rows);
}

export async function createListing(creatorId, fields) {
  const listing = {
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

/**
 * A one-of-a-kind listing's 'sold' status (set by claimUniqueListing inside
 * the checkout transaction) is terminal -- an edit must never be able to
 * put it back to 'active'. When `fields.status === 'active'`, the exclusion
 * is baked directly into this UPDATE's own WHERE clause rather than checked
 * against a value read moments earlier by the caller: a listing that gets
 * bought (flips to 'sold') in the window between the caller's read and this
 * write is still caught, because the guard is evaluated against the row's
 * CURRENT state at the moment of the write, the same atomicity pattern as
 * claimUniqueListing itself.
 */
export async function updateListing(listingId, creatorId, fields) {
  const reactivating = fields.status === 'active';
  const { rows } = await query(
    `update listings
        set data = data || $3::jsonb, updated_at = now()
      where id = $1 and data->>'creatorId' = $2
        ${reactivating ? "and coalesce(data->>'status', '') <> 'sold'" : ''}
      returning id, data`,
    [listingId, String(creatorId), JSON.stringify(fields)],
  );
  if (rows.length) return rowToRecord(rows[0]);

  if (reactivating) {
    const { rows: owned } = await query(
      `select data->>'status' as status from listings where id = $1 and data->>'creatorId' = $2`,
      [listingId, String(creatorId)],
    );
    if (owned.length && owned[0].status === 'sold') {
      throw Object.assign(new Error('This one-of-a-kind item has already sold and cannot be relisted.'), { code: LISTING_SOLD });
    }
  }
  throw new Error('Listing not found');
}

/** Admin/moderation path -- marks a listing removed regardless of creator ownership (updateListing above requires it). */
export async function markListingRemoved(listingId) {
  const { rows } = await query(
    `update listings
        set data = data || '{"status":"removed"}'::jsonb, updated_at = now()
      where id = $1
      returning id, data`,
    [listingId],
  );
  return rows.length ? rowToRecord(rows[0]) : null;
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

/**
 * Appends one media item, but only for a listing this creator owns and only
 * while it is under `cap` items.
 *
 * Ownership and the cap are both conditions on the UPDATE itself rather than
 * checks performed against a value read earlier, so two uploads racing cannot
 * both pass a check at 9 items and land the listing at 11. This lives here
 * rather than in the upload route because the route used to reach into the
 * listings storage directly to get the cap inside the guarded write -- which
 * meant two places had to agree on how listings are stored.
 *
 * Throws with `.code === MEDIA_CAP_EXCEEDED` when the listing exists and is
 * the creator's but is already full, so the caller can tell that apart from
 * "no such listing" and answer 403 rather than 500.
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
    ],
  );
  if (rows.length) return rowToRecord(rows[0]);

  // Nothing updated: either the listing isn't this creator's (or doesn't
  // exist), or it is already full. Only the second is worth distinguishing,
  // and only for a listing they actually own.
  const { rows: owned } = await query(
    `select jsonb_array_length(
              case when jsonb_typeof(data->'media') = 'array' then data->'media' else '[]'::jsonb end
            ) as n
       from listings where id = $1 and data->>'creatorId' = $2`,
    [listingId, String(creatorId)],
  );
  if (owned.length && owned[0].n >= cap) {
    throw Object.assign(new Error('Listing media cap reached'), { code: MEDIA_CAP_EXCEEDED });
  }
  throw new Error('Listing not found');
}
