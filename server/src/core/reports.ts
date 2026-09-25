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
