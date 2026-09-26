import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import { sanitizeTags } from './creator-status';
import { deleteMediaQuietly, recordPendingDeletions } from './blob-cleanup';
import { lockMediaForFinalize } from './media-refs';
import { screenPublicText, detectProhibitedTerms, PROHIBITED_TERMS_MESSAGE } from './prohibited-terms';
import { detectPaymentCircumvention, normalizeForMatching, PAYMENT_CIRCUMVENTION_MESSAGE } from './payment-circumvention-filter';

/**
 * Screens tags exactly as they arrived (before sanitizeTags strips
 * punctuation) and as stored. Tags render publicly as adjacent #chips, so a
 * handover or a prohibited phrase split across two chips has to be caught the
 * same as in a title -- but a join also INVENTS text neither chip says, and
 * the checks across a tag boundary are therefore deliberately narrower than
 * the ones on a single tag:
 *
 *  1. Every tag on its own (raw and stored form): the full screen
 *     (lib/prohibited-terms.js screenPublicText -- prohibited terms first).
 *  2. Prohibited PHRASES across tags ("barely", "legal"; "school", "girl"):
 *     only runs of adjacent SINGLE-WORD tags are joined, so a phrase forms
 *     only when whole tags are its words. Joining everything used to let the
 *     tail of one multi-word tag meet the head of the next -- "old school" +
 *     "girl next door" read as "school girl" and was refused and logged as
 *     minor-suggestive, the most serious category there is.
 *  3. Payment details across tags: every check, including the contact-app
 *     handovers, on the tags joined by a space ("cash" + "app jane", "text
 *     me" + "555 123 4567", "telegram" + "janedoe99", "snapchat" +
 *     "jane_doe"). ONE boundary is joined with " | " instead, which the
 *     handover shapes do not cross: a short one-word tag followed by a short
 *     category-looking tag with a digit in it ("tg" + "y2k", "snap" + "r18",
 *     "insta" + "4k") -- the digit is the only thing that made the second tag
 *     look like a handle. A long service name, or a next tag that is longer or
 *     has "_"/"." in it, keeps the space. Accepted cost: a handle of five
 *     characters or fewer after an abbreviated service name ("ig" + "jd99")
 *     is not read as a handover across the chips. The all-" | " join still
 *     runs too, for an "@handle" near a rail name.
 *
 * Returns null, or { kind: 'prohibited' | 'payment', reasons, snippet,
 * message } for the first hit; callers answer with `message`. Used for
 * listing tags and creator profile tags.
 */
export function findCircumventionInTags(input) {
  const raw = typeof input === 'string' ? input.split(',') : Array.isArray(input) ? input : [];
  const strings = raw.filter((t) => typeof t === 'string' && t.trim()).slice(0, 50);
  if (!strings.length) return null;
  const stored = sanitizeTags(strings);
  const hitOf = (hit, text) => (hit ? { kind: hit.kind, reasons: hit.reasons, snippet: text, message: hit.message } : null);

  // 1. Each tag on its own.
  for (const text of [...strings, ...stored]) {
    const hit = hitOf(screenPublicText(text), text);
    if (hit) return hit;
  }

  // 2. Prohibited phrases across runs of whole single-word tags.
  for (const list of [strings, stored]) {
    for (const run of singleWordRuns(list)) {
      if (run.length < 2) continue;
      const text = run.join(' ');
      const found = detectProhibitedTerms(text);
      if (found.flagged) return { kind: 'prohibited', reasons: found.reasons, snippet: text, message: PROHIBITED_TERMS_MESSAGE };
    }
  }

  // 3. Payment details across tags.
  for (const list of [strings, stored]) {
    if (list.length < 2) continue;
    const spaced = joinForPaymentScreen(list);
    const spacedHit = detectPaymentCircumvention(spaced);
    if (spacedHit.flagged) return { kind: 'payment', reasons: spacedHit.reasons, snippet: spaced, message: PAYMENT_CIRCUMVENTION_MESSAGE };
    const piped = list.join(' | ');
    const pipedHit = detectPaymentCircumvention(piped);
    if (pipedHit.flagged) return { kind: 'payment', reasons: pipedHit.reasons, snippet: piped, message: PAYMENT_CIRCUMVENTION_MESSAGE };
  }
  return null;
}

