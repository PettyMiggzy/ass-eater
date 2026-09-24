import { isAddress, getAddress, recoverMessageAddress } from 'viem';
import { ageVerificationSecret } from '../../../lib/age-verification';
import { parseCookies } from '../../../lib/session';
import { readWalletNonce, sameAddress } from '../../../lib/wallet-auth';
import { holderProofMessage, HOLDER_NONCE_COOKIE_NAME } from '../../../lib/token-gate';
import {
  holderVerificationLive,
  holderChainClient,
  readHolderBalance,
  createHolderToken,
  holderCookieHeader,
  HOLDER_TTL_SECONDS,
} from '../../../lib/holder-access';
import { consumeAttempt, clientIp } from '../../../lib/rate-limit';

/**
 * POST /api/token-gate/verify { address, signature }
 *
 * Step two: the signature must be over the message GET /api/token-gate/nonce
 * issued to THIS browser (the nonce is read from its signed cookie and the
 * message rebuilt from the server's own host -- nothing the client sends is
 * used as text). Once the signer is proven, the server reads balanceOf() and
 * decimals() of $ONLYONE from its OWN RPC and sets a signed, 1-hour
 * `oa_holder` cookie. The client never reports a balance.
 *
 * 200 { address, balance, expiresAt }   balance = whole tokens, decimal string
 * 400 { error } bad input / expired challenge / signature mismatch
 * 429 rate limited, 501 not configured, 502 the chain could not be read
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 20;
// ERC-6492 wrapped-signature suffix (a counterfactual smart-wallet signature).
const ERC6492_MAGIC = '6492649264926492649264926492649264926492649264926492649264926492';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  if (!holderVerificationLive()) {
    return res.status(501).json({ error: 'Token-gate verification is not available yet.' });
  }

  const { limited, retryAfterSeconds } = consumeAttempt(`token-gate-verify:ip:${clientIp(req)}`, {
    limit: MAX_PER_IP,
    windowMs: WINDOW_MS,
  });
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

  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  // The challenge is single-use whatever the outcome.
  const clearNonce = `${HOLDER_NONCE_COOKIE_NAME}=; Path=/api/token-gate; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;

  try {
    const nonce = await readWalletNonce(ageVerificationSecret(), parseCookies(req)[HOLDER_NONCE_COOKIE_NAME]);
    if (!nonce) {
      res.setHeader('Set-Cookie', clearNonce);
      return res.status(400).json({ error: 'That request expired. Please try again.' });
    }
    const message = holderProofMessage({ host: req.headers.host || 'joinonlyone.com', nonce });

    let ok = false;
    try {
      ok = sameAddress(await recoverMessageAddress({ message, signature }), address);
    } catch {
      ok = false;
    }
    if (!ok) {
      // Possibly a smart-contract wallet (ERC-1271/6492), which only the chain
      // can verify. Only worth an eth_call (which simulates caller-shaped
      // calldata) when the signature is 6492-wrapped for a not-yet-deployed
      // wallet, or when the address actually has code; a plain wrong EOA
      // signature stops here.
      try {
        const client = holderChainClient();
        const is6492 = signature.toLowerCase().endsWith(ERC6492_MAGIC);
        const code = is6492 ? null : await client.getCode({ address: getAddress(address) });
        if (is6492 || (code && code !== '0x')) {
          ok = await client.verifyMessage({ address: getAddress(address), message, signature });
        }
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      res.setHeader('Set-Cookie', clearNonce);
      return res.status(400).json({ error: 'That signature doesn’t match the connected wallet. Please try again.' });
    }

    let balance;
    try {
      balance = await readHolderBalance(address, { fresh: true });
    } catch (err) {
      console.error('[token-gate/verify] balance read failed:', err && err.message);
      res.setHeader('Set-Cookie', clearNonce);
      return res.status(502).json({ error: 'Couldn’t read your $ONLYONE balance right now. Please try again shortly.' });
    }

    const now = Date.now();
    const token = createHolderToken({ address, balance }, now);
    res.setHeader('Set-Cookie', [clearNonce, holderCookieHeader(token)]);
    return res.status(200).json({
      address: getAddress(address),
      balance: balance.toString(),
      expiresAt: new Date(now + HOLDER_TTL_SECONDS * 1000).toISOString(),
    });
  } catch (err) {
    console.error('[token-gate/verify] unexpected error:', err);
    if (!res.headersSent) {
      res.setHeader('Set-Cookie', clearNonce);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }
}
