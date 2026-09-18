import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { BlobNotFoundError, head } from '@vercel/blob';
import { getCreators } from './creators-store';
import { readJsonList, updateJsonList } from './blob-json-store';

const MANIFEST_PATH = 'data/users.json';

// Thrown by bumpSessionVersion when the token being logged out was already
// retired. Not an error the caller should surface as a failure -- see
// pages/api/auth/logout.js.
export const SESSION_ALREADY_REVOKED = 'session_already_revoked';

// A real cost-10 bcrypt hash of a random string nobody has -- see
// verifyPassword below for why a login attempt against a nonexistent
// account still has to run a full compare.
const DUMMY_PASSWORD_HASH = '$2b$10$if6Bc87d3eKJ22/8bzZEbuJFflttMkwt7sPga946F98T1lQM7ISua';

export async function getUsers() {
  return readJsonList(MANIFEST_PATH);
}

/**
 * Both sides of every identifier comparison go through this.
 *
 * The trim is load-bearing, not tidiness: signup only started trimming the
 * identifier it stores in commit 435c448, so any account created before
 * that can have a stray leading/trailing space baked into the stored value
 * (a paste, a phone keyboard's auto-space). The login route trims what the
 * person types, so comparing against an untrimmed stored value makes those
 * accounts unfindable -- a correct password failing forever, with no
 * password-reset or recovery route anywhere on this site to get back in
 * through.
 */
function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * readJsonList/updateJsonList cannot tell "this manifest doesn't exist yet"
 * from "the read failed" -- a missing blob, a blob 5xx, a network blip and
 * a bad token all come back as the same empty fallback. That distinction
 * matters here more than anywhere else in the app: a write built on a
 * wrongly-empty read replaces every account on the platform. So before any
 * writer trusts an empty list, it confirms the manifest really is absent.
 * Anything other than a clean not-found means the read failed and the write
 * must not happen.
 *
 * Matched with `instanceof`, not by name or message: @vercel/blob's error
 * classes all leave `.name` as the plain "Error", so a `err.name ===
 * 'BlobNotFoundError'` test silently never matches (and matching on the
 * message would also catch BlobStoreNotFoundError, which is a broken
 * configuration, not an empty store).
 */
async function manifestIsGenuinelyAbsent() {
  try {
    await head(MANIFEST_PATH);
    return false;
  } catch (err) {
    return err instanceof BlobNotFoundError;
  }
}

// "email" is really just "unique login identifier" -- fans can sign up with
// a plain username instead of a real address (see pages/signup.js), nothing
// here ever sends real email to it. Kept as `email` rather than renamed
// throughout, since it's the existing lookup key everywhere else.
export async function findUserByEmail(email) {
  const users = await getUsers();
  const needle = normalizeIdentifier(email);
  if (!needle) return null;
  return users.find((u) => normalizeIdentifier(u.email) === needle) || null;
}

export async function findUserById(id) {
  const users = await getUsers();
  return users.find((u) => String(u.id) === String(id)) || null;
}

export async function findUserByCreatorId(creatorId) {
  const users = await getUsers();
  return users.find((u) => String(u.creatorId) === String(creatorId)) || null;
}

export async function createUser({ email, password, role, creatorId }) {
  const passwordHash = await bcrypt.hash(password, 10);
  return updateJsonList(MANIFEST_PATH, async (users) => {
    // An empty list here is either the genuine first signup or a failed
    // read. Appending to a failed read would persist a manifest holding
    // nothing but this one new account, deleting everybody else -- and the
    // ETag precondition does not catch it, because nobody else wrote.
    if (users.length === 0 && !(await manifestIsGenuinelyAbsent())) {
      throw new Error('Could not read the account list right now. Please try again in a moment.');
    }
    const needle = normalizeIdentifier(email);
    if (users.some((u) => normalizeIdentifier(u.email) === needle)) {
      throw new Error('An account with that email already exists');
    }
    // A sequential "highest existing id + 1" scheme lets two signups that
    // land close together compute the SAME next id (both read the list
    // before either write finished) -- not a cosmetic clash, since the
    // second account created then shares a login-session identity with the
    // first, letting one person's browser end up authenticated as the
    // other's account. A random id makes that collision astronomically
    // unlikely; every id comparison in this codebase already does
    // String(a) === String(b), so a non-numeric id is a safe drop-in. The
    // ETag-guarded write below (see blob-json-store.js) is the other half
    // of this fix -- it also closes the window where two concurrent
    // signups could otherwise silently drop one account's write entirely.
    const user = {
      id: crypto.randomUUID(),
      email,
      passwordHash,
      role,
      creatorId: creatorId ?? null,
      // Session epoch -- bumped on logout to retire tokens already issued.
      sessionVersion: 0,
      createdAt: new Date().toISOString(),
    };
    return { next: [...users, user], result: user };
  });
}

