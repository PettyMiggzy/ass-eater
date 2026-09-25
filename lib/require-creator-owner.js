import { getSessionUser } from './session';
import { getCreators, effectiveCreatorStatus } from './creators-store';
import { userWriteRestriction } from './user-moderation';

export async function requireCreatorOwner(req, res) {
  // getSessionUser, not a stateless token check: this gate guards every
  // creator-content-mutating endpoint, so a token copied off someone's
  // machine must stop working here the moment they log out. It returns the
  // user record too, so this costs no extra read over the findUserById it
  // replaces.
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'Not logged in' });
    return null;
  }
  const uid = user.id;

  if (user.role !== 'creator' || !user.creatorId) {
    res.status(403).json({ error: 'Not a creator account' });
    return null;
  }

  const creators = await getCreators();
  const creator = creators.find((c) => String(c.id) === String(user.creatorId));
  if (!creator) {
    res.status(404).json({ error: 'Creator profile not found' });
    return null;
  }

  // Account-level moderation, which an admin can now set on a creator
  // account whose profile is not approved (lib/users-store.js
  // setUserModeration): a suspended account is read-only everywhere.
  const accountRestricted = userWriteRestriction(user);
  if (accountRestricted) {
    res.status(403).json({ error: accountRestricted });
    return null;
  }

  const status = effectiveCreatorStatus(creator);
  if (status === 'banned') {
    res.status(403).json({ error: 'This account has been permanently banned and can no longer post or edit content.' });
    return null;
  }
  if (status === 'suspended') {
    res.status(403).json({
      error: `This account is suspended until ${new Date(creator.suspendedUntil).toLocaleDateString()} and can't post or edit content until then.`,
    });
    return null;
  }

  return { user, creator };
}
