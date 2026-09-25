import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import { screenPublicText } from './prohibited-terms';
import { USER_MODERATION_STATUSES, effectiveUserStatus } from './user-moderation';
import { enqueueStandingPushes } from './standing-outbox';
import { effectiveCreatorStatus } from './creator-status';

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

/**
 * The account as its OWNER may see it (/api/auth/me, page props). Drops the
 * password hash and the admin's moderation notes: `moderationReason` is typed
 * by an admin ("reported by @mia for threats...") and must never reach the
 * person it is about -- the fan-facing refusal is deliberately generic
 * (lib/user-moderation.js). Only the standing itself (moderationStatus,
 * moderationUntil) stays. The admin endpoints read the full record.
 */
export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, moderationReason, moderatedBy, moderatedAt, ...rest } = user;
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
  // A whitespace-only name counts as no name (it rendered as a blank author).
  if (typeof user.displayName === 'string' && user.displayName.trim()) return user.displayName.trim();
  if (user.creatorId) {
    // One row, not the whole creator roster, which is what this used to
    // fetch on every wall comment and DM rendered.
    const { rows } = await query(`select data->>'name' as name from creators where id = $1`, [String(user.creatorId)]);
    if (rows.length && typeof rows[0].name === 'string' && rows[0].name.trim()) return rows[0].name.trim();
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

export const USER_MODERATION_NOT_ALLOWED = 'user_moderation_not_allowed';

/**
 * Sets (or clears, with status null) account-level moderation on a user --
 * see lib/user-moderation.js. `until` is required for a suspension. A ban
 * also bumps the session epoch in the SAME statement, so every session the
 * account already holds is dead the moment this commits. Suspend/ban is
 * refused (USER_MODERATION_NOT_ALLOWED) for an APPROVED (effectively active)
 * creator account, whose standing is its creator record; allowed for every
 * other account. Clearing (status null) is allowed for every account. Returns the updated user, or null if no such user.
 */
export async function setUserModeration(userId, { status, until = null, reason = null, by = 'admin' } = {}) {
  if (status !== null && !USER_MODERATION_STATUSES.includes(status)) throw new Error('Invalid moderation status');
  const untilIso = status === 'suspended' ? new Date(until).toISOString() : null;
  const { rows: found } = await query('select id, data from users where id = $1', [String(userId)]);
  if (!found.length) return null;
  const current = rowToRecord(found[0]);
  // Clearing is always allowed: moderation set while a creator was still a
  // pending applicant must be liftable after the profile is approved, or the
  // approved creator stays signed out / reported 'banned' to server/ with no
  // way out but un-approving them.
  if (status !== null && (current.role === 'creator' || current.creatorId)) {
    // An APPROVED creator's standing lives on the creator record (it also
    // drives visibility, payouts and server/), so account-level moderation is
    // refused for one. Any other creator account -- a pending applicant who
    // never finished, or one whose profile is missing, suspended or banned --
    // can be moderated here too: anyone can tick "creator" at signup, and
    // such an account posts and pays like a fan, so a permanent ban used to
    // be the only tool left for it. The two levels combine (the stricter one
    // wins): see lib/credits-store.js accountStanding, and the write gates,
    // which all check userWriteRestriction for every account.
    const { rows: cr } = current.creatorId
      ? await query('select data from creators where id = $1', [String(current.creatorId)])
      : { rows: [] };
    if (cr.length && effectiveCreatorStatus(cr[0].data) === 'active') {
      throw Object.assign(new Error("An approved creator's standing is set on its creator profile."), { code: USER_MODERATION_NOT_ALLOWED });
    }
  }
  const patch = {
    moderationStatus: status,
    moderationUntil: untilIso,
    moderationReason: status ? (typeof reason === 'string' ? reason.slice(0, 500) : null) : null,
    moderatedAt: new Date().toISOString(),
    moderatedBy: String(by).slice(0, 100),
  };
  // The new standing is queued for server/ in the SAME transaction
  // (lib/standing-outbox.js): a fan's own account standing (role FAN), or
  // for an unapproved creator account its combined creator standing. The
  // caller delivers it after the commit (lib/server-api.js deliverFor).
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `update users
          set data = data || $2::jsonb
                     || case when $3::boolean
                             then jsonb_build_object('sessionVersion', coalesce((data->>'sessionVersion')::int, 0) + 1)
                             else '{}'::jsonb end
        where id = $1
        returning id, data`,
      [String(userId), JSON.stringify(patch), status === 'banned'],
    );
    if (!rows.length) return null;
    const user = rowToRecord(rows[0]);
    const accountStatus = effectiveUserStatus(user);
    if (user.creatorId) {
      const { rows: cr } = await client.query('select data from creators where id = $1', [String(user.creatorId)]);
      const creatorStatus = cr.length ? effectiveCreatorStatus(cr[0].data) || 'active' : 'banned';
      const combined = accountStatus === 'banned' || creatorStatus === 'banned'
        ? 'banned'
        : accountStatus === 'suspended' ? 'suspended' : creatorStatus;
      await enqueueStandingPushes([{ uid: user.id, status: combined, role: 'CREATOR', suspendedUntil: combined === 'suspended' ? user.moderationUntil || cr[0]?.data?.suspendedUntil || null : null }], client);
    } else {
      await enqueueStandingPushes([{ uid: user.id, status: accountStatus, role: 'FAN' }], client);
    }
    return user;
  });
}

