import { effectiveCreatorStatus, sanitizeTags } from '../../lib/creator-status';
import { gateTokensOf } from '../../lib/token-gate';
import { sanitizeCategories } from '../../lib/categories';

// Pure helpers for the admin creator editor (pages/admin/index.js), kept out
// of the page so the save round-trip can be tested against the real
// /api/admin/profile handler (lib/admin-draft.test.mjs).

/**
 * The editor's draft for one creator, built from the server's copy of the
 * record. Used when a creator is selected (from a FRESH read, not the roster
 * snapshot loaded at unlock), after every save, and as the BASELINE a save is
 * diffed against: the server changes coupled fields on its own (auto-granting
 * Founding on approval, stamping suspendedUntil for a new suspension,
 * normalising the handle), and a draft that kept the pre-save values would
 * post them back on the next save.
 *
 * No subs/posts/likes: the site has no such counters and /api/admin/profile
 * no longer accepts them (the public projection derives posts from the
 * gallery and publishes neither of the others).
 */
export function draftFrom(c) {
  const dmCents = Number(c.dmPriceCents);
  return {
    name: c.name || '',
    handle: c.handle || '',
    bio: c.bio || '',
    price: c.price || '',
    locked: !!c.locked,
    gateTokens: String(gateTokensOf(c) || ''),
    trending: !!c.trending,
    premium: !!c.premium,
    founding: !!c.founding,
    status: effectiveCreatorStatus(c) || 'active',
    // Travels with `status`, and only when status changes -- the two are one
    // coupled decision settled in pages/api/admin/profile.js. Sent verbatim so
    // a suspension still inside its 30 days keeps its own clock.
    suspendedUntil: c.suspendedUntil || null,
    walletAddress: c.walletAddress || '',
    // Edited in dollars, stored in cents; blank = the platform floor.
    dmPrice: Number.isInteger(dmCents) && dmCents > 0 ? (dmCents / 100).toFixed(2) : '',
    // Tags, location and age are public profile fields the server re-screens
    // on go-live (pages/api/admin/profile.js). The panel has to be able to
    // edit them, or a refusal that says "Clear the Tags field" names a field
    // the admin cannot reach. Tags are edited as one comma-separated string.
    tags: Array.isArray(c.tags) ? c.tags.join(', ') : '',
    // Browse categories (lib/categories.js): known keys, edited as toggle chips.
    categories: sanitizeCategories(c.categories),
    location: typeof c.location === 'string' ? c.location : '',
    age: Number.isFinite(Number(c.age)) && c.age !== null && c.age !== '' ? String(c.age) : '',
    socials: {
      twitter: c.socials?.twitter || '',
      instagram: c.socials?.instagram || '',
      tiktok: c.socials?.tiktok || '',
      reddit: c.socials?.reddit || '',
      website: c.socials?.website || '',
    },
  };
}

// Every draft key an admin can edit. suspendedUntil is not in the list: it is
// never edited on its own, only carried alongside a status change.
export const EDITABLE_KEYS = [
  'name', 'handle', 'bio', 'price', 'locked', 'gateTokens', 'trending', 'premium',
  'founding', 'status', 'walletAddress', 'dmPrice', 'tags', 'categories', 'location', 'age', 'socials',
];

const FIELD_NAMES = {
  name: 'name', handle: 'handle', bio: 'bio', price: 'price', locked: 'token gate', gateTokens: 'gate amount',
  trending: 'trending', premium: 'premium', founding: 'Founding', status: 'status', walletAddress: 'payout wallet',
  dmPrice: 'message price', tags: 'tags', categories: 'categories', location: 'location', age: 'age', socials: 'socials',
};

/** Human label for a draft key (used in conflict messages). */
export function fieldName(key) {
  return FIELD_NAMES[key] || key;
}

