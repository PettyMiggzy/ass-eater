import { ageVerificationSecret } from '../../../lib/age-verification';
import {
  createWalletNonce,
  NONCE_TTL_SECONDS,
  ownerWalletAddress,
  walletSignInMessage,
  WALLET_NONCE_COOKIE_NAME,
} from '../../../lib/wallet-auth';
import { clientNetwork, consumeAttempt } from '../../../lib/rate-limit';

// Step one of the wallet owner login: hand out a challenge.
//
// Rate-limited even though this hands out nothing secret, because it is the
// cheap half of the flow -- issuing challenges costs a signature each and an
// unbounded one is free CPU for anyone who finds it.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 30;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // No owner wallet configured means this door does not exist. 404, not 501,
  // for the same reason /api/age-verify/owner 404s on an unset key: the
  // endpoint must not advertise that a bypass is a thing here.
  if (!ownerWalletAddress()) return res.status(404).json({ error: 'Not found' });

  const { limited } = consumeAttempt(`wallet-nonce:ip:${clientNetwork(req)}`, { limit: MAX_PER_IP, windowMs: WINDOW_MS });
  if (limited) return res.status(404).json({ error: 'Not found' });

  const { nonce, token } = await createWalletNonce(ageVerificationSecret());

  // The message is built from OUR host header, and the same derivation runs
  // again server-side at verify time -- the client is never trusted to say
  // what it signed. Returning it here is only so the page can show the user
  // the text before their wallet does.
  const host = req.headers.host || 'joinonlyone.com';
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${WALLET_NONCE_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${NONCE_TTL_SECONDS}${secure}`,
  );
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ message: walletSignInMessage({ host, nonce }) });
}
