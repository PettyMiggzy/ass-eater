import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { money, lockBalance, post, PLATFORM_ID, InsufficientFunds } from '../core/ledger';
import { PLATFORM_FEE_BPS, LISTING_FEE_BPS, MARKETPLACE_TOS_VERSION as CURRENT_TOS_VERSION } from '../core/marketplace-fees';
import { placeBid } from '../core/auctions';
// InsufficientFunds bubbles up to index.ts's global error handler (-> 402), same as every other charge path.

// Physical orders pay the creator at purchase time, same as digital -- no
// escrow. Shipping method, signature-on-delivery, item condition, and any
// buyer dispute over any of that are the creator's own business, not the
// platform's to hold money hostage over or adjudicate. shipStatus below is
// for buyer/creator visibility only; it never gates a payout. See
// MARKETPLACE_FULFILLMENT.md.

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
      saleType: z.enum(['FIXED', 'AUCTION']).default('FIXED'),
      auctionDurationHours: z.number().int().min(1).max(24 * 30).optional(), // required for AUCTION: 1 hour to 30 days
      minBidIncrementCents: z.number().int().min(1).max(100_000_00).optional(),
      reserveCents: z.number().int().min(100).max(100_000_00).optional(),
    }).parse(req.body);
    const { mediaIds, auctionDurationHours, ...fields } = b;
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
    return prisma.$transaction(async (tx) => {
      const l = await tx.listing.create({ data: { creatorId: req.user.id, ...fields } });
      if (mediaIds.length) {
        const r = await tx.media.updateMany({ where: { id: { in: mediaIds }, ownerId: req.user.id, postId: null, messageId: null, listingId: null }, data: { listingId: l.id } });
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
    if (b.kind === 'PHYSICAL') b.unlimited = false;
    const r = await prisma.listing.updateMany({ where: { id: req.params.id, creatorId: req.user.id, status: { not: 'SOLD' } }, data: b });
    return r.count ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  // Age-gated: the platform account itself is already 18+ only (dob check at
  // signup), but the marketplace gets its own explicit confirmation + ToS
  // acceptance on top, recorded per order for an audit trail.
  app.get('/listings', async (req: any) => {
    const q = z.string().trim().max(60).optional().parse(req.query.q || undefined);
    const take = Math.min(Number(req.query.limit ?? 30), 100);
    return prisma.listing.findMany({
      where: {
        status: 'ACTIVE',
        ...(q ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { createdAt: 'desc' }, take, skip: Number(req.query.offset ?? 0),
      include: { creator: { select: { displayName: true, avatarKey: true, user: { select: { username: true } } } } },
    });
  });

  // Media never exposes its raw key here -- full access (once purchased) goes
  // through GET /media/:id/url, which re-checks ownership via canViewListing.
  app.get('/listings/:id', async (req: any, reply) => {
    const l = await prisma.listing.findUnique({
      where: { id: req.params.id },
      include: {
        creator: { select: { displayName: true, avatarKey: true, user: { select: { username: true } } } },
        media: { select: { id: true, mime: true, previewKey: true } },
      },
    });
    return l ?? reply.code(404).send({ error: 'not_found' });
  });

  app.get('/listings/mine', { preHandler: app.creatorOk }, async (req) =>
    prisma.listing.findMany({ where: { creatorId: req.user.id }, orderBy: { createdAt: 'desc' } }));

  app.post('/listings/:id/buy', { preHandler: app.auth }, async (req: any) => {
    const { payAsset } = z.object({
      ageConfirmed: z.literal(true), tosAccepted: z.literal(true), payAsset: z.enum(['USD', 'ONLYASS']).default('USD'),
    }).parse(req.body);

    return money(prisma, async (tx) => {
      const l = await tx.listing.findUniqueOrThrow({ where: { id: req.params.id } });
      if (l.status !== 'ACTIVE') throw Object.assign(new Error('not_available'), { statusCode: 400 });
      if (l.saleType === 'AUCTION') throw Object.assign(new Error('auction_listing_use_bid'), { statusCode: 400 });
      if (l.creatorId === req.user.id) throw Object.assign(new Error('self_purchase'), { statusCode: 400 });

      if (l.unlimited) {
        const already = await tx.listingOrder.findFirst({ where: { listingId: l.id, buyerId: req.user.id } });
        if (already) return { ok: true, already: true, order: already };
      }

      // No buyer-side discount here -- a subscription, a token-lock, or
      // paying in $ONLYASS no longer discount anything on their own.
      // Staking is meant to be the only fan-facing discount; see
      // MEMORY.md's "Fee structure & discounts" section for the decision.
      const chargeCents = l.priceCents;
      const shippingCents = l.kind === 'PHYSICAL' ? l.shippingCents : 0;
      const totalCharge = chargeCents + shippingCents;

      const bal = await lockBalance(tx, req.user.id, payAsset);
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

      await post(tx, req.user.id, -totalCharge, 'MARKETPLACE_SALE', order.id, undefined, payAsset);
      // Paid immediately -- shipping it is the creator's job from here, not the platform's to hold money over.
      await post(tx, l.creatorId, net + shippingCents, 'MARKETPLACE_SALE', order.id, { gross: chargeCents, platformFee, listingFee, shippingCents, originalPriceCents: l.priceCents, payAsset });
      await post(tx, PLATFORM_ID, platformFee + listingFee, 'PLATFORM_FEE', order.id, { source: 'marketplace', platformFee, listingFee });

      return { ok: true, order, payAsset };
    });
  });

  // --- Auctions (see core/auctions.ts) ---

  app.post('/listings/:id/bid', { preHandler: app.auth }, async (req: any) => {
    const { amountCents } = z.object({ amountCents: z.number().int().min(1) }).parse(req.body);
    const bid = await money(prisma, (tx) => placeBid(tx, req.params.id, req.user.id, amountCents));
    return { ok: true, bid };
  });

  app.get('/listings/:id/bids', async (req: any) =>
    prisma.bid.findMany({
      where: { listingId: req.params.id },
      orderBy: { amountCents: 'desc' },
      take: 20,
      include: { bidder: { select: { username: true } } },
    }));

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
