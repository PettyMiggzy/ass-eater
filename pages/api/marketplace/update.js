import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { updateListing } from '../../../lib/listings-store';
import { detectPaymentCircumvention, PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { addViolation } from '../../../lib/violations-store';

const ALLOWED = ['title', 'description', 'priceCents', 'status', 'kind', 'shippingCents', 'signatureRequired', 'aiGenerated'];

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

  for (const field of ['title', 'description']) {
    if (!(field in safeFields)) continue;
    const check = detectPaymentCircumvention(safeFields[field]);
    if (check.flagged) {
      await addViolation({ userId: ctx.user.id, context: `listing_${field}`, reasons: check.reasons, snippet: safeFields[field] });
      return res.status(400).json({ error: PAYMENT_CIRCUMVENTION_MESSAGE });
    }
  }

  try {
    const listing = await updateListing(listingId, ctx.creator.id, safeFields);
    return res.status(200).json({ ok: true, listing });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
