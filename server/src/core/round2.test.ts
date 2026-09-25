import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import crypto, { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { generateMnemonic, english } from 'viem/accounts';
import { money, post, charge, creditDeposit, reserveWithdrawable, PLATFORM_ID, InsufficientFunds } from './ledger';
import { refundPayout, markPayoutSent } from './payouts';
import { subscribeVip } from './vip';
import { canViewMessage, creatorMayOperate } from './access';
import { placeBid, closeAuction, cancelAuction } from './auctions';
import { applyUserStatus } from './moderation';
import { viewerTokenTtlSeconds, checkViewerOnJoin, PAY_GRACE_MS } from './live-sweep';
import { payNextMinute } from './live-billing';
import { uploadQuotaError, maxBytesFor, UPLOAD_LIMITS, createUploadWithinQuota } from './upload-limits';
import { rawToUsdCents } from '../lib/price';
import { isValidMnemonic, xpubFromMnemonic } from '../lib/chain';
import { allocateHedge, hedgeRemaining } from '../workers/treasury-hedge-math';

// Regression tests for the round-2 server fixes: closed-loop withdrawable
// credits, payout refunds, VIP price confirmation, banned senders' DMs,
// auction audit records, site standing over the bridge, live join checks,
// upload quotas, deposit cent math, mnemonic validation and hedge progress.

process.env.BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'test-bridge-secret-' + randomUUID();
const { resolveBridgedUser, verifyBridgeStatusToken, syncSiteStanding } = await import('../lib/bridge');

const prisma = new PrismaClient();

async function makeUser(extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01'), ...extra } });
  return id;
}
async function makeCreator(extra: Record<string, unknown> = {}) {
  const userId = await makeUser({ role: 'CREATOR', kycStatus: 'APPROVED', ...extra });
  await prisma.creatorProfile.create({ data: { userId, displayName: 'C', payoutAddress: '0x000000000000000000000000000000000000dEaD' } });
  return userId;
}
// A DIGITAL listing needs a READY media item to be biddable/sellable (core/auctions.ts hasDeliverable).
const readyMedia = (ownerId: string) => ({ create: { ownerId, key: `raw/${ownerId}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY' as const } });
const acct = async (userId: string) => prisma.account.findUniqueOrThrow({ where: { userId } });
const deposit = (userId: string, cents: number) => money(prisma, (tx) => creditDeposit(tx, userId, BigInt(cents), `dep-${randomUUID()}`));

beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
  await prisma.account.upsert({ where: { userId: PLATFORM_ID }, create: { userId: PLATFORM_ID }, update: {} });
  await prisma.platformConfig.upsert({ where: { id: 1 }, create: { id: 1, vipPriceCents: 2000, burnBps: 2500 }, update: { vipPriceCents: 2000, burnBps: 2500 } });
});
afterAll(async () => { await prisma.$disconnect(); });

describe('closed-loop credits: only earned credits are withdrawable', () => {
  it('a deposit is spendable but never withdrawable; earnings are', async () => {
    const creator = await makeCreator();
    await deposit(creator, 10_000);                       // 9800 credits after the 2% fee
    let a = await acct(creator);
    expect(a.balanceCents).toBe(9800n);
    expect(a.withdrawableCents).toBe(0n);
    await expect(money(prisma, (tx) => reserveWithdrawable(tx, creator, 2000))).rejects.toBeInstanceOf(InsufficientFunds);

    const fan = await makeUser();
    await deposit(fan, 10_000);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 5000, type: 'TIP', refId: randomUUID() }));
    a = await acct(creator);
    expect(a.balanceCents).toBe(9800n + 4500n);
    expect(a.withdrawableCents).toBe(4500n);                 // net of the 10% fee
    // The fan's deposited credits never became withdrawable by spending them.
    expect((await acct(fan)).withdrawableCents).toBe(0n);
  });

  it('a spend consumes the non-withdrawable part first, and withdrawable never exceeds the balance', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 20_000);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 10_000, type: 'TIP', refId: randomUUID() })); // earns 9000
    await deposit(creator, 5_000);                                                                                                        // +4900 deposited
    const other = await makeCreator();
    // Spending 4000: fully covered by the 4900 deposited, earnings untouched.
    await money(prisma, (tx) => charge(tx, { fanId: creator, creatorId: other, grossCents: 4000, type: 'TIP', refId: randomUUID() }));
    let a = await acct(creator);
    expect(a.balanceCents).toBe(9900n);
    expect(a.withdrawableCents).toBe(9000n);
    // Spending 5000 more: only 900 non-withdrawable left, so 4100 comes out of earnings.
    await money(prisma, (tx) => charge(tx, { fanId: creator, creatorId: other, grossCents: 5000, type: 'TIP', refId: randomUUID() }));
    a = await acct(creator);
    expect(a.balanceCents).toBe(4900n);
    expect(a.withdrawableCents).toBe(4900n);
    expect(a.withdrawableCents <= a.balanceCents).toBe(true);
  });

  it('a payout reserves withdrawable credits; a refund restores them exactly once and cancels the burn obligation', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 10_000);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 5000, type: 'TIP', refId: randomUUID() })); // earns 4500
    const p = await money(prisma, async (tx) => {
      await reserveWithdrawable(tx, creator, 3000);
      const payout = await tx.payout.create({ data: { creatorId: creator, asset: 'STABLE', address: '0x000000000000000000000000000000000000dEaD', amountCents: 2870n, feeCents: 130n } });
      await post(tx, creator, -3000, 'PAYOUT', payout.id);
      await post(tx, PLATFORM_ID, 130, 'PLATFORM_FEE', payout.id);
      await tx.tokenBurn.create({ data: { usdCents: 32n, reason: 'withdrawal', refId: payout.id } });
      return payout;
    });
    let a = await acct(creator);
    expect(a.balanceCents).toBe(1500n);
    expect(a.withdrawableCents).toBe(1500n);

    await prisma.payout.update({ where: { id: p.id }, data: { status: 'HELD' } });
    expect(await money(prisma, (tx) => refundPayout(tx, p.id, ['HELD', 'FAILED'], 'test'))).toBe(true);
    // A second settle of the same payout does nothing -- guarded on status.
    expect(await money(prisma, (tx) => refundPayout(tx, p.id, ['HELD', 'FAILED'], 'test'))).toBe(false);
    expect(await money(prisma, (tx) => markPayoutSent(tx, p.id, ['HELD', 'FAILED'], '0x' + 'ab'.repeat(32)))).toBe(false);
    a = await acct(creator);
    expect(a.balanceCents).toBe(4500n);
    expect(a.withdrawableCents).toBe(4500n);
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('REFUNDED');
    expect(await prisma.tokenBurn.count({ where: { refId: p.id, executedAt: null } })).toBe(0);
  });
});

describe('VIP needs the price the fan saw', () => {
  it('refuses a changed price with 409 and charges nothing', async () => {
    const fan = await makeUser();
    await deposit(fan, 100_000);
    const before = (await acct(fan)).balanceCents;
    await prisma.platformConfig.update({ where: { id: 1 }, data: { vipPriceCents: 5000 } });
    await expect(money(prisma, (tx) => subscribeVip(tx, fan, 2000))).rejects.toMatchObject({ message: 'price_changed', statusCode: 409 });
    expect((await acct(fan)).balanceCents).toBe(before);
    await expect(money(prisma, (tx) => subscribeVip(tx, fan, 5000))).resolves.toMatchObject({ priceCents: 5000 });
  });
});

describe('a suspended or banned sender\'s messages stop being served', () => {
  it('free and unlocked messages both go dark for the recipient, never for the sender', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    const pair = creator < fan ? { aId: creator, bId: fan } : { aId: fan, bId: creator };
    const conv = await prisma.conversation.create({ data: pair });
    const msg = await prisma.message.create({ data: { conversationId: conv.id, senderId: creator, text: 'hi', priceCents: 0 } });
    const m = { id: msg.id, senderId: creator, priceCents: 0, conversation: pair };
    expect(await canViewMessage(fan, m)).toBe(true);
    await applyUserStatus(creator, 'BANNED', { rooms: { deleteRoom: async () => {} } });
    expect(await canViewMessage(fan, m)).toBe(false);
    expect(await canViewMessage(creator, m)).toBe(true);
  });
});

describe('auction orders carry the winner\'s own confirmation', () => {
  it('copies the winning bid\'s 18+/ToS record, and leaves it null for a bid that never gave one', async () => {
    const creator = await makeCreator();
    const winner = await makeUser();
    await deposit(winner, 100_000);
    const mk = () => prisma.listing.create({ data: { creatorId: creator, title: 'Lot', saleType: 'AUCTION', priceCents: 1000, auctionEndsAt: new Date(Date.now() + 3_600_000), media: readyMedia(creator) } });
    const confirmedAt = new Date('2026-09-20T10:00:00Z');
    const l1 = await mk();
    await money(prisma, (tx) => placeBid(tx, l1.id, winner, 1000, { ageConfirmedAt: confirmedAt, tosVersion: 'v1' }));
    await prisma.listing.update({ where: { id: l1.id }, data: { auctionEndsAt: new Date(Date.now() - 1000) } });
    const r1 = await money(prisma, (tx) => closeAuction(tx, l1.id));
    expect(r1.sold && r1.order.ageConfirmedAt?.toISOString()).toBe(confirmedAt.toISOString());
    expect(r1.sold && r1.order.tosVersion).toBe('v1');

    const l2 = await mk();
    await money(prisma, (tx) => placeBid(tx, l2.id, winner, 1000));
    await prisma.listing.update({ where: { id: l2.id }, data: { auctionEndsAt: new Date(Date.now() - 1000) } });
    const r2 = await money(prisma, (tx) => closeAuction(tx, l2.id));
    expect(r2.sold && r2.order.ageConfirmedAt).toBeNull();
    // The creator's sale is withdrawable earnings.
    expect((await acct(creator)).withdrawableCents).toBe(1700n);
  });
});

describe('an auction hold returns earned credits as earned', () => {
  it('an all-earned bidder who is outbid, or whose auction is cancelled, keeps their withdrawable credits', async () => {
    const bidderCreator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 20_000);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: bidderCreator, grossCents: 10_000, type: 'TIP', refId: randomUUID() })); // earns 9000
    const seller = await makeCreator();
    const rival = await makeUser();
    await deposit(rival, 100_000);
    const mk = () => prisma.listing.create({ data: { creatorId: seller, title: 'Lot', saleType: 'AUCTION', priceCents: 1000, auctionEndsAt: new Date(Date.now() + 3_600_000), media: readyMedia(seller) } });

    // Outbid.
    const l1 = await mk();
    await money(prisma, (tx) => placeBid(tx, l1.id, bidderCreator, 5000));
    let a = await acct(bidderCreator);
    expect(a.balanceCents).toBe(4000n);
    expect(a.withdrawableCents).toBe(4000n);
    // Raising their own lead keeps the accounting exact too.
    await money(prisma, (tx) => placeBid(tx, l1.id, bidderCreator, 6000));
    expect((await acct(bidderCreator)).withdrawableCents).toBe(3000n);
    await money(prisma, (tx) => placeBid(tx, l1.id, rival, 7000));
    a = await acct(bidderCreator);
    expect(a.balanceCents).toBe(9000n);
    expect(a.withdrawableCents).toBe(9000n);

    // Cancelled.
    const l2 = await mk();
    await money(prisma, (tx) => placeBid(tx, l2.id, bidderCreator, 9000));
    expect((await acct(bidderCreator)).withdrawableCents).toBe(0n);
    await money(prisma, (tx) => cancelAuction(tx, l2.id, 'test'));
    expect((await acct(bidderCreator)).withdrawableCents).toBe(9000n);

    // Reserve not met at close.
    const l3 = await prisma.listing.create({ data: { creatorId: seller, title: 'Lot', saleType: 'AUCTION', priceCents: 1000, reserveCents: 50_000, auctionEndsAt: new Date(Date.now() + 3_600_000), media: readyMedia(seller) } });
    await money(prisma, (tx) => placeBid(tx, l3.id, bidderCreator, 2000));
    await prisma.listing.update({ where: { id: l3.id }, data: { auctionEndsAt: new Date(Date.now() - 1000) } });
    await money(prisma, (tx) => closeAuction(tx, l3.id));
    a = await acct(bidderCreator);
    expect(a.balanceCents).toBe(9000n);
    expect(a.withdrawableCents).toBe(9000n);
  });

  it('a hold paid partly from deposited credits returns only the earned part as withdrawable', async () => {
    const bidderCreator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 20_000);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: bidderCreator, grossCents: 10_000, type: 'TIP', refId: randomUUID() })); // earns 9000
    await deposit(bidderCreator, 5_000); // +4900 deposited, balance 13900
    const seller = await makeCreator();
    const l = await prisma.listing.create({ data: { creatorId: seller, title: 'Lot', saleType: 'AUCTION', priceCents: 1000, auctionEndsAt: new Date(Date.now() + 3_600_000), media: readyMedia(seller) } });
    await money(prisma, (tx) => placeBid(tx, l.id, bidderCreator, 10_000)); // 4900 deposited + 5100 earned
    expect((await acct(bidderCreator)).withdrawableCents).toBe(3900n);
    await money(prisma, (tx) => cancelAuction(tx, l.id, 'test'));
    const a = await acct(bidderCreator);
    expect(a.balanceCents).toBe(13_900n);
    expect(a.withdrawableCents).toBe(9000n);
  });
});

describe('site standing over the bridge', () => {
  const claims = (uid: string, creatorStatus: 'active' | 'pending' | 'suspended' | 'banned') => ({
    typ: 'bridge' as const, uid, email: `${uid}@site.test`, username: `u_${uid.replace(/-/g, '').slice(0, 12)}`,
    role: 'CREATOR' as const, creatorStatus, jti: randomUUID(), exp: Date.now() + 60_000,
  });

  it('a site ban reaching an existing account applies the ban there, not just a refused exchange', async () => {
    const uid = randomUUID();
    const r = await resolveBridgedUser(claims(uid, 'active'));
    if (!r.ok) throw new Error('setup');
    const id = r.user.id;
    const fan = await makeUser();
    await prisma.subscriptionTier.create({ data: { creatorId: id, name: 't', priceCents: 500 } }).then((t) =>
      prisma.subscription.create({ data: { fanId: fan, creatorId: id, tierId: t.id, priceCents: 500, currentPeriodEnd: new Date(Date.now() + 864e5) } }));
    const listing = await prisma.listing.create({ data: { creatorId: id, title: 'x', priceCents: 500 } });

    expect(await resolveBridgedUser(claims(uid, 'banned'))).toMatchObject({ ok: false, status: 403, error: 'banned' });
    const u = await prisma.user.findUniqueOrThrow({ where: { id }, include: { creator: true } });
    expect(u.status).toBe('BANNED');
    expect(u.creator?.payoutsFrozen).toBe(true);
    expect((await prisma.subscription.findFirstOrThrow({ where: { creatorId: id } })).status).toBe('CANCELLED');
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe('REMOVED');
    // The site saying 'active' later never lifts a ban.
    expect(await resolveBridgedUser(claims(uid, 'active'))).toMatchObject({ ok: false, error: 'account_banned' });
  });

  it('a site suspension lifts when the site says active again; an admin suspension does not', async () => {
    const uid = randomUUID();
    const r = await resolveBridgedUser(claims(uid, 'active'));
    if (!r.ok) throw new Error('setup');
    await resolveBridgedUser(claims(uid, 'suspended'));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } })).status).toBe('SUSPENDED');
    const back = await resolveBridgedUser(claims(uid, 'active'));
    expect(back.ok).toBe(true);
    // Payouts stay frozen until an admin lifts the freeze.
    expect((await prisma.creatorProfile.findUniqueOrThrow({ where: { userId: r.user.id } })).payoutsFrozen).toBe(true);

    await applyUserStatus(r.user.id, 'SUSPENDED', { rooms: { deleteRoom: async () => {} } });   // an admin's
    expect(await resolveBridgedUser(claims(uid, 'active'))).toMatchObject({ ok: false, error: 'account_suspended' });
  });

  it('a creator who reverts to pending on the site can no longer operate here', async () => {
    const uid = randomUUID();
    const r = await resolveBridgedUser(claims(uid, 'active'));
    if (!r.ok) throw new Error('setup');
    await prisma.user.update({ where: { id: r.user.id }, data: { kycStatus: 'APPROVED' } });
    expect(creatorMayOperate(await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } }))).toBe(true);
    await resolveBridgedUser(claims(uid, 'pending'));
    expect(creatorMayOperate(await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } }))).toBe(false);
    // Native (non-bridged) creators are unaffected.
    expect(creatorMayOperate({ role: 'CREATOR', kycStatus: 'APPROVED', siteUid: null, siteCreatorStatus: null })).toBe(true);
  });

  it('a status-push token and an exchange token cannot stand in for each other', async () => {
    const sign = (payload: object) => {
      const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${b64}.${crypto.createHmac('sha256', process.env.BRIDGE_SECRET!).update(b64).digest('base64url')}`;
    };
    const uid = randomUUID();
    const push = { typ: 'bridge_status', uid, creatorStatus: 'banned', jti: randomUUID(), exp: Date.now() + 60_000 };
    expect(verifyBridgeStatusToken(sign(push))?.creatorStatus).toBe('banned');
    expect(verifyBridgeStatusToken(sign({ ...claims(uid, 'banned') }))).toBeNull();
    expect(verifyBridgeStatusToken(sign({ ...push, exp: Date.now() - 1 }))).toBeNull();
    expect(verifyBridgeStatusToken(sign(push).slice(0, -2) + 'xx')).toBeNull();
    // A push for an ADMIN row is never applied.
    const adminId = await makeUser({ role: 'ADMIN', siteUid: randomUUID() });
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    expect(await syncSiteStanding(admin, 'banned')).toBe('unchanged');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).status).toBe('ACTIVE');
  });
});

