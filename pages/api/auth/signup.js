import { createUser } from '../../../lib/users-store';
import { createCreator, deleteCreator } from '../../../lib/creators-store';
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

  let newCreatorId = null;

  try {
    if (role === 'creator') {
      const creator = await createCreator({
        name: displayName,
        handle: handle.startsWith('@') ? handle : `@${handle}`,
        bio: bio || '',
        status: 'pending',
        locked: true,
      });
      newCreatorId = creator.id;
    }

    const user = await createUser({ email, password, role, creatorId: newCreatorId });
    const token = createSessionToken(user.id, user.sessionVersion);
    setSessionCookie(res, token);

    return res.status(200).json({
      ok: true,
      user: { id: user.id, email: user.email, role: user.role, creatorId: user.creatorId },
    });
  } catch (err) {
    // The creator profile is written before the account that owns it, so a
    // failure in createUser (a duplicate email is the everyday one) used to
    // strand a pending creator profile nobody can ever log into -- sitting
    // in the admin applicant queue forever, and piling up another ghost
    // every time someone retried. Roll it back.
    if (newCreatorId !== null) {
      try {
        await deleteCreator(newCreatorId);
      } catch {
        // Nothing better to do here: the original failure below is what the
        // person needs to see, and the leftover profile is still visible to
        // an admin. Don't mask the real error with this one.
      }
    }
    return res.status(400).json({ error: err.message });
  }
}
