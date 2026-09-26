import { prisma } from '../lib/prisma.js';
import { isVip } from './ledger.js';

/**
 * A creator's content is served only while their account is ACTIVE (and is
 * SOLD only while they are also approved -- core/creator-standing.ts
 * creatorMayBePaid). Suspending or banning (modules/admin.ts setStatus) used to change
 * the User row and nothing else, so a creator banned for non-consensual
 * content kept every PUBLIC post, every media URL and every marketplace
 * listing reachable -- and sellable. The owner themselves is exempt; nobody
 * else is, prior buyers included.
 */
export async function creatorIsActive(creatorId: string) {
  const u = await prisma.user.findUnique({ where: { id: creatorId }, select: { status: true } });
  return u?.status === 'ACTIVE';
}

// creatorMayOperate / creatorMayBePaid live in core/creator-standing.ts so
// core/ledger.ts can use them without importing this module (which imports
// ledger.ts). Re-exported here for the existing callers.
export { creatorMayOperate, creatorMayBePaid, creatorMayBePaidById, OPERATING_CREATOR_USER_WHERE } from './creator-standing.js';

/**
 * True while `obj` is inside its VIP early-access window for this viewer.
 * The list endpoints hide such rows; this is the gate for anyone who has the
 * id anyway (a PPV unlock, a media URL, a bid) -- ids are shareable.
 */
export async function inVipWindow(obj: { vipEarlyUntil: Date | null; creatorId: string }, viewerId: string | null) {
  if (!obj.vipEarlyUntil || obj.vipEarlyUntil <= new Date()) return false;
  if (viewerId && viewerId === obj.creatorId) return false;
  return !(viewerId && (await isVip(prisma, viewerId)));
}

export async function isSubscribed(fanId: string, creatorId: string) {
  if (fanId === creatorId) return true;
  const s = await prisma.subscription.findUnique({ where: { fanId_creatorId: { fanId, creatorId } } });
  return !!s && s.status === 'ACTIVE' && s.currentPeriodEnd > new Date();
}

/**
 * How long past its period end an auto-renewing subscription still counts
 * for LIVE entitlement. Renewals are not charged at currentPeriodEnd: the
 * renewals worker (workers/renewals.ts) picks up due rows on a 5-minute
 * repeat, under a tick lock that can be held up to 15 minutes by an overrunning
 * tick. Without this grace the 20-second live sweep removed a fan who was about
 * to be renewed from a subscriber-only stream at every period boundary, and
 * /join refused them until the tick landed. The worker renews or EXPIRES the
 * row inside this window, after which the strict rule applies again.
 */
export const LIVE_RENEWAL_GRACE_MS = 20 * 60_000;

type SubRow = { status: string; autoRenew: boolean; currentPeriodEnd: Date };

/**
 * Live entitlement from a subscription row: current, or ACTIVE with auto-renew
 * on and inside LIVE_RENEWAL_GRACE_MS of its period end (a renewal is pending).
 * Deliberately only for live rooms: post/media gating keeps strict
 * isSubscribed(), so nothing else is loosened.
 */
export function subscriptionCoversLive(s: SubRow | null | undefined, now = new Date()) {
  if (!s || s.status !== 'ACTIVE') return false;
  if (s.currentPeriodEnd > now) return true;
  return s.autoRenew && s.currentPeriodEnd.getTime() > now.getTime() - LIVE_RENEWAL_GRACE_MS;
}

export async function isSubscribedForLive(fanId: string, creatorId: string, now = new Date()) {
  if (fanId === creatorId) return true;
  const s = await prisma.subscription.findUnique({
    where: { fanId_creatorId: { fanId, creatorId } },
    select: { status: true, autoRenew: true, currentPeriodEnd: true },
  });
  return subscriptionCoversLive(s, now);
}

/**
 * Per-request memo for canViewPost over a page of posts: without it a
 * 30-post list re-reads the same creator's status (and the viewer's VIP
 * status) once per row. Keys are namespaced; values are the pending lookups.
 */
export type ViewMemo = Map<string, Promise<boolean>>;

