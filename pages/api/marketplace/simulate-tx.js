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
 * GOPLUS_SUPPORTED_CHAIN_IDS (lib/marketplace-payment-config.js) is real and
 * load-bearing, not a guess: the same direct test above returned this exact
 * list in GoPlus's own validation error when an unsupported chain_id was
 * sent. Robinhood Chain (0x1237) is NOT on it, so on the chain this platform
 * actually settles payments on today, GoPlus cannot simulate the
 * transaction at all -- this reports `available: false` and the page says
 * "unavailable on this network" rather than implying a pass.
 *
 * This is a trust-layer UX signal, not the platform's actual security
 * boundary. The transaction simulated is built HERE, from server config:
 * the configured stablecoin's `transfer(payoutAddress, amount)` for the
 * amount the fan is about to pay. The client supplies only its own address
 * and that amount -- never a `to` or calldata (an earlier version forwarded
 * whatever the client sent, and the page sent an empty call to the token,
 * which is not the transaction the fan signs at all).
 *
 * Request: { from, amountCents }. Response: { available: false } |
 * { available: true, safe: true|false|null, reason }.
 */
import { encodeFunctionData, getAddress, isAddress } from 'viem';
import { getVerifiedSessionUserId } from '../../../lib/session';
import { consumeAttempt, clientIp } from '../../../lib/rate-limit';
import { getMarketplacePaymentConfig, marketplacePaymentsLive, safetyCheckAvailable } from '../../../lib/marketplace-payment-config';
import { centsToTokenUnits } from '../../../lib/wallet';

const TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
];
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USER = 30;
const MAX_PER_IP = 60;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Was reachable with no auth of any kind -- an unbounded free relay to
  // GoPlus for anyone. Login is a real gate here (only a signed-in fan
  // reaches the flow this exists for), and the rate limit bounds it further.
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

  const config = getMarketplacePaymentConfig();
  if (!marketplacePaymentsLive(config) || !safetyCheckAvailable(config.chainId)) {
    return res.status(200).json({ available: false });
  }

  const { from, amountCents } = req.body || {};
  if (typeof from !== 'string' || !isAddress(from, { strict: false })) {
    return res.status(400).json({ error: 'Missing or invalid wallet address' });
  }
  let data;
  try {
    data = encodeFunctionData({
      abi: TRANSFER_ABI,
      functionName: 'transfer',
      args: [getAddress(config.payoutAddress), centsToTokenUnits(Number(amountCents), config.usdcDecimals)],
    });
  } catch {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  const hexChainId = `0x${Number(config.chainId).toString(16)}`;

  try {
    const upstream = await fetch('https://api.gopluslabs.io/api/v1/transaction_simulation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain_id: hexChainId,
        from: getAddress(from),
        to: getAddress(config.usdcAddress),
        data,
        value: '0',
        gas_limit: '200000',
        gas_price: '1000000000',
      }),
    });
    const body = await upstream.json();
    if (!upstream.ok || body.code !== 1) {
      return res.status(200).json({ available: true, safe: null, reason: 'Simulation unavailable right now' });
    }
    const r = body.result || {};
    const safe = !r.is_revert && (!r.flagged || r.flagged.length === 0) && !r.suspicious_url;
    return res.status(200).json({ available: true, safe, reason: r.is_revert ? String(r.revert_reason || 'The transfer would fail') : null });
  } catch {
    return res.status(200).json({ available: true, safe: null, reason: 'Could not reach the simulation service' });
  }
}
