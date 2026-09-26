import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { screenPublicText, rawTagItems } from '../../../lib/prohibited-terms';
import { addViolation } from '../../../lib/violations-store';
import { validateTextFields, refuseMalformedText } from '../../../lib/field-validation';
import { consumeAttempt } from '../../../lib/rate-limit';
import { LISTING_LIMITS, sanitizeTags } from '../../../lib/creator-status';
import { createListing, findCircumventionInTags } from '../../../lib/listings-store';

// No cap of any kind existed here, unlike the gallery's slot limit or the
// rate limits on every other comparable write path (wall posts, DMs,
// marketplace reports) -- a scripted creator account could otherwise create
// listings without bound, each one a DB write and eligible for its own
// media-upload allotment.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_CREATOR = 20;

/**
 * The public-text screen for a marketplace listing, applied identically by
 * create.js and update.js. KEEP IDENTICAL to the copy in update.js -- the two
 * routes must screen listing text the same way.
 *
 * Runs lib/prohibited-terms.js's screenPublicText -- the payment-circumvention
 * filter AND the prohibited-terms list, the same screen a creator's public
 * profile goes through -- over the title, the description, and every tag both
 * exactly as typed and as sanitizeTags() will store it. Only keys present in
 * `fields` are screened, so a partial edit checks only what it writes.
 *
 * Returns null, or { context, reasons, snippet, message } for the first hit:
 * `context` is what the violations queue records ('listing_title',
 * 'listing_description', 'listing_tags'); `message` is safe to show the user.
 */
function screenListingText(fields) {
  if (!fields || typeof fields !== 'object') return null;
  const entries = [];
  for (const key of ['title', 'description']) {
    if (key in fields && typeof fields[key] === 'string' && fields[key]) entries.push([`listing_${key}`, fields[key]]);
  }
  if ('tags' in fields && fields.tags !== undefined && fields.tags !== null) {
    for (const raw of rawTagItems(fields.tags)) entries.push(['listing_tags', raw]);
    for (const tag of sanitizeTags(fields.tags)) entries.push(['listing_tags', tag]);
  }
  for (const [context, value] of entries) {
    const hit = screenPublicText(value);
    if (hit) return { context, reasons: hit.reasons, snippet: value, message: hit.message };
  }
  return null;
}

export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { limited, retryAfterSeconds } = consumeAttempt(`marketplace-create:creator:${ctx.creator.id}`, {
    limit: MAX_PER_CREATOR,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many listings created recently. Please wait a while and try again.' });
  }

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
  if (typeof title !== 'string' || !title.trim() || !Number.isSafeInteger(price) || price < LISTING_LIMITS.minPriceCents) {
    return res.status(400).json({ error: 'Title and a price of at least $1 are required' });
  }
  // An upper bound too: one absurd price set the range of the marketplace's
  // MAX PRICE slider for every visitor and rendered as "$1e+19".
  if (price > LISTING_LIMITS.maxPriceCents) {
    return res.status(400).json({ error: `Price can be at most $${(LISTING_LIMITS.maxPriceCents / 100).toLocaleString()}` });
  }
  const shipping = shippingCents == null ? null : Math.round(Number(shippingCents));
  if (kind === 'physical' && (shipping == null || !Number.isSafeInteger(shipping) || shipping < 0)) {
    return res.status(400).json({ error: 'Physical items need a shipping fee (can be 0 for free shipping)' });
  }
  if (kind === 'physical' && shipping > LISTING_LIMITS.maxShippingCents) {
    return res.status(400).json({ error: `Shipping can be at most $${(LISTING_LIMITS.maxShippingCents / 100).toLocaleString()}` });
  }

  // Title, description and every tag -- each tag both as typed and as it will
  // be stored -- go through the same screen as a creator's public profile:
  // payment circumvention AND the prohibited-terms list. All of it renders
  // publicly (every card, /search, the sidebar tag cloud); only the payment
  // half used to be checked, so a prohibited term typed as a title or tag went
  // straight out.
  const hit = screenListingText({ title, description, tags });
  if (hit) {
    await addViolation({ userId: ctx.user.id, context: hit.context, reasons: hit.reasons, snippet: hit.snippet });
    return res.status(400).json({ error: hit.message });
  }
  // Tags are also checked JOINED, so a handle or phone number split across two
  // tags ("venmo", "@janedoe") is caught the same as in a title -- and so is
  // a prohibited phrase split across two ("barely", "legal").
  const tagHit = findCircumventionInTags(tags);
  if (tagHit) {
    await addViolation({ userId: ctx.user.id, context: 'listing_tags', reasons: tagHit.reasons, snippet: tagHit.snippet });
    return res.status(400).json({ error: tagHit.message || PAYMENT_CIRCUMVENTION_MESSAGE });
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
