import { createUser, findUserByEmail } from '../../../lib/users-store';
import { createCreator, deleteCreator } from '../../../lib/creators-store';
import { createSessionToken, setSessionCookie } from '../../../lib/session';
import { clientIp, consumeAttempt } from '../../../lib/rate-limit';

// Signup unavoidably tells the caller whether an identifier is already
// taken: there is no email-confirmation channel on this site (nothing here
// ever sends mail -- see lib/users-store.js), so "that one is taken" has to
// be said out loud or account creation is unusable. That makes this an
// account-existence oracle in exactly the way the login route deliberately
// is not, which matters here because on an adult platform the account list
// is itself the sensitive asset. Each call also costs a bcrypt hash and a
// read-modify-write of the shared users manifest, so an unmetered one is
// simultaneously the cheapest CPU-burn and account-flood vector on the
// site. Metering it per IP is what stops all three being free; it can't
// stop them outright while the "taken" answer has to be given at all.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_SIGNUPS_PER_IP = 5;

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

  // Counted after the shape checks, so somebody fumbling the form doesn't
  // spend their own budget on requests that never reached the account list.
  const { limited, retryAfterSeconds } = consumeAttempt(`signup:ip:${clientIp(req)}`, {
    limit: MAX_SIGNUPS_PER_IP,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many signup attempts from this connection. Please wait a few minutes and try again.' });
  }

  // Look for a taken identifier BEFORE writing anything. createUser checks
  // again inside its own ETag-guarded transform and that one is the
  // authoritative check (this one can go stale between here and there) --
  // but the everyday case has to stop here, because the creator profile
  // below is written before the account that owns it, so a duplicate
  // surfacing from inside createUser means rolling that profile back out
  // through deleteCreator. Putting a delete against data/creators.json on
  // the end of an ordinary "that email is taken" request, which anyone can
  // trigger at will, is not a trade worth taking -- see the rollback below.
  if (await findUserByEmail(email)) {
    return res.status(400).json({ error: 'An account with that email already exists' });
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
    // failure in createUser used to strand a pending creator profile nobody
    // can ever log into -- sitting in the admin applicant queue forever, and
    // piling up another ghost every time someone retried. Roll it back.
    //
    // The hazard this used to carry is gone: deleteCreator no longer
    // rewrites a whole manifest whose failed read fell back to the demo
    // roster, so a rollback during a storage wobble can no longer replace
    // every real creator with the seed rows. It is now a single-row DELETE.
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
