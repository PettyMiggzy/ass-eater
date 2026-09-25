import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { getListingById, updateListing, findCircumventionInTags, LISTING_SOLD, LISTING_MODERATED } from '../../../lib/listings-store';
import { getReports } from '../../../lib/reports-store';
import { PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { screenPublicText, rawTagItems } from '../../../lib/prohibited-terms';
import { addViolation } from '../../../lib/violations-store';
import { sanitizeTags, LISTING_LIMITS } from '../../../lib/creator-status';
import { validateTextFields } from '../../../lib/field-validation';
import { consumeAttempt } from '../../../lib/rate-limit';

// Same budget as create.js. Edits had no limit at all.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_CREATOR = 120;

const ALLOWED = ['title', 'description', 'priceCents', 'status', 'kind', 'shippingCents', 'signatureRequired', 'aiGenerated', 'tags'];

// The only two states a creator sets themselves (the dashboard's Remove /
// Reactivate button). 'sold' is not in here on purpose -- it's set by the
// purchase flow, not by the seller.
//
// That alone does NOT stop a sold listing being put back up: it restricts the
// TARGET value, not the listing's CURRENT status. 'sold' is terminal for any
// status change (sold->removed->active used to resell a one-of-a-kind item),
// enforced below and, authoritatively, inside updateListing's own WHERE.
const ALLOWED_STATUSES = ['active', 'removed'];

/**
 * The public-text screen for a marketplace listing, applied identically by
 * create.js and update.js. KEEP IDENTICAL to the copy in create.js -- the two
 * routes must screen listing text the same way.
 *
 * Runs lib/prohibited-terms.js's screenPublicText -- the payment-circumvention
 * filter AND the prohibited-terms list, the same screen a creator's public
 * profile goes through -- over the title, the description, and every tag both
 * exactly as typed and as sanitizeTags() will store it. Only keys present in
 * `fields` are screened, so a partial edit checks only what it writes.
 *
 * Returns null, or { context, reasons, snippet, message } for the first hit:
 * `context` is what the violations queue records ('listing_title',
 * 'listing_description', 'listing_tags'); `message` is safe to show the user.
 */
function screenListingText(fields) {
  if (!fields || typeof fields !== 'object') return null;
  const entries = [];
  for (const key of ['title', 'description']) {
    if (key in fields && typeof fields[key] === 'string' && fields[key]) entries.push([`listing_${key}`, fields[key]]);
  }
  if ('tags' in fields && fields.tags !== undefined && fields.tags !== null) {
    for (const raw of rawTagItems(fields.tags)) entries.push(['listing_tags', raw]);
    for (const tag of sanitizeTags(fields.tags)) entries.push(['listing_tags', tag]);
  }
  for (const [context, value] of entries) {
    const hit = screenPublicText(value);
    if (hit) return { context, reasons: hit.reasons, snippet: value, message: hit.message };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { listingId, fields } = req.body && typeof req.body === 'object' ? req.body : {};
  if (!listingId) return res.status(400).json({ error: 'Missing listing id' });
  // `key in fields` below throws a TypeError on a string or number, which
  // escaped as an unhandled 500 -- refuse anything but a plain object.
  if (fields !== undefined && (fields === null || typeof fields !== 'object' || Array.isArray(fields))) {
    return res.status(400).json({ error: 'Invalid fields' });
  }

  const { limited, retryAfterSeconds } = consumeAttempt(`marketplace-update:creator:${ctx.creator.id}`, {
    limit: MAX_PER_CREATOR,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many edits recently. Please wait a while and try again.' });
  }

  const safeFields = {};
  for (const key of ALLOWED) {
    if (fields && key in fields) safeFields[key] = fields[key];
  }

  // Both fields are rendered straight into the marketplace grid and
  // .toLowerCase()'d inside /search's getServerSideProps, so storing a
  // non-string here is a server-side 500 on /search for every visitor, not
  // just a bad-looking listing. Checked before the filter below, which String()s
  // whatever it is handed and so reads {} as a harmless "[object Object]".
  for (const field of ['title', 'description']) {
    if (field in safeFields && typeof safeFields[field] !== 'string') {
      return res.status(400).json({ error: 'Title and description must be text' });
    }
  }
  // The same length caps create.js applies. Without them an edit could store a
  // ~1MB description that every marketplace/search visitor then downloaded.
  const tooLong = validateTextFields(safeFields, ['title', 'description']);
  if (tooLong) return res.status(400).json({ error: tooLong });

  // Same screen as create.js (payment circumvention AND prohibited terms, on
  // title, description and every tag raw and sanitised), over exactly the
  // fields this edit writes.
  const hit = screenListingText(safeFields);
  if (hit) {
    await addViolation({ userId: ctx.user.id, context: hit.context, reasons: hit.reasons, snippet: hit.snippet });
    return res.status(400).json({ error: hit.message });
  }
  if ('tags' in safeFields) {
    const tagHit = findCircumventionInTags(safeFields.tags);
    if (tagHit) {
      await addViolation({ userId: ctx.user.id, context: 'listing_tags', reasons: tagHit.reasons, snippet: tagHit.snippet });
      return res.status(400).json({ error: tagHit.message || PAYMENT_CIRCUMVENTION_MESSAGE });
    }
  }

  // Normalize the same way createListing() does, so an edit can't store a
  // priced-in-a-string listing or an arbitrary kind/flag value.
  if ('priceCents' in safeFields) safeFields.priceCents = Math.round(Number(safeFields.priceCents));
  if ('shippingCents' in safeFields) safeFields.shippingCents = Math.round(Number(safeFields.shippingCents));
  if ('kind' in safeFields) safeFields.kind = safeFields.kind === 'physical' ? 'physical' : 'digital';
  if ('signatureRequired' in safeFields) safeFields.signatureRequired = !!safeFields.signatureRequired;
  if ('aiGenerated' in safeFields) safeFields.aiGenerated = !!safeFields.aiGenerated;
  if ('tags' in safeFields) safeFields.tags = sanitizeTags(safeFields.tags);
  if ('status' in safeFields && !ALLOWED_STATUSES.includes(safeFields.status)) {
    return res.status(400).json({ error: 'Invalid listing status' });
  }
  // Range-checked here rather than only in the `physical` branch further down:
  // that branch never runs for a digital listing, so a negative fee could be
  // stored on one and then blocked it from ever being switched to physical,
  // with an error naming a field the creator had not touched in that request.
  if ('shippingCents' in safeFields && (!Number.isSafeInteger(safeFields.shippingCents) || safeFields.shippingCents < 0)) {
    return res.status(400).json({ error: 'Shipping fee must be 0 or more' });
  }
  if ('shippingCents' in safeFields && safeFields.shippingCents > LISTING_LIMITS.maxShippingCents) {
    return res.status(400).json({ error: `Shipping can be at most $${(LISTING_LIMITS.maxShippingCents / 100).toLocaleString()}` });
  }
  if ('priceCents' in safeFields && Number.isFinite(safeFields.priceCents) && safeFields.priceCents > LISTING_LIMITS.maxPriceCents) {
    return res.status(400).json({ error: `Price can be at most $${(LISTING_LIMITS.maxPriceCents / 100).toLocaleString()}` });
  }

  const found = await getListingById(listingId);
  const existing = found && String(found.creatorId) === String(ctx.creator.id) ? found : null;
  if (!existing) return res.status(404).json({ error: 'Listing not found' });

  // A one-of-a-kind listing's 'sold' status is set by claimUniqueListing()
  // inside the checkout transaction (lib/listings-store.js) -- it is
  // terminal. ANY status change is refused, not just a direct sold->active:
  // sold->removed was accepted as a "takedown" and removed->active then put
  // the item back on sale. updateListing enforces the same in its WHERE
  // clause, which also covers a sale landing between this read and the write.
  if ('status' in safeFields && existing.status === 'sold') {
    return res.status(403).json({ error: 'This one-of-a-kind item has already sold and cannot be relisted.' });
  }
  if (safeFields.status === 'active' && existing.moderationRemoved) {
    return res.status(403).json({ error: 'This listing was removed by moderation and cannot be relisted. Contact support if you believe that was a mistake.' });
  }

  // Legacy backstop: takedowns made before markListingRemoved started writing
  // `moderationRemoved` only wrote status 'removed', indistinguishable from one
  // the creator pulled themselves. For those the actioned report IS the marker.
  if (safeFields.status === 'active' && existing.status === 'removed') {
    const reports = await getReports();
    const moderated = reports.some(
      (r) => r.targetType === 'listing' && String(r.targetId) === String(listingId) && r.status === 'actioned'
    );
    if (moderated) {
      return res.status(403).json({ error: 'This listing was removed by moderation and cannot be relisted. Contact support if you believe that was a mistake.' });
    }
  }

  // Taking your own listing down is always allowed, even when the stored record
  // would fail the checks below -- one created through create.js, which still
  // accepts a non-numeric priceCents, would otherwise be stuck public with no
  // way for its owner to pull it.
  const takedownOnly = Object.keys(safeFields).length === 1 && safeFields.status === 'removed';

  // pages/api/marketplace/create.js's rules were only ever enforced at
  // creation, so editing was a way into a state creation would have rejected
  // (a $0 price, a blank title, a physical item with no shipping fee). A
  // partial edit ("just the price") is normal here, so the MERGED result is
  // what gets validated, not the handful of fields this request happened to
  // send.
  if (!takedownOnly) {
    const merged = { ...existing, ...safeFields };
    const mergedPrice = Number(merged.priceCents);
    // typeof, not String(...) -- `String({})` is the truthy "[object Object]",
    // so stringifying to validate would pass exactly the values that crash
    // /search's SSR.
    if (typeof merged.title !== 'string' || !merged.title.trim() || !Number.isSafeInteger(mergedPrice) || mergedPrice < LISTING_LIMITS.minPriceCents) {
      return res.status(400).json({ error: 'Title and a price of at least $1 are required' });
    }
    if (mergedPrice > LISTING_LIMITS.maxPriceCents) {
      return res.status(400).json({ error: `Price can be at most $${(LISTING_LIMITS.maxPriceCents / 100).toLocaleString()}` });
    }
    if (merged.kind === 'physical') {
      const mergedShipping = Number(merged.shippingCents);
      if (!Number.isFinite(mergedShipping) || mergedShipping < 0) {
        return res.status(400).json({ error: 'Physical items need a shipping fee (can be 0 for free shipping)' });
      }
    } else if ('kind' in safeFields || 'shippingCents' in safeFields || 'signatureRequired' in safeFields) {
      // createListing() zeroes these for a digital item; an edit that touches
      // either of them (or switches back to digital) has to do the same, or a
      // shipping fee ends up attached to something that never ships.
      safeFields.shippingCents = 0;
      safeFields.signatureRequired = false;
    }
  }

  try {
    const listing = await updateListing(listingId, ctx.creator.id, safeFields);
    return res.status(200).json({ ok: true, listing });
  } catch (err) {
    // The fast-path check above already catches this in the common case; this
    // is the backstop for a listing that sold in the window between that
    // check and this write (see updateListing's own atomic WHERE-clause guard).
    if (err.code === LISTING_SOLD || err.code === LISTING_MODERATED) return res.status(403).json({ error: err.message });
    console.error('[marketplace/update] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
