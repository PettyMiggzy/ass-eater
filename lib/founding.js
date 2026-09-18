/**
 * The Founding Creator programme -- "first 100 creators" launch offer.
 *
 * All of its rules live here so the cap and the window cannot drift apart
 * across the pages that show them. Pure functions, no storage import, so
 * client components can use it too.
 *
 * WHAT IS AND ISN'T ENFORCEABLE TODAY, because this matters for what the
 * recruitment page is allowed to promise:
 *
 *  - The badge, the 100-slot cap and priority placement are real right now.
 *    They are decided here and applied by the pages that sort creators.
 *  - "0% platform fee for 30 days" is recorded here (foundingSince ->
 *    feeWaiverActive) but there is nothing to waive yet: this site takes no
 *    fee because it processes no payments. The 10% fee lives in server/'s
 *    ledger, which is not deployed. When it is, charge() must consult
 *    feeWaiverActive() -- until then the promise is honoured trivially, by
 *    there being no fee at all.
 *  - Crypto payouts are already how this works: wallet to wallet, no
 *    platform balance.
 */

export const FOUNDING_LIMIT = 100;
export const FEE_WAIVER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isFoundingCreator(creator) {
  return !!creator?.founding;
}

/** How many of the 100 slots are gone. */
export function countFounding(creators) {
  return (creators || []).filter(isFoundingCreator).length;
}

export function foundingSlotsLeft(creators) {
  return Math.max(0, FOUNDING_LIMIT - countFounding(creators));
}

export function foundingProgrammeOpen(creators) {
  return foundingSlotsLeft(creators) > 0;
}

/**
 * When the fee-free window is allowed to start counting.
 *
 * This exists because of a real trap in the offer. "0% platform fee for
 * your first 30 days" measured from the day someone is accepted would burn
 * through while the platform charges nothing anyway -- there is no payment
 * processing yet. A creator who joins today would reach the day payments
 * go live with their entire perk already spent, having never once been
 * charged 0% of anything. That is the offer quietly evaporating, which is
 * worse than not making it.
 *
 * So the clock starts at the LATER of: the day they were accepted, and the
 * day the platform can actually take a fee. Set PAYMENTS_LIVE_AT to an ISO
 * date when that happens; until then every founding creator's 30 days is
 * simply pending, and the recruitment page says so rather than implying a
 * countdown is already running.
 */
export const PAYMENTS_LIVE_AT = null; // e.g. '2026-11-01T00:00:00.000Z'

export function feeWaiverStartsAt(creator) {
  const since = Date.parse(creator?.foundingSince || '');
  if (Number.isNaN(since)) return null;
  const live = PAYMENTS_LIVE_AT ? Date.parse(PAYMENTS_LIVE_AT) : null;
  if (live === null || Number.isNaN(live)) return null; // pending: payments aren't live
  return new Date(Math.max(since, live));
}

/**
 * Is this creator inside their 30-day 0%-fee window right now?
 *
 * False while payments aren't live -- not because the perk is denied, but
 * because there is no fee to waive and the window hasn't started. A
 * founding creator with no `foundingSince` also gets false rather than an
 * unbounded waiver: failing closed on a money question.
 */
export function feeWaiverActive(creator, now = Date.now()) {
  if (!isFoundingCreator(creator)) return false;
  const start = feeWaiverStartsAt(creator);
  if (!start) return false;
  return now >= start.getTime() && now < start.getTime() + FEE_WAIVER_DAYS * DAY_MS;
}

export function feeWaiverEndsAt(creator) {
  const start = feeWaiverStartsAt(creator);
  return start ? new Date(start.getTime() + FEE_WAIVER_DAYS * DAY_MS) : null;
}

/** True when the perk is owed but hasn't started counting yet. */
export function feeWaiverPending(creator) {
  return isFoundingCreator(creator) && !feeWaiverStartsAt(creator);
}

/**
 * Placement order for every public creator listing: founding creators
 * first, then trending, then whatever order they arrived in.
 *
 * This is the "priority placement in Explore / Marketplace" perk, and it is
 * a real sort rather than a label -- a perk that only appears in marketing
 * copy is not a perk.
 */
export function byPlacement(a, b) {
  const founding = (isFoundingCreator(b) ? 1 : 0) - (isFoundingCreator(a) ? 1 : 0);
  if (founding !== 0) return founding;
  return (b?.trending === true ? 1 : 0) - (a?.trending === true ? 1 : 0);
}

/** The post a creator shares. Kept here so every surface offers the same text. */
export function creatorShareText(creator, url) {
  const name = creator?.name || 'me';
  return [
    `I'm now on ONLYONE.`,
    `Exclusive content. Marketplace. Direct messages.`,
    ``,
    `Follow ${name} here: ${url}`,
  ].join('\n');
}
