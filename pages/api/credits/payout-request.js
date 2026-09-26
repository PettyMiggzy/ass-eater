import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { effectiveCreatorStatus, isDemoCreator } from '../../../lib/creators-store';
import {
  requestPayout,
  getBalanceSummary,
  normalizePayoutWallet,
  INSUFFICIENT_BALANCE,
  INSUFFICIENT_WITHDRAWABLE,
  INVALID_PAYOUT_WALLET,
  PAYOUT_NOT_ALLOWED,
} from '../../../lib/credits-store';
import { consumeAttempt } from '../../../lib/rate-limit';
import { refuseMalformedText } from '../../../lib/field-validation';

/**
 * A creator cashes out their EARNED credits to real USDG. Uses the wallet
 * address already saved on their profile (dashboard's Payout section) --
 * they don't type one in per request. Debits the balance immediately;
 * sending the actual USDG is a manual admin step (see lib/db.js's
 * payout_requests comment for why).
 *
 * Only an active (approved, not suspended/banned, not demo) creator may cash
 * out, only to a valid EVM address, only in USDG, and only up to their
 * withdrawable (earned) credits -- credits they bought themselves are
 * spend-only. requestPayout re-checks all of it inside its transaction;
 * the checks here only give a clearer message sooner.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USER = 10;

export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
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

  // requireCreatorOwner lets a PENDING (unreviewed) creator through so they
  // can finish their profile; cashing out is not part of that.
  if (effectiveCreatorStatus(ctx.creator) !== 'active' || isDemoCreator(ctx.creator)) {
    return res.status(403).json({ error: 'Cash-outs open once your creator account is approved.' });
  }

  if (!ctx.creator.walletAddress) {
    return res.status(400).json({ error: 'Add a payout wallet address in your profile before cashing out' });
  }
  let wallet;
  try {
    wallet = normalizePayoutWallet(ctx.creator.walletAddress);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const { amountCents } = req.body || {};
  if (typeof amountCents !== 'number' && typeof amountCents !== 'string') {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  const cents = Math.round(Number(amountCents));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    const request = await requestPayout({ userId: ctx.user.id, cents, payoutWallet: wallet });
    const { balanceCents, withdrawableCents } = await getBalanceSummary(ctx.user.id);
    return res.status(200).json({ ok: true, request, balanceCents, withdrawableCents });
  } catch (err) {
    if (err.code === INSUFFICIENT_BALANCE) return res.status(402).json({ error: 'Not enough credits' });
    if (err.code === INSUFFICIENT_WITHDRAWABLE) return res.status(402).json({ error: err.message, code: err.code });
    if (err.code === INVALID_PAYOUT_WALLET) return res.status(400).json({ error: err.message });
    if (err.code === PAYOUT_NOT_ALLOWED) return res.status(403).json({ error: err.message });
    console.error('[credits/payout-request] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