function norm(key, value) {
  if (key === 'socials') return JSON.stringify(value || {});
  // Compared as the list the server would store, so "a, b" vs "a,b" (or a
  // re-cased tag) is not a change and not a false rebase conflict.
  if (key === 'tags') return sanitizeTags(Array.isArray(value) ? value : String(value ?? '')).join(',');
  // Compared as the stored list, so a legacy unknown key or a comma string is
  // not mistaken for an edit. Order matters (it is the creator's order).
  if (key === 'categories') return sanitizeCategories(value).join(',');
  if (key === 'location') return String(value ?? '').replace(/\s+/g, ' ').trim();
  if (typeof value === 'boolean') return value;
  if (key === 'dmPrice') {
    const cents = parseDmPrice(value);
    return cents.error ? `invalid:${String(value ?? '').trim()}` : cents.value;
  }
  return String(value ?? '').trim();
}

/** Whether the draft's value for `key` differs from the baseline's. */
export function changedFrom(draft, baseline, key) {
  return norm(key, draft?.[key]) !== norm(key, baseline?.[key]);
}

/**
 * The age box: blank clears it, otherwise a whole number of years, 18 or
 * over. Refused here as well as on the server (sanitizeAge throws
 * UnderageProfile), so a typo is caught before anything is sent.
 */
function parseAge(age) {
  const raw = String(age ?? '').trim();
  if (!raw) return { value: '' };
  if (!/^\d{1,3}$/.test(raw)) return { error: 'Age must be a whole number of years, or blank.' };
  if (Number(raw) < 18) return { error: 'Refused: a creator profile cannot state an age under 18.' };
  return { value: raw };
}

function parseDmPrice(dmPrice) {
  const raw = String(dmPrice ?? '').trim().replace(/^\$/, '');
  if (!raw) return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { error: 'Message price must be a dollar amount (e.g. 2.50), or blank for the default.' };
  return { value: Math.round(n * 100) };
}

/**
 * Draft -> the `fields` body /api/admin/profile expects. Returns { fields } or
 * { error }.
 *
 * With a `baseline` (draftFrom of the record the draft was opened from) only
 * the fields the admin actually CHANGED are sent. The panel used to post every
 * field from a roster snapshot loaded at unlock, and the server can't tell an
 * echo of a stale value from a deliberate change -- so ticking "Trending" on a
 * creator who had since changed their payout wallet wrote the OLD wallet back,
 * and the next payout went to it. Without a baseline everything is sent (only
 * used by tests of the full mapping).
 *
 * Coupled fields travel together: status with suspendedUntil, locked with
 * gateTokens. A banned creator's status is always sent (see below).
 */
export function fieldsFromDraft(draft, baseline) {
  const all = !baseline;
  const changed = (k) => all || changedFrom(draft, baseline, k);
  const fields = {};
  for (const key of ['name', 'handle', 'bio', 'price', 'trending', 'premium', 'founding', 'walletAddress', 'socials']) {
    if (changed(key)) fields[key] = draft[key];
  }
  // Tags go as the raw comma-separated string: the server sanitizes it AND
  // runs the payment-circumvention check over the raw items (a split handle
  // like "venmo, @jane" is only visible before sanitizing).
  if (changed('tags')) fields.tags = String(draft.tags ?? '');
  if (changed('categories')) fields.categories = sanitizeCategories(draft.categories);
  if (changed('location')) fields.location = String(draft.location ?? '');
  if (changed('age')) {
    const parsed = parseAge(draft.age);
    if (parsed.error) return { error: parsed.error };
    fields.age = parsed.value;
  }
  if (changed('locked') || changed('gateTokens')) {
    fields.locked = !!draft.locked;
    fields.gateTokens = draft.gateTokens;
  }
  // A banned creator's save always carries status: 'banned', changed or not.
  // /api/admin/profile takes a banned creator's listings down on every save
  // that says 'banned', and that is the ONLY way to retry a takedown that
  // failed part-way ("The ban was saved, but taking their listings down
  // failed. Save again to retry."). With diff-only saves the retry used to
  // send nothing ("Nothing to save"), so the listings stayed up for good.
  // Only when the baseline (the stored record) is banned too: rebaseDraft has
  // already replaced an untouched status with the current one, so a creator
  // reinstated elsewhere since the draft was opened is never re-banned.
  const reBan = !all && draft.status === 'banned' && baseline.status === 'banned';
  if (changed('status') || reBan) {
    fields.status = draft.status;
    fields.suspendedUntil = reBan ? null : draft.suspendedUntil ?? null;
  }
  if (changed('dmPrice')) {
    const parsed = parseDmPrice(draft.dmPrice);
    if (parsed.error) return { error: parsed.error };
    fields.dmPriceCents = parsed.value;
  }
  // payoutMethod is not sent: only USDG is paid out, and the server stores
  // 'usdg' whatever arrives. img is not sent either -- the avatar only changes
  // through the avatar upload / remove.
  return { fields };
}

