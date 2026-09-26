import { createPublicClient, http, isAddress, getAddress, recoverMessageAddress } from 'viem';
import { getSessionUser } from '../../../lib/session';
import { ageVerificationSecret } from '../../../lib/age-verification';
import { readWalletNonce, depositProofMessage, depositAccountLabel, sameAddress, DEPOSIT_NONCE_COOKIE_NAME } from '../../../lib/wallet-auth';
import { createDepositWalletToken, DEPOSIT_WALLET_COOKIE_NAME, DEPOSIT_WALLET_TTL_SECONDS } from '../../../lib/deposit';
import { getMarketplaceVerificationConfig, marketplaceVerificationLive } from '../../../lib/marketplace-payment-config';
import { consumeAttempt } from '../../../lib/rate-limit';
import { accountStanding, isFrozenStanding, FROZEN_BUY_MESSAGE } from '../../../lib/credits-store';
import { refuseMalformedText } from '../../../lib/field-validation';

/**
 * Step two of buying credits, BEFORE any money moves: prove the connected
 * wallet is yours.
 *
 * Body: { address, signature } -- a signature (from the wallet the fan is
 * about to pay from) over the message GET /api/credits/wallet-nonce issued.
 * On success: 200 { address } and a signed `oa_deposit_wallet` cookie
 * (2 hours, bound to this account and this address). /api/credits/buy then
 * accepts just a tx hash and checks the transaction's sender against it.
 *
 * Doing this first is the point: if anything about the proof is wrong
 * (expired, wrong account, a wallet whose signatures don't verify), the fan
 * finds out before sending USDG, not after. Smart-contract wallets
 * (ERC-1271) are verified through the chain when a plain ecrecover doesn't
 * match.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USER = 30;

export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const config = getMarketplaceVerificationConfig();
  if (!marketplaceVerificationLive(config)) {
    return res.status(501).json({ error: 'Buying credits is not configured yet.' });
  }

  const user = await getSessionUser(req);
  const uid = user ? user.id : null;
  if (!uid) return res.status(401).json({ error: 'Log in first' });

  // Refused BEFORE the fan sends anything: a suspended or banned creator's
  // credits are frozen (lib/credits-store.js), so a deposit could never be
  // spent or withdrawn. See also wallet-nonce.js and buy.js.
  if (isFrozenStanding(await accountStanding(uid))) {
    return res.status(403).json({ code: 'ACCOUNT_FROZEN', error: FROZEN_BUY_MESSAGE });
  }

  const { limited, retryAfterSeconds } = consumeAttempt(`credits-verify-wallet:user:${uid}`, { limit: MAX_PER_USER, windowMs: WINDOW_MS });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const { address, signature } = req.body || {};
  if (typeof address !== 'string' || !isAddress(address, { strict: false })) {
    return res.status(400).json({ error: 'Missing or invalid wallet address.' });
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature) || signature.length > 20000) {
    return res.status(400).json({ error: 'Missing wallet signature.' });
  }

  // Only a challenge minted for THIS account (round-22 money#0): a nonce
  // cookie from another session -- with a signature phished to match it --
  // must not bind that wallet here.
  const nonce = await readWalletNonce(ageVerificationSecret(), req.cookies?.[DEPOSIT_NONCE_COOKIE_NAME], { uid });
  if (!nonce) {
    return res.status(400).json({ error: 'Wallet verification expired. Please verify your wallet again -- nothing has been sent.' });
  }
  // Rebuilt from the server's own host, its own nonce and the session's own
  // account -- never from text the client supplies.
  const message = depositProofMessage({ host: req.headers.host || 'joinonlyone.com', nonce, account: depositAccountLabel(user) });

  let ok = false;
  try {
    const recovered = await recoverMessageAddress({ message, signature });
    ok = sameAddress(recovered, address);
  } catch {
    ok = false;
  }
  if (!ok) {
    // Not a plain EOA signature for this address -- it may be a
    // smart-contract wallet, which only the chain can verify.
    try {
      const client = createPublicClient({ transport: http(config.rpcUrl) });
      ok = await client.verifyMessage({ address: getAddress(address), message, signature });
    } catch {
      ok = false;
    }
  }

  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  // The challenge is single-use whatever the outcome.
  const clearNonce = `${DEPOSIT_NONCE_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  if (!ok) {
    res.setHeader('Set-Cookie', clearNonce);
    return res.status(400).json({ error: 'That signature doesn’t match the connected wallet. Nothing has been sent -- try again.' });
  }

  const token = createDepositWalletToken(ageVerificationSecret(), { uid, address });
  res.setHeader('Set-Cookie', [
    clearNonce,
    `${DEPOSIT_WALLET_COOKIE_NAME}=${token}; Path=/api/credits; HttpOnly; SameSite=Lax; Max-Age=${DEPOSIT_WALLET_TTL_SECONDS}${secure}`,
  ]);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ address: getAddress(address) });
}
