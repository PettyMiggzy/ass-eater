import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { getListings, updateListing } from '../../../lib/listings-store';
import { getReports } from '../../../lib/reports-store';
import { detectPaymentCircumvention, PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { addViolation } from '../../../lib/violations-store';

const ALLOWED = ['title', 'description', 'priceCents', 'status', 'kind', 'shippingCents', 'signatureRequired', 'aiGenerated'];

// The only two states a creator sets themselves (the dashboard's Remove /
// Reactivate button). 'sold' is not in here on purpose -- it's set by the
// purchase flow, not by the seller, so an edit can't put a sold item back up.
const ALLOWED_STATUSES = ['active', 'removed'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { listingId, fields } = req.body || {};
  if (!listingId) return res.status(400).json({ error: 'Missing listing id' });

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

  for (const field of ['title', 'description']) {
    if (!(field in safeFields)) continue;
    const check = detectPaymentCircumvention(safeFields[field]);
    if (check.flagged) {
      await addViolation({ userId: ctx.user.id, context: `listing_${field}`, reasons: check.reasons, snippet: safeFields[field] });
      return res.status(400).json({ error: PAYMENT_CIRCUMVENTION_MESSAGE });
    }
  }

  // Normalize the same way createListing() does, so an edit can't store a
  // priced-in-a-string listing or an arbitrary kind/flag value.
  if ('priceCents' in safeFields) safeFields.priceCents = Math.round(Number(safeFields.priceCents));
  if ('shippingCents' in safeFields) safeFields.shippingCents = Math.round(Number(safeFields.shippingCents));
  if ('kind' in safeFields) safeFields.kind = safeFields.kind === 'physical' ? 'physical' : 'digital';
  if ('signatureRequired' in safeFields) safeFields.signatureRequired = !!safeFields.signatureRequired;
  if ('aiGenerated' in safeFields) safeFields.aiGenerated = !!safeFields.aiGenerated;
  if ('status' in safeFields && !ALLOWED_STATUSES.includes(safeFields.status)) {
    return res.status(400).json({ error: 'Invalid listing status' });
  }
  // Range-checked here rather than only in the `physical` branch further down:
  // that branch never runs for a digital listing, so a negative fee could be
  // stored on one and then blocked it from ever being switched to physical,
  // with an error naming a field the creator had not touched in that request.
  if ('shippingCents' in safeFields && (!Number.isFinite(safeFields.shippingCents) || safeFields.shippingCents < 0)) {
    return res.status(400).json({ error: 'Shipping fee must be 0 or more' });
  }

  const listings = await getListings();
  const existing = listings.find((l) => String(l.id) === String(listingId) && String(l.creatorId) === String(ctx.creator.id));
  if (!existing) return res.status(404).json({ error: 'Listing not found' });

  // An admin takedown (pages/api/admin/reports-resolve.js -> markListingRemoved)
  // only writes status: 'removed', leaving a moderated listing indistinguishable
  // from one the creator pulled themselves -- so the dashboard's Reactivate
  // button put moderated content straight back up. Ownership is unchanged by a
  // takedown, so nothing else here catches it. The actioned report IS the marker.
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
    if (typeof merged.title !== 'string' || !merged.title.trim() || !Number.isFinite(mergedPrice) || mergedPrice < 100) {
      return res.status(400).json({ error: 'Title and a price of at least $1 are required' });
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
    return res.status(500).json({ error: err.message });
  }
}
