import { recoverMessageAddress } from 'viem';
import { getVerifiedSessionUserId } from '../../../lib/session';
import { getMarketplaceVerificationConfig, marketplaceVerificationLive } from '../../../lib/marketplace-payment-config';
import { creditDepositFromChain, TX_ALREADY_USED, BELOW_MINIMUM } from '../../../lib/deposit';
import { ageVerificationSecret } from '../../../lib/age-verification';
import { readWalletNonce, depositProofMessage, DEPOSIT_NONCE_COOKIE_NAME } from '../../../lib/wallet-auth';

/**
 * The ONLY place a fan ever needs a wallet: converting a real on-chain USDG
 * payment into a credits balance. Every purchase after this (marketplace,
 * and eventually tips/subscriptions) spends from that balance with no
 * wallet interaction at all -- see pages/api/marketplace/orders/create.js.
 *
 * Requires a signature (over a nonce from GET /api/credits/wallet-nonce)
 * proving the caller controls the wallet the payment is claimed to be from.
 * Without this, the amount+destination check alone doesn't prove who paid --
 * the payout address is public (right there in the client bundle), so
 * anyone watching the chain could submit someone else's real deposit's
 * txHash to their own account and steal the credit. See lib/chain-verify.js
 * and lib/wallet-auth.js for the full reasoning.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const config = getMarketplaceVerificationConfig();
  if (!marketplaceVerificationLive(config)) {
    return res.status(501).json({ error: 'Buying credits is not configured yet.' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to buy credits' });

  const { txHash, signature } = req.body || {};
  if (!txHash) return res.status(400).json({ error: 'Missing transaction hash' });
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return res.status(400).json({ error: 'Missing wallet signature -- verify your wallet before submitting a payment.' });
  }

  const nonce = await readWalletNonce(ageVerificationSecret(), req.cookies?.[DEPOSIT_NONCE_COOKIE_NAME]);
  if (!nonce) {
    return res.status(400).json({ error: 'Wallet verification expired. Please try again.' });
  }

  // Rebuilt from the server's own host and its own nonce -- the client sends
  // ONLY a signature, never the message it claims to have signed, or it
  // could hand over any text a real signature happened to exist for.
  const message = depositProofMessage({ host: req.headers.host || 'joinonlyone.com', nonce });

  let expectedFrom;
  try {
    expectedFrom = await recoverMessageAddress({ message, signature });
  } catch {
    return res.status(400).json({ error: 'Invalid wallet signature.' });
  }

  // Single-use: burn the challenge regardless of outcome below, same as the
  // owner-wallet login does.
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${DEPOSIT_NONCE_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);

  try {
    const result = await creditDepositFromChain({ userId: uid, txHash, expectedFrom, config });
    return res.status(200).json({ ok: true, creditedCents: result.creditedCents, feeCents: result.feeCents, balanceCents: result.balanceCents });
  } catch (err) {
    if (err.code === TX_ALREADY_USED) return res.status(409).json({ error: err.message });
    if (err.code === BELOW_MINIMUM) return res.status(400).json({ error: err.message });
    if (err.code === 'SENDER_MISMATCH') return res.status(402).json({ error: err.message, code: err.code });
    if (err.code) return res.status(402).json({ error: err.message, code: err.code });
    console.error('[credits/buy] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong confirming your payment. If USDG left your wallet, use "Already paid?" below with the same transaction to retry.' });
  }
}
