import { addToWaitlist, isValidWaitlistEmail, normalizeWaitlistRole } from '../../lib/waitlist-store';
import { consumeAttempt, clientIp } from '../../lib/rate-limit';

// Enough that a household or an office behind one address can all sign up,
// low enough that scripting thousands of junk addresses into the list costs
// something. A repeat signup from the same person folds into their existing
// row rather than adding one, so honest use barely touches this.
const MAX_SIGNUPS_PER_IP = 10;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Public, unauthenticated pre-launch signup. Deliberately reachable without
 * passing the age gate -- it is exempt in proxy.js -- because the whole
 * point is capturing people the site cannot serve yet, including every
 * visitor from the 27 geoblocked states, who otherwise hit /blocked-region
 * and are gone for good.
 *
 * Nothing here is behind the gate: no creator content, no account, no
 * payment. Just an address and which side of the platform someone is
 * interested in.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, role, source, website } = req.body || {};

  // Honeypot: a field hidden from real people that bots fill in anyway.
  // Answer 200 rather than an error -- telling a bot it was caught just
  // teaches whoever wrote it to stop filling that field in.
  if (website) return res.status(200).json({ ok: true });

  const { limited, retryAfterSeconds } = consumeAttempt(`waitlist:ip:${clientIp(req)}`, {
    limit: MAX_SIGNUPS_PER_IP,
    windowMs: SIGNUP_WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many signups from this connection. Please try again later.' });
  }

  if (!isValidWaitlistEmail(email)) {
    return res.status(400).json({ error: "That doesn't look like an email address." });
  }
  if (!normalizeWaitlistRole(role)) {
    return res.status(400).json({ error: 'Choose whether you are joining as a fan or a creator.' });
  }

  try {
    // Read the state off Vercel's edge headers rather than accepting one
    // from the caller. The edge sets these itself from the real client IP
    // and overwrites anything the client sent, which is the only reason
    // they are worth recording at all.
    await addToWaitlist({
      email,
      role,
      source,
      state: req.headers['x-vercel-ip-country-region'],
      country: req.headers['x-vercel-ip-country'],
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
