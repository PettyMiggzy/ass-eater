import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query, rowToRecord, rowsToRecords } from './db';
import { screenPublicText } from './prohibited-terms';

// Thrown by bumpSessionVersion when the token being logged out was already
// retired. Not an error the caller should surface as a failure -- see
// pages/api/auth/logout.js.
export const SESSION_ALREADY_REVOKED = 'session_already_revoked';

// A real cost-10 bcrypt hash of a random string nobody has -- see
// verifyPassword below for why a login attempt against a nonexistent
// account still has to run a full compare.
const DUMMY_PASSWORD_HASH = '$2b$10$if6Bc87d3eKJ22/8bzZEbuJFflttMkwt7sPga946F98T1lQM7ISua';

export async function getUsers() {
  const { rows } = await query('select id, data from users order by created_at');
  return rowsToRecords(rows);
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
 *
 * The unique index in lib/db.js applies lower(btrim(...)) for the same
 * reason and must keep matching this.
 */
function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

// "email" is really just "unique login identifier" -- fans can sign up with
// a plain username instead of a real address (see pages/signup.js), nothing
// here ever sends real email to it. Kept as `email` rather than renamed
// throughout, since it's the existing lookup key everywhere else.
export async function findUserByEmail(email) {
  const needle = normalizeIdentifier(email);
  if (!needle) return null;
  const { rows } = await query(
    `select id, data from users where lower(btrim(data->>'email')) = $1`,
    [needle],
  );
  return rows.length ? rowToRecord(rows[0]) : null;
}

export async function findUserById(id) {
  const { rows } = await query('select id, data from users where id = $1', [String(id)]);
  return rows.length ? rowToRecord(rows[0]) : null;
}

export async function findUserByCreatorId(creatorId) {
  const { rows } = await query(`select id, data from users where data->>'creatorId' = $1`, [String(creatorId)]);
  return rows.length ? rowToRecord(rows[0]) : null;
}

/**
 * Creates an account.
 *
 * Uniqueness of the login identifier is enforced by a unique index, not by
 * reading the list and checking first. That read-then-check was a real race:
 * two signups for the same address landing together both saw "not taken".
 * It also means this no longer has to prove the account list was readable
 * before writing -- the old version had to, because an append built on a
 * wrongly-empty read would have replaced every account on the platform.
 * With one row per account, a failed read cannot destroy anything.
 */
/**
 * `client` is optional: pass one from db.js's withTransaction() to run this
 * insert as part of a larger transaction (see pages/api/auth/signup.js,
 * which creates the creator profile and the account that owns it
 * atomically, so a failure partway through cannot strand one without the
 * other).
 */
export async function createUser({ email, password, role, creatorId, referredByCreatorId = null, acceptance = null }, client = null) {
  const passwordHash = await bcrypt.hash(password, 10);
  // A random id rather than "highest existing + 1": that scheme let two
  // signups landing together compute the SAME id, and the second account
  // then shared a login-session identity with the first -- one person's
  // browser authenticated as the other's account. Every id comparison in
  // this codebase does String(a) === String(b), so a non-numeric id is a
  // safe drop-in.
  const id = crypto.randomUUID();
  const user = {
    email,
    passwordHash,
    role,
    creatorId: creatorId ?? null,
    // Which creator's referral link brought this account in, if any.
    // Resolved to a real creator id by the signup route before it gets
    // here -- never a raw handle off a cookie.
    referredByCreatorId: referredByCreatorId ?? null,
    // Session epoch -- bumped on logout to retire tokens already issued.
    sessionVersion: 0,
    createdAt: new Date().toISOString(),
  };
  // Server-side evidence that this person accepted the Terms and attested to
  // being 18+ at signup: { tosAcceptedAt, tosVersion, ageAttestedAt }. The
  // signup route refuses to create an account without it; the checkbox on the
  // page alone left no record anywhere.
  if (acceptance) {
    user.tosAcceptedAt = acceptance.tosAcceptedAt ?? null;
    user.tosVersion = acceptance.tosVersion ?? null;
    user.ageAttestedAt = acceptance.ageAttestedAt ?? null;
  }
  const runner = client || { query };
  try {
    const { rows } = await runner.query('insert into users (id, data) values ($1, $2) returning id, data', [id, user]);
    return rowToRecord(rows[0]);
  } catch (err) {
    // 23505 = unique_violation. Same message the read-then-check produced,
    // so callers and the signup page behave exactly as before.
    if (err?.code === '23505') throw new Error('An account with that email already exists');
    throw err;
  }
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
 * The match is part of the UPDATE's WHERE clause, so two logouts racing
 * cannot both succeed against the same epoch.
 */
export async function bumpSessionVersion(userId, expectedVersion) {
  const expected = expectedVersion === undefined ? null : Number(expectedVersion);
  const { rows } = await query(
    `update users
        set data = jsonb_set(
              data,
              '{sessionVersion}',
              to_jsonb(coalesce((data->>'sessionVersion')::int, 0) + 1)
            )
      where id = $1
        and ($2::int is null or coalesce((data->>'sessionVersion')::int, 0) = $2::int)
      returning id, data`,
    [String(userId), expected],
  );
  if (!rows.length) {
    const { rows: exists } = await query('select 1 from users where id = $1', [String(userId)]);
    if (!exists.length) throw new Error('Session could not be revoked: user record not found');
    throw Object.assign(new Error('Session was already revoked'), { code: SESSION_ALREADY_REVOKED });
  }
  return Number(rowToRecord(rows[0]).sessionVersion);
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

/**
 * Deletes any login account still pointing at a creator id that no longer
 * exists. Deleting a creator via admin (single or bulk) used to leave their
 * user/login account behind -- unreachable as a creator (their profile is
 * gone) but still a live account nobody ever cleaned up. Call this right
 * after any creator deletion; a plain NOT EXISTS against the creators table
 * needs no list of which ids were removed.
 */
export async function deleteOrphanedCreatorUsers() {
  const { rows } = await query(
    `delete from users
      where data->>'creatorId' is not null
        and not exists (select 1 from creators where creators.id = users.data->>'creatorId')
      returning id`,
  );
  return rows.map((r) => r.id);
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
    // One row, not the whole creator roster, which is what this used to
    // fetch on every wall comment and DM rendered.
    const { rows } = await query(`select data->>'name' as name from creators where id = $1`, [String(user.creatorId)]);
    if (rows.length && rows[0].name) return rows[0].name;
  }
  const email = String(user.email || '');
  // Defence in depth for accounts created before signup screened usernames:
  // a username that reads as a Cash App handle or carries a prohibited term
  // must not become the public author of every comment and DM the account
  // writes. Signup refuses such names now (pages/api/auth/signup.js); this
  // covers the ones already stored.
  if (email && !email.includes('@') && !screenPublicText(email)) return email;
  return 'Someone';
}

/**
 * Creator handles are unique through two partial unique indexes in lib/db.js
 * (the as-stored one and the "@"-stripped one). A 23505 from any OTHER
 * constraint -- the creators primary key after a sequence collision, say --
 * is a server problem, and reporting it as "that handle is taken" sends the
 * person off retrying names that were never the issue.
 */
const HANDLE_CONSTRAINTS = new Set(['creators_handle_unique_idx', 'creators_handle_norm_unique_idx']);

export function isHandleConflict(err) {
  return !!err && err.code === '23505' && HANDLE_CONSTRAINTS.has(err.constraint);
}

export const HANDLE_TAKEN_MESSAGE = 'That handle is already taken. Pick another.';
