import { recoverMessageAddress } from 'viem';
import { getVerifiedSessionUserId } from '../../../lib/session';
import { getMarketplaceVerificationConfig, marketplaceVerificationLive } from '../../../lib/marketplace-payment-config';
import {
  creditDepositFromChain,
  readDepositWalletToken,
  DEPOSIT_WALLET_COOKIE_NAME,
  TX_ALREADY_USED,
  BELOW_MINIMUM,
} from '../../../lib/deposit';
import { ageVerificationSecret } from '../../../lib/age-verification';
import { readWalletNonce, depositProofMessage, DEPOSIT_NONCE_COOKIE_NAME } from '../../../lib/wallet-auth';
import { consumeAttempt, clientIp } from '../../../lib/rate-limit';
import { accountStanding, isFrozenStanding } from '../../../lib/credits-store';

/**
 * The ONLY place a fan ever needs a wallet: converting a real on-chain USDG
 * payment into a credits balance. Every purchase after this (marketplace,
 * and eventually tips/subscriptions) spends from that balance with no
 * wallet interaction at all -- see pages/api/marketplace/orders/create.js.
 *
 * Requires proof that the caller controls the wallet the payment came from:
 * normally the cookie set by POST /api/credits/verify-wallet (checked before
 * the fan sends anything), or a signature over a nonce from GET
 * /api/credits/wallet-nonce.
 * Without this, the amount+destination check alone doesn't prove who paid --
 * the payout address is public (right there in the client bundle), so
 * anyone watching the chain could submit someone else's real deposit's
 * txHash to their own account and steal the credit. See lib/chain-verify.js
 * and lib/wallet-auth.js for the full reasoning.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USER = 20;
const MAX_PER_IP = 40;

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

  // Every call here does a real on-chain RPC lookup, unlike most rate-limited
  // routes in this codebase -- both keys guard against a different abuse: a
  // compromised/scripted account hammering the RPC provider, and many
  // accounts behind one IP doing the same.
  const perUser = consumeAttempt(`credits-buy:user:${uid}`, { limit: MAX_PER_USER, windowMs: WINDOW_MS });
  if (perUser.limited) {
    res.setHeader('Retry-After', String(perUser.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }
  const perIp = consumeAttempt(`credits-buy:ip:${clientIp(req)}`, { limit: MAX_PER_IP, windowMs: WINDOW_MS });
  if (perIp.limited) {
    res.setHeader('Retry-After', String(perIp.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const { txHash, signature } = req.body || {};
  if (typeof txHash !== 'string' || !txHash) return res.status(400).json({ error: 'Missing transaction hash' });

  // A suspended or banned creator's balance is frozen, so crediting it would
  // put real money where it can never be spent or withdrawn. Refused WITHOUT
  // claiming the hash: if USDG was already sent (the earlier steps refuse
  // first, so only a hand-sent transfer or a ban landing mid-purchase gets
  // here), support can still credit or return it from the admin panel.
  if (isFrozenStanding(await accountStanding(uid))) {
    return res.status(403).json({
      code: 'ACCOUNT_FROZEN',
      error: 'This account is suspended or banned, so credits can’t be added to it. If you already sent USDG, contact support with this transaction hash -- it has not been used.',
    });
  }

  // The sender proof. Preferred: the oa_deposit_wallet cookie from POST
  // /api/credits/verify-wallet, established BEFORE the fan sent anything
  // (see lib/deposit.js). Still accepted: the older one-shot signature over
  // a wallet-nonce challenge, for a page loaded before this changed.
  let expectedFrom = readDepositWalletToken(ageVerificationSecret(), req.cookies?.[DEPOSIT_WALLET_COOKIE_NAME], uid);
  if (!expectedFrom && typeof signature === 'string' && /^0x[0-9a-fA-F]+$/.test(signature)) {
    const nonce = await readWalletNonce(ageVerificationSecret(), req.cookies?.[DEPOSIT_NONCE_COOKIE_NAME]);
    if (nonce) {
      // Rebuilt from the server's own host and its own nonce -- the client
      // sends ONLY a signature, never the message it claims to have signed.
      const message = depositProofMessage({ host: req.headers.host || 'joinonlyone.com', nonce });
      try {
        expectedFrom = await recoverMessageAddress({ message, signature });
      } catch {
        expectedFrom = null;
      }
      // Single-use: burn the challenge regardless of outcome.
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${DEPOSIT_NONCE_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    }
  }
  if (!expectedFrom) {
    // By the time this runs the USDG may already have left the wallet, so
    // this must never read as "try paying again" -- that pays twice.
    return res.status(400).json({
      code: 'PROOF_REQUIRED',
      error: 'Your wallet verification has expired, but your payment is safe. Use "Already paid?" below with this transaction to verify your wallet and get credited -- do not pay again.',
    });
  }

  try {
    const result = await creditDepositFromChain({ userId: uid, txHash, expectedFrom, config });
    return res.status(200).json({ ok: true, creditedCents: result.creditedCents, feeCents: result.feeCents, balanceCents: result.balanceCents });
  } catch (err) {
    if (err.code === TX_ALREADY_USED) return res.status(409).json({ error: err.message });
    if (err.code === BELOW_MINIMUM) return res.status(400).json({ error: err.message });
    if (err.code === 'SENDER_MISMATCH') return res.status(402).json({ error: err.message, code: err.code });
    // The rest of verifyUsdcPayment's deliberately-thrown codes (lib/chain-verify.js)
    // -- every one of them was written with a message safe to show the buyer.
    // Enumerated explicitly rather than a bare `if (err.code)`: a Postgres
    // driver error or a viem/RPC network failure also carries a truthy
    // `.code` (a SQLSTATE, ECONNREFUSED, etc.), and a catch-all here would
    // leak that raw infra text straight past the generic-message fallback
    // this exact function exists to provide.
    if (['BAD_HASH', 'NOT_CONFIRMED', 'TX_REVERTED', 'NO_MATCHING_TRANSFER'].includes(err.code)) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[credits/buy] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong confirming your payment. If USDG left your wallet, use "Already paid?" below with the same transaction to retry.' });
  }
}
