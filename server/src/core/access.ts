import { prisma } from '../lib/prisma.js';

export async function isSubscribed(fanId: string, creatorId: string) {
  if (fanId === creatorId) return true;
  const s = await prisma.subscription.findUnique({ where: { fanId_creatorId: { fanId, creatorId } } });
  return !!s && s.status === 'ACTIVE' && s.currentPeriodEnd > new Date();
}

export async function canViewPost(
  userId: string | null,
  post: { id: string; creatorId: string; visibility: string; removed: boolean },
) {
  if (post.removed) return false;
  if (post.visibility === 'PUBLIC') return true;
  if (!userId) return false;
  if (post.creatorId === userId) return true;
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
