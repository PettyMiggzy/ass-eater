import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { money, lockBalance, post, PLATFORM_ID, InsufficientFunds } from '../core/ledger';
import { holdInEscrow, markShipped, confirmReceipt, disputeOrder, voluntaryRefund } from '../core/escrow';
// InsufficientFunds bubbles up to index.ts's global error handler (-> 402), same as every other charge path.

const PLATFORM_FEE_BPS = 1000; // 10% commission on the sale
const LISTING_FEE_BPS = 500; // 5% listing fee, also cut at sale time
const LOYALTY_DISCOUNT_BPS = 1000; // 10% off for a buyer with any active subscription or token-lock
const CURRENT_TOS_VERSION = 'v1';

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
    }).parse(req.body);
    const { mediaIds, ...fields } = b;
    // Physical items ship one-at-a-time -- no inventory tracking yet, so "unlimited" doesn't mean anything for them.
    if (fields.kind === 'PHYSICAL') fields.unlimited = false;
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
      if (l.creatorId === req.user.id) throw Object.assign(new Error('self_purchase'), { statusCode: 400 });

      if (l.unlimited) {
        const already = await tx.listingOrder.findFirst({ where: { listingId: l.id, buyerId: req.user.id } });
        if (already) return { ok: true, already: true, order: already };
      }

      // Loyalty discount (any active subscription/token-lock) and the
      // pay-in-$ONLYASS discount don't stack -- take whichever's better for
      // the buyer, same 10% rate either way.
      const [hasSub, hasLock] = await Promise.all([
        tx.subscription.findFirst({ where: { fanId: req.user.id, status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } } }),
        tx.tokenLock.findFirst({ where: { fanId: req.user.id, status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } } }),
      ]);
      const discounted = !!(hasSub || hasLock) || payAsset === 'ONLYASS';
      // Discount applies to the item price only -- shipping is a pass-through carrier cost, not a margin to discount.
      const chargeCents = discounted ? Math.round((l.priceCents * (10_000 - LOYALTY_DISCOUNT_BPS)) / 10_000) : l.priceCents;
      const shippingCents = l.kind === 'PHYSICAL' ? l.shippingCents : 0;
      const totalCharge = chargeCents + shippingCents;

      const bal = await lockBalance(tx, req.user.id, payAsset);
      if (bal < BigInt(totalCharge)) throw new InsufficientFunds();

      const platformFee = Math.floor((chargeCents * PLATFORM_FEE_BPS) / 10_000);
      const listingFee = Math.floor((chargeCents * LISTING_FEE_BPS) / 10_000);
      const net = chargeCents - platformFee - listingFee;
      const netCentsHeld = net + shippingCents; // shipping isn't commissioned, but it's still held with the rest until delivery

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
          fulfillmentStatus: isPhysical ? 'AWAITING_SHIPMENT' : 'DIGITAL',
          netCentsHeld: isPhysical ? netCentsHeld : 0,
        },
      });

      await post(tx, req.user.id, -totalCharge, 'MARKETPLACE_SALE', order.id, undefined, payAsset);
      if (isPhysical) {
        // Held, not paid out -- see core/escrow.ts. Released on delivery confirmation, auto-release, or dispute resolution.
        await holdInEscrow(tx, order.id, netCentsHeld);
      } else {
        await post(tx, l.creatorId, net, 'MARKETPLACE_SALE', order.id, { gross: chargeCents, platformFee, listingFee, originalPriceCents: l.priceCents, discountApplied: discounted, payAsset });
      }
      await post(tx, PLATFORM_ID, platformFee + listingFee, 'PLATFORM_FEE', order.id, { source: 'marketplace', platformFee, listingFee });

      return { ok: true, order, discountApplied: discounted, payAsset };
    });
  });

  // --- Physical-order fulfillment lifecycle (escrow-backed -- see core/escrow.ts) ---

  app.get('/listings/orders/mine', { preHandler: app.auth }, async (req: any) =>
    prisma.listingOrder.findMany({ where: { buyerId: req.user.id }, orderBy: { createdAt: 'desc' }, include: { listing: { select: { title: true, kind: true } } } }));

  app.get('/listings/orders/selling', { preHandler: app.creatorOk }, async (req) =>
    prisma.listingOrder.findMany({
      where: { listing: { creatorId: req.user.id }, fulfillmentStatus: { in: ['AWAITING_SHIPMENT', 'SHIPPED', 'DISPUTED'] } },
      orderBy: { createdAt: 'asc' },
      include: { listing: { select: { title: true } }, buyer: { select: { username: true } } },
    }));

  app.post('/listings/orders/:id/ship', { preHandler: app.creatorOk }, async (req: any) => {
    const { carrier, trackingNumber } = z.object({ carrier: z.string().min(1).max(100), trackingNumber: z.string().min(1).max(100) }).parse(req.body);
    return prisma.$transaction((tx) => markShipped(tx, req.params.id, req.user.id, { carrier, trackingNumber }));
  });

  app.post('/listings/orders/:id/confirm-receipt', { preHandler: app.auth }, async (req: any) =>
    prisma.$transaction((tx) => confirmReceipt(tx, req.params.id, req.user.id)));

  app.post('/listings/orders/:id/dispute', { preHandler: app.auth }, async (req: any) => {
    const { reason } = z.object({ reason: z.string().min(1).max(1000) }).parse(req.body);
    return prisma.$transaction((tx) => disputeOrder(tx, req.params.id, req.user.id, reason));
  });

  // Creator's own call, no dispute or admin sign-off needed -- see core/escrow.ts's voluntaryRefund.
  app.post('/listings/orders/:id/refund', { preHandler: app.creatorOk }, async (req: any) =>
    prisma.$transaction((tx) => voluntaryRefund(tx, req.params.id, req.user.id)));
};
