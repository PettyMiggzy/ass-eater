import { clearHolderCookieHeader } from '../../../lib/holder-access';
import { refuseCrossSite } from '../../../lib/same-origin';

/** POST /api/token-gate/clear -- forget this browser's holder pass. 200 { ok: true }. */
export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Cross-site refused before the clearing cookie is set (round-21
  // gates-token#2): otherwise any website could drop a visitor's holder pass
  // with an auto-submitting form. Callers are same-origin fetches.
  if (refuseCrossSite(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', clearHolderCookieHeader());
  return res.status(200).json({ ok: true });
}
