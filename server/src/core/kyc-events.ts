import { prisma } from '../lib/prisma.js';

/**
 * Applies one verified Sumsub webhook event to the user it names.
 *
 * Sumsub retries failed deliveries, so events can arrive out of order: a
 * GREEN review queued while this API was down used to land AFTER a later RED
 * re-review (or an admin's REJECTED) and silently re-approve the creator.
 * Ordering is now enforced in the database, not by arrival:
 *  - User.kycStatusAt holds the time of the decision kycStatus reflects (the
 *    event's own createdAt, or now() for an admin override), and an event is
 *    applied only if it is NOT OLDER than that -- as a guarded updateMany, so
 *    two deliveries racing each other can't both win.
 *  - An event for a different applicant than the stored kycRef is ignored:
 *    it describes an applicant this account no longer uses.
 * Ignored events still return normally, so the route acks them (200) and
 * Sumsub stops retrying.
 *
 * An event with no readable timestamp falls back to the receipt time (the old
 * behaviour) with a warning, rather than being dropped: refusing it would lose
 * real approvals if Sumsub's payload format ever differs from what is parsed
 * here.
 */
export type KycEventResult = 'applied' | 'stale' | 'ignored';

export function kycEventTime(evt: any): Date | null {
  for (const v of [evt?.createdAtMs, evt?.createdAt]) {
    if (typeof v === 'number' && Number.isFinite(v)) { const d = new Date(v); if (!Number.isNaN(d.getTime())) return d; }
    if (typeof v !== 'string' || !v.trim()) continue;
    let s = v.trim();
    // Sumsub sends "2020-02-21 13:23:19.321" (UTC, no zone) and
    // "2020-02-21 13:23:19+0000"; normalise both to ISO-8601.
    s = s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    if (!/(Z|[+-]\d{2}:\d{2})$/i.test(s)) s += 'Z';
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

export async function applyKycEvent(evt: any, log: { warn: (...a: any[]) => void } = console): Promise<KycEventResult> {
  const reviewed = evt.type === 'applicantReviewed' || evt.type === 'applicantWorkflowCompleted';
  const reset = evt.type === 'applicantReset';
  if (!reviewed && !reset) return 'ignored';
  if (typeof evt.externalUserId !== 'string') throw new Error('missing_external_user_id');

  let at = kycEventTime(evt);
  if (!at) {
    log.warn({ type: evt.type }, 'kyc webhook: event has no readable createdAt; applying at receipt time');
    at = new Date();
  }
  const applicantId = typeof evt.applicantId === 'string' && evt.applicantId ? evt.applicantId : undefined;

  const where = {
    id: evt.externalUserId,
    AND: [
      { OR: [{ kycStatusAt: null }, { kycStatusAt: { lte: at } }] },
      // Same applicant, or none recorded yet. An event with no applicantId
      // can only apply while nothing is recorded.
      { OR: [{ kycRef: null }, ...(applicantId ? [{ kycRef: applicantId }] : [])] },
    ],
  };
  const data = reviewed
    ? { kycStatus: evt.reviewResult?.reviewAnswer === 'GREEN' ? 'APPROVED' as const : 'REJECTED' as const, kycStatusAt: at, ...(applicantId ? { kycRef: applicantId } : {}) }
    : { kycStatus: 'PENDING' as const, kycStatusAt: at };
  const r = await prisma.user.updateMany({ where, data });
  return r.count ? 'applied' : 'stale';
}
