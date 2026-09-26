import { addToWaitlist, isValidWaitlistEmail, normalizeWaitlistRole } from '../../lib/waitlist-store';
import { consumeNetworkAttempt } from '../../lib/rate-limit';
import { refuseMalformedText } from '../../lib/field-validation';

// Enough that a household or an office behind one address can all sign up,
// low enough that scripting thousands of junk addresses into the list costs
// something. A repeat signup from the same person folds into their existing
// row rather than adding one, so honest use barely touches this.
const MAX_SIGNUPS_PER_IP = 10;
// Per IPv6 /48 (round-10 gates-token#1): one routed allocation is 65,536
// /64s, and without this each could mint its own budget -- and its own key in
// the limiter's map. Generous, since a carrier puts many subscribers in one.
const MAX_SIGNUPS_PER_NETWORK = MAX_SIGNUPS_PER_IP * 10;
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
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, role, source, website } = req.body || {};

  // Honeypot: a field hidden from real people that bots fill in anyway.
  // Answer 200 rather than an error -- telling a bot it was caught just
  // teaches whoever wrote it to stop filling that field in.
  if (website) return res.status(200).json({ ok: true });

  const { limited, retryAfterSeconds } = consumeNetworkAttempt(req, 'waitlist', {
    networkLimit: MAX_SIGNUPS_PER_NETWORK,
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
    //
    // Only a US state is kept, and nothing else about location: its one
    // purpose (the Privacy Policy, Section 1) is telling someone when their
    // geoblocked state opens. A non-US visitor's region ('ON' for Ontario)
    // and anyone's country were stored here without being disclosed.
    const country = String(req.headers['x-vercel-ip-country'] || '').toUpperCase();
    await addToWaitlist({
      email,
      role,
      source,
      state: country === 'US' ? req.headers['x-vercel-ip-country-region'] : null,
      country: null,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    // addToWaitlist's own defense-in-depth checks (already validated above
    // via isValidWaitlistEmail/normalizeWaitlistRole, so not normally
    // reachable) -- anything else is an unexpected DB failure.
    if (err.message === 'A valid email address is required' || err.message === 'Tell us whether you are joining as a fan or a creator') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[waitlist] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
