import { requireAdminKey } from '../../../lib/admin-auth';
import { creditDepositFromChain, TX_ALREADY_USED, BELOW_MINIMUM } from '../../../lib/deposit';
import { getMarketplaceVerificationConfig, marketplaceVerificationLive } from '../../../lib/marketplace-payment-config';

/**
 * Support fallback for a fan whose payment landed on-chain but the browser
 * died before /api/credits/buy ever ran (closed tab, crashed wallet app,
 * lost connection right after broadcasting). The self-service path
 * (pages/credits.js's "Already paid?" box) covers the same case for anyone
 * who can still reach the site with the same wallet -- this exists for
 * whoever can't, and reaches an admin instead.
 *
 * Deliberately requires `fromAddress` explicitly rather than skipping the
 * sender check: the admin has to state which wallet the fan says they paid
 * from (confirmed some other way -- a support conversation, a screenshot),
 * and the on-chain check below still confirms a real transfer from that
 * exact address actually exists before anything is credited. This can't be
 * fabricated -- it can only misattribute a real payment if the admin is
 * given a wrong address, which is a support-process risk, not a code one.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAdminKey(req, res)) return;

  const config = getMarketplaceVerificationConfig();
  if (!marketplaceVerificationLive(config)) {
    return res.status(501).json({ error: 'Credits payments are not configured.' });
  }

  const { userId, txHash, fromAddress } = req.body || {};
  if (!userId || !txHash || !fromAddress) {
    return res.status(400).json({ error: 'userId, txHash, and fromAddress are all required' });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(fromAddress))) {
    return res.status(400).json({ error: 'fromAddress is not a valid wallet address' });
  }

  try {
    const result = await creditDepositFromChain({ userId, txHash, expectedFrom: fromAddress, config });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err.code === TX_ALREADY_USED) return res.status(409).json({ error: err.message });
    if (err.code === BELOW_MINIMUM) return res.status(400).json({ error: err.message });
    if (err.code === 'SENDER_MISMATCH') return res.status(400).json({ error: `That transaction was not sent from ${fromAddress}.` });
    if (err.code) return res.status(400).json({ error: err.message });
    console.error('[admin/manual-credit] unexpected error:', err);
    return res.status(500).json({ error: 'internal' });
  }
}
