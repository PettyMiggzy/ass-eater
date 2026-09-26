import { createUser, findUserByEmail } from '../../../lib/users-store';
import { createCreator, getCreators, isPubliclyVisible } from '../../../lib/creators-store';
import { normalizeReferralCode } from '../../../lib/referral';
import { createSessionToken, setSessionCookie } from '../../../lib/session';
import { clientIp, clientNetwork, clientNetworkCoarse, consumeAttempt, refundAttempt } from '../../../lib/rate-limit';
import { withTransaction } from '../../../lib/db';
import { signupsOpen, SIGNUPS_CLOSED_MESSAGE } from '../../../lib/signups';
import {
  validateTextFields,
  normalizeHandle,
  handleKey,
  isEmailIdentifier,
  USERNAME_RE,
  EMAIL_IDENTIFIER_MAX,
  PASSWORD_MAX,
  looksLikePhoneNumber,
  PHONE_NAME_MESSAGE,
  isReservedName,
  RESERVED_NAME_MESSAGE,
  refuseMalformedText,
} from '../../../lib/field-validation';
import { screenPublicText, publicProfileTextEntries } from '../../../lib/prohibited-terms';
import { addViolation } from '../../../lib/violations-store';
import { isHandleConflict, HANDLE_TAKEN_MESSAGE } from '../../../lib/users-store';
import { CURRENT_TOS_VERSION } from '../../../lib/orders-store';
import { refuseCrossSite } from '../../../lib/same-origin';

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
// A second, generous bucket per IPv6 /48 (round-9 gates-token#0): one party
// can hold 65,536 /64s. Same address as the first for IPv4.
const MAX_SIGNUPS_PER_NETWORK = 25;

// Something@domain.tld, with a 2+ letter TLD and no whitespace.
const CREATOR_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/;

