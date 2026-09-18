import { clearSessionCookie, getSessionClaims } from '../../../lib/session';
import { bumpSessionVersion, SESSION_ALREADY_REVOKED } from '../../../lib/users-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const claims = getSessionClaims(req);
  // Clear the cookie first and unconditionally -- whatever happens below,
  // this browser is signed out.
  clearSessionCookie(res);

  if (claims) {
    try {
      // Session tokens are stateless and valid for 30 days, so dropping the
      // cookie alone leaves a copied token working long after the person
      // thought they'd logged out. Bumping the user's session epoch is what
      // retires it (see lib/users-store.js and getSessionUser in
      // lib/session.js -- note that only /api/auth/me consults the epoch so
      // far, so this is not yet the whole fix).
      //
      // The epoch from the presented token is passed along so this call can
      // only ever retire the session that token belongs to. Without that,
      // anyone holding a copied token could re-post here on a loop and kill
      // the owner's freshly created session every time they signed back in.
      await bumpSessionVersion(claims.uid, claims.sv);
    } catch (err) {
      if (err?.code === SESSION_ALREADY_REVOKED) {
        // An earlier logout already retired this token. Nothing left to do,
        // and nothing went wrong.
        return res.status(200).json({ ok: true });
      }
      // Don't claim a logout we didn't manage to perform: the cookie is
      // gone here, but any token copied elsewhere is still live.
      return res.status(500).json({ error: 'Signed out on this device, but the session could not be revoked everywhere. Please try again.' });
    }
  }

  return res.status(200).json({ ok: true });
}
