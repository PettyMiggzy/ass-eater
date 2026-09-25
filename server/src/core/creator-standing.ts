import type { Prisma } from '@prisma/client';

/**
 * Creator standing, as pure predicates plus the matching Prisma filter.
 *
 * Kept in its own module (no imports from ledger.ts or access.ts) because
 * both of those need it and access.ts already imports ledger.ts -- putting
 * it in either would make the two import each other.
 */

type StandingRow = { role: string; kycStatus: string; siteUid?: string | null; siteCreatorStatus?: string | null };

/**
 * May this account act as a creator (publish, sell, price messages,
 * withdraw)? KYC-approved on this stack, AND -- for an account bridged from
 * the Next.js site -- approved THERE ('active' as last seen by
 * lib/bridge.ts). The site's approval queue, including its §2257 gate, is
 * the platform's creator approval; server-side KYC alone is not.
 */
export function creatorMayOperate(u: StandingRow | null) {
  if (!u) return false;
  if (u.role === 'ADMIN') return u.kycStatus === 'APPROVED';
  if (u.role !== 'CREATOR' || u.kycStatus !== 'APPROVED') return false;
  return !u.siteUid || u.siteCreatorStatus === 'active';
}

/**
 * May this account be PAID right now: not suspended or banned, AND approved
 * (creatorMayOperate). This is the gate on every NEW flow of money to a
 * creator -- core/ledger.ts charge() (tips, DMs, PPV and message unlocks,
 * live tickets and minutes, subscriptions and their renewals, token locks),
 * marketplace buys and bids, and the auction close.
 *
 * It is deliberately NOT the gate on SERVING content: a creator whose KYC is
 * re-reviewed or whose site standing goes back to 'pending' still has
 * buyers and subscribers who paid for access, and those keep it until the
 * period they paid for ends (core/access.ts creatorIsActive -- suspension
 * and ban -- is what takes content down). An unapproved creator simply
 * cannot take anyone's money in the meantime.
 */
export function creatorMayBePaid(u: (StandingRow & { status: string }) | null) {
  return !!u && u.status === 'ACTIVE' && creatorMayOperate(u);
}

/** Prisma `User` where-fragment equivalent to creatorMayBePaid() for a CREATOR row. */
export const OPERATING_CREATOR_USER_WHERE = {
  status: 'ACTIVE',
  kycStatus: 'APPROVED',
  OR: [{ siteUid: null }, { siteCreatorStatus: 'active' }],
} satisfies Prisma.UserWhereInput;

export const CREATOR_STANDING_SELECT = {
  role: true, status: true, kycStatus: true, siteUid: true, siteCreatorStatus: true,
} as const;

/** Reads the standing of `creatorId` through `db` (a transaction or the client). */
export async function creatorMayBePaidById(
  db: { user: { findUnique: (a: any) => Promise<any> } },
  creatorId: string,
) {
  const u = await db.user.findUnique({ where: { id: creatorId }, select: CREATOR_STANDING_SELECT });
  return creatorMayBePaid(u);
}
