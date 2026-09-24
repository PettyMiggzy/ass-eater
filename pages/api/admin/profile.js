import {
  getCreators,
  getCreatorById,
  updateCreatorProfile,
  effectiveCreatorStatus,
  sanitizeSocials,
  sanitizeTags,
  sanitizeAge,
  sanitizeLocation,
  UnderageProfile,
} from '../../../lib/creators-store';
import { findCircumventionInTags } from '../../../lib/listings-store';
import { deleteMediaQuietly } from '../../../lib/blob-cleanup';
import { FOUNDING_LIMIT, foundingSlotsLeft, isFoundingCreator, profileQualifiesForFounding } from '../../../lib/founding';
import { requireAdminKey } from '../../../lib/admin-auth';
import { screenPublicText, publicProfileTextEntries, rawTagItems } from '../../../lib/prohibited-terms';
import { addViolation } from '../../../lib/violations-store';
import { sanitizeGateTokens } from '../../../lib/token-gate';
import {
  validateTextFields,
  normalizeHandle,
  isAllowedAvatarSrc,
  sanitizeDmPriceCents,
  sanitizePayoutFields,
} from '../../../lib/field-validation';
import { isHandleConflict, HANDLE_TAKEN_MESSAGE } from '../../../lib/users-store';
import { query } from '../../../lib/db';
import { getAddress } from 'viem';

const FIELD_LABELS = {
  name: 'Display name',
  handle: 'Handle',
  bio: 'Bio',
  location: 'Location',
  price: 'Price',
  tag: 'Tags',
};

const STATUSES = new Set(['pending', 'active', 'suspended', 'banned']);

// Mirrors lib/creators-store.js's SUSPENSION_MS (the automatic violation
// ladder's window), which isn't exported. A suspension picked by hand from
// the admin panel is the same 30-day call, so it gets the same length rather
// than a second, different meaning of "suspended".
const SUSPENSION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * §2257: the platform's public statement (/2257) says it keeps its own record
 * for every performer. That is only true if a creator cannot go live without
 * one, so approval checks for a non-archived performer record linked to this
 * creator (performer_records.data.creatorId), read straight from the table.
 */
async function hasPerformerRecord(creatorId) {
  const { rows } = await query(
    `select 1 from performer_records
      where data->>'creatorId' = $1
        and coalesce(data->>'status', 'active') <> 'archived'
      limit 1`,
    [String(creatorId)],
  );
  return rows.length > 0;
}