describe('suspending a creator ends their live stream', () => {
  it('deletes the room and marks the stream ENDED', async () => {
    const creator = await makeCreator();
    const s = await prisma.liveStream.create({ data: { creatorId: creator, roomName: `live_${randomUUID()}`, title: 't' } });
    const deleted: string[] = [];
    await applyUserStatus(creator, 'SUSPENDED', { rooms: { deleteRoom: async (n: string) => { deleted.push(n); } } });
    expect(deleted).toEqual([s.roomName]);
    expect((await prisma.liveStream.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('ENDED');
  });
});

describe('per-minute live: a lapsed viewer cannot ride an old token', () => {
  it('token lifetime follows paid time', () => {
    const now = Date.now();
    expect(viewerTokenTtlSeconds(0, null, now)).toBe(600);
    expect(viewerTokenTtlSeconds(100, new Date(now + 60_000), now)).toBe(Math.ceil((60_000 + PAY_GRACE_MS) / 1000));
    expect(viewerTokenTtlSeconds(100, new Date(now - 3_600_000), now)).toBe(60);
  });

  it('participant_joined removes a viewer with no paid time, keeps a paying one and the creator', async () => {
    const creator = await makeCreator();
    const s = await prisma.liveStream.create({ data: { creatorId: creator, roomName: `live_${randomUUID()}`, title: 't', perMinuteCents: 100 } });
    const payer = await makeUser(); const freeloader = await makeUser();
    await deposit(payer, 10_000);
    await payNextMinute(payer, s);
    const removed: string[] = [];
    const rooms = { removeParticipant: async (_r: string, id: string) => { removed.push(id); return undefined as any; } };
    expect(await checkViewerOnJoin(rooms, s.roomName, payer)).toBe(false);
    expect(await checkViewerOnJoin(rooms, s.roomName, creator)).toBe(false);
    expect(await checkViewerOnJoin(rooms, s.roomName, freeloader)).toBe(true);
    expect(removed).toEqual([freeloader]);
  });
});

describe('upload limits', () => {
  it('caps object size by type and role, and counts open uploads and daily bytes', async () => {
    expect(maxBytesFor('image/jpeg', true)).toBe(UPLOAD_LIMITS.IMAGE_MAX_BYTES);
    expect(maxBytesFor('video/mp4', false)).toBe(UPLOAD_LIMITS.OTHER_VIDEO_MAX_BYTES);
    expect(maxBytesFor('video/mp4', true)).toBe(UPLOAD_LIMITS.CREATOR_VIDEO_MAX_BYTES);
    const fan = await makeUser();
    expect(await uploadQuotaError(fan, 1000, false)).toBeNull();
    await prisma.media.createMany({ data: Array.from({ length: UPLOAD_LIMITS.MAX_OPEN_UPLOADS }, (_, i) => ({ ownerId: fan, key: `raw/${fan}/${i}`, mime: 'image/jpeg', bytes: 10 })) });
    expect(await uploadQuotaError(fan, 1000, false)).toBe('too_many_open_uploads');
    const fan2 = await makeUser();
    await prisma.media.create({ data: { ownerId: fan2, key: `raw/${fan2}/big`, mime: 'video/mp4', bytes: UPLOAD_LIMITS.OTHER_DAILY_BYTES - 10, status: 'READY' } });
    expect(await uploadQuotaError(fan2, 100, false)).toBe('upload_quota_exceeded');
    expect(await uploadQuotaError(fan2, 100, true)).toBeNull();
  });

  it('a burst of parallel upload requests cannot pass the quota together', async () => {
    const fan = await makeUser();
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      createUploadWithinQuota(fan, false, { key: `raw/${fan}/burst-${i}`, mime: 'image/jpeg', bytes: 10 })));
    expect(results.filter((r) => 'media' in r).length).toBe(UPLOAD_LIMITS.MAX_OPEN_UPLOADS);
    expect(await prisma.media.count({ where: { ownerId: fan } })).toBe(UPLOAD_LIMITS.MAX_OPEN_UPLOADS);
  });
});

