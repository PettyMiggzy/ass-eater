import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { updateCreatorProfile, sanitizeSocials, sanitizeTags } from '../../../lib/creators-store';
import { detectPaymentCircumvention, PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { addViolation } from '../../../lib/violations-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { fields } = req.body || {};
  const allowed = ['name', 'handle', 'bio', 'price', 'payoutMethod', 'walletAddress', 'img'];
  const safeFields = {};
  for (const key of allowed) {
    if (fields && key in fields) safeFields[key] = fields[key];
  }
  if (fields && 'socials' in fields) safeFields.socials = sanitizeSocials(fields.socials);
  if (fields && 'tags' in fields) safeFields.tags = sanitizeTags(fields.tags);

  if ('bio' in safeFields) {
    const check = detectPaymentCircumvention(safeFields.bio);
    if (check.flagged) {
      await addViolation({ userId: ctx.user.id, context: 'bio', reasons: check.reasons, snippet: safeFields.bio });
      return res.status(400).json({ error: PAYMENT_CIRCUMVENTION_MESSAGE });
    }
  }

  try {
    const creator = await updateCreatorProfile(ctx.creator.id, safeFields);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
