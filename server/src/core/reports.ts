import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

/**
 * Moderation reports on server/ content. Every report route (posts, direct
 * messages, marketplace listings, users) files through here, so they share
 * one shape and one de-duplication rule; admin resolves them through
 * /admin/reports/:id/resolve (modules/admin.ts), which acts per target type.
 */
export type ReportTarget = 'post' | 'message' | 'listing' | 'user';
export const REPORT_TARGETS: ReportTarget[] = ['post', 'message', 'listing', 'user'];

/**
 * Files a report, or returns the reporter's existing OPEN report on the same
 * target: re-submitting (a double-click, or reporting again before an admin
 * has looked) must not bury the queue in copies of one complaint.
 */
export async function fileReport(reporterId: string, targetType: ReportTarget, targetId: string, reason: string) {
  // A report on content that is ALREADY taken down (a blanked mass-DM copy, a
  // removed post) is still filed and kept OPEN: taking the content down is
  // not the end of moderation -- a later report can carry what the first did
  // not (a possible minor, NCII), which needs a suspension, a ban or a legal
  // report. It used to be dropped here with no row at all. The queue stays
  // usable instead through listReports: reports on already-removed content
  // sort after live ones and carry contentRemoved, so they cannot bury a
  // report on something still up.
  const open = () => prisma.report.findFirst({ where: { reporterId, targetType, targetId, status: 'OPEN' } });
  const existing = await open();
  if (existing) return { ...existing, already: true };
  try {
    const r = await prisma.report.create({ data: { reporterId, targetType, targetId, reason } });
    return { ...r, already: false };
  } catch (err) {
    // Two concurrent submissions both passed the read above; the partial
    // unique index on OPEN (reporter, target) (round-4 migration) let only
    // one in. The loser answers with the winner's row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const raced = await open();
      if (raced) return { ...raced, already: true };
    }
    throw err;
  }
}

/**
 * The ids of every copy of a message: itself, plus -- for a mass DM, which
 * is one Message row per subscriber sharing its sender and broadcastId
 * (workers/broadcast.ts) -- every other subscriber's copy. A report on one
 * copy is a report on the content, and removing it from one inbox only is
 * not removing it (admin.ts /reports/:id/resolve).
 */
export async function messageAndBroadcastSiblings(messageId: string): Promise<string[]> {
  const m = await prisma.message.findUnique({ where: { id: messageId }, select: { id: true, senderId: true, broadcastId: true } });
  if (!m) return [];
  if (!m.broadcastId) return [m.id];
  const copies = await prisma.message.findMany({ where: { senderId: m.senderId, broadcastId: m.broadcastId }, select: { id: true } });
  return [...new Set([m.id, ...copies.map((c) => c.id)])];
}

/**
 * True once an admin has ACTIONED a report on any copy of this mass DM --
 * every action but dismiss takes the content down (admin.ts). The broadcast
 * worker keeps inserting copies for the subscribers it has not reached yet,
 * with the text and price from its job data, and a failed job can be
 * re-queued with the same requestId (POST /messages/broadcast), so the
 * takedown has to be something the worker and the route can SEE: the
 * actioned report row itself is that durable marker (no Redis key to expire
 * or lose, no schema change).
 */
