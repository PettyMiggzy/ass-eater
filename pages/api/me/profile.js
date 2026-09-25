import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { updateCreatorProfile, sanitizeSocials, sanitizeTags, sanitizeAge, sanitizeLocation, UnderageProfile } from '../../../lib/creators-store';
import { screenPublicText, publicProfileTextEntries, rawTagItems } from '../../../lib/prohibited-terms';
import { addViolation } from '../../../lib/violations-store';
import { sanitizeGateTokens, refusesUnenforceableGate } from '../../../lib/token-gate';
import {
  validateTextFields,
  normalizeHandle,
  sanitizeDmPriceCents,
  sanitizePayoutFields,
  looksLikePhoneNumber,
  PHONE_NAME_MESSAGE,
  isReservedName,
  RESERVED_NAME_MESSAGE,
} from '../../../lib/field-validation';
import { isHandleConflict, HANDLE_TAKEN_MESSAGE } from '../../../lib/users-store';
import { findCircumventionInTags } from '../../../lib/listings-store';
import { PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { getAddress } from 'viem';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { fields } = req.body || {};
  // `key in fields` throws a TypeError on a string or number, which surfaced
  // as an uncaught 500; an array would be read as an empty edit.
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  // `img` is deliberately NOT here. The avatar is set only by the avatar
  // upload endpoint, which stores a path under this creator's own media
  // folder. Accepting it here let a creator point their public avatar at any
  // URL -- a tracking pixel on their own server logging the IP of every fan
  // browsing Explore, or an off-site image no moderation tool ever sees. The
  // dashboard used to echo `img` back on every save; it is now ignored.
  const allowed = ['name', 'handle', 'bio', 'price', 'payoutMethod', 'walletAddress', 'locked'];
  const safeFields = {};
  for (const key of allowed) {
    if (key in fields) safeFields[key] = fields[key];
  }
  // Before anything else touches these: a non-string here is stored verbatim
  // in jsonb and then 500s /search and /creators for every visitor, from one
  // ordinary creator account. See lib/field-validation.js.
  const invalid = validateTextFields(safeFields, ['name', 'handle', 'bio', 'price', 'payoutMethod', 'walletAddress']);
  if (invalid) return res.status(400).json({ error: invalid });
  if ('locked' in safeFields) safeFields.locked = !!safeFields.locked;
  // Payouts are USDG only (payoutMethod is forced to 'usdg'), and the wallet
  // must be a real EVM address: a typo'd one is refused now, when it is
  // typed, not discovered when a payout is requested. An empty string clears
  // it. Stored checksummed, the form requestPayout() records. The dashboard
  // echoes the wallet on every save, so an unchanged echo of a legacy
  // malformed value is left alone rather than blocking an unrelated bio edit
  // (requestPayout() still refuses to pay it).
  if (
    'walletAddress' in safeFields &&
    String(safeFields.walletAddress ?? '').trim() === String(ctx.creator.walletAddress ?? '').trim()
  ) {
    delete safeFields.walletAddress;
  }
  const payoutError = sanitizePayoutFields(safeFields);
  if (payoutError) return res.status(400).json({ error: payoutError });
  if (safeFields.walletAddress) safeFields.walletAddress = getAddress(safeFields.walletAddress);

  // One canonical stored form for handles ("@" + body), so "alice" and
  // "@alice" can't be two creators and ?ref=alice can't resolve to the wrong
  // one. See normalizeHandle.
  // The dashboard echoes the handle on every save: an unchanged echo of the
  // stored (already canonical) value is left alone, so a legacy handle that
  // predates a newer rule (the phone-number one) can't block a bio edit.
  if ('handle' in safeFields && safeFields.handle === ctx.creator.handle) {
    delete safeFields.handle;
  }
  if ('handle' in safeFields) {
    const { handle, error } = normalizeHandle(safeFields.handle);
    if (error) return res.status(400).json({ error });
    safeFields.handle = handle;
  }
  // The display name is published beside the handle, so it gets the same
  // "not a phone number" rule normalizeHandle applies. Both are refused if
  // they read as the platform's own staff or brand ("OnlyOne Support",
  // "@onlyone_team") -- only an admin can set such a name. An unchanged echo
  // of the stored value is left alone, so a legacy name can't block an
  // unrelated edit.
  for (const key of ['name', 'handle']) {
    if (!(key in safeFields) || typeof safeFields[key] !== 'string') continue;
    if (String(safeFields[key]).trim() === String(ctx.creator[key] ?? '').trim()) continue;
    if (key === 'name' && looksLikePhoneNumber(safeFields.name)) {
      return res.status(400).json({ error: PHONE_NAME_MESSAGE });
    }
    if (isReservedName(safeFields[key])) {
      return res.status(400).json({ error: RESERVED_NAME_MESSAGE });
    }
  }

  if ('dmPriceCents' in fields) {
    const { value, error } = sanitizeDmPriceCents(fields.dmPriceCents);
    if (error) return res.status(400).json({ error });
    safeFields.dmPriceCents = value;
  }

  if (fields && 'socials' in fields) safeFields.socials = sanitizeSocials(fields.socials);
  if (fields && 'tags' in fields) safeFields.tags = sanitizeTags(fields.tags);
  if (fields && 'gateTokens' in fields) safeFields.gateTokens = sanitizeGateTokens(fields.gateTokens);
  // A gate over media that is served as public files would lock nothing (see
  // lib/token-gate.js gateEnforceable).
  const gateRefusal = refusesUnenforceableGate(ctx.creator, safeFields);
  if (gateRefusal) return res.status(400).json({ error: gateRefusal });
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

  // Every public free-text field, checked AFTER sanitising so what is
  // screened is exactly what will be stored: name, handle, bio, location,
  // price, each tag and each social handle. Location, price and tags used to
  // skip this entirely although all three render publicly (profile header,
  // every Explore card, the site-wide tag cloud) -- "venmo @mia 555-123-4567"
  // saved as a location went straight out. Prohibited terms (lib/
  // prohibited-terms.js) ride the same loop: a "teen" tag is public the
  // moment it saves.
  const entries = publicProfileTextEntries(safeFields);
  if (fields && 'tags' in fields) for (const raw of rawTagItems(fields.tags)) entries.push(['tag', raw]);
  for (const [context, value] of entries) {
    const hit = screenPublicText(value);
    if (hit) {
      await addViolation({ userId: ctx.user.id, context, reasons: hit.reasons, snippet: value });
      return res.status(400).json({ error: hit.message });
    }
  }
  // Each tag was screened on its own above; this also screens them JOINED, so a handle or
  // phone number split across two tags ("venmo", "@janedoe") is caught the
  // same way it is on a marketplace listing.
  if (fields && 'tags' in fields) {
    const tagHit = findCircumventionInTags(fields.tags);
    if (tagHit) {
      await addViolation({ userId: ctx.user.id, context: 'tags', reasons: tagHit.reasons, snippet: tagHit.snippet });
      return res.status(400).json({ error: PAYMENT_CIRCUMVENTION_MESSAGE });
    }
  }

  try {
    const creator = await updateCreatorProfile(ctx.creator.id, safeFields);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    // Only the handle-uniqueness indexes mean "handle taken" -- any other
    // duplicate key is a server problem and must not be reported as the
    // creator's fault.
    if (isHandleConflict(err)) {
      return res.status(409).json({ error: HANDLE_TAKEN_MESSAGE });
    }
    console.error('[me/profile] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
