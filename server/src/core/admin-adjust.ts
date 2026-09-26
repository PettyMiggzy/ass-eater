import { prisma } from '../lib/prisma.js';
import { money, post, PLATFORM_ID, BURNED_ID } from './ledger.js';

export class AdjustRefused extends Error {
  constructor(public reason: 'user_not_found' | 'system_account' | 'insufficient_balance' | 'insufficient_withdrawable' | 'request_id_reused', public statusCode: number) {
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
 *
 * `earnings` (default false) says which part of the balance the adjustment
 * is about -- credits are closed-loop, and only EARNED credits
 * (Account.withdrawableCents) can ever be paid out:
 *  - false: a credit is ordinary spendable credit that can never be withdrawn
 *    (goodwill, refunds of a fan's own spend); a debit spends the
 *    non-withdrawable part first, exactly like a purchase.
 *  - true: a credit is restored AS EARNINGS, payable in a payout (correcting
 *    earnings that were wrongly removed); a debit claws back EARNINGS -- it
 *    takes the amount out of withdrawableCents under the row lock, and is
 *    refused (409 insufficient_withdrawable) when the creator's withdrawable
 *    credits don't cover it, rather than silently spending deposited credits
 *    and leaving the earnings payable.
 * The flag is stored on AdminAdjustRequest and a replay must match it.
 * Which of these an admin should use in a given dispute is a policy call for
 * the owner; the code only makes each explicit.
 */
export async function adminAdjust(
  adminId: string,
  targetId: string,
  p: { requestId: string; amountCents: number; reason: string; allowNegative?: boolean; earnings?: boolean },
): Promise<{ ok: true; replayed: boolean }> {
  if (targetId === PLATFORM_ID || targetId === BURNED_ID) throw new AdjustRefused('system_account', 400);
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
  if (!target) throw new AdjustRefused('user_not_found', 404);
  const amt = BigInt(p.amountCents);
  const earnings = !!p.earnings;
  try {
    await money(prisma, async (tx) => {
      await tx.adminAdjustRequest.create({ data: { key: p.requestId, adminId, targetId, amountCents: amt, reason: p.reason, earnings } });
      if (amt < 0n && (!p.allowNegative || earnings)) {
        await tx.account.upsert({ where: { userId: targetId }, create: { userId: targetId }, update: {} });
        const [row] = await tx.$queryRaw<{ balanceCents: bigint; withdrawableCents: bigint }[]>`
          SELECT "balanceCents", "withdrawableCents" FROM "Account" WHERE "userId" = ${targetId} FOR UPDATE`;
        if (!p.allowNegative && row.balanceCents + amt < 0n) throw new AdjustRefused('insufficient_balance', 409);
        if (earnings) {
          // Clawback of earnings: withdrawable falls by exactly the amount,
          // under the lock just taken, before the debit posts (post() then
          // only clamps withdrawable to the new balance).
          if (row.withdrawableCents < -amt) throw new AdjustRefused('insufficient_withdrawable', 409);
          await tx.account.update({ where: { userId: targetId }, data: { withdrawableCents: { decrement: -amt } } });
        }
      }
      const meta = { reason: p.reason, by: adminId, requestId: p.requestId, ...(earnings ? { earnings: true } : {}) };
      await post(tx, targetId, amt, 'ADJUSTMENT', p.requestId, meta, 'CREDITS', amt > 0n && earnings ? { earned: true } : {});
      await post(tx, PLATFORM_ID, -amt, 'ADJUSTMENT', p.requestId, { reason: p.reason, target: targetId, by: adminId, requestId: p.requestId });
    });
    return { ok: true, replayed: false };
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    const prior = await prisma.adminAdjustRequest.findUnique({ where: { key: p.requestId } });
    if (!prior) throw e;
    if (prior.targetId !== targetId || prior.amountCents !== amt || prior.earnings !== earnings) throw new AdjustRefused('request_id_reused', 409);
    return { ok: true, replayed: true };
  }
}
