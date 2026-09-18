import { getSessionUser } from '../../../lib/session';
import { publicUser } from '../../../lib/users-store';

export default async function handler(req, res) {
  // getSessionUser consults the account's session epoch, so a session that
  // was logged out elsewhere reports as signed out here rather than on the
  // strength of a still-unexpired token alone.
  const user = await getSessionUser(req);
  return res.status(200).json({ user: publicUser(user) });
}
