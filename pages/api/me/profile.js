import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { updateCreatorProfile, sanitizeSocials, sanitizeTags, sanitizeAge, sanitizeLocation, UnderageProfile } from '../../../lib/creators-store';
import { detectPaymentCircumvention, PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { addViolation } from '../../../lib/violations-store';
import { sanitizeGateTokens } from '../../../lib/token-gate';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { fields } = req.body || {};
  const allowed = ['name', 'handle', 'bio', 'price', 'payoutMethod', 'walletAddress', 'img', 'locked'];
  const safeFields = {};
  for (const key of allowed) {
    if (fields && key in fields) safeFields[key] = fields[key];
  }
  if (fields && 'socials' in fields) safeFields.socials = sanitizeSocials(fields.socials);
  if (fields && 'tags' in fields) safeFields.tags = sanitizeTags(fields.tags);
  if (fields && 'gateTokens' in fields) safeFields.gateTokens = sanitizeGateTokens(fields.gateTokens);
  if (fields && 'location' in fields) safeFields.location = sanitizeLocation(fields.location);
  if (fields && 'age' in fields) {
    try {
      safeFields.age = sanitizeAge(fields.age);
    } catch (err) {
      if (err instanceof UnderageProfile) {
        return res.status(400).json({ error: 'You must be 18 or older to have a creator profile here.' });
      }
      throw err;
    }
  }

  for (const field of ['name', 'handle', 'bio']) {
    if (!(field in safeFields)) continue;
    const check = detectPaymentCircumvention(safeFields[field]);
    if (check.flagged) {
      await addViolation({ userId: ctx.user.id, context: field, reasons: check.reasons, snippet: safeFields[field] });
      return res.status(400).json({ error: PAYMENT_CIRCUMVENTION_MESSAGE });
    }
  }

  // sanitizeSocials only bounds shape/length -- it does not stop a "handle"
  // field from actually being "cashapp $handle, text me at 555-123-4567".
  // Public-facing the same way name/handle/bio are, so it gets the same gate.
  if (safeFields.socials) {
    for (const [field, value] of Object.entries(safeFields.socials)) {
      const check = detectPaymentCircumvention(value);
      if (check.flagged) {
        await addViolation({ userId: ctx.user.id, context: `social_${field}`, reasons: check.reasons, snippet: value });
        return res.status(400).json({ error: PAYMENT_CIRCUMVENTION_MESSAGE });
      }
    }
  }

  try {
    const creator = await updateCreatorProfile(ctx.creator.id, safeFields);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
