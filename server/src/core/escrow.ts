import { post, ESCROW_ID, PLATFORM_ID, type Tx } from './ledger';

// Shipping and item condition are the creator's responsibility, full stop --
// this module is about who holds the MONEY in the meantime, not who ships.
// A physical order's creator payout sits in the ESCROW_ID pseudo-account
// (never the creator's own balance) from purchase until one of:
//   - the buyer confirms receipt (confirmReceipt) -- released immediately
//   - AUTO_RELEASE_DAYS pass after shipping with no dispute (short --
//     see below) -- released automatically
//   - a disputed order's grace period passes with no resolution -- released
//     automatically, same as the above (silence favors whoever already
//     performed -- the creator shipped, the buyer didn't act)
//   - the creator voluntarily refunds (voluntaryRefund) -- their call, no
//     platform sign-off needed, any time before release
//   - an admin steps in (resolveDispute) -- a manual override for the rare
//     case that actually needs it (fraud pattern, chargeback, legal), NOT
//     the default path for an ordinary "buyer says it never arrived"
// The platform deliberately never adjudicates "who's telling the truth" by
// default -- that's real liability for zero benefit, since the platform has
// no better evidence than either party does. A dispute just pauses the timer
// so buyer and creator can work it out directly (they already have Inbox
// messaging for this); if they don't, the clock still runs out and the
// creator gets paid, because they're the one who already delivered on their
// half of the deal and unproven claims shouldn't freeze that indefinitely.
// This is still the eBay/Amazon-style liability shift -- the platform is a
// payment intermediary holding funds pending delivery, not the seller of
// record -- just without the platform pretending it can referee reality.

export function statusCode(err: string, code: number) {
  return Object.assign(new Error(err), { statusCode: code });
}

export const AUTO_RELEASE_DAYS = Number(process.env.MARKETPLACE_AUTO_RELEASE_DAYS ?? 5); // most domestic shipping arrives well inside this
export const DISPUTE_GRACE_DAYS = Number(process.env.MARKETPLACE_DISPUTE_GRACE_DAYS ?? 5); // extra time a dispute buys to talk it out, not a freeze

/** Called at purchase time for a physical order: the creator's net proceeds (+ shipping) go into escrow, not their own balance. */
export async function holdInEscrow(tx: Tx, orderId: string, netCentsHeld: number) {
  await post(tx, ESCROW_ID, netCentsHeld, 'MARKETPLACE_SALE', orderId, { held: true });
}

/** Creator marks a physical order shipped. Starts the auto-release clock; doesn't touch money. */
export async function markShipped(tx: Tx, orderId: string, creatorId: string, info: { carrier: string; trackingNumber: string }) {
  const order = await tx.listingOrder.findFirst({ where: { id: orderId, listing: { creatorId } } });
  if (!order) throw statusCode('not_found', 404);
  if (order.fulfillmentStatus !== 'AWAITING_SHIPMENT') throw statusCode('wrong_status', 400);

  const autoReleaseAt = new Date(Date.now() + AUTO_RELEASE_DAYS * 86_400_000);
  return tx.listingOrder.update({
    where: { id: orderId },
    data: { fulfillmentStatus: 'SHIPPED', carrier: info.carrier, trackingNumber: info.trackingNumber, shippedAt: new Date(), autoReleaseAt },
  });
}

async function releaseEscrow(tx: Tx, orderId: string, resolvedStatus: 'DELIVERED_CONFIRMED' | 'AUTO_RELEASED') {
  const order = await tx.listingOrder.findUniqueOrThrow({ where: { id: orderId }, include: { listing: true } });
  if (!['SHIPPED', 'DISPUTED'].includes(order.fulfillmentStatus)) throw statusCode('wrong_status', 400);
  if (order.netCentsHeld <= 0) throw statusCode('nothing_held', 400);

  await post(tx, ESCROW_ID, -order.netCentsHeld, 'MARKETPLACE_SALE', orderId, { released: true });
  await post(tx, order.listing.creatorId, order.netCentsHeld, 'MARKETPLACE_SALE', orderId, { released: true });

  return tx.listingOrder.update({ where: { id: orderId }, data: { fulfillmentStatus: resolvedStatus, releasedAt: new Date(), netCentsHeld: 0 } });
}

