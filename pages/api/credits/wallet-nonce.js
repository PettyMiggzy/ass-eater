import { getSessionUser } from '../../../lib/session';
import { ageVerificationSecret } from '../../../lib/age-verification';
import { createWalletNonce, NONCE_TTL_SECONDS, depositProofMessage, depositAccountLabel, DEPOSIT_NONCE_COOKIE_NAME } from '../../../lib/wallet-auth';
import { consumeAttempt } from '../../../lib/rate-limit';
import { accountStanding, isFrozenStanding, FROZEN_BUY_MESSAGE } from '../../../lib/credits-store';

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

  const user = await getSessionUser(req);
  const uid = user ? user.id : null;
  if (!uid) return res.status(401).json({ error: 'Log in first' });

  // A suspended or banned creator's balance can't be spent or cashed out, so
  // anything they deposit would be stuck. Refused at every step of buying,
  // starting before any money moves.
  if (isFrozenStanding(await accountStanding(uid))) {
    return res.status(403).json({ code: 'ACCOUNT_FROZEN', error: FROZEN_BUY_MESSAGE });
  }

  const { limited, retryAfterSeconds } = consumeAttempt(`credits-wallet-nonce:user:${uid}`, {
    limit: MAX_PER_USER,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  // Bound to this account (round-22 money#0): verify-wallet.js and buy.js
  // refuse the challenge from any other session, and the signed text names
  // the account so the signer can see what they are binding.
  const { nonce, token } = await createWalletNonce(ageVerificationSecret(), { uid });
  const host = req.headers.host || 'joinonlyone.com';
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${DEPOSIT_NONCE_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${NONCE_TTL_SECONDS}${secure}`,
  );
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ message: depositProofMessage({ host, nonce, account: depositAccountLabel(user) }) });
}