// Whether a tags write is just the panel echoing the stored tags back.
function sameTags(next, stored) {
  const a = Array.isArray(next) ? next : [];
  const b = Array.isArray(stored) ? stored : [];
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { creatorId, fields } = req.body || {};
  if (!creatorId || (typeof creatorId !== 'string' && typeof creatorId !== 'number') || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return res.status(400).json({ error: 'Missing creatorId or fields' });
  }

  const existing = await getCreatorById(creatorId);
  if (!existing) return res.status(404).json({ error: 'Creator not found' });

  const allowed = ['name', 'handle', 'bio', 'price', 'subs', 'posts', 'likes', 'locked', 'trending', 'status', 'suspendedUntil', 'payoutMethod', 'walletAddress', 'img', 'premium', 'founding'];
  const safeFields = {};
  for (const key of allowed) {
    if (key in fields) safeFields[key] = fields[key];
  }
  if ('locked' in safeFields) safeFields.locked = !!safeFields.locked;

  // Same crash class already fixed on the creator's own editor
  // (pages/api/me/profile.js) and marketplace listings: a non-string
  // name/handle/bio written here 500s /search and /creators for every
  // visitor via .toLowerCase() the moment this creator becomes publicly
  // visible. This endpoint writes the exact same fields, so it needs the
  // exact same guard.
  const invalid = validateTextFields(safeFields, ['name', 'handle', 'bio', 'price', 'payoutMethod', 'walletAddress', 'img']);
  if (invalid) return res.status(400).json({ error: invalid });

  if ('status' in safeFields && !STATUSES.has(safeFields.status)) {
    return res.status(400).json({ error: 'status must be pending, active, suspended or banned' });
  }

  // Canonical "@" + body form, same as every other write path. A handle
  // that is merely being echoed back unchanged is left alone, so a legacy
  // record whose handle predates the charset rule can still be moderated.
  if ('handle' in safeFields && safeFields.handle !== existing.handle) {
    const { handle, error } = normalizeHandle(safeFields.handle, { allowBlank: true });
    if (error) return res.status(400).json({ error });
    safeFields.handle = handle;
  }

  // Avatar: our own media route for THIS creator, or a local /images/ file.
  // Any other URL would load in every visitor's browser (see
  // isAllowedAvatarSrc). An unchanged echo of the stored value passes.
  if ('img' in safeFields && safeFields.img !== existing.img) {
    if (!isAllowedAvatarSrc(safeFields.img, existing.id)) {
      return res.status(400).json({ error: 'The avatar must be an uploaded image (use the avatar upload) or a site image under /images/.' });
    }
  }

  if ('dmPriceCents' in fields) {
    const { value, error } = sanitizeDmPriceCents(fields.dmPriceCents);
    if (error) return res.status(400).json({ error });
    safeFields.dmPriceCents = value;
  }

  // Payouts are USDG only (payoutMethod is forced to 'usdg') and the wallet
  // must be a real EVM address -- refused here, when it is typed, rather than
  // discovered when a payout is requested. Stored checksummed, the same form
  // requestPayout() records against the payout.
  //
  // The panel echoes walletAddress on every save, so an unchanged echo of the
  // stored value is left alone rather than re-judged (same rule as handle and
  // the public text): otherwise a legacy record with a malformed wallet could
  // not be suspended or banned until someone cleared the wallet first. The
  // bad value still can't be paid to -- requestPayout() refuses it.
  if (
    'walletAddress' in safeFields &&
    String(safeFields.walletAddress ?? '').trim() === String(existing.walletAddress ?? '').trim()
  ) {
    delete safeFields.walletAddress;
  }
  const payoutError = sanitizePayoutFields(safeFields);
  if (payoutError) return res.status(400).json({ error: payoutError });
  if (safeFields.walletAddress) safeFields.walletAddress = getAddress(safeFields.walletAddress);

  if ('socials' in fields) safeFields.socials = sanitizeSocials(fields.socials);
  if ('tags' in fields) safeFields.tags = sanitizeTags(fields.tags);
  if ('gateTokens' in fields) safeFields.gateTokens = sanitizeGateTokens(fields.gateTokens);
  if ('location' in fields) safeFields.location = sanitizeLocation(fields.location);
  if ('age' in fields) {
    // Same refusal as the creator's own editor: an admin must not be able to
    // save an under-18 age either, by hand or by accident.
    try {
      safeFields.age = sanitizeAge(fields.age);
    } catch (err) {
      if (err instanceof UnderageProfile) {
        return res.status(400).json({ error: 'Refused: a creator profile cannot state an age under 18.' });
      }
      throw err;
    }
  }

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

  // What the creator is going FROM, judged by the effective status (an
  // expired suspension already reads 'active'). A legacy/seed record with no
  // status at all is already public, so it counts as active too.
  const previousStatus = effectiveCreatorStatus(existing) ?? 'active';

  // A suspension is not a holding state: effectiveCreatorStatus() reads a
  // lapsed suspension as 'active', so suspending someone schedules them to go
  // live in 30 days. For a pending applicant that would publish a creator who
  // was never approved, has no §2257 record and whose signup text was never
  // screened. Pending applicants stay pending, or get banned.
  if (safeFields.status === 'suspended' && (existing.status === 'pending' || previousStatus === 'pending')) {
    return res.status(400).json({
      error: "Nothing was saved -- a pending applicant can't be suspended (a suspension lifts itself to live after 30 days). Leave them pending, or ban them.",
    });
  }

  // Making someone live who isn't: approval (pending -> active) or a
  // reinstatement (suspended/banned -> active). Banned -> suspended counts
  // too, for the same reason as above: that suspension lapses into 'active'
  // on its own, so the go-live checks have to pass now, not never.
  const goingLive =
    (safeFields.status === 'active' && previousStatus !== 'active') ||
    (safeFields.status === 'suspended' && previousStatus === 'banned');
  // Approval specifically: the stored status is 'pending'. This is the ONLY
  // transition that may auto-grant Founding Creator (see below).
  const approving = safeFields.status === 'active' && existing.status === 'pending';

  const merged = { ...existing, ...safeFields };

  if (goingLive) {
    if (!String(merged.handle || '').replace(/^@+/, '').trim()) {
      return res.status(409).json({ error: 'Set a handle before making this creator live.' });
    }
    if (!(await hasPerformerRecord(existing.id))) {
      return res.status(409).json({
        error: 'Nothing was saved -- this creator has no §2257 performer record. Add one in the Records tab (linked to this creator) before making them live.',
      });
    }
  }

  // Public text. Normally only text this request is actually *introducing*
  // is checked: the admin panel posts every field on every save, and
  // rejecting the whole request on stored-but-unchanged text made the creator
  // who posted a Cash App handle the one creator an admin could no longer
  // suspend or ban -- exactly backwards for a moderation tool.
  //
  // Going live is the exception: EVERY public field is checked, changed or
  // not. Signup text and anything typed while pending has never been seen by
  // the public, so approval is the moment it is actually published -- and
  // skipping unchanged fields is what let a signup bio of "cashapp $jane"
  // go public on approval with no violation logged.
  //
  // The violation is logged against the creator whose profile was being
  // edited: there's no logged-in user on the admin path, so `userId` records
  // which creator record the text would have landed on, not who typed it.
  const existingTags = new Set(Array.isArray(existing.tags) ? existing.tags : []);
  const existingSocials = (existing.socials && typeof existing.socials === 'object') ? existing.socials : {};
  const unchanged = (context, value) => {
    if (context === 'tag') return existingTags.has(value);
    if (context.startsWith('social_')) return String(existingSocials[context.slice(7)] ?? '') === String(value ?? '');
    return String(existing[context] ?? '') === String(value ?? '');
  };
  let entries = publicProfileTextEntries(safeFields);
  if ('tags' in fields) for (const raw of rawTagItems(fields.tags)) entries.push(['tag', raw]);
  if (goingLive) {
    // Everything that will be public after this save, not just what was posted.
    entries = [...publicProfileTextEntries(merged), ...entries];
  } else {
    entries = entries.filter(([context, value]) => !unchanged(context, value));
  }
  // Tags render publicly as #chips, and a handle or phone number split across
  // two tags ("venmo", "@janedoe") passes every per-tag check above. Same
  // joined check the marketplace applies to listing tags; run whenever tags
  // are written, and on go-live over the stored ones.
  const tagSource = 'tags' in fields ? fields.tags : goingLive ? existing.tags : null;
  const tagHit = tagSource ? findCircumventionInTags(tagSource) : null;
  const tagsUnchanged = 'tags' in fields && !goingLive && sameTags(safeFields.tags, existing.tags);
  if (tagHit && !tagsUnchanged) {
    await addViolation({ userId: `admin-edit:creator:${creatorId}`, context: 'tags', reasons: tagHit.reasons, snippet: tagHit.snippet });
    return res.status(400).json({
      error: `Nothing was saved -- the Tags field looks like it's trying to move a payment off-platform, which isn't allowed here (flagged: ${tagHit.reasons.join(', ')}). Clear it and save again.`,
    });
  }
  for (const [context, value] of entries) {
    const hit = screenPublicText(value);
    if (hit) {
      await addViolation({ userId: `admin-edit:creator:${creatorId}`, context, reasons: hit.reasons, snippet: value });
      const label = FIELD_LABELS[context] || (context.startsWith('social_') ? `${context.slice(7)} link` : context);
      const what = hit.kind === 'prohibited'
        ? "contains a term that isn't allowed anywhere on this platform"
        : "looks like it's trying to move a payment off-platform, which isn't allowed here";
      return res.status(400).json({
        error: `Nothing was saved -- the ${label} field ${what} (flagged: ${hit.reasons.join(', ')}). Clear it and save again.`,
      });
    }
  }

  // Founding Creator is two coupled facts as well: the flag and the moment
  // the 30-day 0%-fee window starts. Stamped here so the window cannot be
  // set by hand, and so re-saving an existing founding creator's profile
  // doesn't silently restart their clock.
  //
  // The 100-slot cap is enforced here rather than trusted to the admin
  // panel's counter -- that counter is a display, this is the rule.
  //
  // Unticking the badge on a creator who has it is an explicit revocation
  // and is remembered (foundingRevokedAt), so no later status change can
  // silently hand it back. Ticking it by hand clears that marker: a
  // deliberate re-grant is the admin's call to make.
  if ('founding' in safeFields) {
    if (safeFields.founding) {
      safeFields.founding = true;
      if (!isFoundingCreator(existing)) {
        if (foundingSlotsLeft(await getCreators()) <= 0) {
          return res.status(409).json({ error: `All ${FOUNDING_LIMIT} Founding Creator slots are taken.` });
        }
        safeFields.foundingSince = new Date().toISOString();
        safeFields.foundingRevokedAt = null;
      }
      // Already founding: leave foundingSince exactly as it was.
    } else {
      safeFields.founding = false;
      safeFields.foundingSince = null;
      if (isFoundingCreator(existing)) safeFields.foundingRevokedAt = new Date().toISOString();
    }
  }

  // Founding status is granted at approval, automatically, to the first 100
  // creators who clear the finished-profile bar in lib/founding.js. Doing it
  // here rather than by hand is the point: a slot that depends on an admin
  // remembering to tick a box is a perk that quietly doesn't get given.
  //
  // ONLY on approval -- the stored status moving from 'pending' to 'active'.
  // It used to fire on any save where the stored status wasn't 'active',
  // which included the first routine edit after a 30-day violation
  // suspension had lapsed (the panel posts the effective status, 'active'),
  // reinstating a banned creator, and every save of a seed creator with no
  // status at all. Never for a creator with a confirmed content violation,
  // and never after an admin explicitly revoked it.
  //
  // The known cost: the admin panel posts every field on every save, so an
  // explicit `founding: false` in the same request that approves someone is
  // indistinguishable from the panel just echoing the current value --
  // meaning an admin who wants to approve a qualifying creator WITHOUT the
  // badge has to untick it on a second save (which then records the
  // revocation). Recoverable, and the opposite default (never auto-grant)
  // fails silently instead.
  if (
    approving &&
    !isFoundingCreator(existing) &&
    !safeFields.founding &&
    !existing.foundingRevokedAt &&
    !(Number(existing.contentViolationCount) > 0)
  ) {
    if (profileQualifiesForFounding({ ...existing, ...safeFields })) {
      if (foundingSlotsLeft(await getCreators()) > 0) {
        safeFields.founding = true;
        safeFields.foundingSince = new Date().toISOString();
      }
    }
  }

  let creator;
  try {
    creator = await updateCreatorProfile(existing.id, safeFields);
  } catch (err) {
    // Only the handle-uniqueness indexes mean "handle taken" -- any other
    // duplicate key is a server problem, not a naming one.
    if (isHandleConflict(err)) {
      return res.status(409).json({ error: HANDLE_TAKEN_MESSAGE });
    }
    console.error('[admin/profile] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

  // A ban set by hand takes the creator's listings off sale: every UNSOLD
  // listing -- including ones the creator had pulled themselves, which could
  // otherwise be reactivated if the ban were later lifted by hand -- is marked
  // removed by moderation and its media deleted. Otherwise a banned creator's
  // merch stayed live with a working Buy button on every surface that
  // resolves a listing's seller separately. Not done for a suspension: that
  // lifts itself and 'removed' would not un-mark.
  //
  // SOLD listings are deliberately left alone here, unlike the NCII path
  // (lib/ncii-reports-store.js -> removeListingsForCreator), which takes
  // everything down because the content itself was found unlawful. A manual
  // ban can be for anything, and a buyer who already paid for a digital item
  // keeps it; if the content itself has to go, that is a takedown of that
  // listing, not a side effect of banning its seller.
  //
  // The UPDATE only matches listings not already taken down, so it runs on
  // every save of a banned creator (the panel posts status every time) at the
  // cost of one no-op query, and a takedown that failed part-way is retried by
  // simply saving again.
  if (safeFields.status === 'banned') {
    try {
      const { rows } = await query(
        `update listings
            set data = data || jsonb_build_object(
                  'status', 'removed',
                  'moderationRemoved', true,
                  'mediaDeletedAt', $2::text
                ),
                updated_at = now()
          where data->>'creatorId' = $1
            and coalesce(data->>'status', '') <> 'sold'
            and not coalesce((data->>'moderationRemoved')::boolean, false)
          returning data`,
        [String(existing.id), new Date().toISOString()],
      );
      const media = rows.flatMap((r) => (Array.isArray(r.data?.media) ? r.data.media : []));
      if (media.length) await deleteMediaQuietly(media);
    } catch (err) {
      // The ban itself is saved; say plainly that the takedown didn't finish
      // so the admin can re-save rather than assume it did.
      console.error('[admin/profile] banned, but listing takedown failed:', err);
      return res.status(500).json({
        error: 'The ban was saved, but taking their listings down failed. Save again to retry.',
        creator,
      });
    }
  }

  return res.status(200).json({ ok: true, creator });
}
