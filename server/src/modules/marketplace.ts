import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { money, lockBalance, post, InsufficientFunds, isVip, postPlatformRevenue } from '../core/ledger.js';
import { PLATFORM_FEE_BPS, LISTING_FEE_BPS, MARKETPLACE_TOS_VERSION as CURRENT_TOS_VERSION, PHYSICAL_SALES_ENABLED } from '../core/marketplace-fees.js';
import { placeBid, cancelAuction, statusCode, hasDeliverable } from '../core/auctions.js';
import { OPERATING_CREATOR_USER_WHERE, creatorMayBePaidById } from '../core/creator-standing.js';
import { page } from '../plugins/pagination.js';
// InsufficientFunds bubbles up to index.ts's global error handler (-> 402), same as every other charge path.

// Physical orders pay the creator at purchase time, same as digital -- no
// escrow. Shipping method, signature-on-delivery, item condition, and any
// buyer dispute over any of that are the creator's own business, not the
// platform's to hold money hostage over or adjudicate. shipStatus below is
// for buyer/creator visibility only; it never gates a payout. See
// MARKETPLACE_FULFILLMENT.md.

/**
 * Hides a listing inside its VIP first-look window from non-VIPs.
 *
 * Returned as a where-fragment so it can be AND-ed with whatever else the
 * query is doing. Filtered out rather than shown-and-refused: on a
 * one-of-a-kind item, knowing it exists and being unable to buy it is the
 * annoying half of the experience without the perk.
 */
export async function vipFirstLookFilter(viewerId: string | null) {
  if (viewerId && (await isVip(prisma, viewerId))) return {};
  const now = new Date();
  return {
    OR: [
      { vipEarlyUntil: null },
      { vipEarlyUntil: { lte: now } },
      ...(viewerId ? [{ creatorId: viewerId }] : []),
    ],
  };
}

/**
 * The Listing columns anyone may see. An explicit allowlist, never
 * `include`: that returned every scalar, including reserveCents (the
 * creator's HIDDEN minimum -- knowing it defeats it) and currentBidderId (the
 * leading bidder's user id). Both are selected here only so publicListing()
 * can derive the safe booleans from them, and are stripped before returning.
 */
const LISTING_SELECT = {
  id: true, creatorId: true, title: true, description: true, vipEarlyUntil: true, priceCents: true,
  unlimited: true, kind: true, shippingCents: true, signatureRequired: true, images: true, status: true,
  createdAt: true, saleType: true, auctionEndsAt: true, minBidIncrementCents: true, currentBidCents: true,
  reserveCents: true, currentBidderId: true,
  creator: { select: { displayName: true, avatarKey: true, user: { select: { username: true } } } },
} as const;

function publicListing<T extends { creatorId: string; reserveCents: number | null; currentBidderId: string | null; currentBidCents: number | null }>(l: T, viewerId: string | null) {
  const { reserveCents, currentBidderId, ...rest } = l;
  const own = viewerId === l.creatorId;
  return {
    ...rest,
    hasReserve: reserveCents != null,
    reserveMet: reserveCents == null || (l.currentBidCents != null && l.currentBidCents >= reserveCents),
    isLeading: !!viewerId && currentBidderId === viewerId,
    // The creator is the one person who set the reserve; nobody else sees it.
    ...(own ? { reserveCents } : {}),
  };
}

/**
 * A listing is listed and sellable only while its seller may be paid: not
 * suspended or banned AND still approved (KYC, and the site's approval for a
 * bridged creator) -- core/creator-standing.ts. Checking status alone kept a
 * creator whose approval was withdrawn selling by direct link after
 * discovery had already hidden them.
 */
const activeSeller = { creator: { user: OPERATING_CREATOR_USER_WHERE } };

/**
 * A DIGITAL listing's product IS its media (core/access.ts canViewListing),
 * so it is listed only once at least one attached item is READY. Physical
 * items ship; their media is optional.
 */
const deliverable = { OR: [{ kind: 'PHYSICAL' as const }, { media: { some: { status: 'READY' as const } } }] };

async function optionalViewer(req: any): Promise<string | null> {
  try { await req.jwtVerify(); return req.user.id; } catch { return null; }
}

function physicalDisabled() {
  return statusCode('physical_sales_disabled', 400);
}