//
// A media takedown with no report (DELETE /admin/media/:id, the direct NCII /
// TAKE IT DOWN route) counts too: it REJECTs the source and every copy, and a
// copy of a broadcast is never REJECTED for any other reason (copies are not
// transcoded; they are written READY from their source), so a REJECTED media
// row on any copy is the same durable marker.
export async function broadcastTakenDown(senderId: string, broadcastId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one FROM "Report" r JOIN "Message" m ON m.id = r."targetId"
    WHERE r."targetType" = 'message' AND r.status = 'ACTIONED'
      AND m."senderId" = ${senderId} AND m."broadcastId" = ${broadcastId}
    UNION ALL
    SELECT 1 AS one FROM "Media" md JOIN "Message" m ON m.id = md."messageId"
    WHERE md.status = 'REJECTED' AND m."senderId" = ${senderId} AND m."broadcastId" = ${broadcastId}
    LIMIT 1`;
  return rows.length > 0;
}

/**
 * Blanks every copy of a taken-down mass DM (text, price) and REJECTs their
 * media rows. Idempotent. The worker calls it for copies it wrote after (or
 * racing) the admin's resolve: those were created from the job's stale data
 * and would otherwise carry the removed text at full price, with media rows
 * still READY that point at objects the takedown already deleted.
 */
export async function blankBroadcast(senderId: string, broadcastId: string) {
  const copies = await prisma.message.findMany({ where: { senderId, broadcastId }, select: { id: true } });
  const ids = copies.map((c) => c.id);
  if (!ids.length) return;
  await prisma.$transaction([
    prisma.message.updateMany({ where: { id: { in: ids } }, data: { text: '', priceCents: 0 } }),
    prisma.media.updateMany({ where: { messageId: { in: ids } }, data: { status: 'REJECTED', hlsKey: null, previewKey: null } }),
  ]);
}

export type ReportListQuery = {
  status: 'OPEN' | 'ACTIONED' | 'DISMISSED';
  targetType?: ReportTarget;
  /** true: only reports whose content is already down; false: only live ones; undefined: both. */
  contentRemoved?: boolean;
  limit: number;
  offset: number;
};

/**
 * The moderation queue, paged, each report marked `contentRemoved` when what
 * it points at is already down: a removed post, a REMOVED listing, a BANNED
 * user, or a message whose content was taken down (for a mass DM, ANY copy's
 * report ACTIONED or any copy's media REJECTED -- broadcastTakenDown; for a
 * single DM, an ACTIONED report on it).
 *
 * Ordered live-first, then oldest-first: one widely reported drop (a report
 * per subscriber's copy, left OPEN so every reason is still read) cannot
 * push a report on content that is still up behind it. Nothing is hidden
 * or auto-closed -- `contentRemoved=false` narrows to what still needs a
 * takedown, `true` to what needs only a decision on the reporter's reason.
 */
export async function listReports(q: ReportListQuery) {
  const removed = Prisma.sql`CASE r."targetType"
      WHEN 'post' THEN EXISTS (SELECT 1 FROM "Post" p WHERE p.id = r."targetId" AND p.removed)
      WHEN 'listing' THEN EXISTS (SELECT 1 FROM "Listing" l WHERE l.id = r."targetId" AND l.status = 'REMOVED')
      WHEN 'user' THEN EXISTS (SELECT 1 FROM "User" u WHERE u.id = r."targetId" AND u.status = 'BANNED')
      WHEN 'message' THEN EXISTS (
        SELECT 1 FROM "Message" m JOIN "Message" s
          ON s.id = m.id OR (m."broadcastId" IS NOT NULL AND s."senderId" = m."senderId" AND s."broadcastId" = m."broadcastId")
        WHERE m.id = r."targetId" AND (
          EXISTS (SELECT 1 FROM "Report" r2 WHERE r2."targetType" = 'message' AND r2."targetId" = s.id AND r2.status = 'ACTIONED')
          OR (m."broadcastId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Media" md WHERE md."messageId" = s.id AND md.status = 'REJECTED'))))
      ELSE false END`;
  const conds: Prisma.Sql[] = [Prisma.sql`r.status = ${q.status}::"ReportStatus"`];
  if (q.targetType) conds.push(Prisma.sql`r."targetType" = ${q.targetType}`);
  const base = Prisma.sql`SELECT r.*, (${removed}) AS "contentRemoved" FROM "Report" r WHERE ${Prisma.join(conds, ' AND ')}`;
  const filter = q.contentRemoved === undefined ? Prisma.empty : Prisma.sql`WHERE q."contentRemoved" = ${q.contentRemoved}`;
  const [reports, count] = await Promise.all([
    prisma.$queryRaw<Array<Record<string, unknown> & { contentRemoved: boolean }>>`
      SELECT * FROM (${base}) q ${filter}
      ORDER BY q."contentRemoved" ASC, q."createdAt" ASC, q.id ASC
      LIMIT ${q.limit} OFFSET ${q.offset}`,
    prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM (${base}) q ${filter}`,
  ]);
  return { reports, total: Number(count[0]?.n ?? 0) };
}
