import { createUser, findUserByEmail } from '../../../lib/users-store';
import { createCreator, getCreators, isPubliclyVisible } from '../../../lib/creators-store';
import { normalizeReferralCode } from '../../../lib/referral';
import { createSessionToken, setSessionCookie } from '../../../lib/session';
import { clientIp, consumeAttempt } from '../../../lib/rate-limit';
import { withTransaction } from '../../../lib/db';
import { signupsOpen, SIGNUPS_CLOSED_MESSAGE } from '../../../lib/signups';

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

  // Checked here, before anything else, because this is the actual gate --
  // the /signup page hiding its form is a courtesy, not a control. A stale
  // tab, a bookmarked fetch or a direct POST all land here.
  if (!signupsOpen()) {
    return res.status(403).json({ error: SIGNUPS_CLOSED_MESSAGE });
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

  // Resolve the referral code to a real creator before writing anything, so
  // a forged or stale cookie credits nobody rather than writing a dangling
  // handle onto the account. Read-only, so it doesn't need to be inside the
  // transaction below.
  let referredByCreatorId = null;
  const refCode = normalizeReferralCode(req.body?.ref);
  if (refCode) {
    const existingCreators = await getCreators();
    const referrer = existingCreators.find(
      (c) => String(c.handle || '').replace(/^@/, '').toLowerCase() === refCode && isPubliclyVisible(c),
    );
    if (referrer) referredByCreatorId = String(referrer.id);
  }

  try {
    // The creator profile and the account that owns it are created in one
    // Postgres transaction: either both commit or neither does. Before this,
    // a failure between the two writes (createUser throwing, or the process
    // being killed outright before it got the chance to) could strand a
    // pending creator profile with no login that could ever claim it --
    // sitting in the admin applicant queue forever, and piling up another
    // ghost on every retry. A catch-and-manually-delete fallback closed the
    // common case (createUser throwing) but not a hard process kill between
    // the two awaits; a real transaction closes both, because Postgres
    // rolls back an uncommitted transaction on its own if the connection
    // ever drops mid-way.
    const { user, creatorId } = await withTransaction(async (client) => {
      let newCreatorId = null;
      if (role === 'creator') {
        const creator = await createCreator(
          {
            name: displayName,
            handle: handle.startsWith('@') ? handle : `@${handle}`,
            bio: bio || '',
            status: 'pending',
            // NOT locked. `locked` means token-gated (lib/token-gate.js),
            // and defaulting it on meant every real creator's photos were
            // blurred on Explore behind an 'Unlock Now' button that went
            // nowhere.
            locked: false,
          },
          client,
        );
        newCreatorId = creator.id;
      }

      // Self-referral is only knowable once the creator (if any) has an id.
      const finalReferredBy =
        referredByCreatorId && String(referredByCreatorId) === String(newCreatorId) ? null : referredByCreatorId;

      const createdUser = await createUser(
        { email, password, role, creatorId: newCreatorId, referredByCreatorId: finalReferredBy },
        client,
      );
      return { user: createdUser, creatorId: newCreatorId };
    });

    const token = createSessionToken(user.id, user.sessionVersion);
    setSessionCookie(res, token);

    return res.status(200).json({
      ok: true,
      user: { id: user.id, email: user.email, role: user.role, creatorId },
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
