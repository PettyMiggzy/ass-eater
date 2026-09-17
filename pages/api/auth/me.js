import { getSessionUser } from '../../../lib/session';
import { publicUser } from '../../../lib/users-store';

export default async function handler(req, res) {
  // getSessionUser, not getSessionUserId: the stateless token alone doesn't
  // prove the session is still live, so a session that was logged out
  // elsewhere has to report as signed out here.
  const user = await getSessionUser(req);
  return res.status(200).json({ user: publicUser(user) });
}