export const PASSWORD_MIN_LENGTH = 6;
export const WRONG_PASSWORD = 'wrong_password';
export const ACCOUNT_IS_CREATOR = 'account_is_creator';
export const ACCOUNT_HAS_OBLIGATIONS = 'account_has_obligations';

/**
 * Signed-in password change. Verifies the current password, stores the new
 * hash and bumps the session epoch in the same UPDATE, so every other session
 * (a copied cookie, another device) dies with the old password. Returns the
 * new session version, for the caller to re-issue THIS browser's cookie.
 * Throws `.code === WRONG_PASSWORD` for a wrong current password. (A reset for
 * someone who forgot the password needs an email provider -- not built.)
 */
export async function changePassword(userId, currentPassword, newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > 200) {
    throw Object.assign(new Error(`Pick a password of ${PASSWORD_MIN_LENGTH} to 200 characters.`), { code: 'bad_password' });
  }
  const user = await findUserById(userId);
  if (!user || !(await verifyPassword(user, String(currentPassword ?? '')))) {
    throw Object.assign(new Error('Current password is wrong.'), { code: WRONG_PASSWORD });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  const { rows } = await query(
    `update users
        set data = data || jsonb_build_object(
              'passwordHash', $2::text,
              'passwordChangedAt', $3::text,
              'sessionVersion', coalesce((data->>'sessionVersion')::int, 0) + 1)
      where id = $1 and data->>'passwordHash' = $4
      returning id, data`,
    [String(user.id), hash, new Date().toISOString(), user.passwordHash],
  );
  // The hash moved between the check and the write (a concurrent change):
  // the current password proved above is no longer the current one.
  if (!rows.length) throw Object.assign(new Error('Current password is wrong.'), { code: WRONG_PASSWORD });
  return Number(rowToRecord(rows[0]).sessionVersion);
}

/**
 * Deletes a FAN account and its off-chain personal data, as Privacy Policy
 * section 7 promises on request: the login row, the account's wall
 * comments, the messages it sent (a conversation left empty goes too; the
 * other person's own messages stay theirs), its favorites and notifications.
 * Kept, as section 7 excludes them: the credit ledger, orders and payout
 * records (financial records), reports and violations (moderation records).
 *
 * Refused (ACCOUNT_IS_CREATOR) for an account whose creator profile still
 * exists -- deleting a creator goes through lib/creators-store.js
 * deleteCreator, which also handles their listings and media. Refused
 * (ACCOUNT_HAS_OBLIGATIONS, with `.obligations`) while the account has
 * withdrawable earnings or a pending payout request -- that is real money
 * owed to them -- unless `force`. A remaining NON-withdrawable balance
 * (deposited credits: closed-loop, never refunded) is forfeited; the caller
 * must have the person acknowledge that first.
 *
 * `strict` (the admin path, pages/api/admin/delete-user.js): ANY credit
 * balance and any of their physical orders still waiting to ship count as
 * obligations too, so an operator honouring an emailed request is shown
 * what would be forfeited or left unshipped and has to confirm with `force`
 * -- the self-service path asks the person about the balance itself.
 * `obligations.unshippedOrders` is always reported.
 *
 * The server/ account is queued 'banned' in the same commit
 * (lib/standing-outbox.js). Returns { deletedUserId, forfeitedCents } or null
 * when there is no such account.
 */
