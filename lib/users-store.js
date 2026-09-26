import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query, rowToRecord, rowsToRecords, withTransaction, withTransactionRetryOnDeadlock } from './db';
import { screenPublicText } from './prohibited-terms';
import { USER_MODERATION_STATUSES, effectiveUserStatus } from './user-moderation';
import { enqueueStandingPushes } from './standing-outbox';
import { effectiveCreatorStatus } from './creator-status';
import { removeListingsForCreator } from './listings-store';
import { deleteMediaQuietly } from './blob-cleanup';
import { eraseShippedAddressesForBuyer } from './orders-store';
import { snapshotReportedContentBeforeDelete, countOpenSeriousReportsAgainstUser } from './reports-store';
import { sliceText } from './unicode-text';
import { wallAuthorKey } from './wall-author-key';

// Thrown by bumpSessionVersion when the token being logged out was already
// retired. Not an error the caller should surface as a failure -- see
// pages/api/auth/logout.js.
export const SESSION_ALREADY_REVOKED = 'session_already_revoked';
export const SESSION_USER_GONE = 'SESSION_USER_GONE';

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
    // A deleted account has no live sessions left to revoke (getSessionUser
    // misses once the row is gone), so callers treat this as already revoked.
    if (!exists.length) throw Object.assign(new Error('Session could not be revoked: user record not found'), { code: SESSION_USER_GONE });
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
  if (email && !email.includes('@') && !screenPublicText(email, { context: 'username' })) return email;
  return 'Someone';
}

/**
 * A stable, non-identifying label for a fan who has no name that is safe to
 * show ("Fan #3F9A21"): derived from the user id, never from the login, so
 * it reveals nothing and is the same on every screen and every load. Fans who
 * signed up with a real email have no public name (the address must never be
 * shown), and every one of them used to read as the same "Unknown" in a
 * creator's inbox -- several paid threads nobody could tell apart.
 */
export function fanLabelFor(userId) {
  const digest = crypto.createHash('sha256').update(`oa:fan-label:v1:${String(userId ?? '')}`).digest('hex');
  return `Fan #${digest.slice(0, 6).toUpperCase()}`;
}

/**
 * The name to show for the other side of a DM thread: a creator's public
 * name, else a fan's screened username (displayNameFor's rules, so a legacy
 * username that reads as a payment handle stays suppressed here too), else
 * the stable fan label. Never the email.
 */