export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Login CSRF (round-14 gates-token#0): a cross-site form must not be able
  // to sign a visitor into someone else's account (lib/same-origin.js).
  if (refuseCrossSite(req, res)) return;

  // Checked here, before anything else, because this is the actual gate --
  // the /signup page hiding its form is a courtesy, not a control. A stale
  // tab, a bookmarked fetch or a direct POST all land here.
  if (!signupsOpen()) {
    return res.status(403).json({ error: SIGNUPS_CLOSED_MESSAGE });
  }

  const { password, role, displayName: rawDisplayName, bio } = req.body || {};
  // Trimmed on the way in: a whitespace-only name passed the "required"
  // check and was stored as-is, so the creator showed with a blank name on
  // every card and as the author of their wall posts and DMs.
  const displayName = typeof rawDisplayName === 'string' ? rawDisplayName.trim() : rawDisplayName;
  let { handle } = req.body || {};
  // Field is still called "email" internally (nothing here ever sends real
  // email, it's purely a unique login identifier + display-name fallback --
  // see lib/users-store.js) but a fan can put any username in it; only
  // creators are required to use a real, `type="email"`-validated address
  // client-side. Server-side we just need a sane minimum length either way.
  const email = String(req.body?.email || '').trim();

  if (!email || email.length < 3 || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'An email or username (3+ characters) and a password (6+ characters) are required' });
  }
  if (password.length > PASSWORD_MAX) {
    return res.status(400).json({ error: `Password must be ${PASSWORD_MAX} characters or fewer` });
  }
  // A username (no "@") is shown publicly as this account's name on wall
  // comments and DMs (lib/users-store.js displayNameFor), so it is public
  // text: capped, restricted to a plain charset, and screened below like any
  // other public field. An email-shaped identifier is never shown and just
  // gets a sane upper bound.
  if (isEmailIdentifier(email)) {
    if (email.length > EMAIL_IDENTIFIER_MAX) {
      return res.status(400).json({ error: `Email must be ${EMAIL_IDENTIFIER_MAX} characters or fewer` });
    }
  } else if (!USERNAME_RE.test(email)) {
    return res.status(400).json({ error: 'Usernames are 3-40 characters: letters, numbers, ".", "_" or "-".' });
  } else if (looksLikePhoneNumber(email)) {
    // A username is published; a phone number as one would be too. Same
    // helper as creator handles and display names (lib/field-validation.js).
    return res.status(400).json({ error: "A username can't be a phone number -- it's shown publicly on your comments and messages." });
  } else if (isReservedName(email)) {
    // Shown as the author of every comment and DM this account writes.
    return res.status(400).json({ error: RESERVED_NAME_MESSAGE });
  }
  if (!['fan', 'creator'].includes(role)) {
    return res.status(400).json({ error: 'Role must be fan or creator' });
  }
  // A creator's login is how an admin reaches an applicant (for the photo ID
  // the §2257 record needs before approval -- pages/api/admin/creators.js),
  // so it has to be a real, deliverable-looking address. The page's
  // type="email" input is a courtesy; a direct POST used to create a creator
  // with a bare username nobody could ever contact. Fans keep the username
  // option on purpose (anonymous fan signup).
  if (role === 'creator' && !CREATOR_EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Creator accounts need a real email address so we can reach you for verification.' });
  }
  // Terms §1 has every account holder represent that they are 18+ and accept
  // the Terms. The checkbox on /signup is a courtesy; this is the control,
  // and the acceptance (version + time) is stored on the account below so
  // there is a record of it. Must be exactly `true` -- a direct POST that
  // leaves it out creates nothing.
  if (req.body?.acceptedTerms !== true) {
    return res.status(400).json({ error: 'You must confirm you are 18 or older and agree to the Terms of Service and Privacy Policy.' });
  }
  if (role === 'creator' && (!displayName || !handle)) {
    return res.status(400).json({ error: 'Display name and handle are required for creator accounts' });
  }
  // Same crash class already fixed on every other creator-writing endpoint
  // (me/profile.js, admin/profile.js, admin/create.js, marketplace/create.js):
  // an object or over-length value here would be written straight into
  // Postgres and later 500 /search and /creators via .toLowerCase() for every
  // visitor, the moment this creator becomes publicly visible. This is the
  // one creator-writing path that's reachable with no login at all, so it
  // gets the same guard as the others.
  if (role === 'creator') {
    const invalid = validateTextFields({ name: displayName, handle, bio }, ['name', 'handle', 'bio']);
    if (invalid) return res.status(400).json({ error: invalid });
    // One canonical stored form ("@" + body), the same one the profile
    // editors write, so "alice" and "@alice" can never be two creators.
    const normalized = normalizeHandle(handle);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    handle = normalized.handle;
    if (looksLikePhoneNumber(displayName)) return res.status(400).json({ error: PHONE_NAME_MESSAGE });
    if (isReservedName(displayName) || isReservedName(handle)) {
      return res.status(400).json({ error: RESERVED_NAME_MESSAGE });
    }
  }

  // Counted after the shape checks, so somebody fumbling the form doesn't
  // spend their own budget on requests that never reached the account list.
  const { limited, retryAfterSeconds } = consumeAttempt(`signup:ip:${clientNetwork(req)}`, {
    limit: MAX_SIGNUPS_PER_IP,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many signup attempts from this connection. Please wait a few minutes and try again.' });
  }
  if (clientNetworkCoarse(req) !== clientNetwork(req)) {
    const perNet = consumeAttempt(`signup:net:${clientNetworkCoarse(req)}`, { limit: MAX_SIGNUPS_PER_NETWORK, windowMs: WINDOW_MS });
    if (perNet.limited) {
      refundAttempt(`signup:ip:${clientNetwork(req)}`);
      res.setHeader('Retry-After', String(perNet.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many signup attempts from this connection. Please wait a few minutes and try again.' });
    }
  }

  // The same public-text screen every other creator-text writer runs
  // (payment circumvention + prohibited terms). Signup used to be the one
  // path with no filter at all, and admin approval then skipped the
  // unchanged text -- so a signup bio of "cashapp $jane" went public on
  // approval with nothing logged. A fan's username is on the list because it
  // becomes the public author name of every comment and DM they write.
  // After the rate limit, so a flood of flagged signups can't flood the
  // violations queue for free.
  const publicText = role === 'creator'
    ? publicProfileTextEntries({ name: displayName, handle, bio: bio || '' })
    : isEmailIdentifier(email) ? [] : [['username', email]];
  for (const [context, value] of publicText) {
    const hit = screenPublicText(value, { context });
    if (hit) {
      await addViolation({ userId: `signup:ip:${clientIp(req)}`, context, reasons: hit.reasons, snippet: value });
      return res.status(400).json({ error: hit.message });
    }
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
    // handleKey is the same "@"-stripped, lowercased form the unique index
    // compares, so at most one creator can ever match.
    const referrer = existingCreators.find((c) => handleKey(c.handle) === refCode && isPubliclyVisible(c));
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
            handle,
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

      const acceptedAt = new Date().toISOString();
      const createdUser = await createUser(
        {
          email,
          password,
          role,
          creatorId: newCreatorId,
          referredByCreatorId: finalReferredBy,
          acceptance: { tosAcceptedAt: acceptedAt, tosVersion: CURRENT_TOS_VERSION, ageAttestedAt: acceptedAt },
        },
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
    // createUser() converts its OWN email collision into a plain Error with
    // no .code (see lib/users-store.js). A raw 23505 reaching here is a
    // creators constraint -- and only the handle indexes mean "handle
    // taken". The creators primary key can also raise 23505 (a sequence
    // collision); calling that "handle taken" sent people retrying names
    // that were never the problem.
    if (isHandleConflict(err)) {
      return res.status(409).json({ error: HANDLE_TAKEN_MESSAGE });
    }
    if (err && err.message === 'An account with that email already exists') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[auth/signup] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