function memoized(memo: ViewMemo | undefined, key: string, fn: () => Promise<boolean>) {
  if (!memo) return fn();
  let v = memo.get(key);
  if (!v) { v = fn(); memo.set(key, v); }
  return v;
}

export async function canViewPost(
  userId: string | null,
  post: { id: string; creatorId: string; visibility: string; removed: boolean; removedByCreator?: boolean; vipEarlyUntil?: Date | null },
  memo?: ViewMemo,
) {
  if (post.removed) {
    // A moderation takedown hides it from everyone. A creator's OWN delete
    // hides it from everyone who has not paid for it -- but a fan who
    // unlocked a PPV post keeps it (fans get no refunds), exactly as a
    // listing's buyers keep what they bought when the creator removes it
    // (canViewListing). Still subject to the creator's standing below it.
    if (!post.removedByCreator || !userId) return false;
    if (post.creatorId === userId) return true;
    if (post.visibility !== 'PPV') return false;
    if (!(await memoized(memo, `active:${post.creatorId}`, () => creatorIsActive(post.creatorId)))) return false;
    return !!(await prisma.postUnlock.findUnique({ where: { fanId_postId: { fanId: userId, postId: post.id } } }));
  }
  if (userId && post.creatorId === userId) return true;
  if (!(await memoized(memo, `active:${post.creatorId}`, () => creatorIsActive(post.creatorId)))) return false;
  if (post.vipEarlyUntil && post.vipEarlyUntil > new Date()) {
    const vip = !!userId && (await memoized(memo, `vip:${userId}`, () => isVip(prisma, userId)));
    if (!vip) return false;
  }
  if (post.visibility === 'PUBLIC') return true;
  if (!userId) return false;
  if (post.visibility === 'SUBSCRIBERS') return isSubscribed(userId, post.creatorId);
  return !!(await prisma.postUnlock.findUnique({ where: { fanId_postId: { fanId: userId, postId: post.id } } }));
}

export async function canViewMessage(
  userId: string,
  msg: { id: string; senderId: string; priceCents: number; conversation: { aId: string; bId: string } },
) {
  if (![msg.conversation.aId, msg.conversation.bId].includes(userId)) return false;
  if (msg.senderId === userId) return true;
  // Same rule as posts and listings: once the sender is suspended or banned,
  // what they sent -- text and media, mass-broadcast copies included -- is
  // no longer served to anyone but them, paid-for or free. DMs are the most
  // likely vector for exactly the content a ban is for (e.g. NCII), and
  // GET /media/:id/url resolves message media through here.
  if (!(await creatorIsActive(msg.senderId))) return false;
  if (msg.priceCents === 0) return true;
  return !!(await prisma.messageUnlock.findUnique({ where: { fanId_messageId: { fanId: userId, messageId: msg.id } } }));
}

export async function canViewListing(userId: string | null, listingId: string, creatorId: string) {
  if (!userId) return false;
  if (userId === creatorId) return true;
  if (!(await creatorIsActive(creatorId))) return false;
  return !!(await prisma.listingOrder.findFirst({ where: { listingId, buyerId: userId } }));
}

export async function canViewMedia(userId: string | null, mediaId: string) {
  const m = await prisma.media.findUnique({
    where: { id: mediaId },
    include: { post: true, message: { include: { conversation: true } }, listing: true },
  });
  if (!m || m.status !== 'READY') return { ok: false as const };
  if (m.ownerId === userId) return { ok: true as const, m };
  // Any context that grants access grants it. Media is only ever attached to
  // one context (the attach routes all require postId, messageId and
  // listingId to be null), but this used to be first-match -- post, then
  // message, then listing -- so a listing's product that also got attached to
  // a post was decided by the POST's rule, and the people who BOUGHT the
  // listing were locked out of what they paid for.
  if (!m.post && !m.message && !m.listing) return { ok: false as const };
  if (m.post && (await canViewPost(userId, m.post))) return { ok: true as const, m };
  if (m.message && userId && (await canViewMessage(userId, m.message))) return { ok: true as const, m };
  if (m.listing && (await canViewListing(userId, m.listing.id, m.listing.creatorId))) return { ok: true as const, m };
  return { ok: false as const, m };
}
