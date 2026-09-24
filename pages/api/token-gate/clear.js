import { clearHolderCookieHeader } from '../../../lib/holder-access';

/** POST /api/token-gate/clear -- forget this browser's holder pass. 200 { ok: true }. */
export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', clearHolderCookieHeader());
  return res.status(200).json({ ok: true });
}
