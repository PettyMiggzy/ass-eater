import { createUser } from '../../../lib/users-store';
import { createCreator } from '../../../lib/creators-store';
import { createSessionToken, setSessionCookie } from '../../../lib/session';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password, role, displayName, handle, bio } = req.body || {};
  // Field is still called "email" internally (nothing here ever sends real
  // email, it's purely a unique login identifier + display-name fallback --
  // see lib/users-store.js) but a fan can put any username in it; only
  // creators are required to use a real, `type="email"`-validated address
  // client-side. Server-side we just need a sane minimum length either way.
  const email = String(req.body?.email || '').trim();

  if (!email || email.length < 3 || !password || password.length < 6) {
    return res.status(400).json({ error: 'An email or username (3+ characters) and a password (6+ characters) are required' });
  }
  if (!['fan', 'creator'].includes(role)) {
    return res.status(400).json({ error: 'Role must be fan or creator' });
  }
  if (role === 'creator' && (!displayName || !handle)) {
    return res.status(400).json({ error: 'Display name and handle are required for creator accounts' });
  }

  try {
    let creatorId = null;

    if (role === 'creator') {
      const creator = await createCreator({
        name: displayName,
        handle: handle.startsWith('@') ? handle : `@${handle}`,
        bio: bio || '',
        status: 'pending',
        locked: true,
      });
      creatorId = creator.id;
    }

    const user = await createUser({ email, password, role, creatorId });
    const token = createSessionToken(user.id);
    setSessionCookie(res, token);

    return res.status(200).json({
      ok: true,
      user: { id: user.id, email: user.email, role: user.role, creatorId: user.creatorId },
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
