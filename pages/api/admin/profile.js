import { updateCreatorProfile, sanitizeSocials, sanitizeTags } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { detectPaymentCircumvention, PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { addViolation } from '../../../lib/violations-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { creatorId, fields } = req.body || {};
  if (!creatorId || !fields) {
    return res.status(400).json({ error: 'Missing creatorId or fields' });
  }

  const allowed = ['name', 'handle', 'bio', 'price', 'subs', 'posts', 'likes', 'locked', 'trending', 'status', 'payoutMethod', 'walletAddress', 'img', 'premium'];
  const safeFields = {};
  for (const key of allowed) {
    if (key in fields) safeFields[key] = fields[key];
  }
  if ('socials' in fields) safeFields.socials = sanitizeSocials(fields.socials);
  if ('tags' in fields) safeFields.tags = sanitizeTags(fields.tags);

  // Same check pages/api/me/profile.js runs on the creator's own edits --
  // without it this endpoint was a trivial way around the filter, since it
  // writes to the exact same public name/handle/bio fields. The violation is
  // logged against the creator whose profile was being edited: there's no
  // logged-in user on the admin path, so `userId` records which creator
  // record the text would have landed on, not who typed it.
  for (const field of ['name', 'handle', 'bio']) {
    if (!(field in safeFields)) continue;
    const check = detectPaymentCircumvention(safeFields[field]);
    if (check.flagged) {
      await addViolation({ userId: `admin-edit:creator:${creatorId}`, context: field, reasons: check.reasons, snippet: safeFields[field] });
      return res.status(400).json({ error: PAYMENT_CIRCUMVENTION_MESSAGE });
    }
  }

  try {
    const creator = await updateCreatorProfile(creatorId, safeFields);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
