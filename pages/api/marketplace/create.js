import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { createListing } from '../../../lib/listings-store';
import { detectPaymentCircumvention, PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { addViolation } from '../../../lib/violations-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { title, description, priceCents, unlimited, kind, shippingCents, signatureRequired, aiGenerated } = req.body || {};
  if (!title || !priceCents || priceCents < 100) {
    return res.status(400).json({ error: 'Title and a price of at least $1 are required' });
  }
  if (kind === 'physical' && (shippingCents == null || shippingCents < 0)) {
    return res.status(400).json({ error: 'Physical items need a shipping fee (can be 0 for free shipping)' });
  }

  for (const [field, value] of [['title', title], ['description', description]]) {
    const check = detectPaymentCircumvention(value);
    if (check.flagged) {
      await addViolation({ userId: ctx.user.id, context: `listing_${field}`, reasons: check.reasons, snippet: value });
      return res.status(400).json({ error: PAYMENT_CIRCUMVENTION_MESSAGE });
    }
  }

  try {
    const listing = await createListing(ctx.creator.id, { title, description, priceCents, unlimited, kind, shippingCents, signatureRequired, aiGenerated });
    return res.status(200).json({ ok: true, listing });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
