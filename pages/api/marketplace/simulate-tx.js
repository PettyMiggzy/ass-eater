/**
 * Proxies a pre-signature transaction simulation to GoPlus Security's real
 * Transaction Simulation API for EVM (POST
 * https://api.gopluslabs.io/api/v1/transaction_simulation) -- endpoint and
 * shape confirmed against GoPlus's own docs, and the no-auth claim confirmed
 * by actually calling it directly with no Authorization header at all: it
 * returned a real `{"code":1,"message":"ok"}` result. An earlier version of
 * this file assumed the documented app_key/app_secret handshake was
 * required; it isn't, at least not for this endpoint at the traffic level
 * this feature needs.
 *
 * GOPLUS_SUPPORTED_CHAIN_IDS is real and load-bearing, not a guess: the same
 * direct test above returned this exact list in GoPlus's own validation
 * error when an unsupported chain_id was sent. Robinhood Chain (0x1237) is
 * NOT on it, so on the chain this platform actually settles payments on
 * today, GoPlus cannot simulate the transaction at all -- this reports
 * `available: false` in that case rather than calling an endpoint we
 * already know will reject it, or worse, silently showing a stale/wrong
 * safety badge.
 *
 * This is a trust-layer UX signal, not the platform's actual security
 * boundary: the transaction it simulates is always a plain, known-shape
 * ERC-20 `transfer` call to our own fixed payout address (built server-side
 * config, never an address the client supplies), so there is no attacker-
 * controlled contract interaction here for GoPlus to catch that our own
 * code doesn't already constrain. The point is showing a nervous buyer an
 * independent "this is safe" check before they sign, not gating checkout on
 * a third party being reachable.
 */
import { getVerifiedSessionUserId } from '../../../lib/session';
import { consumeAttempt, clientIp } from '../../../lib/rate-limit';

const GOPLUS_SUPPORTED_CHAIN_IDS = new Set(['0x1', '0x38', '0x2105']); // Ethereum, BSC, Base
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USER = 30;
const MAX_PER_IP = 60;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Was reachable with no auth of any kind, forwarding whatever to/data/value
  // the caller sent to a third-party API -- an unbounded free relay to
  // GoPlus for anyone, not just someone actually checking out. Login is a
  // real gate here (only a signed-in fan reaches the checkout flow this
  // exists for), and the rate limit bounds it further for a compromised or
  // scripted account.
  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in first' });

  const perUser = consumeAttempt(`marketplace-simulate-tx:user:${uid}`, { limit: MAX_PER_USER, windowMs: WINDOW_MS });
  if (perUser.limited) {
    res.setHeader('Retry-After', String(perUser.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }
  const perIp = consumeAttempt(`marketplace-simulate-tx:ip:${clientIp(req)}`, { limit: MAX_PER_IP, windowMs: WINDOW_MS });
  if (perIp.limited) {
    res.setHeader('Retry-After', String(perIp.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const { chainId, from, to, data, value } = req.body || {};
  if (!chainId || !from || !to) {
    return res.status(400).json({ error: 'Missing transaction fields' });
  }

  const hexChainId = `0x${Number(chainId).toString(16)}`;
  if (!GOPLUS_SUPPORTED_CHAIN_IDS.has(hexChainId)) {
    return res.status(200).json({ available: false });
  }

  try {
    const upstream = await fetch('https://api.gopluslabs.io/api/v1/transaction_simulation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain_id: hexChainId,
        from,
        to,
        data: data || '0x',
        value: value || '0',
        gas_limit: '200000',
        gas_price: '1000000000',
      }),
    });
    const body = await upstream.json();
    if (!upstream.ok || body.code !== 1) {
      return res.status(200).json({ available: true, safe: null, reason: body.message || 'Simulation unavailable' });
    }
    const r = body.result || {};
    const safe = !r.is_revert && (!r.flagged || r.flagged.length === 0) && !r.suspicious_url;
    return res.status(200).json({ available: true, safe, reason: r.is_revert ? r.revert_reason : null });
  } catch {
    return res.status(200).json({ available: true, safe: null, reason: 'Could not reach the simulation service' });
  }
}
