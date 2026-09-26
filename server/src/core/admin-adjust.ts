import { prisma } from '../lib/prisma.js';
import { money, post, PLATFORM_ID, BURNED_ID } from './ledger.js';

export class AdjustRefused extends Error {
  constructor(public reason: 'user_not_found' | 'system_account' | 'insufficient_balance' | 'request_id_reused', public statusCode: number) {
    super(reason);
  }
}

/**
 * Admin manual credit/debit (refunds, goodwill, corrections), counter-posted
 * against the platform treasury -- at most once per client `requestId`.
 *
 * The route used to post on every call with nothing to dedupe on, so a
 * request that committed but whose response was lost (a 502, a timeout) and
 * was then retried credited the fan twice out of treasury -- or, for a debit,
 * took it twice. The AdminAdjustRequest row is inserted in the same
 * transaction as both postings: a retry collides on its primary key, rolls
 * back, and gets the first request's answer (`replayed: true`). As in
 * modules/tips.ts, P2002 alone is not proof -- the re-read on `prisma` (never
 * on the rolled-back transaction) decides. A requestId reused for a DIFFERENT
 * adjustment is refused rather than answered "done".
 *
 * Also refused: an unknown user (404, nothing posted), the system accounts
 * (PLATFORM_ID would net to zero while writing two misleading ledger rows;
 * BURNED_ID holds nothing that may ever move), and a debit that would take
 * the balance below zero unless `allowNegative` is passed explicitly.
 */
export async function adminAdjust(
  adminId: string,
  targetId: string,
  p: { requestId: string; amountCents: number; reason: string; allowNegative?: boolean },
): Promise<{ ok: true; replayed: boolean }> {
  if (targetId === PLATFORM_ID || targetId === BURNED_ID) throw new AdjustRefused('system_account', 400);
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
  if (!target) throw new AdjustRefused('user_not_found', 404);
  const amt = BigInt(p.amountCents);
  try {
    await money(prisma, async (tx) => {
      await tx.adminAdjustRequest.create({ data: { key: p.requestId, adminId, targetId, amountCents: amt, reason: p.reason } });
      if (amt < 0n && !p.allowNegative) {
        await tx.account.upsert({ where: { userId: targetId }, create: { userId: targetId }, update: {} });
        const [row] = await tx.$queryRaw<{ balanceCents: bigint }[]>`
          SELECT "balanceCents" FROM "Account" WHERE "userId" = ${targetId} FOR UPDATE`;
        if (row.balanceCents + amt < 0n) throw new AdjustRefused('insufficient_balance', 409);
      }
      await post(tx, targetId, amt, 'ADJUSTMENT', p.requestId, { reason: p.reason, by: adminId, requestId: p.requestId });
      await post(tx, PLATFORM_ID, -amt, 'ADJUSTMENT', p.requestId, { reason: p.reason, target: targetId, by: adminId, requestId: p.requestId });
    });
    return { ok: true, replayed: false };
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    const prior = await prisma.adminAdjustRequest.findUnique({ where: { key: p.requestId } });
    if (!prior) throw e;
    if (prior.targetId !== targetId || prior.amountCents !== amt) throw new AdjustRefused('request_id_reused', 409);
    return { ok: true, replayed: true };
  }
}
