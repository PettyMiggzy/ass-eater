import { ageVerificationSecret } from '../../../lib/age-verification';
import { createWalletNonce, NONCE_TTL_SECONDS } from '../../../lib/wallet-auth';
import { holderProofMessage, HOLDER_NONCE_COOKIE_NAME } from '../../../lib/token-gate';
import { holderVerificationLive } from '../../../lib/holder-access';
import { consumeNetworkAttempt } from '../../../lib/rate-limit';

/**
 * GET /api/token-gate/nonce -- step one of proving a $ONLYONE holding.
 *
 * 200 { message } plus a signed, 5-minute, single-use `oa_holder_nonce`
 * cookie. The browser asks the wallet to personal_sign exactly `message`,
 * then POSTs { address, signature } to /api/token-gate/verify.
 * 501 when the verifier is not configured (no token address or no RPC).
 *
 * No login is needed: holding a token is a property of a wallet, not an
 * account, and many fans browse without one. Same stateless signed-cookie
 * nonce primitive as the owner login and deposit proof (lib/wallet-auth.js),
 * under its own cookie name, with a message that names this flow so a
 * signature for one can never be replayed into another.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 60;
// Per IPv6 /48 (round-10 gates-token#1): one routed allocation is 65,536
// /64s, and without this each could mint its own budget -- and its own key in
// the limiter's map. Generous, since a carrier puts many subscribers in one.
const MAX_PER_NETWORK = MAX_PER_IP * 10;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  if (!holderVerificationLive()) {
    return res.status(501).json({ error: 'Token-gate verification is not available yet.' });
  }

  const { limited, retryAfterSeconds } = consumeNetworkAttempt(req, 'token-gate-nonce', {
    networkLimit: MAX_PER_NETWORK,
    limit: MAX_PER_IP,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  try {
    const { nonce, token } = await createWalletNonce(ageVerificationSecret());
    const host = req.headers.host || 'joinonlyone.com';
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${HOLDER_NONCE_COOKIE_NAME}=${token}; Path=/api/token-gate; HttpOnly; SameSite=Lax; Max-Age=${NONCE_TTL_SECONDS}${secure}`,
    );
    return res.status(200).json({ message: holderProofMessage({ host, nonce }) });
  } catch (err) {
    console.error('[token-gate/nonce] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