export async function inboxNameFor(user) {
  if (!user) return 'Unknown';
  const name = await displayNameFor(user);
  return name === 'Someone' ? fanLabelFor(user.id) : name;
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
 * When a suspension that may come from two places (the login's own
 * moderation and the creator profile's) actually ends: the LATER of the
 * given dates that parse, as an ISO string, or null. Exported for
 * lib/server-api.js, which answers the same question.
 */
export function latestLapse(...dates) {
  const ms = dates.map((d) => (d ? Date.parse(d) : NaN)).filter(Number.isFinite);
  return ms.length ? new Date(Math.max(...ms)).toISOString() : null;
}

/**
 * The ONE rule for what a creator account's standing is on server/ (the
 * status pushed through lib/standing-outbox.js and carried by bridge tokens),
 * combining the creator PROFILE's effective status with any account-level
 * moderation on the LOGIN. Shared by lib/server-api.js and setUserModeration
 * below, which each used to carry their own copy. Returns
 * { status, suspendedUntil } -- suspendedUntil only ever set on 'suspended'.
 *
 *  - Either side banned (or the profile missing): 'banned'.
 *  - The profile suspended (it is approved underneath), or an account
 *    suspension on an otherwise ACTIVE profile: 'suspended' with the later of
 *    the two ends. server/ lifts it to active when that passes, which is the
 *    site's truth too.
 *  - An account suspension on a profile that is NOT approved (pending):
 *    'suspended' with NO end. Sending the account suspension's end used to
 *    make server/ lift the creator to 'active' -- approved -- when it passed,
 *    while the site still had them pending; nothing on the site sends
 *    'pending' again on a lapse. With no end, server/ keeps them restricted
 *    until the site says otherwise (the daily maintenance cron re-pushes
 *    creator accounts whose account suspension has lapsed:
 *    lapsedAccountSuspensionCreatorIds).
 *  - Otherwise the profile's own status ('active', 'pending', ...).
 */
export function combinedCreatorPushStanding(creator, user) {
  const raw = creator ? effectiveCreatorStatus(creator) : 'banned';
  const creatorStatus = raw == null || raw === '' ? 'active' : String(raw);
  const account = user ? effectiveUserStatus(user) : 'active';
  if (account === 'banned' || creatorStatus === 'banned') return { status: 'banned', suspendedUntil: null };
  if (creatorStatus === 'suspended' || (account === 'suspended' && creatorStatus === 'active')) {
    return {
      status: 'suspended',
      suspendedUntil: latestLapse(
        creatorStatus === 'suspended' ? creator?.suspendedUntil : null,
        account === 'suspended' ? user?.moderationUntil : null,
      ),
    };
  }
  if (account === 'suspended') return { status: 'suspended', suspendedUntil: null };
  return { status: creatorStatus, suspendedUntil: null };
}

/**
 * Creator ids whose LOGIN carried an account suspension that has lapsed in the
 * last `withinMs` -- their server/ standing was pushed with no end (see
 * combinedCreatorPushStanding) and needs re-sending now that it is over.
 */
export async function lapsedAccountSuspensionCreatorIds({ withinMs = 3 * 24 * 60 * 60 * 1000, limit = 200 } = {}) {
  const { rows } = await query(
    `select distinct data->>'creatorId' as cid from users
      where data->>'creatorId' is not null
        and data->>'moderationStatus' = 'suspended'
        and (data->>'moderationUntil') ~ '^[0-9]{4}-'
        and (data->>'moderationUntil')::timestamptz <= now()
        and (data->>'moderationUntil')::timestamptz > now() - ($1::bigint * interval '1 millisecond')
      limit $2`,
    [Math.max(0, Math.floor(withinMs)), limit],
  );
  return rows.map((r) => String(r.cid));
}

/**
 * Sets (or clears, with status null) account-level moderation on a user --
 * see lib/user-moderation.js. `until` is required for a suspension. A ban
 * also bumps the session epoch in the SAME statement, so every session the
 * account already holds is dead the moment this commits. Suspend/ban is
 * refused (USER_MODERATION_NOT_ALLOWED) for an APPROVED (effectively active)
 * creator account, whose standing is its creator record; allowed for every
 * other account. Clearing (status null) is allowed for every account. Returns the updated user, or null if no such user.
 *
 * On a creator account whose profile is SUSPENDED, the profile follows: an
 * account ban also bans the profile (and takes its listings off sale), and an account
 * suspension longer than a suspended profile's own extends the profile's end
 * -- so a profile suspension lapsing can never republish a creator whose login
 * is banned or still suspended. Clearing the account moderation does NOT undo
 * either; reinstating the profile is a separate, deliberate admin save.
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
    moderationReason: status ? (typeof reason === 'string' ? sliceText(reason, 500) : null) : null,
    moderatedAt: new Date().toISOString(),
    moderatedBy: String(by).slice(0, 100),
  };
  // The new standing is queued for server/ in the SAME transaction
  // (lib/standing-outbox.js): a fan's own account standing (role FAN), or
  // for an unapproved creator account its combined creator standing. The
  // caller delivers it after the commit (lib/server-api.js deliverFor).
  let doomedFiles = [];
  const updated = await withTransaction(async (client) => {
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
      // Locked (users, then creators -- the order every money path takes),
      // and the "not an approved creator" rule re-checked on the locked row:
      // the check above ran before this transaction.
      const { rows: cr } = await client.query('select id, data from creators where id = $1 for update', [String(user.creatorId)]);
      let profile = cr.length ? cr[0].data : null;
      if (status !== null && profile && effectiveCreatorStatus(profile) === 'active') {
        throw Object.assign(new Error("An approved creator's standing is set on its creator profile."), { code: USER_MODERATION_NOT_ALLOWED });
      }
      // The PROFILE follows the account, so a profile-level lapse can never
      // republish a creator whose login is banned or still suspended.
      // isPubliclyVisible reads only the creator record, and a suspended
      // profile turns 'active' on its own when suspendedUntil passes -- so a
      // login banned during a 30-day content suspension used to reappear on
      // /creators, /search and its profile page on day 31, listings and Buy
      // buttons included, for an account that could never sign in again.
      //  - An account BAN of a suspended profile bans the profile too (founding status ended, the
      //    same markers a manual ban sets) and takes its listings off sale in
      //    this commit, keeping only files buyers have paid for.
      //  - An account SUSPENSION longer than a suspended profile's own
      //    extends the profile's suspendedUntil to match.
      // Only a SUSPENDED profile needs this: it is the one state that turns
      // public again by itself. A pending profile stays hidden until an admin
      // approves it, and approval is refused while the login is moderated
      // (pages/api/admin/profile.js).
      if (profile && status === 'banned' && effectiveCreatorStatus(profile) === 'suspended') {
        const now = new Date().toISOString();
        const { rows: banned } = await client.query(
          `update creators
              set data = data || jsonb_build_object(
                    'status', 'banned',
                    'suspendedUntil', null,
                    'founding', false,
                    'foundingSince', null,
                    'bannedAt', coalesce(data->'bannedAt', to_jsonb($2::text)),
                    'foundingRevokedAt', case when coalesce((data->>'founding')::boolean, false)
                                              then to_jsonb($2::text) else data->'foundingRevokedAt' end),
                  updated_at = now()
            where id = $1
            returning data`,
          [String(user.creatorId), now],
        );
        profile = banned[0].data;
        ({ files: doomedFiles } = await removeListingsForCreator(String(user.creatorId), { moderation: true, keepPaid: true, client }));
      } else if (profile && status === 'suspended' && effectiveCreatorStatus(profile) === 'suspended') {
        const profileEnd = Date.parse(profile.suspendedUntil || '');
        if (Number.isFinite(profileEnd) && profileEnd < Date.parse(untilIso)) {
          const { rows: extended } = await client.query(
            `update creators set data = data || jsonb_build_object('suspendedUntil', $2::text), updated_at = now()
              where id = $1 returning data`,
            [String(user.creatorId), untilIso],
          );
          profile = extended[0].data;
        }
      }
      const { status: combined, suspendedUntil } = combinedCreatorPushStanding(profile, user);
      await enqueueStandingPushes([{ uid: user.id, status: combined, role: 'CREATOR', suspendedUntil }], client);
    } else {
      // A fan's suspension carries its end too, so server/ lifts it when it
      // lapses here instead of waiting for another message (the creator
      // pushes always did).
      await enqueueStandingPushes([{ uid: user.id, status: accountStatus, role: 'FAN', suspendedUntil: accountStatus === 'suspended' ? user.moderationUntil || null : null }], client);
    }
    return user;
  });
  // Files of listings the ban took down, deleted after the commit (they are
  // recorded for the orphan sweep in it, so nothing is lost if this fails).
  if (doomedFiles.length) await deleteMediaQuietly(doomedFiles);
  return updated;
}

export const PASSWORD_MIN_LENGTH = 6;
export const WRONG_PASSWORD = 'wrong_password';
export const ACCOUNT_IS_CREATOR = 'account_is_creator';
export const ACCOUNT_HAS_OBLIGATIONS = 'account_has_obligations';
export const ACCOUNT_UNDER_REVIEW = 'account_under_review';
export const ACCOUNT_UNSHIPPED_ORDERS = 'unshipped_orders';
// Self-service deletion was confirmed for a different forfeit than the one
// that would actually happen now (a deposit or a purchase landed between the
// prompt and the confirmation). Carries `.forfeit` { balanceCents,
// digitalPurchases } -- the current amounts, to prompt again with.
export const BALANCE_FORFEIT = 'BALANCE_FORFEIT';

/**
 * What deleting this fan account would cost them, for the self-service
 * confirmation (pages/api/auth/delete-account.js): physical orders still
 * waiting to ship (self-deletion is refused while there are any -- Privacy
 * section 7 promises those are settled first) and the number of digital
 * items they bought that stop being viewable (/api/media serves a listing's
 * files only to a signed-in buyer, and the account is gone).
 */
export async function getSelfDeleteImpact(userId, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `select
       count(*) filter (where data->>'status' = 'pending_shipment')::int as unshipped,
       count(distinct data->>'listingId') filter (
         where data->>'kind' = 'digital' and coalesce(data->>'status', '') in ('fulfilled', 'delivered'))::int as digital
       from orders
      where data->>'buyerId' = $1`,
    [String(userId)],
  );
  return { unshippedOrders: rows[0]?.unshipped || 0, digitalPurchases: rows[0]?.digital || 0 };
}

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
 * Deletes what one login account wrote or saved, on the caller's transaction:
 * its wall comments, the messages it sent (a conversation left empty goes
 * too; the other person's own messages stay theirs), its favorites and its
 * notifications. Every reported comment/message is copied onto its report
 * first (lib/reports-store.js snapshotReportedContentBeforeDelete). Financial
 * and moderation records are not touched -- except that reports this account
 * filed stop naming it (round-17 legal-journeys#1), and that the shipping name
 * and address on every order this login BOUGHT that has already shipped are
 * erased (the carrier and tracking number stay: they are the seller's
 * reference, round 18) (Privacy section 7: deleting the account is the
 * erasure request). Round 16 (legal-journeys#0) moved that erase in here: it
 * used to run only on fan self-deletion, so a deleted creator who had bought
 * from another creator kept their address on those orders for good. An order
 * still pending_shipment keeps its address so it can be sent; it is erased
 * the moment it ships or is closed (lib/orders-store.js markOrderShipped,
 * closeUnfulfilledOrder -- round-17 money#1), and the daily cron sweeps any
 * finished order of a gone buyer (eraseAddressesOfDeletedBuyers). Shared by fan self-deletion,
 * the admin user delete and creator deletion (lib/creators-store.js), so the
 * three can't drift apart -- deleting a creator used to leave all of this
 * behind, their sent DMs still readable in every fan's inbox.
 */
export async function purgeUserContent(client, userId) {
  const uid = String(userId);
  // Lock this account's conversations FIRST, in id order, before anything
  // below touches a report row (round-18 media#0 / social#0). Resolving a DM
  // report (pages/api/admin/reports-resolve.js) locks the conversation and
  // then writes the report; this purge used to write reports (the snapshot
  // just below, and the filed-report anonymisation) and only then the
  // conversations -- the opposite order on the same two rows, so an admin's
  // Remove on a DM report the account filed, landing during its deletion,
  // deadlocked. Now both take conversations before reports. Both callers
  // (deleteFanAccount here, creator deletion in lib/creators-store.js) reach
  // this holding the account's users row FOR UPDATE, so the order is users ->
  // [creators] -> conversations -> reports. The paid-DM send used to take the
  // conversation first and the users rows only inside transferWithFee -- the
  // opposite order on the same rows (round-19 media#1 / money#1), and the
  // send was not retried, so the fan got a 500. It now locks both users rows
  // FOR SHARE before the conversation (lib/messages-store.js
  // sendDirectMessage) and retries once on 40P01 as a backstop.
  await client.query(
    `select 1 from conversations where data->'participantIds' ? $1 order by id for update`,
    [uid],
  );
  await snapshotReportedContentBeforeDelete(client, { authorId: uid });
  // Reports this account FILED stay as moderation records (the category, the
  // reason and what was reported), but stop naming who filed them (round-17
  // legal-journeys#1): the reporter id goes, and so does the same id in the
  // participant list of a reported DM's copy (matched on its text, so an id
  // stored as a JSON number goes too). The copy's sender -- the person
  // reported -- is untouched. Deliberately KEPT: the report's
  // conversationId (top level and in the copy). A DM conversation id is the
  // two participant ids joined ("<a>__<b>", lib/messages-store.js pairId),
  // so it still carries the reporter's id -- but it is the key the admin
  // Remove / Remove & Ban actions and the report queue use to find the
  // reported message in the conversation that survives (it keeps the other
  // person's messages, and its own participantIds), so rewriting it would
  // break moderation of the very message reported. It is an internal id, and
  // EVERY admin route that returns a report drops it and shows a gone
  // participant as null: /api/admin/reports (attachReportTargets, round-18
  // social#1) and all three report bodies of /api/admin/reports-resolve
  // (lib/reports-store.js stripReporterTrail, round-19 media#0). The content
  // lookup (/api/admin/content-lookup) returns a deleted participant as
  // { deleted: true } with no id, and a message it sent with senderId null;
  // the conversation's own id there still joins the two ids, which is what a
  // takedown addresses, so the admin panel never prints it for a thread with
  // a deleted participant.
  await client.query(
    `update reports
        set data = (data - 'reporterId')
                   || jsonb_build_object('reporterDeletedAt', to_jsonb($2::text))
                   || case when jsonb_typeof(data->'reportedContent'->'participantIds') = 'array'
                           then jsonb_build_object('reportedContent', (data->'reportedContent') || jsonb_build_object('participantIds', (
                             select coalesce(jsonb_agg(case when p #>> '{}' = $1 then 'null'::jsonb else p end order by ord), '[]'::jsonb)
                               from jsonb_array_elements(data->'reportedContent'->'participantIds') with ordinality as t(p, ord))))
                           else '{}'::jsonb end
      where data->>'reporterId' = $1`,
    [uid, new Date().toISOString()],
  );
  // Notifications this account CAUSED in other people's bells carry its name
  // as text ("New message from alice_nyc", "alice_nyc commented on your
  // wall"). Privacy section 7 promises the messages and comments go, and
  // these kept the name tied to that creator indefinitely (round-11
  // legal-journeys#0). Anonymised rather than deleted, so the recipient's
  // history stays accurate while the name is gone. Before the wall_posts
  // delete below: those rows are how the walls they commented on are found.
  await client.query(
    `update notifications
        set message = 'New message from Someone', meta = meta - 'fromUserId'
      where type = 'message' and meta->>'fromUserId' = $1`,
    [uid],
  );
  // The walls are found two ways: their CURRENT comments, and every wall
  // that has a not-yet-anonymised comment notification at all (its key is
  // "<creatorId>:<digest>"). The second catches a comment the person, the
  // creator or an admin deleted before the account was -- no wall_posts row
  // links that wall any more, but its notification still names them
  // (round-11 fix-up). The key is an HMAC of (wall, account), so recomputing
  // it per candidate wall matches only this account's notifications.
  const { rows: walls } = await client.query(
    `select data->>'creatorId' as creator_id from wall_posts where data->>'authorId' = $1
     union
     select split_part(meta->>'wallAuthorKey', ':', 1) from notifications
      where type = 'wall_comment' and meta ? 'wallAuthorKey'
        and message <> 'Someone commented on your wall'`,
    [uid],
  );
  const wallKeys = walls.map((w) => w.creator_id).filter(Boolean).map((creatorId) => wallAuthorKey(creatorId, uid));
  if (wallKeys.length) {
    await client.query(
      `update notifications set message = 'Someone commented on your wall'
        where type = 'wall_comment' and meta->>'wallAuthorKey' = any($1::text[])`,
      [wallKeys],
    );
  }
  await client.query(`delete from wall_posts where data->>'authorId' = $1`, [uid]);
  await client.query('delete from favorites where fan_id = $1', [uid]);
  await client.query('delete from notifications where user_id = $1', [uid]);
  // Wall blocks they made, and those made of them (an opaque inbox row for an
  // account that no longer exists could never be anything but noise).
  await client.query('delete from wall_blocks where owner_user_id = $1 or author_id = $1', [uid]);
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
  await eraseShippedAddressesForBuyer(uid, client);
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
 * `selfService` (the person deleting their own account, pages/api/auth/
 * delete-account.js) is refused (ACCOUNT_UNDER_REVIEW) while the account is
 * suspended or banned, or while a possible-minor / non-consensual report
 * against something it wrote is still open. A suspended account is read-only,
 * and deleting it destroyed the suspension record with the users row, wiped
 * every message it had sent out of the recipient's inbox, and freed the
 * identifier to sign up again clean. Only the admin path can delete a
 * moderated account. It is also refused (ACCOUNT_UNSHIPPED_ORDERS, with
 * `.obligations`) while any of their physical orders has not shipped yet:
 * Privacy section 7 promises those are settled with the person before the
 * account goes, and deleting it would take away their only view of the order.
 *
 * `expectedForfeit` { balanceCents, digitalPurchases } (self-service): what
 * the person was shown and agreed to lose. Compared against the LOCKED
 * balance row and the purchases visible under that lock -- every purchase
 * debits that row, so none can slip in after the check -- and a mismatch
 * throws BALANCE_FORFEIT with the current amounts instead of deleting. An
 * acknowledgement covers the amount it was given for, never "whatever is
 * there by then": a $100 deposit finished in another tab is not silently
 * forfeited by a confirmation given for 50 credits.
 *
 * Whatever the path, every wall comment or message of theirs that a report
 * points at is copied onto that report first (in this transaction), so a
 * deletion can never leave a report pointing at nothing.
 *
 * The server/ account is queued 'banned' in the same commit
 * (lib/standing-outbox.js). Returns { deletedUserId, forfeitedCents } or null
 * when there is no such account.
 */
export async function deleteFanAccount(userId, { force = false, strict = false, selfService = false, expectedForfeit = null } = {}) {
  const uid = String(userId);
  // Retried once on a deadlock (round-18 media#0 / social#0): deleting an
  // account can still meet an admin resolving a report it filed.
  return withTransactionRetryOnDeadlock(async (client) => {
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
    if (selfService) {
      if (effectiveUserStatus(user) !== 'active' || (await countOpenSeriousReportsAgainstUser(uid, client)) > 0) {
        throw Object.assign(new Error('This account is under review.'), { code: ACCOUNT_UNDER_REVIEW });
      }
      if (unshippedOrders > 0) {
        throw Object.assign(new Error('This account has orders that have not shipped yet.'), { code: ACCOUNT_UNSHIPPED_ORDERS, obligations });
      }
    }
    if (expectedForfeit) {
      const { digitalPurchases } = await getSelfDeleteImpact(uid, client);
      if (
        Number(expectedForfeit.balanceCents) !== balanceCents ||
        Number(expectedForfeit.digitalPurchases || 0) !== digitalPurchases
      ) {
        throw Object.assign(new Error('What would be forfeited changed since it was confirmed.'), {
          code: BALANCE_FORFEIT,
          forfeit: { balanceCents, digitalPurchases },
        });
      }
    }
    if (owed && !force) {
      throw Object.assign(new Error('This account has earnings or a pending payout attached.'), { code: ACCOUNT_HAS_OBLIGATIONS, obligations });
    }

    // Privacy section 7: a shipped order's name and address can be deleted
    // on request -- and deleting the account is that request. Orders
    // themselves stay (they are financial records, and the creator's), but
    // every one that has already shipped loses the address now, inside
    // purgeUserContent. An unshipped one keeps it: the creator still has to
    // ship it (self-service refuses above while there are any; an
    // admin-forced deletion leaves them so the item can still be sent, and
    // markOrderShipped / closeUnfulfilledOrder erase it when it ships or is closed once the buyer is gone).
    await purgeUserContent(client, uid);
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
    // Belt and braces for the purge above (round-16 social#0): createNotification
    // now waits on this row's lock and inserts nothing once it is gone, and this
    // sweeps anything a caller wrote without going through it.
    await client.query('delete from notifications where user_id = $1', [uid]);
    await enqueueStandingPushes([{ uid, status: 'banned', role: user.creatorId ? 'CREATOR' : 'FAN' }], client);
    return { deletedUserId: uid, forfeitedCents: balanceCents, obligations };
  });
}