// Joins tags with a space, except " | " at a boundary where a short one-word
// tag meets a short category tag whose digit is all that makes it look like a
// handle ("tg" + "y2k"). See step 3 above.
function joinForPaymentScreen(list) {
  const bare = (tag) => normalizeForMatching(String(tag)).trim().replace(/^#+/, '');
  let out = '';
  list.forEach((tag, i) => {
    if (i > 0) {
      const prev = bare(list[i - 1]);
      const next = bare(tag);
      const shortWord = /^[a-z0-9]{1,5}$/.test(prev);
      const categoryTag = /^[a-z0-9]{1,5}$/.test(next) && /[0-9]/.test(next) && /[a-z]/.test(next);
      out += shortWord && categoryTag ? ' | ' : ' ';
    }
    out += tag;
  });
  return out;
}

// Maximal runs of adjacent tags that are each ONE word (letters/digits only,
// once a leading "#" and any trailing/leading punctuation are dropped),
// returned as the bare words. Any multi-word tag ends the run.
function singleWordRuns(list) {
  const runs = [];
  let run = [];
  for (const tag of list) {
    const word = normalizeForMatching(String(tag)).trim().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (word && /^[a-z0-9]+$/.test(word)) {
      run.push(word);
    } else {
      if (run.length) runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs;
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

// SQL: "a buyer holds a paid DIGITAL order for listings row `l`". The same
// shape lib/media.js's buyerHasDigitalOrder() checks per viewer.
const PAID_DIGITAL_ORDER_SQL = `exists (
  select 1 from orders o
   where o.data->>'listingId' = l.id::text
     and o.data->>'kind' = 'digital'
     and coalesce(o.data->>'status', '') in ('fulfilled', 'delivered'))`;

/** Does anyone hold a paid digital order for this listing? */
export async function listingHasPaidDigitalOrders(listingId, client = null) {
  const runner = client || { query };
  const { rows } = await runner.query(
    `select ${PAID_DIGITAL_ORDER_SQL} as paid from listings l where l.id = $1`,
    [String(listingId)],
  );
  return !!rows[0]?.paid;
}

function allFiles(listing) {
  return [
    ...(Array.isArray(listing?.media) ? listing.media : []),
    ...(Array.isArray(listing?.retainedMedia) ? listing.retainedMedia : []),
  ];
}

/**
 * Admin/moderation path -- marks a listing removed regardless of creator
 * ownership (updateListing above requires it), flags it as a moderation
 * removal so the owner cannot put it back up, and deletes its media files once
 * the change is committed. A takedown that only flipped the status left the
 * files in storage, which for a TAKE IT DOWN Act removal is the one outcome
 * that must not happen. This is a takedown of the CONTENT, so buyers lose it
 * too: `mediaDeletedAt` is what the media route and delivery read as "gone".
 */
export async function markListingRemoved(listingId) {
  // The files are recorded for deletion (media_uploads) in the SAME
  // transaction as the takedown, so if the post-commit deletion fails or
  // never runs, the orphan sweep still removes them.
  const listing = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `update listings
          set data = data || jsonb_build_object('status', 'removed', 'moderationRemoved', true, 'mediaDeletedAt', $2::text),
              updated_at = now()
        where id = $1
        returning id, data`,
      [listingId, new Date().toISOString()],
    );
    if (!rows.length) return null;
    const record = rowToRecord(rows[0]);
    await recordPendingDeletions(allFiles(record), client);
    return record;
  });
  if (!listing) return null;
  await deleteMediaQuietly(allFiles(listing));
  return listing;
}

/**
 * Takes every listing of one creator off sale and deletes their media files
 * after the change commits. Sold rows keep their status -- 'sold' is terminal
 * and is what an order points back to. `moderation: true` also blocks the
 * owner from ever relisting them.
 *
 * `keepPaid: true` (a ban set by hand, or the creator being deleted) keeps
 * the files of every listing a buyer already holds a paid digital order for
 * -- unlimited listings included, which never become 'sold' and so used to
 * be swept up with everything else. Those listings still come off sale, but
 * get no `mediaDeletedAt`, so /api/media and /api/marketplace/orders/delivery
 * keep serving buyers what they paid for. A SOLD listing keeps its status in
 * this mode (sold is terminal) -- but a sold PHYSICAL listing's photos are
 * deleted, since no buyer is ever served them. Listings nobody bought lose
 * their files as before. `keepPaid: false` (the default, used for a CONTENT
 * violation ban) deletes everything: there the content itself was unlawful.
 *
 * Every file it is about to delete is recorded (media_uploads,
 * 'delete_pending') in the same transaction as the UPDATE, so a deletion that
 * throws or times out after the commit is finished by the orphan sweep. That
 * is also why a listing whose files were already marked deleted is skipped:
 * its files were recorded when that happened, and keep their original
 * mediaDeletedAt.
 *
 * `client` (optional) runs the UPDATE and the recording on a caller's
 * transaction (deleting a creator does, so the creator row and their
 * listings go in one commit). With a client, NOTHING is deleted here -- the
 * caller runs deleteMediaQuietly(files) after its own commit.
 *
 * Returns { listings, kept: listingId[], files, cleanup } (cleanup is null
 * when a client was passed).
 */
export async function removeListingsForCreator(creatorId, { moderation = false, keepPaid = false, client = null } = {}) {
  if (!client) {
    const out = await withTransaction((tx) => removeListingsForCreator(creatorId, { moderation, keepPaid, client: tx }));
    return { ...out, cleanup: await deleteMediaQuietly(out.files) };
  }
  // Lock first, decide second. The paid-order check used to sit in a CTE of
  // the same statement that took FOR UPDATE, and under READ COMMITTED a
  // statement that waits on a row lock re-checks that row but keeps its
  // ORIGINAL snapshot for every other table -- so an order committed by a
  // checkout that held the listing lock first was invisible to the EXISTS,
  // and the listing just paid for lost its files. The lock is its own
  // statement now; the UPDATE below is a later statement with a fresh
  // snapshot that sees any such order (the same shape as
  // removeListingMediaForOwner).
  await client.query(`select id from listings where data->>'creatorId' = $1 for update`, [String(creatorId)]);
  // Files are kept ONLY for listings a buyer holds a paid DIGITAL order for:
  // that is the only reader they have left. A sold PHYSICAL listing keeps its
  // 'sold' status (keep_sold -- terminal, and what its order points back to)
  // but its photos are deleted like any other: no buyer is ever served
  // listing media for a physical order, and once the seller is gone nobody
  // else could read them either.
  const { rows } = await client.query(
    `with cur as (
       select l.id,
              (l.data ? 'mediaDeletedAt') as was_deleted,
              ${keepPaid ? PAID_DIGITAL_ORDER_SQL : 'false'} as paid,
              ${keepPaid ? "coalesce(l.data->>'status', '') = 'sold'" : 'false'} as keep_sold
         from listings l
        where l.data->>'creatorId' = $1
     )
     update listings
        set data = data
                   || case when cur.paid or cur.was_deleted then '{}'::jsonb
                           else jsonb_build_object('mediaDeletedAt', $3::text) end
                   || case when coalesce(data->>'status', '') = 'sold' then '{}'::jsonb
                           else jsonb_build_object('status', 'removed') end
                   || case when $2::boolean and not cur.keep_sold then jsonb_build_object('moderationRemoved', true) else '{}'::jsonb end,
            updated_at = now()
       from cur
      where listings.id = cur.id
      returning listings.id, listings.data, cur.paid, cur.was_deleted`,
    [String(creatorId), !!moderation, new Date().toISOString()],
  );
  const listings = rowsToRecords(rows);
  const doomed = rows.filter((r) => !r.paid && !r.was_deleted).map((r) => rowToRecord(r));
  const kept = rows.filter((r) => r.paid).map((r) => String(r.id));
  const files = doomed.flatMap(allFiles);
  await recordPendingDeletions(files, client);
  return { listings, kept, files, cleanup: null };
}

export const MEDIA_ITEM_GONE = 'media_item_gone';

/**
 * Owner removes ONE media item from their listing, addressed by its src.
 *
 * Refused (LISTING_NOT_EDITABLE) on a sold listing and on one removed by
 * moderation. The row is locked for the whole decision:
 *  - nobody has bought the listing: the item is dropped and its file deleted
 *    after the change commits (mirrors removeGalleryItem);
 *  - someone HAS bought it: the item leaves `media` (so it is no longer part
 *    of what is for sale, nor in any preview) but moves to `retainedMedia`
 *    with `removedAt`, and the file is kept -- the buyers who paid before
 *    that moment keep receiving it (delivery + /api/media check the order
 *    time). A buyer after the removal never gets it.
 * No match throws MEDIA_ITEM_GONE.
 *
 * Returns { listing, retained: boolean }.
 */
export async function removeListingMediaForOwner(listingId, creatorId, src) {
  if (typeof src !== 'string' || !src) {
    throw Object.assign(new Error('That item is no longer on this listing'), { code: MEDIA_ITEM_GONE });
  }
  const { listing, removed, retained } = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `select id, data from listings where id = $1 and data->>'creatorId' = $2 for update`,
      [String(listingId), String(creatorId)],
    );
    if (!rows.length) throw new Error('Listing not found');
    const current = rowToRecord(rows[0]);
    if (current.status === 'sold' || current.moderationRemoved) {
      throw Object.assign(new Error('This listing can no longer be edited'), { code: LISTING_NOT_EDITABLE });
    }
    const media = Array.isArray(current.media) ? [...current.media] : [];
    const at = media.findIndex((m) => m && m.src === src);
    if (at === -1) throw Object.assign(new Error('That item is no longer on this listing'), { code: MEDIA_ITEM_GONE });
    const [gone] = media.splice(at, 1);
    const paid = await listingHasPaidDigitalOrders(current.id, client);
    const patch = { media };
    if (paid) {
      const kept = Array.isArray(current.retainedMedia) ? [...current.retainedMedia] : [];
      kept.push({ ...gone, removedAt: new Date().toISOString() });
      patch.retainedMedia = kept;
    }
    const { rows: updated } = await client.query(
      `update listings set data = data || $2::jsonb, updated_at = now() where id = $1 returning id, data`,
      [String(current.id), JSON.stringify(patch)],
    );
    const record = rowToRecord(updated[0]);
    const doomed = !paid && !allFiles(record).some((m) => m && m.src === gone.src);
    if (doomed) await recordPendingDeletions(gone, client);
    return { listing: record, removed: doomed ? gone : null, retained: paid };
  });
  if (removed) await deleteMediaQuietly(removed);
  return { listing, retained };
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
  // Under the file's lock, and refused if the file was already deleted (the
  // orphan sweep reaped it) -- lib/media-refs.js lockMediaForFinalize.
  return withTransaction(async (client) => {
    await lockMediaForFinalize(client, item && item.src);
    const { rows } = await client.query(
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
    const { rows: owned } = await client.query(
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
  });
}
