import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { requestPayout, getBalanceCents, INSUFFICIENT_BALANCE } from '../../../lib/credits-store';
import { consumeAttempt } from '../../../lib/rate-limit';

/**
 * A creator cashes out their earned credits to real USDG. Uses the wallet
 * address already saved on their profile (dashboard's Payout section) --
 * they don't type one in per request. Debits the balance immediately;
 * sending the actual USDG is a manual admin step (see lib/db.js's
 * payout_requests comment for why).
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USER = 10;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  // A repeatable insufficient-balance/valid request loop is cheap per call
  // but each success writes a real payout_requests row an admin has to
  // triage -- worth capping regardless of whether it's abuse or a buggy
  // client retrying.
  const { limited, retryAfterSeconds } = consumeAttempt(`credits-payout-request:user:${ctx.user.id}`, {
    limit: MAX_PER_USER,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  if (!ctx.creator.walletAddress) {
    return res.status(400).json({ error: 'Add a payout wallet address in your profile before cashing out' });
  }

  const { amountCents } = req.body || {};
  const cents = Math.round(Number(amountCents));
  if (!Number.isFinite(cents) || cents <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    const request = await requestPayout({ userId: ctx.user.id, cents, payoutWallet: ctx.creator.walletAddress });
    const balanceCents = await getBalanceCents(ctx.user.id);
    return res.status(200).json({ ok: true, request, balanceCents });
  } catch (err) {
    if (err.code === INSUFFICIENT_BALANCE) return res.status(402).json({ error: 'Not enough credits' });
    console.error('[credits/payout-request] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
