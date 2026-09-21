import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { createListing } from '../../../lib/listings-store';
import { detectPaymentCircumvention, PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { addViolation } from '../../../lib/violations-store';
import { validateTextFields } from '../../../lib/field-validation';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { title, description, priceCents, unlimited, kind, shippingCents, signatureRequired, aiGenerated, tags } = req.body || {};
  // `!title` lets an object through (truthy) and `"abc" < 100` is false, so
  // the original check accepted both a non-string title and a non-numeric
  // price -- each of which 500s /search and /marketplace for every visitor
  // once stored. update.js had the right guard; create.js never got it.
  const invalid = validateTextFields({ title, description }, ['title', 'description']);
  if (invalid) return res.status(400).json({ error: invalid });

  const price = Math.round(Number(priceCents));
  // typeof, not just truthiness -- validateTextFields skips a key whose
  // value is undefined entirely (treats "not provided" as valid), so an
  // omitted title passed that check and then threw on `.trim()` here.
  if (typeof title !== 'string' || !title.trim() || !Number.isFinite(price) || price < 100) {
    return res.status(400).json({ error: 'Title and a price of at least $1 are required' });
  }
  const shipping = shippingCents == null ? null : Math.round(Number(shippingCents));
  if (kind === 'physical' && (shipping == null || !Number.isFinite(shipping) || shipping < 0)) {
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
    const listing = await createListing(ctx.creator.id, {
      title,
      description,
      priceCents: price,
      unlimited: !!unlimited,
      kind: kind === 'physical' ? 'physical' : 'digital',
      shippingCents: shipping,
      signatureRequired: !!signatureRequired,
      aiGenerated: !!aiGenerated,
      tags,
    });
    return res.status(200).json({ ok: true, listing });
  } catch (err) {
    console.error('[marketplace/create] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