export async function deleteFanAccount(userId, { force = false, strict = false } = {}) {
  const uid = String(userId);
  return withTransaction(async (client) => {
    const { rows } = await client.query('select id, data from users where id = $1 for update', [uid]);
    if (!rows.length) return null;
    const user = rowToRecord(rows[0]);
    if (user.creatorId) {
      const { rows: cr } = await client.query('select 1 from creators where id = $1', [String(user.creatorId)]);
      if (cr.length) {
        throw Object.assign(new Error('This is a creator account -- delete the creator profile instead.'), { code: ACCOUNT_IS_CREATOR });
      }
    }
    const { rows: bal } = await client.query(
      'select balance_cents, withdrawable_cents from credit_balances where user_id = $1 for update',
      [uid],
    );
    const { rows: pay } = await client.query(
      `select count(*)::int as n, coalesce(sum(amount_cents), 0)::bigint as cents from payout_requests where user_id = $1 and status = 'pending'`,
      [uid],
    );
    const { rows: ships } = await client.query(
      `select count(*)::int as n from orders where data->>'buyerId' = $1 and data->>'status' = 'pending_shipment'`,
      [uid],
    );
    const balanceCents = Number(bal[0]?.balance_cents || 0);
    const withdrawableCents = Number(bal[0]?.withdrawable_cents || 0);
    const unshippedOrders = ships[0]?.n || 0;
    const obligations = { balanceCents, withdrawableCents, pendingPayouts: pay[0].n, pendingPayoutCents: Number(pay[0].cents), unshippedOrders };
    const owed = withdrawableCents > 0 || pay[0].n > 0 || (strict && (balanceCents > 0 || unshippedOrders > 0));
    if (owed && !force) {
      throw Object.assign(new Error('This account has earnings or a pending payout attached.'), { code: ACCOUNT_HAS_OBLIGATIONS, obligations });
    }

    await client.query(`delete from wall_posts where data->>'authorId' = $1`, [uid]);
    await client.query('delete from favorites where fan_id = $1', [uid]);
    await client.query('delete from notifications where user_id = $1', [uid]);
    // Their own messages out of every conversation they are in; a
    // conversation with nothing left in it goes entirely.
    await client.query(
      `update conversations
          set data = jsonb_set(data, '{messages}', coalesce((
                select jsonb_agg(m) from jsonb_array_elements(coalesce(data->'messages', '[]'::jsonb)) as m
                 where m->>'senderId' <> $1), '[]'::jsonb))
        where data->'participantIds' ? $1`,
      [uid],
    );
    await client.query(
      `delete from conversations
        where data->'participantIds' ? $1
          and jsonb_array_length(coalesce(data->'messages', '[]'::jsonb)) = 0`,
      [uid],
    );
    if (balanceCents > 0) {
      await client.query(
        `insert into credit_ledger (user_id, type, amount_cents, meta) values ($1, 'account_deleted', $2, $3)`,
        [uid, -balanceCents, JSON.stringify({ reason: 'account deleted; balance forfeited', withdrawableCents })],
      );
      await client.query(
        'update credit_balances set balance_cents = 0, withdrawable_cents = 0, updated_at = now() where user_id = $1',
        [uid],
      );
    }
    await client.query('delete from users where id = $1', [uid]);
    await enqueueStandingPushes([{ uid, status: 'banned', role: user.creatorId ? 'CREATOR' : 'FAN' }], client);
    return { deletedUserId: uid, forfeitedCents: balanceCents, obligations };
  });
}
