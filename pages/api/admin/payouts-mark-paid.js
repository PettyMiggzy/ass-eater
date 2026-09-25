import { isAddress } from 'viem';
import {
  markPayoutPaid,
  getPayoutRequest,
  PAYOUT_FROZEN,
  PAYOUT_NOT_PENDING,
  TX_HASH_REUSED,
} from '../../../lib/credits-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { verifyUsdcPayment, assertTokenDecimals } from '../../../lib/chain-verify';
import { getMarketplaceVerificationConfig, marketplaceVerificationLive } from '../../../lib/marketplace-payment-config';

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

// The wallet payouts are SENT from. Optional, server-only, and deliberately
// not defaulted to the receiving wallet (NEXT_PUBLIC_MARKETPLACE_PAYOUT_ADDRESS):
// until the owner says which wallet pays creators, a wrong default would
// refuse every genuine payout. When set, a hash only closes a payout if the
// transfer came FROM it -- otherwise any transfer of the exact amount into
// the creator's wallet (including one the creator sent to themselves)
// passed as proof the platform paid.
function payoutSenderAddress() {
  const v = String(process.env.PAYOUT_SENDER_ADDRESS || '').trim();
  if (!v) return null;
  return isAddress(v, { strict: false }) ? v : false;
}

/**
 * Manual step, deliberately: the admin has ALREADY sent the real USDG by
 * hand before calling this -- it only records that it happened, requiring
 * a real transaction hash as proof. See lib/db.js's payout_requests comment
 * for why sending is manual rather than something this endpoint triggers.
 *
 * Body: { id, txHash, override?, skipChainCheck? }
 *
 *  - The hash is checked ON-CHAIN before anything is recorded: it must be a
 *    confirmed transfer of the payout token, of EXACTLY the requested
 *    amount, to the request's own payout wallet, in a block no older than
 *    the request itself. A typo or a hash pasted into the wrong row is
 *    refused instead of telling a creator they were paid when they weren't
 *    -- "at least the amount" let a $100 transfer close a $40 request to the
 *    same wallet (and the unique hash index then stopped it closing the $100
 *    one), let an overpayment pass unnoticed, and accepted any older
 *    transfer into that wallet. The SENDER is checked too when
 *    PAYOUT_SENDER_ADDRESS is set (the payout treasury); while it is unset
 *    a transfer from any wallet passes, so set it.
 *    `skipChainCheck: true` records without that check (e.g. the server's
 *    RPC is down) -- an explicit admin decision. When the check cannot run the
 *    answer is 501 (not configured), 502 (RPC unreachable) or 503
 *    { code: 'chain_check_unavailable' } (PAYOUT_SENDER_ADDRESS invalid); the
 *    admin panel offers the skip on exactly those.
 *  - One hash closes one request (unique index; 409 if reused).
 *  - A request from an account that is no longer an active creator
 *    (banned/suspended/...) is frozen: 409 unless `override: true`.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAdminKey(req, res)) return;

  const { id, txHash, override, skipChainCheck } = req.body || {};
  const idOk = (typeof id === 'string' && /^\d{1,18}$/.test(id)) || (Number.isSafeInteger(id) && id > 0);
  if (!idOk || typeof txHash !== 'string') return res.status(400).json({ error: 'Missing id or transaction hash' });
  if (!TX_HASH_RE.test(txHash.trim())) {
    return res.status(400).json({ error: 'A real transaction hash is required to mark a payout paid' });
  }
  const hash = txHash.trim().toLowerCase();

  const request = await getPayoutRequest(id);
  if (!request || request.status !== 'pending') {
    return res.status(409).json({ error: 'Payout request not found or not pending' });
  }

  if (skipChainCheck !== true) {
    if (!isAddress(String(request.payout_wallet || ''), { strict: false })) {
      return res.status(400).json({ error: `This request's payout wallet (${request.payout_wallet || 'none'}) isn't a valid address, so it can't have been paid. Reject it instead.` });
    }
    const sender = payoutSenderAddress();
    if (sender === false) {
      console.error('[admin/payouts-mark-paid] PAYOUT_SENDER_ADDRESS is not a valid address');
      // 503 + code, not a bare 500: the admin panel offers its explicit
      // "record without the on-chain check" confirmation on this code (as it
      // does for 501/502). A genuine unexpected 500 below never offers it.
      return res.status(503).json({ code: 'chain_check_unavailable', error: 'The payout treasury address (PAYOUT_SENDER_ADDRESS) is misconfigured, so the transfer cannot be checked. Fix it, or record without the check.' });
    }
    const config = getMarketplaceVerificationConfig();
    if (!marketplaceVerificationLive(config)) {
      return res.status(501).json({ error: 'On-chain verification is not configured. Pass skipChainCheck to record without it.' });
    }
    try {
      await assertTokenDecimals({ rpcUrl: config.rpcUrl, tokenAddress: config.usdcAddress, expectedDecimals: config.usdcDecimals });
      if (config.usdcDecimals < 2) throw new Error('Configured stablecoin decimals must be at least 2');
      const exactAmount = BigInt(request.amount_cents) * 10n ** BigInt(config.usdcDecimals - 2);
      const created = new Date(request.created_at).getTime();
      await verifyUsdcPayment({
        rpcUrl: config.rpcUrl,
        txHash: hash,
        tokenAddress: config.usdcAddress,
        payoutAddress: request.payout_wallet,
        exactAmount,
        notBefore: Number.isFinite(created) ? created : undefined,
        ...(sender ? { expectedFrom: sender } : {}),
      });
    } catch (err) {
      if (err.code === 'SENDER_MISMATCH') {
        return res.status(400).json({
          error: `That transfer was not sent from the payout treasury (${sender}), so it does not show the platform paid this request.`,
          code: err.code,
        });
      }
      if (['BAD_HASH', 'NOT_CONFIRMED', 'TX_REVERTED', 'NO_MATCHING_TRANSFER', 'TX_TOO_OLD'].includes(err.code)) {
        return res.status(400).json({
          error: `That transaction doesn't show a transfer of exactly $${(Number(request.amount_cents) / 100).toFixed(2)} ${config.stableSymbol} to ${request.payout_wallet}, made after this request: ${err.message}`,
          code: err.code,
        });
      }
      console.error('[admin/payouts-mark-paid] chain check failed:', err);
      return res.status(502).json({ error: 'Could not check the transaction on-chain right now. Try again, or pass skipChainCheck to record it anyway.' });
    }
  }

  try {
    const paid = await markPayoutPaid(id, hash, { override: override === true });
    return res.status(200).json({ ok: true, request: paid });
  } catch (err) {
    // markPayoutPaid's own deliberately-thrown, safe errors -- anything
    // else is an unexpected DB failure and shouldn't reach the client as-is.
    if (err.code === PAYOUT_FROZEN || err.code === TX_HASH_REUSED || err.code === PAYOUT_NOT_PENDING) {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    if (err.message === 'A real transaction hash is required to mark a payout paid') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[admin/payouts-mark-paid] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
