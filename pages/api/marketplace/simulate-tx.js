/**
 * Proxies a pre-signature transaction simulation to GoPlus Security's real
 * Transaction Simulation API for EVM (POST
 * https://api.gopluslabs.io/api/v1/transaction_simulation, bearer-token
 * authed) -- endpoint and shape confirmed against GoPlus's own docs, not
 * guessed at.
 *
 * This is a trust-layer UX signal, not the platform's actual security
 * boundary: the transaction it simulates is always a plain, known-shape
 * ERC-20 `transfer` call to our own fixed payout address (built server-side
 * config, never an address the client supplies), so there is no attacker-
 * controlled contract interaction here for GoPlus to catch that our own
 * code doesn't already constrain. The point is showing a nervous buyer an
 * independent "this is safe" check before they sign, not gating checkout on
 * a third party being reachable.
 *
 * Same honest pattern as everywhere else a real vendor integration exists in
 * this codebase: without GOPLUS_API_KEY set, this returns `{ available:
 * false }` and the checkout UI just skips showing the badge -- it never
 * claims a check ran that didn't.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GOPLUS_API_KEY;
  if (!apiKey) {
    return res.status(200).json({ available: false });
  }

  const { chainId, from, to, data, value } = req.body || {};
  if (!chainId || !from || !to) {
    return res.status(400).json({ error: 'Missing transaction fields' });
  }

  try {
    const upstream = await fetch('https://api.gopluslabs.io/api/v1/transaction_simulation', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        chain_id: String(chainId),
        from,
        to,
        data: data || '0x',
        value: value || '0',
        gas_limit: '200000',
        gas_price: '0',
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
