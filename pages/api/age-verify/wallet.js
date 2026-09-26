import { recoverMessageAddress } from 'viem';
import {
  AGE_VERIFIED_COOKIE_NAME,
  ageVerificationSecret,
  bypassMaxAgeSeconds,
  createBypassAgeVerificationToken,
} from '../../../lib/age-verification';
import {
  ownerWalletAddress,
  readWalletNonce,
  sameAddress,
  walletSignInMessage,
  WALLET_NONCE_COOKIE_NAME,
} from '../../../lib/wallet-auth';
import { checkRateLimit, clearFailures, clientNetwork, recordFailure } from '../../../lib/rate-limit';
import { findMalformedText } from '../../../lib/unicode-text';

/**
 * Step two of the wallet owner login: check the signature.
 *
 * This is the same hole in the same legal control that
 * /api/age-verify/owner?key= is, and everything that route's header says
 * about that still applies -- read it. What changes is what has to be kept
 * safe. There is no shared secret here at all: the server stores a public
 * address, and the thing that opens the door is a signature only the private
 * key can produce. Nothing typeable, nothing to leak in a URL, nothing in
 * browser history, and no value in intercepting a used challenge.
 *
 * The key route is deliberately kept alongside this one. It is how the
 * owner's partner gets in, and she does not have his wallet.
 *
 * The cookie this sets is a 180-day age-verification cookie bound to the
 * configured OWNER_WALLET_ADDRESS (see createBypassAgeVerificationToken in
 * lib/age-verification.js): changing or removing that env var revokes every
 * cookie issued through this door on the next request. `via` records which
 * door was used, so a decoded token can be told apart from a real AgeChecker
 * pass.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 10;

export default async function handler(req, res) {
  // No owner wallet configured means this door does not exist, and that
  // check comes FIRST: every answer below it (a wrong method, malformed
  // text) used to be a distinct 405/400 that confirmed the endpoint is real
  // on a deployment with no wallet at all (round-12 gates-token#0). Every
  // refusal here is the same 404 with the same body, like wallet-nonce,
  // owner and reviewer.
  const owner = ownerWalletAddress();
  if (!owner) return res.status(404).json({ error: 'Not found' });
  if (req.method !== 'POST') return res.status(404).json({ error: 'Not found' });
  // NUL / half-an-emoji anywhere in the request: refused, never a 500 from
  // the database -- but as the same 404, not refuseMalformedText's 400.
  if (findMalformedText(req.body) !== null || findMalformedText(req.query) !== null) {
    return res.status(404).json({ error: 'Not found' });
  }

  const bucket = `wallet-access:ip:${clientNetwork(req)}`;
  if (checkRateLimit(bucket, { limit: MAX_FAILURES_PER_IP, windowMs: WINDOW_MS }).limited) {
    return res.status(404).json({ error: 'Not found' });
  }

  const fail = () => {
    recordFailure(bucket, { limit: MAX_FAILURES_PER_IP, windowMs: WINDOW_MS });
    // Every failure is the same 404 with the same body. Distinguishing
    // "wrong wallet" from "expired challenge" would confirm to a stranger
    // both that this endpoint is real and which half they got right.
    return res.status(404).json({ error: 'Not found' });
  };

  const signature = req.body?.signature;
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) return fail();

  const nonce = await readWalletNonce(ageVerificationSecret(), req.cookies?.[WALLET_NONCE_COOKIE_NAME]);
  if (!nonce) return fail();

  // Rebuilt from the server's own host and the server's own nonce. The
  // client sends ONLY a signature -- if it could also supply the message, it
  // could hand over any text a real signature happened to exist for and this
  // would verify it happily.
  const message = walletSignInMessage({ host: req.headers.host || 'joinonlyone.com', nonce });

  let recovered;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch {
    // Malformed signatures throw rather than returning a wrong address.
    return fail();
  }

  if (!sameAddress(recovered, owner)) {
    console.warn(`[wallet-access] rejected sign-in from ${recovered} on host ${req.headers.host || 'unknown'}`);
    return fail();
  }

  clearFailures(bucket);

  const token = await createBypassAgeVerificationToken(ageVerificationSecret(), 'owner-wallet');
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `${AGE_VERIFIED_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${bypassMaxAgeSeconds('owner-wallet')}${secure}`,
    // Burn the challenge. It is single-use by intent, and leaving it live
    // for the rest of its five minutes serves nothing.
    `${WALLET_NONCE_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  ]);
  console.warn(`[wallet-access] owner sign-in granted on host ${req.headers.host || 'unknown'}`);
  return res.status(200).json({ ok: true, next: '/home' });
}
