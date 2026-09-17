import { AGE_VERIFIED_COOKIE_NAME, ageVerificationSecret, createAgeVerificationToken } from '../../../lib/age-verification';

// The client-side AgeChecker popup (pages/verify-age.js) reports "accepted"
// via a JS callback, but that alone is bypassable -- anyone can fake the
// callback firing from devtools. This is the real gate: it calls
// AgeChecker's own Server API (GET /v1/status/:uuid, authenticated with our
// account secret, never exposed client-side) to confirm the verification
// actually is "accepted" before ever setting the cookie proxy.js checks.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uuid } = req.body || {};
  if (!uuid || typeof uuid !== 'string') {
    return res.status(400).json({ error: 'Missing verification uuid' });
  }

  const secret = process.env.AGECHECKER_SECRET_KEY;
  const domainKey = process.env.NEXT_PUBLIC_AGECHECKER_KEY;
  if (!secret || !domainKey) {
    return res.status(501).json({ error: 'Age verification is not fully configured yet.' });
  }

  let statusRes;
  try {
    statusRes = await fetch(`https://api.agechecker.net/v1/status/${encodeURIComponent(uuid)}`, {
      headers: { 'X-AgeChecker-Secret': secret },
    });
  } catch {
    return res.status(502).json({ error: 'Could not reach the verification service. Please try again.' });
  }

  const data = await statusRes.json().catch(() => null);
  if (!statusRes.ok || !data) {
    return res.status(502).json({ error: 'Verification service returned an unexpected response.' });
  }

  // The status response echoes the domain key the verification was created
  // under -- confirm it matches ours so a UUID from an unrelated site/account
  // can never be replayed here.
  if (data.key !== domainKey) {
    return res.status(400).json({ error: 'Verification does not belong to this site.' });
  }

  if (data.status !== 'accepted') {
    return res.status(400).json({ error: 'Age verification was not accepted.' });
  }

  const token = await createAgeVerificationToken(ageVerificationSecret(), { uuid });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AGE_VERIFIED_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 180}${secure}`);
  return res.status(200).json({ ok: true });
}
