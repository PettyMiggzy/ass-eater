import { addNciiReport, NCII_FIELD_LIMITS, NCII_CATEGORIES } from '../../lib/ncii-reports-store';
import { consumeNetworkAttempt, clientNetwork, clientNetworkCoarse } from '../../lib/rate-limit';
import { consumeLoginAttempts, releaseLoginAttempts } from '../../lib/login-guard';
import { sendNciiAlert } from '../../lib/alerts';
import { refuseMalformedText } from '../../lib/field-validation';
import { CONTROL_CHAR_RE } from '../../lib/unicode-text';

// Deliberately generous. This queue is sorted oldest-first and carries a
// federal 48-hour clock, so burying it under junk filings is a real way to
// hurt actual victims -- but a limit tight enough to inconvenience a genuine
// reporter would be worse than the flooding it prevents. Twenty filings from
// one address in an hour is far past any honest use and far below anything a
// person reporting themselves would hit.
const MAX_REPORTS_PER_IP = 20;
// Per IPv6 /48 (round-10 gates-token#1): one routed allocation is 65,536
// /64s, and without this each could mint its own budget -- and its own key in
// the limiter's map. Generous, since a carrier puts many subscribers in one.
const MAX_REPORTS_PER_NETWORK = MAX_REPORTS_PER_IP * 10;
const REPORT_WINDOW_MS = 60 * 60 * 1000;
// The in-memory limit above is per warm serverless instance, so a flood
// spread over instances got a budget per instance. The same budget is also
// counted in Postgres (lib/login-guard.js's shared fixed-window counters,
// under their own 'ncii-report:' keys), which every instance shares: per /64
// (or IPv4 address) and per /48, over half-hour windows (the counters'
// housekeeping keeps rows for 30 minutes), i.e. the same 20/200 an hour
// (round-12 social#0). A database hiccup here fails OPEN -- the in-memory
// limit still applies, and a victim's filing must not be refused because a
// counter could not be read.
const DURABLE_WINDOW_MS = 30 * 60 * 1000;
const DURABLE_PER_IP = MAX_REPORTS_PER_IP / 2;
const DURABLE_PER_NETWORK = MAX_REPORTS_PER_NETWORK / 2;

async function durablyLimited(req) {
  const ip = clientNetwork(req);
  const net = clientNetworkCoarse(req);
  const entries = [{ key: `ncii-report:ip:${ip}`, limit: DURABLE_PER_IP }];
  if (net !== ip) entries.push({ key: `ncii-report:net:${net}`, limit: DURABLE_PER_NETWORK });
  try {
    const out = await consumeLoginAttempts(entries, { windowMs: DURABLE_WINDOW_MS });
    const hit = Object.values(out).find((o) => o.limited);
    if (!hit) return null;
    // A refused filing is not counted: the counters stay the number of
    // filings actually accepted.
    await releaseLoginAttempts(entries.map((e) => e.key), { windowMs: DURABLE_WINDOW_MS });
    return hit.retryAfterSeconds;
  } catch (err) {
    console.error('[report-content] durable rate limit unavailable; relying on the in-memory limit:', err?.message || err);
    return null;
  }
}

// C0/C1 control characters are refused (lib/unicode-text.js CONTROL_CHAR_RE):
// a 4,000-character field of them was ~24 KB in the admin list, the cheapest
// way to inflate the queue (round-12 social#0).