describe('deposit cents are exact', () => {
  it('every exact-cent stablecoin amount from $0.01 to $100.00 credits exactly', () => {
    for (let c = 1n; c <= 10_000n; c++) expect(rawToUsdCents(c * 10_000n, 6, 1)).toBe(c);
    expect(rawToUsdCents(1_150_000n, 6, 1)).toBe(115n);
    expect(rawToUsdCents(10n ** 18n, 18, 2500.5)).toBe(250_050n);
  });
});

describe('deposit mnemonic validation', () => {
  it('accepts a real mnemonic and refuses a one-word typo that viem would accept', () => {
    const m = generateMnemonic(english);
    expect(isValidMnemonic(m)).toBe(true);
    expect(() => xpubFromMnemonic(m)).not.toThrow();
    const words = m.split(' ');
    const swapped = english.find((w) => w !== words[11] && !isValidMnemonic([...words.slice(0, 11), w].join(' ')))!;
    const typo = [...words.slice(0, 11), swapped].join(' ');
    expect(isValidMnemonic(typo)).toBe(false);
    expect(() => xpubFromMnemonic(typo)).toThrow(/not a valid BIP-39/);
    expect(isValidMnemonic(words.slice(0, 11).join(' ') + ' junl')).toBe(false);
  });
});

describe('treasury hedge progress', () => {
  it('records a partial share of a deposit larger than one slice, and stops at the target', () => {
    const d = { id: 'a', rawAmount: '20000000', hedgedRaw: '0' };
    const first = allocateHedge([d], 1_250_000n, 7500);
    expect(first).toEqual([{ id: 'a', hedgedRaw: 1_250_000n, done: false }]);
    let cur = { ...d, hedgedRaw: '0' };
    let sold = 0n;
    for (let i = 0; i < 100 && hedgeRemaining(cur, 7500) > 0n; i++) {
      const slice = hedgeRemaining(cur, 7500) < 1_250_000n ? hedgeRemaining(cur, 7500) : 1_250_000n;
      const [a] = allocateHedge([cur], slice, 7500);
      sold += slice;
      cur = { ...cur, hedgedRaw: a.hedgedRaw.toString() };
    }
    expect(sold).toBe(15_000_000n);            // exactly the 75% target, never more
    expect(hedgeRemaining(cur, 7500)).toBe(0n);
  });
});
