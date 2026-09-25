/**
 * Account-level moderation for ANY login (fans included).
 *
 * Every posting restriction used to come from the CREATOR record's status,
 * and there was no status on a user account at all -- so a fan who harassed
 * creators on public walls, or kept tripping the payment-circumvention
 * filter, could only have each comment deleted, one report at a time, while
 * the account kept posting. An admin now sets `moderationStatus` on the user
 * record (lib/users-store.js setUserModeration, POST /api/admin/user-moderation):
 *
 *  - 'suspended' until `moderationUntil`: read-only. No wall posts, DMs,
 *    reports, checkout or credit purchases (the credits side is
 *    lib/credits-store.js accountStanding -> isFrozenStanding). Lifts by
 *    itself when the date passes, like a creator suspension.
 *  - 'banned': cannot be signed in at all -- lib/session.js getSessionUser
 *    refuses the session, login refuses the account, and the ban bumps the
 *    session epoch so every existing session dies with it.
 *
 * A CREATOR account's standing is its creator record (status on the creator
 * profile, which also drives visibility, payouts and server/); the admin
 * endpoint refuses to set this on one, so the two can never disagree.
 *
 * Pure: no database import.
 */

export const USER_MODERATION_STATUSES = ['suspended', 'banned'];

/** 'active' | 'suspended' | 'banned', with a lapsed suspension reading 'active'. */
export function effectiveUserStatus(user, now = Date.now()) {
  if (!user) return 'active';
  if (user.moderationStatus === 'banned') return 'banned';
  if (user.moderationStatus === 'suspended') {
    const until = Date.parse(user.moderationUntil ?? '');
    return Number.isFinite(until) && until > now ? 'suspended' : 'active';
  }
  return 'active';
}

/**
 * Fan-facing refusal for a write (post, message, report, purchase), or null.
 * Deliberately generic: it says the account is restricted, not what anyone
 * reported.
 */
export function userWriteRestriction(user, now = Date.now()) {
  const status = effectiveUserStatus(user, now);
  if (status === 'banned') return 'This account has been banned.';
  if (status === 'suspended') {
    const until = new Date(Date.parse(user.moderationUntil)).toISOString().slice(0, 10);
    return `This account is suspended until ${until} and can't post, message, report or buy until then.`;
  }
  return null;
}