export const marketplace: FastifyPluginAsync = async (app) => {
  // unlimited: true for digital goods (images/videos) sellable to many buyers
  // at whatever price the creator sets; false (default) for a one-of-a-kind
  // item that flips to SOLD after the first purchase.
  app.post('/listings', { preHandler: app.creatorOk }, async (req) => {
    const b = z.object({
      title: z.string().min(1).max(120), description: z.string().max(4000).default(''),
      priceCents: z.number().int().min(100).max(100_000_00), images: z.array(z.string()).max(10).default([]),
      unlimited: z.boolean().default(false), mediaIds: z.array(z.string().uuid()).max(20).default([]),
      kind: z.enum(['DIGITAL', 'PHYSICAL']).default('DIGITAL'), shippingCents: z.number().int().min(0).max(100_000_00).default(0),
      signatureRequired: z.boolean().default(false),
      // Hours this listing is VIP-only before everyone else sees it. Capped
      // at 72, same as posts -- past that it stops being a head start and
      // becomes a second gate on something already for sale.
      earlyAccessHours: z.number().int().min(0).max(72).default(0),
      saleType: z.enum(['FIXED', 'AUCTION']).default('FIXED'),
      auctionDurationHours: z.number().int().min(1).max(24 * 30).optional(), // required for AUCTION: 1 hour to 30 days
      minBidIncrementCents: z.number().int().min(1).max(100_000_00).optional(),
      reserveCents: z.number().int().min(100).max(100_000_00).optional(),
    }).parse(req.body);
    const { mediaIds, auctionDurationHours, earlyAccessHours, ...fields } = b;
    if (fields.kind === 'PHYSICAL' && !PHYSICAL_SALES_ENABLED) throw physicalDisabled();
    if (earlyAccessHours) (fields as any).vipEarlyUntil = new Date(Date.now() + earlyAccessHours * 3_600_000);
    // Physical items ship one-at-a-time -- no inventory tracking yet, so "unlimited" doesn't mean anything for them.
    // An auction is one-of-a-kind by nature (bidding on "one of infinite copies" doesn't mean anything either).
    if (fields.kind === 'PHYSICAL' || fields.saleType === 'AUCTION') fields.unlimited = false;
    if (fields.saleType === 'AUCTION') {
      if (!auctionDurationHours) throw Object.assign(new Error('auctionDurationHours is required for an auction listing'), { statusCode: 400 });
      if (fields.reserveCents != null && fields.reserveCents < fields.priceCents) {
        throw Object.assign(new Error('reserveCents cannot be below the starting bid (priceCents)'), { statusCode: 400 });
      }
      (fields as any).auctionEndsAt = new Date(Date.now() + auctionDurationHours * 3_600_000);
    }
    // A DIGITAL listing's media is what the buyer gets. There is no route
    // that attaches media to a listing later, so one created without any
    // could only ever be sold as nothing.
    if (fields.kind === 'DIGITAL' && !mediaIds.length) throw Object.assign(new Error('digital_listing_needs_media'), { statusCode: 400 });
    if (new Set(mediaIds).size !== mediaIds.length) throw Object.assign(new Error('bad_media'), { statusCode: 400 });
    return prisma.$transaction(async (tx) => {
      const l = await tx.listing.create({ data: { creatorId: req.user.id, ...fields } });
      if (mediaIds.length) {
        // Unattached originals that can still become viewable (still
        // uploading/processing is fine -- the listing is not listed or
        // sellable until one is READY). Never a broadcast copy.
        const r = await tx.media.updateMany({ where: { id: { in: mediaIds }, ownerId: req.user.id, postId: null, messageId: null, listingId: null, sourceMediaId: null, status: { not: 'REJECTED' } }, data: { listingId: l.id } });
        if (r.count !== mediaIds.length) throw Object.assign(new Error('bad_media'), { statusCode: 400 });
      }
      return tx.listing.findUnique({ where: { id: l.id }, include: { media: { select: { id: true, mime: true, previewKey: true } } } });
    });
  });

  app.patch('/listings/:id', { preHandler: app.creatorOk }, async (req: any, reply) => {
    const b = z.object({
      title: z.string().min(1).max(120).optional(), description: z.string().max(4000).optional(),
      priceCents: z.number().int().min(100).max(100_000_00).optional(), images: z.array(z.string()).max(10).optional(),
      status: z.enum(['ACTIVE', 'REMOVED']).optional(), unlimited: z.boolean().optional(),
      kind: z.enum(['DIGITAL', 'PHYSICAL']).optional(), shippingCents: z.number().int().min(0).max(100_000_00).optional(),
      signatureRequired: z.boolean().optional(),
    }).parse(req.body);
    if (b.kind === 'PHYSICAL' && !PHYSICAL_SALES_ENABLED) throw physicalDisabled();
    if (b.kind === 'PHYSICAL') b.unlimited = false;

    const r = await money(prisma, async (tx) => {
      const l = await tx.listing.findFirst({ where: { id: req.params.id, creatorId: req.user.id, status: { not: 'SOLD' } } });
      if (!l) return null;
      if (l.saleType === 'AUCTION') {
        // The money terms of an auction are fixed once anyone has bid: the
        // leader's hold was sized from them (bid + shipping), and letting
        // them move afterwards is how a creator used to set shipping to
        // $100k on an auction with a $1 bid and be paid it at close.
        const moneyTerms = b.priceCents !== undefined || b.kind !== undefined || b.shippingCents !== undefined || b.unlimited !== undefined;
        if (moneyTerms && l.currentBidderId) throw statusCode('auction_has_bids', 409);
        if (b.unlimited) throw statusCode('auction_is_one_of_a_kind', 400);
        if (b.status === 'ACTIVE' && l.status !== 'ACTIVE' && (!l.auctionEndsAt || l.auctionEndsAt <= new Date())) {
          // Reactivating an ended auction would let the close sweep sell it
          // against whatever bid state it was left in.
          throw statusCode('auction_ended', 400);
        }
        if (b.status === 'REMOVED' && l.status === 'ACTIVE') {
          // Same transaction as the removal: the leader gets their hold back.
          const { status: _s, ...rest } = b;
          if (Object.keys(rest).length) await tx.listing.update({ where: { id: l.id }, data: rest });
          await cancelAuction(tx, l.id, 'removed_by_creator');
          return l.id;
        }
      }
      await tx.listing.update({ where: { id: l.id }, data: b });
      return l.id;
    });
    return r ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  // Age-gated: the platform account itself is already 18+ only (dob check at
  // signup), but the marketplace gets its own explicit confirmation + ToS
  // acceptance on top, recorded per order for an audit trail.
  app.get('/listings', async (req: any) => {
    const q = z.string().trim().max(60).optional().parse(req.query.q || undefined);
    // page() refuses a negative/NaN limit (Prisma reads a negative take as
    // "the last N rows", which bypassed the 100-row cap entirely).
    const { limit: take } = page(req.query);
    // Optional auth: browsing works signed out, but a VIP has to be
    // recognised or their first-look window is worthless.
    const viewerId = await optionalViewer(req);
    // AND, not a second OR key -- spreading another `OR` would silently
    // replace the search one and return everything.
    const conditions: any[] = [await vipFirstLookFilter(viewerId), activeSeller, deliverable].filter((c) => Object.keys(c).length);
    if (q) conditions.push({ OR: [{ title: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] });
    const rows = await prisma.listing.findMany({
      where: {
        status: 'ACTIVE',
        ...(conditions.length ? { AND: conditions } : {}),
      },
      orderBy: { createdAt: 'desc' }, take, skip: page(req.query).offset,
      select: LISTING_SELECT,
    });
    return rows.map((l) => publicListing(l, viewerId));
  });

  // Media never exposes its raw key here -- full access (once purchased) goes
  // through GET /media/:id/url, which re-checks ownership via canViewListing.
  //
  // Same visibility as the list: a listing inside its VIP first-look window,
  // or one whose seller may not currently sell (suspended, banned, or no
  // longer approved), is not found for anyone but its creator -- an id is
  // shareable, so filtering only the list is not a gate. The one exception
  // is someone who already BOUGHT it: while the seller is not suspended or
  // banned (core/access.ts canViewListing, the serving rule) a buyer keeps
  // the page of what they paid for.
  app.get('/listings/:id', async (req: any, reply) => {
    const viewerId = await optionalViewer(req);
    const vip = await vipFirstLookFilter(viewerId);
    const l = await prisma.listing.findFirst({
      where: {
        id: req.params.id,
        ...(viewerId
          ? { OR: [
            { creatorId: viewerId },
            { AND: [vip, activeSeller] },
            { AND: [{ creator: { user: { status: 'ACTIVE' as const } } }, { orders: { some: { buyerId: viewerId } } }] },
          ] }
          : { AND: [vip, activeSeller] }),
      },
      select: { ...LISTING_SELECT, media: { select: { id: true, mime: true, previewKey: true } } },
    });
    return l ? publicListing(l, viewerId) : reply.code(404).send({ error: 'not_found' });
  });

  app.get('/listings/mine', { preHandler: app.creatorOk }, async (req) =>
    prisma.listing.findMany({ where: { creatorId: req.user.id }, orderBy: { createdAt: 'desc' } }));

  app.post('/listings/:id/buy', { preHandler: app.auth }, async (req: any) => {
    const { expectedTotalCents } = z.object({
      ageConfirmed: z.literal(true), tosAccepted: z.literal(true),
      // The total (price + shipping) the buyer saw and agreed to. Charged
      // only if it still matches -- otherwise a creator editing the price or
      // shipping between the fan opening the listing and clicking Buy was
      // charged in full, with no refunds.
      expectedTotalCents: z.number().int().min(0),
    }).parse(req.body);

    return money(prisma, async (tx) => {
      const l = await tx.listing.findUniqueOrThrow({ where: { id: req.params.id } });
      if (l.status !== 'ACTIVE') throw Object.assign(new Error('not_available'), { statusCode: 400 });
      // Hiding it from the list is presentation; this is the actual gate. A
      // listing id is guessable and shareable, so without this a non-VIP who
      // has one buys straight through the window.
      if (l.vipEarlyUntil && l.vipEarlyUntil > new Date() && l.creatorId !== req.user.id && !(await isVip(tx, req.user.id))) {
        throw Object.assign(new Error('vip_early_access'), { statusCode: 403 });
      }
      if (l.saleType === 'AUCTION') throw Object.assign(new Error('auction_listing_use_bid'), { statusCode: 400 });
      if (l.creatorId === req.user.id) throw Object.assign(new Error('self_purchase'), { statusCode: 400 });
      if (l.kind === 'PHYSICAL' && !PHYSICAL_SALES_ENABLED) throw physicalDisabled();
      // A seller who may not currently be paid (suspended, banned, or no
      // longer approved) is hidden from browsing; this is the gate for anyone
      // still holding the id.
      if (!(await creatorMayBePaidById(tx, l.creatorId))) throw Object.assign(new Error('not_available'), { statusCode: 400 });
      // Nothing to deliver, nothing to sell: a DIGITAL listing's product is
      // its media, and with none READY the buyer would be charged for an
      // empty item (fans get no refunds).
      if (!(await hasDeliverable(tx, l))) throw Object.assign(new Error('no_deliverable'), { statusCode: 409 });

      if (l.unlimited) {
        const already = await tx.listingOrder.findFirst({ where: { listingId: l.id, buyerId: req.user.id } });
        if (already) return { ok: true, already: true, order: already };
      }

      // Nothing discounts a marketplace purchase -- not a subscription, not
      // a token-lock, not VIP. The platform keeps a flat cut (2026-09-18).
      const chargeCents = l.priceCents;
      const shippingCents = l.kind === 'PHYSICAL' ? l.shippingCents : 0;
      const totalCharge = chargeCents + shippingCents;
      if (totalCharge !== expectedTotalCents) {
        throw Object.assign(new Error('price_changed'), { statusCode: 409 });
      }

      const bal = await lockBalance(tx, req.user.id);
      if (bal < BigInt(totalCharge)) throw new InsufficientFunds();

      const platformFee = Math.floor((chargeCents * PLATFORM_FEE_BPS) / 10_000);
      const listingFee = Math.floor((chargeCents * LISTING_FEE_BPS) / 10_000);
      const net = chargeCents - platformFee - listingFee;

      if (!l.unlimited) {
        const updated = await tx.listing.updateMany({ where: { id: l.id, status: 'ACTIVE' }, data: { status: 'SOLD' } });
        if (!updated.count) throw Object.assign(new Error('not_available'), { statusCode: 400 });
      }

      const isPhysical = l.kind === 'PHYSICAL';
      const order = await tx.listingOrder.create({
        data: {
          listingId: l.id, buyerId: req.user.id, priceCents: chargeCents, shippingCents,
          platformFeeCents: platformFee, listingFeeCents: listingFee,
          ageConfirmedAt: new Date(), tosVersion: CURRENT_TOS_VERSION,
          shipStatus: isPhysical ? 'AWAITING_SHIPMENT' : 'DIGITAL',
        },
      });

      await post(tx, req.user.id, -totalCharge, 'MARKETPLACE_SALE', order.id);
      // Paid immediately -- shipping it is the creator's job from here, not the platform's to hold money over.
      await post(tx, l.creatorId, net + shippingCents, 'MARKETPLACE_SALE', order.id, { gross: chargeCents, platformFee, listingFee, shippingCents, originalPriceCents: l.priceCents, fanId: req.user.id }, 'CREDITS', { earned: true });
      await postPlatformRevenue(tx, platformFee + listingFee, order.id, { source: 'marketplace', platformFee, listingFee });

      return { ok: true, order };
    });
  });

  // --- Auctions (see core/auctions.ts) ---

  app.post('/listings/:id/bid', { preHandler: app.auth }, async (req: any) => {
    // Same explicit 18+ confirmation and ToS acceptance as a fixed-price buy:
    // a winning bid becomes an order, and the order's audit record is the one
    // given here (core/auctions.ts closeAuction), not one made up at close.
    const { amountCents } = z.object({
      amountCents: z.number().int().min(1),
      ageConfirmed: z.literal(true), tosAccepted: z.literal(true),
    }).parse(req.body);
    if (!PHYSICAL_SALES_ENABLED) {
      const l = await prisma.listing.findUnique({ where: { id: req.params.id }, select: { kind: true } });
      if (l?.kind === 'PHYSICAL') throw physicalDisabled();
    }
    const bid = await money(prisma, (tx) => placeBid(tx, req.params.id, req.user.id, amountCents, { ageConfirmedAt: new Date(), tosVersion: CURRENT_TOS_VERSION }));
    return { ok: true, bid };
  });

  // Bid history, without outing bidders. Tying a username to a bid on an
  // adult-marketplace item publicly is the same exposure getTopSupporters()
  // refuses to create, so the public sees stable per-listing labels
  // ("Bidder 1" = the first distinct person to bid), the requester sees
  // which bids are theirs, and only the listing's creator sees usernames.
  app.get('/listings/:id/bids', async (req: any, reply) => {
    const viewerId = await optionalViewer(req);
    // Same visibility as GET /listings/:id: the bid history must not confirm
    // a listing still inside its VIP first-look window, or one whose seller
    // is suspended or banned, to anyone but its creator.
    const vip = await vipFirstLookFilter(viewerId);
    const l = await prisma.listing.findFirst({
      where: {
        id: req.params.id,
        ...(viewerId ? { OR: [{ creatorId: viewerId }, { AND: [vip, activeSeller] }] } : { AND: [vip, activeSeller] }),
      },
      select: { creatorId: true },
    });
    if (!l) return reply.code(404).send({ error: 'not_found' });
    const all = await prisma.bid.findMany({
      where: { listingId: req.params.id }, orderBy: { createdAt: 'asc' },
      select: { id: true, bidderId: true, amountCents: true, createdAt: true, bidder: { select: { username: true } } },
    });
    const label = new Map<string, number>();
    for (const b of all) if (!label.has(b.bidderId)) label.set(b.bidderId, label.size + 1);
    const isCreator = viewerId === l.creatorId;
    return [...all].sort((a, b) => b.amountCents - a.amountCents).slice(0, 20).map((b) => ({
      id: b.id, amountCents: b.amountCents, createdAt: b.createdAt,
      bidder: isCreator ? b.bidder.username : `Bidder ${label.get(b.bidderId)}`,
      isYou: !!viewerId && b.bidderId === viewerId,
    }));
  });

  // --- Physical-order shipping status (visibility only -- see comment above) ---

  app.get('/listings/orders/mine', { preHandler: app.auth }, async (req: any) =>
    prisma.listingOrder.findMany({ where: { buyerId: req.user.id }, orderBy: { createdAt: 'desc' }, include: { listing: { select: { title: true, kind: true, signatureRequired: true } } } }));

  app.get('/listings/orders/selling', { preHandler: app.creatorOk }, async (req) =>
    prisma.listingOrder.findMany({
      where: { listing: { creatorId: req.user.id }, shipStatus: 'AWAITING_SHIPMENT' },
      orderBy: { createdAt: 'asc' },
      include: { listing: { select: { title: true, signatureRequired: true } }, buyer: { select: { username: true } } },
    }));

  app.post('/listings/orders/:id/ship', { preHandler: app.creatorOk }, async (req: any, reply) => {
    const { carrier, trackingNumber } = z.object({ carrier: z.string().min(1).max(100), trackingNumber: z.string().min(1).max(100) }).parse(req.body);
    const r = await prisma.listingOrder.updateMany({
      where: { id: req.params.id, listing: { creatorId: req.user.id }, shipStatus: 'AWAITING_SHIPMENT' },
      data: { shipStatus: 'SHIPPED', carrier, trackingNumber, shippedAt: new Date() },
    });
    return r.count ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });
};
