import { effectiveCreatorStatus } from '../../lib/creator-status';
import { gateTokensOf } from '../../lib/token-gate';

// Pure helpers for the admin creator editor (pages/admin/index.js), kept out
// of the page so the save round-trip can be tested against the real
// /api/admin/profile handler (lib/admin-draft.test.mjs).

/**
 * The editor's draft for one creator, built from the server's copy of the
 * record. Used both when a creator is selected AND after every save: the
 * server changes coupled fields on its own (auto-granting Founding on
 * approval, stamping suspendedUntil for a new suspension, normalising the
 * handle), and a draft that kept the pre-save values would post them back on
 * the next save -- revoking a Founding badge the server had just granted, or
 * restarting a suspension's 30 days on every unrelated edit.
 */
export function draftFrom(c) {
  const dmCents = Number(c.dmPriceCents);
  return {
    name: c.name || '',
    handle: c.handle || '',
    bio: c.bio || '',
    price: c.price || '',
    subs: c.subs || '',
    posts: c.posts ?? 0,
    likes: c.likes || '',
    locked: !!c.locked,
    gateTokens: gateTokensOf(c) || '',
    trending: !!c.trending,
    premium: !!c.premium,
    founding: !!c.founding,
    status: effectiveCreatorStatus(c) || 'active',
    // Rides along with `status` on every save because the two are one
    // coupled decision -- see the comment in pages/api/admin/profile.js,
    // which is where the pair is actually settled. Sent verbatim so a
    // suspension still inside its 30 days keeps its own clock when the admin
    // saves some unrelated field. Only correct because the draft is rebuilt
    // from the saved record after every save (see saveProfile).
    suspendedUntil: c.suspendedUntil || null,
    walletAddress: c.walletAddress || '',
    // Edited in dollars, stored in cents; blank = the platform floor.
    dmPrice: Number.isInteger(dmCents) && dmCents > 0 ? (dmCents / 100).toFixed(2) : '',
    socials: {
      twitter: c.socials?.twitter || '',
      instagram: c.socials?.instagram || '',
      tiktok: c.socials?.tiktok || '',
      reddit: c.socials?.reddit || '',
      website: c.socials?.website || '',
    },
  };
}

/** Draft -> the `fields` body /api/admin/profile expects. Returns { fields } or { error }. */
export function fieldsFromDraft(draft) {
  const { dmPrice, ...rest } = draft;
  let dmPriceCents = null;
  const raw = String(dmPrice ?? '').trim().replace(/^\$/, '');
  if (raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return { error: 'Message price must be a dollar amount (e.g. 2.50), or blank for the default.' };
    dmPriceCents = Math.round(n * 100);
  }
  // payoutMethod is not sent: only USDG is paid out, and the server stores
  // 'usdg' whatever arrives. img is not sent either -- the avatar only changes
  // through the avatar upload.
  return { fields: { ...rest, dmPriceCents } };
}