/** Buyer confirms delivery -- releases escrow to the creator right away, doesn't wait for the auto-release window. */
export async function confirmReceipt(tx: Tx, orderId: string, buyerId: string) {
  const order = await tx.listingOrder.findFirst({ where: { id: orderId, buyerId } });
  if (!order) throw statusCode('not_found', 404);
  return releaseEscrow(tx, orderId, 'DELIVERED_CONFIRMED');
}

/** Auto-release worker calls this once a SHIPPED or DISPUTED order's clock runs out unresolved -- same effect as buyer confirmation, sides with the creator by default. */
export async function autoRelease(tx: Tx, orderId: string) {
  return releaseEscrow(tx, orderId, 'AUTO_RELEASED');
}

async function refund(tx: Tx, orderId: string, order: { netCentsHeld: number; platformFeeCents: number; listingFeeCents: number; priceCents: number; shippingCents: number; buyerId: string }) {
  await post(tx, ESCROW_ID, -order.netCentsHeld, 'REFUND', orderId, { refunded: true });
  await post(tx, PLATFORM_ID, -(order.platformFeeCents + order.listingFeeCents), 'REFUND', orderId, { refunded: true });
  await post(tx, order.buyerId, order.priceCents + order.shippingCents, 'REFUND', orderId, { refunded: true });
  return tx.listingOrder.update({ where: { id: orderId }, data: { fulfillmentStatus: 'REFUNDED', netCentsHeld: 0 } });
}

/**
 * Buyer disputes -- doesn't freeze the money or force anyone to adjudicate
 * anything. It buys DISPUTE_GRACE_DAYS more time on the same auto-release
 * clock (so buyer and creator can actually talk -- see the existing Inbox
 * messaging) and logs a Report for visibility, but if neither side acts
 * before the grace period runs out, it still auto-releases to the creator
 * same as an ordinary unresolved shipment. A dispute is a pause button, not
 * a hold-forever button.
 */
export async function disputeOrder(tx: Tx, orderId: string, buyerId: string, reason: string) {
  const order = await tx.listingOrder.findFirst({ where: { id: orderId, buyerId } });
  if (!order) throw statusCode('not_found', 404);
  if (order.fulfillmentStatus !== 'SHIPPED') throw statusCode('wrong_status', 400);
  await tx.report.create({ data: { reporterId: buyerId, targetType: 'listing_order', targetId: orderId, reason } });
  const autoReleaseAt = new Date(Date.now() + DISPUTE_GRACE_DAYS * 86_400_000);
  return tx.listingOrder.update({ where: { id: orderId }, data: { fulfillmentStatus: 'DISPUTED', disputedAt: new Date(), autoReleaseAt } });
}

/** Creator's own call, any time before release -- no dispute or admin sign-off required. If they're convinced (or just don't want the hassle), they can give the money back directly. */
export async function voluntaryRefund(tx: Tx, orderId: string, creatorId: string) {
  const order = await tx.listingOrder.findFirst({ where: { id: orderId, listing: { creatorId } } });
  if (!order) throw statusCode('not_found', 404);
  if (!['AWAITING_SHIPMENT', 'SHIPPED', 'DISPUTED'].includes(order.fulfillmentStatus)) throw statusCode('wrong_status', 400);
  return refund(tx, orderId, order);
}

/**
 * Admin manual override -- NOT the default dispute path (see disputeOrder's
 * comment). Reserved for the rare case that actually needs the platform to
 * step in: a chargeback already filed, a clear fraud pattern, a legal
 * request. 'release' sides with the creator (same as auto-release/
 * confirmation). 'refund' sides with the buyer and claws back the
 * platform's own fee too -- a sale that didn't happen shouldn't leave the
 * platform still holding a cut of it.
 */
export async function resolveDispute(tx: Tx, orderId: string, resolution: 'release' | 'refund') {
  const order = await tx.listingOrder.findUniqueOrThrow({ where: { id: orderId } });
  if (order.fulfillmentStatus !== 'DISPUTED') throw statusCode('wrong_status', 400);

  if (resolution === 'release') return releaseEscrow(tx, orderId, 'DELIVERED_CONFIRMED');
  return refund(tx, orderId, order);
}
