import { post, ESCROW_ID, PLATFORM_ID, type Tx } from './ledger';

// Shipping and item condition are the creator's responsibility, full stop --
// this module is about who holds the MONEY in the meantime, not who ships.
// A physical order's creator payout sits in the ESCROW_ID pseudo-account
// (never the creator's own balance) from purchase until one of:
//   - the buyer confirms receipt (confirmReceipt) -- released immediately
//   - MARKETPLACE_AUTO_RELEASE_DAYS pass after shipping with no dispute
//     (see workers/escrow-auto-release.ts) -- released automatically
//   - an admin resolves a dispute (resolveDispute) -- released or refunded
// This is the same shape as eBay/Amazon marketplace buyer protection: the
// platform is a payment intermediary holding funds pending delivery, not the
// seller of record, which is the actual liability-shifting mechanism here --
// ToS wording alone doesn't do this, an escrow flow that a court/chargeback
// review can point to is what backs it up.

export function statusCode(err: string, code: number) {
  return Object.assign(new Error(err), { statusCode: code });
}

export const AUTO_RELEASE_DAYS = Number(process.env.MARKETPLACE_AUTO_RELEASE_DAYS ?? 14);

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

/** Auto-release worker calls this once the clock runs out with no dispute -- same effect as buyer confirmation. */
export async function autoRelease(tx: Tx, orderId: string) {
  return releaseEscrow(tx, orderId, 'AUTO_RELEASED');
}

/**
 * Buyer disputes -- freezes the clock (an order can't be auto-released
 * mid-dispute) and files a Report so it lands in the admin's existing
 * /admin/reports queue rather than needing a second resolution UI.
 */
export async function disputeOrder(tx: Tx, orderId: string, buyerId: string, reason: string) {
  const order = await tx.listingOrder.findFirst({ where: { id: orderId, buyerId } });
  if (!order) throw statusCode('not_found', 404);
  if (order.fulfillmentStatus !== 'SHIPPED') throw statusCode('wrong_status', 400);
  await tx.report.create({ data: { reporterId: buyerId, targetType: 'listing_order', targetId: orderId, reason } });
  return tx.listingOrder.update({ where: { id: orderId }, data: { fulfillmentStatus: 'DISPUTED', disputedAt: new Date() } });
}

/**
 * Admin resolves a dispute. 'release' sides with the creator (buyer's claim
 * rejected) -- same money movement as delivery confirmation. 'refund' sides
 * with the buyer: they get everything back (price + shipping), and the
 * platform claws back its own fee too -- a sale that didn't happen shouldn't
 * leave the platform still holding a cut of it.
 */
export async function resolveDispute(tx: Tx, orderId: string, resolution: 'release' | 'refund') {
  const order = await tx.listingOrder.findUniqueOrThrow({ where: { id: orderId } });
  if (order.fulfillmentStatus !== 'DISPUTED') throw statusCode('wrong_status', 400);

  if (resolution === 'release') return releaseEscrow(tx, orderId, 'DELIVERED_CONFIRMED');

  await post(tx, ESCROW_ID, -order.netCentsHeld, 'REFUND', orderId, { refunded: true });
  await post(tx, PLATFORM_ID, -(order.platformFeeCents + order.listingFeeCents), 'REFUND', orderId, { refunded: true });
  await post(tx, order.buyerId, order.priceCents + order.shippingCents, 'REFUND', orderId, { refunded: true });
  return tx.listingOrder.update({ where: { id: orderId }, data: { fulfillmentStatus: 'REFUNDED', netCentsHeld: 0 } });
}
