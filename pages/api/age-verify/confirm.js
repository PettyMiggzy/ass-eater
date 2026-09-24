import {
  AGE_VERIFIED_COOKIE_NAME,
  AGE_VERIFIED_MAX_AGE_SECONDS,
  ageVerificationSecret,
  createAgeVerificationToken,
} from '../../../lib/age-verification';
import { claimAgeVerificationUuid } from '../../../lib/age-verification-uses';
import { clientIp, consumeAttempt } from '../../../lib/rate-limit';

// The client-side AgeChecker popup (pages/verify-age.js) reports "accepted"
// via a JS callback, but that alone is bypassable -- anyone can fake the
// callback firing from devtools. This is the real gate: it calls
// AgeChecker's own Server API (GET /v1/status/:uuid, authenticated with our
// account secret, never exposed client-side) to confirm the verification
// actually is "accepted" before ever setting the cookie proxy.js checks.
//
// Each accepted uuid is redeemable ONCE (lib/age-verification-uses.js).
// Without that, a uuid posted anywhere minted a fresh 180-day cookie for
// anyone who replayed it, forever.
//
// Rate-limited per IP because every request that gets this far makes an
// authenticated call to AgeChecker with our account secret, and this route
// is public by design (proxy.js exempts /api/age-verify/ from both gates).
// The limit is generous -- the real flow is one POST per verification, and
// carrier NAT puts many real people behind one address -- and, like every
// limiter in lib/rate-limit.js, it is per-instance memory: a speed bump,
// not a hard cap.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 20;
const MAX_UUID_LENGTH = 200;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uuid } = req.body || {};
  if (!uuid || typeof uuid !== 'string' || !uuid.trim() || uuid.length > MAX_UUID_LENGTH) {
    return res.status(400).json({ error: 'Missing verification uuid' });
  }

  const secret = process.env.AGECHECKER_SECRET_KEY;
  const domainKey = process.env.NEXT_PUBLIC_AGECHECKER_KEY;
  if (!secret || !domainKey) {
    return res.status(501).json({ error: 'Age verification is not fully configured yet.' });
  }

  // Before the outbound call, or it limits nothing.
  const { limited, retryAfterSeconds } = consumeAttempt(`age-confirm:ip:${clientIp(req)}`, {
    limit: MAX_PER_IP,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please try again shortly.' });
  }

  let statusRes;
  try {
    statusRes = await fetch(`https://api.agechecker.net/v1/status/${encodeURIComponent(uuid.trim())}`, {
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

  // Claimed only after AgeChecker says "accepted", so random or pending
  // uuids never occupy the table, and before the cookie is minted, so a
  // database failure mints nothing.
  let claimed;
  try {
    claimed = await claimAgeVerificationUuid(uuid);
  } catch (err) {
    console.error('[age-verify/confirm] could not record verification use', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
  if (!claimed) {
    return res.status(409).json({ error: 'This verification has already been used. Please verify again.' });
  }

  const token = await createAgeVerificationToken(ageVerificationSecret(), { uuid: uuid.trim() });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AGE_VERIFIED_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AGE_VERIFIED_MAX_AGE_SECONDS}${secure}`);
  return res.status(200).json({ ok: true });
}
