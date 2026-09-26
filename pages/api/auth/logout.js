import { clearSessionCookie, getSessionClaims } from '../../../lib/session';
import { bumpSessionVersion, SESSION_ALREADY_REVOKED, SESSION_USER_GONE } from '../../../lib/users-store';
import { refuseCrossSite } from '../../../lib/same-origin';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Refused cross-site BEFORE the cookie is cleared (round-21 gates-token#2):
  // the effect of this route is the Set-Cookie on the response, which a
  // browser applies even to a cross-site top-level form POST that carried no
  // session cookie -- so any website could sign a visitor out, over and over.
  // The site's own caller (pages/dashboard.js) is a same-origin fetch with no
  // body. See lib/same-origin.js.
  if (refuseCrossSite(req, res)) return;

  const claims = getSessionClaims(req);
  // Clear the cookie first and unconditionally -- whatever happens below,
  // this browser is signed out.
  clearSessionCookie(res);

  if (claims) {
    try {
      // Session tokens are stateless and valid for 30 days, so dropping the
      // cookie alone leaves a copied token working long after the person
      // thought they'd logged out. Bumping the user's session epoch is what
      // retires it -- lib/session.js's getSessionUser/getVerifiedSessionUserId
      // both check it, and every route that authenticates a session
      // (dashboard, messages, credits, notifications, etc.) goes through one
      // of those two, not the old non-revocation-aware getSessionUserId,
      // which was deleted outright rather than left around to be used by
      // accident (see lib/session.js's own comment on that removal).
      //
      // The epoch from the presented token is passed along so this call can
      // only ever retire the session that token belongs to. Without that,
      // anyone holding a copied token could re-post here on a loop and kill
      // the owner's freshly created session every time they signed back in.
      await bumpSessionVersion(claims.uid, claims.sv);
    } catch (err) {
      if (err?.code === SESSION_ALREADY_REVOKED || err?.code === SESSION_USER_GONE) {
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