/**
 * Rebase an open draft onto a fresh server copy just before saving.
 *
 * `baseline` is what the draft was opened from, `current` is the record as it
 * is NOW. Fields the admin didn't touch take the current value; fields the
 * admin edited keep the edit -- unless the stored value ALSO changed since the
 * draft was opened (the creator edited it from their dashboard, or another
 * admin tab saved), in which case the admin's edit would silently overwrite
 * that change. Those are returned as `conflicts`, and the rebased draft shows
 * the stored value so the admin can look before saving again.
 *
 * Returns { draft, baseline, conflicts: [key] }.
 */
export function rebaseDraft(draft, baseline, current) {
  const fresh = draftFrom(current);
  const next = { ...fresh };
  const conflicts = [];
  for (const key of EDITABLE_KEYS) {
    const edited = changedFrom(draft, baseline, key);
    if (!edited) continue;
    const moved = changedFrom(fresh, baseline, key);
    if (moved && changedFrom(fresh, draft, key)) {
      conflicts.push(key);
      continue;
    }
    next[key] = draft[key];
  }
  return { draft: next, baseline: fresh, conflicts };
}

// Mirrors pages/api/admin/profile.js's SUSPENSION_MS: a NEW suspension runs
// 30 days from the save.
const SUSPENSION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What saving a Founding grant does to the 30-day fee-free window of a
 * creator whose window has not started yet -- the same decision
 * pages/api/admin/profile.js makes when it stamps foundingSince, from the
 * status the creator has AFTER the save (`resultingStatus`: the draft's
 * status, which the panel only sends when it changed, so it is the resulting
 * one either way). The editor's hint is built from this, so it can't promise
 * a later start than the server gives (round-9 admin-ui#2: it said "has not
 * started yet" while the save started it immediately).
 *
 * Returns
 *   { kind: 'started' }            the window already started (foundingSince in the past)
 *   { kind: 'now' }                active after the save: it starts on save
 *   { kind: 'at', at, fresh }      suspended after the save: it starts when the
 *                                  suspension ends (`fresh` = a new 30-day one)
 *   { kind: 'approval' }           pending: it starts at approval
 *   { kind: 'revoked' }            banned: the save revokes Founding
 */
export function foundingWindowOutcome(creator, resultingStatus, now = Date.now()) {
  const sinceMs = Date.parse(creator?.foundingSince || '');
  if (Number.isFinite(sinceMs) && sinceMs <= now) return { kind: 'started' };
  const status = resultingStatus || effectiveCreatorStatus(creator) || 'active';
  if (status === 'banned') return { kind: 'revoked' };
  if (status === 'pending') return { kind: 'approval' };
  if (status === 'suspended') {
    // An existing suspension keeps its own end date across the save; a new
    // one (or one whose date already passed) runs 30 days from now.
    const keep = effectiveCreatorStatus(creator) === 'suspended' ? Date.parse(creator?.suspendedUntil || '') : NaN;
    if (Number.isFinite(keep) && keep > now) return { kind: 'at', at: keep, fresh: false };
    return { kind: 'at', at: now + SUSPENSION_MS, fresh: true };
  }
  return { kind: 'now' };
}
