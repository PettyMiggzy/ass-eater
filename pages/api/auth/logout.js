import { clearSessionCookie, getSessionUserId } from '../../../lib/session';
import { bumpSessionVersion } from '../../../lib/users-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = getSessionUserId(req);
  // Clear the cookie first and unconditionally -- whatever happens below,
  // this browser is signed out.
  clearSessionCookie(res);

  if (uid) {
    try {
      // Session tokens are stateless and valid for 30 days, so dropping the
      // cookie alone left a copied token working long after the person
      // thought they'd logged out. Bumping the user's session epoch is what
      // actually retires it (see lib/users-store.js and getSessionUser in
      // lib/session.js).
      await bumpSessionVersion(uid);
    } catch {
      // Don't claim a logout we didn't manage to perform: the cookie is
      // gone here, but any token copied elsewhere is still live.
      return res.status(500).json({ error: 'Signed out on this device, but the session could not be revoked everywhere. Please try again.' });
    }
  }

  return res.status(200).json({ ok: true });
}
