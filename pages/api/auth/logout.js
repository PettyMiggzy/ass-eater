import { clearSessionCookie } from '../../../lib/session';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
}
