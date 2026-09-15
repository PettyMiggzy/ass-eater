import { getSessionUserId } from '../../../lib/session';
import { findUserById, publicUser } from '../../../lib/users-store';

export default async function handler(req, res) {
  const uid = getSessionUserId(req);
  if (!uid) return res.status(200).json({ user: null });

  const user = await findUserById(uid);
  return res.status(200).json({ user: publicUser(user) });
}
