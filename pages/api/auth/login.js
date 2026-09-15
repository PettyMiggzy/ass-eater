import { findUserByEmail, verifyPassword } from '../../../lib/users-store';
import { createSessionToken, setSessionCookie } from '../../../lib/session';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await findUserByEmail(email);
    if (!user || !(await verifyPassword(user, password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = createSessionToken(user.id);
    setSessionCookie(res, token);

    return res.status(200).json({
      ok: true,
      user: { id: user.id, email: user.email, role: user.role, creatorId: user.creatorId },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
