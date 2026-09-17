import { getSessionUserId } from './session';
import { findUserById } from './users-store';
import { getCreators, effectiveCreatorStatus } from './creators-store';

export async function requireCreatorOwner(req, res) {
  const uid = getSessionUserId(req);
  if (!uid) {
    res.status(401).json({ error: 'Not logged in' });
    return null;
  }

  const user = await findUserById(uid);
  if (!user || user.role !== 'creator' || !user.creatorId) {
    res.status(403).json({ error: 'Not a creator account' });
    return null;
  }

  const creators = await getCreators();
  const creator = creators.find((c) => String(c.id) === String(user.creatorId));
  if (!creator) {
    res.status(404).json({ error: 'Creator profile not found' });
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
