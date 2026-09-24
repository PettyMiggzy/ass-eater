import { prisma } from '../lib/prisma.js';
import { isVip } from './ledger.js';

/**
 * A creator's content is served, and sold, only while their account is
 * ACTIVE. Suspending or banning (modules/admin.ts setStatus) used to change
 * the User row and nothing else, so a creator banned for non-consensual
 * content kept every PUBLIC post, every media URL and every marketplace
 * listing reachable -- and sellable. The owner themselves is exempt; nobody
 * else is, prior buyers included.
 */
export async function creatorIsActive(creatorId: string) {
  const u = await prisma.user.findUnique({ where: { id: creatorId }, select: { status: true } });
  return u?.status === 'ACTIVE';
}

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
  post: { id: string; creatorId: string; visibility: string; removed: boolean; vipEarlyUntil?: Date | null },
  memo?: ViewMemo,
) {
  if (post.removed) return false;
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
  if (msg.senderId === userId || msg.priceCents === 0) return true;
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
  if (m.post) return { ok: await canViewPost(userId, m.post), m };
  if (m.message && userId) return { ok: await canViewMessage(userId, m.message), m };
  if (m.listing) return { ok: await canViewListing(userId, m.listing.id, m.listing.creatorId), m };
  return { ok: false as const };
}
