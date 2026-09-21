import { getVerifiedSessionUserId } from '../../../lib/session';
import { ageVerificationSecret } from '../../../lib/age-verification';
import { createWalletNonce, NONCE_TTL_SECONDS, depositProofMessage, DEPOSIT_NONCE_COOKIE_NAME } from '../../../lib/wallet-auth';
import { consumeAttempt } from '../../../lib/rate-limit';

// Step one of proving a deposit's sender: hand out a one-time challenge for
// the fan's wallet to sign. Same primitive as the owner-wallet login
// (lib/wallet-auth.js), reused for its actual documented purpose -- "proving
// you own this address" is exactly what a deposit needs before the server
// will trust who sent it. A separate cookie name from the owner-login flow
// so the two can never collide if someone somehow has both flows open.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USER = 30;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in first' });

  const { limited, retryAfterSeconds } = consumeAttempt(`credits-wallet-nonce:user:${uid}`, {
    limit: MAX_PER_USER,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const { nonce, token } = await createWalletNonce(ageVerificationSecret());
  const host = req.headers.host || 'joinonlyone.com';
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${DEPOSIT_NONCE_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${NONCE_TTL_SECONDS}${secure}`,
  );
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ message: depositProofMessage({ host, nonce }) });
}