// Deliberately unauthenticated -- required by the federal TAKE IT DOWN Act's
// notice-and-removal process, which must be usable by anyone depicted in
// non-consensual content, whether or not they have (or want) an account
// here. Do not add a login requirement to this endpoint.
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { limited, retryAfterSeconds } = consumeNetworkAttempt(req, 'ncii-report', {
    networkLimit: MAX_REPORTS_PER_NETWORK,
    limit: MAX_REPORTS_PER_IP,
    windowMs: REPORT_WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      error: 'Too many reports from this address in a short time. Please wait and try again — if this is urgent, email team@onlyone1.fun.',
    });
  }

  const { reporterName, reporterContact, contentLocation, description, consentStatement, goodFaithStatement } = req.body || {};
  // Who is filing (lib/ncii-reports-store.js NCII_CATEGORIES). Absent means a
  // 'self' filing, the form's original shape; anything else unknown is refused
  // rather than guessed, since it decides which statement is required.
  const rawCategory = (req.body || {}).category;
  if (rawCategory !== undefined && rawCategory !== null && !NCII_CATEGORIES.includes(rawCategory)) {
    return res.status(400).json({ error: 'Choose who is making this report' });
  }
  const category = rawCategory || 'self';

  // typeof checks, not just truthiness: `!x` lets a truthy non-string
  // (an object, a number) through, and `.trim()` on it throws a raw
  // TypeError -- an unhandled 500 on a public, unauthenticated, deliberately
  // must-stay-freely-accessible TAKE IT DOWN Act endpoint.
  if (typeof reporterName !== 'string' || !reporterName.trim()) {
    return res.status(400).json({ error: 'Your name is required' });
  }
  if (typeof reporterContact !== 'string' || !reporterContact.trim()) {
    return res.status(400).json({ error: 'A way to contact you is required' });
  }
  if (typeof contentLocation !== 'string' || !contentLocation.trim()) {
    return res.status(400).json({ error: 'Please describe or link the specific content' });
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return res.status(400).json({ error: 'The description must be text' });
  }
  for (const [field, value] of Object.entries({ reporterName, reporterContact, contentLocation, description })) {
    if (typeof value === 'string' && CONTROL_CHAR_RE.test(value)) {
      return res.status(400).json({
        error: 'Your report contains an invisible control character. Remove it (retyping the text usually does) and try again, or email team@onlyone1.fun.',
        field,
      });
    }
  }
  // Too long is refused, never cut: a truncated location list is content
  // that stays up while the reporter was told the report was received.
  const LABELS = { reporterName: 'Your name', reporterContact: 'Your contact details', contentLocation: 'Where the content is', description: 'The details' };
  for (const [field, max] of Object.entries(NCII_FIELD_LIMITS)) {
    const value = { reporterName, reporterContact, contentLocation, description }[field];
    if (typeof value === 'string' && value.length > max) {
      return res.status(400).json({
        error: `${LABELS[field]} is too long (${value.length} of ${max} characters). Shorten it (or file the rest as a second report), or email team@onlyone1.fun.`,
        field,
        maxLength: max,
      });
    }
  }
  // The self-attestation ("I am the person who appears ... posted without
  // consent") is only asked of someone who can truthfully make it. A third
  // party -- including anyone reporting a suspected minor -- signs a plain
  // good-faith statement instead; requiring the self-attestation from them
  // meant either no report at all or a knowingly false one.
  if (category === 'self' ? consentStatement !== true : goodFaithStatement !== true) {
    return res.status(400).json({ error: 'You must confirm the statement below to submit a report' });
  }

  // Counted only for a filing that passed validation, like the store insert
  // it guards.
  const durableRetry = await durablyLimited(req);
  if (durableRetry) {
    res.setHeader('Retry-After', String(durableRetry));
    return res.status(429).json({
      error: 'Too many reports from this address in a short time. Please wait and try again — if this is urgent, email team@onlyone1.fun.',
    });
  }

  try {
    const report = await addNciiReport({
      reporterName, reporterContact, contentLocation, description, consentStatement, goodFaithStatement, category,
    });
    // After the insert, never before and never instead of it: the filing is
    // what the law cares about, the alert is how a human finds out about it
    // before the 48-hour clock runs down. sendNciiAlert never throws and has
    // its own timeout, and it carries only the report id, time and (for a
    // possible-minor filing) a fixed "POSSIBLE MINOR" label taken from the
    // stored category -- no reporter name or contact goes to a third-party
    // webhook.
    await sendNciiAlert({ id: report.id, createdAt: report.createdAt, category: report.category });
    return res.status(200).json({ ok: true, report: { id: report.id } });
  } catch (err) {
    console.error('[report-content] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