/**
 * Invalidates every session token issued for this user so far (the token
 * carries the epoch as `sv`, see lib/session.js). Logout calls this: until
 * it did, logging out only cleared the cookie in that one browser, so a
 * token copied off the machine stayed valid for the rest of its 30 days.
 *
 * It's per-user rather than per-token, so logging out on one device signs
 * the account out everywhere -- a deliberate trade for not keeping a
 * server-side table of live tokens.
 *
 * `expectedVersion` is the epoch carried by the token being logged out. It
 * must still match the record, or this refuses: otherwise a copied token
 * that an earlier logout already retired could keep calling logout to kill
 * whatever fresh session the real owner had just signed into, over and over
 * for the remaining 30 days the stolen token stays signed. Matching means a
 * given token is good for exactly one revocation -- which also retires the
 * copy that performed it.
 *
 * Both of the refusals below throw rather than returning quietly, because
 * throwing is the ONLY way to leave updateJsonList without writing, and not
 * writing is the whole point -- see the not-found case for what a
 * write-anyway costs.
 */
export async function bumpSessionVersion(userId, expectedVersion) {
  return updateJsonList(MANIFEST_PATH, (users) => {
    const idx = users.findIndex((u) => String(u.id) === String(userId));
    if (idx === -1) {
      // Never hand the list back unchanged here. updateJsonList persists
      // whatever the transform returns, so returning `users` when the list
      // came back empty would write `[]` over data/users.json and delete
      // every account on the platform -- with the ETag precondition happily
      // matching, because nobody else wrote.
      //
      // blob-json-store.js now refuses to hand a transform the fallback
      // unless storage confirmed the manifest genuinely does not exist, so
      // that empty list should never reach this function in the first
      // place. This stays anyway: that exact conflation shipped to
      // production once already, and a second independent layer costs one
      // throw. The caller reports this rather than claiming a revocation
      // that did not happen.
      throw new Error('Session could not be revoked: user record not found');
    }
    const current = Number(users[idx].sessionVersion || 0);
    if (expectedVersion !== undefined && Number(expectedVersion) !== current) {
      throw Object.assign(new Error('Session was already revoked'), { code: SESSION_ALREADY_REVOKED });
    }
    const next = [...users];
    next[idx] = { ...users[idx], sessionVersion: current + 1 };
    return { next, result: next[idx].sessionVersion };
  });
}

/**
 * Deliberately tolerates a null/unknown `user`: the login route calls this
 * even when no account matched, so that "no such account" and "wrong
 * password" cost the same. Returning early for an unknown login made
 * response time an account-existence oracle (a millisecond or two versus
 * the ~100ms of a real bcrypt compare) -- which is enough to enumerate who
 * has an account here, and on an adult platform the account list is itself
 * the sensitive part. The dummy hash makes the compare do the same work
 * and always fail. Callers must therefore still check that the user exists
 * -- a `false` here does not distinguish the two cases, which is the point.
 */
export async function verifyPassword(user, password) {
  const hash = user?.passwordHash || DUMMY_PASSWORD_HASH;
  return bcrypt.compare(password, hash);
}

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

/**
 * Public-safe display name for wall comments / DM sender info. Two rules:
 * - A creator shows their real, already-public creator name -- never their
 *   raw login email, even though creators are required to have one.
 * - A fan's `email` field is really just "unique login identifier" and can
 *   hold either a real email or a plain chosen username (see
 *   pages/signup.js) -- if it has no "@", it IS the username they
 *   intentionally chose to be shown by, so it's safe to display in full.
 *   If it looks like a real email address, never expose any part of it;
 *   that's exactly the private information the anonymous-signup feature
 *   exists to protect. (Previously this always showed the email's
 *   local-part regardless, which leaked a real address for any creator
 *   and any fan who opted into a real email at signup.)
 */
export async function displayNameFor(user) {
  if (!user) return 'Someone';
  if (user.displayName) return user.displayName;
  if (user.creatorId) {
    const creators = await getCreators();
    const creator = creators.find((c) => String(c.id) === String(user.creatorId));
    if (creator?.name) return creator.name;
  }
  const email = String(user.email || '');
  if (email && !email.includes('@')) return email;
  return 'Someone';
}
