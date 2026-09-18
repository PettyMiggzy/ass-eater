import { getCreators, updateCreatorProfile, sanitizeSocials, sanitizeTags } from '../../../lib/creators-store';
import { FOUNDING_LIMIT, foundingSlotsLeft, isFoundingCreator, profileQualifiesForFounding } from '../../../lib/founding';
import { requireAdminKey } from '../../../lib/admin-auth';
import { detectPaymentCircumvention } from '../../../lib/payment-circumvention-filter';
import { addViolation } from '../../../lib/violations-store';

const FIELD_LABELS = { name: 'Display name', handle: 'Handle', bio: 'Bio' };

// Mirrors lib/creators-store.js's SUSPENSION_MS (the automatic violation
// ladder's window), which isn't exported. A suspension picked by hand from
// the admin panel is the same 30-day call, so it gets the same length rather
// than a second, different meaning of "suspended".
const SUSPENSION_MS = 30 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { creatorId, fields } = req.body || {};
  if (!creatorId || !fields) {
    return res.status(400).json({ error: 'Missing creatorId or fields' });
  }

  const allowed = ['name', 'handle', 'bio', 'price', 'subs', 'posts', 'likes', 'locked', 'trending', 'status', 'suspendedUntil', 'payoutMethod', 'walletAddress', 'img', 'premium', 'founding'];
  const safeFields = {};
  for (const key of allowed) {
    if (key in fields) safeFields[key] = fields[key];
  }
  if ('socials' in fields) safeFields.socials = sanitizeSocials(fields.socials);
  if ('tags' in fields) safeFields.tags = sanitizeTags(fields.tags);

  // `status` and `suspendedUntil` are one coupled decision, not two
  // independent fields: effectiveCreatorStatus() (lib/creators-store.js)
  // reads a suspension whose suspendedUntil has already passed as active
  // again. So writing `status: 'suspended'` while a stale timestamp left
  // over from an earlier automatic suspension is still on the record
  // resolves straight back to 'active' -- the admin sees "Saved." and the
  // suspension silently does nothing at all. Settled here rather than in
  // the panel so that no caller can produce that combination:
  //   - not suspended         -> no timestamp at all
  //   - suspended, future     -> kept, so an automatic 30-day suspension
  //                              keeps its own clock across unrelated edits
  //   - suspended, past/none  -> a fresh 30-day window starting now, which is
  //                              also what the two places that print the date
  //                              to the creator (lib/require-creator-owner.js,
  //                              pages/dashboard.js) need in order not to say
  //                              "suspended until 1/1/1970"
  if ('status' in safeFields) {
    const until = Date.parse(safeFields.suspendedUntil);
    const keepExisting = Number.isFinite(until) && until > Date.now();
    safeFields.suspendedUntil =
      safeFields.status !== 'suspended'
        ? null
        : new Date(keepExisting ? until : Date.now() + SUSPENSION_MS).toISOString();
  } else {
    // suspendedUntil only ever moves as part of a status decision.
    delete safeFields.suspendedUntil;
  }

  // Founding Creator is two coupled facts as well: the flag and the moment
  // the 30-day 0%-fee window starts. Stamped here so the window cannot be
  // set by hand, and so re-saving an existing founding creator's profile
  // doesn't silently restart their clock.
  //
  // The 100-slot cap is enforced here rather than trusted to the admin
  // panel's counter -- that counter is a display, this is the rule.
  if ('founding' in safeFields) {
    const creators = await getCreators();
    const existing = creators.find((c) => String(c.id) === String(creatorId));
    if (safeFields.founding) {
      if (!isFoundingCreator(existing)) {
        if (foundingSlotsLeft(creators) <= 0) {
          return res.status(409).json({ error: `All ${FOUNDING_LIMIT} Founding Creator slots are taken.` });
        }
        safeFields.foundingSince = new Date().toISOString();
      }
      // Already founding: leave foundingSince exactly as it was.
    } else {
      safeFields.founding = false;
      safeFields.foundingSince = null;
    }
  }

  const existing = (await getCreators()).find((c) => String(c.id) === String(creatorId));

  // Founding status is granted at approval, automatically, to the first 100
  // creators who clear the finished-profile bar in lib/founding.js. Doing it
  // here rather than by hand is the point: a slot that depends on an admin
  // remembering to tick a box is a perk that quietly doesn't get given.
  //
  // Only on the transition INTO active, so re-saving an approved creator
  // never re-grants. The known cost: the admin panel posts every field on
  // every save, so an explicit `founding: false` in the same request that
  // approves someone is indistinguishable from the panel just echoing the
  // current value -- meaning an admin who wants to approve a qualifying
  // creator WITHOUT the badge has to untick it on a second save. Recoverable,
  // and the opposite default (never auto-grant) fails silently instead.
  if (
    safeFields.status === 'active' &&
    existing &&
    existing.status !== 'active' &&
    !isFoundingCreator(existing) &&
    !safeFields.founding
  ) {
    const merged = { ...existing, ...safeFields };
    if (profileQualifiesForFounding(merged)) {
      const roster = await getCreators();
      if (foundingSlotsLeft(roster) > 0) {
        safeFields.founding = true;
        safeFields.foundingSince = new Date().toISOString();
      }
    }
  }

  // Same check pages/api/me/profile.js runs on the creator's own edits --
  // without it this endpoint was a trivial way around the filter, since it
  // writes to the exact same public name/handle/bio fields.
  //
  // Only text this request is actually *introducing* is checked. The admin
  // panel posts every field on every save, changed or not, and flagged text
  // can already be sitting in the record (pages/api/auth/signup.js writes a
  // creator's initial bio with no filter on it). Rejecting the whole request
  // on stored-but-unchanged text made the creator who posted a Cash App
  // handle the one creator an admin could no longer suspend or ban -- exactly
  // backwards for a moderation tool, since `status` never got written either.
  //
  // The violation is logged against the creator whose profile was being
  // edited: there's no logged-in user on the admin path, so `userId` records
  // which creator record the text would have landed on, not who typed it.
  for (const field of ['name', 'handle', 'bio']) {
    if (!(field in safeFields)) continue;
    if (existing && String(safeFields[field] ?? '') === String(existing[field] ?? '')) continue;
    const check = detectPaymentCircumvention(safeFields[field]);
    if (check.flagged) {
      await addViolation({ userId: `admin-edit:creator:${creatorId}`, context: field, reasons: check.reasons, snippet: safeFields[field] });
      // PAYMENT_CIRCUMVENTION_MESSAGE is worded for a blocked message send.
      // An admin needs to know which field stopped the save and that nothing
      // at all was written, so this endpoint words its own.
      return res.status(400).json({
        error: `Nothing was saved -- the ${FIELD_LABELS[field]} field looks like it's trying to move a payment off-platform, which isn't allowed here (flagged: ${check.reasons.join(', ')}). Clear it and save again.`,
      });
    }
  }

  try {
    const creator = await updateCreatorProfile(creatorId, safeFields);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
