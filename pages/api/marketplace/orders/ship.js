import { getSessionUser } from '../../../../lib/session';
import { getCreatorById, effectiveCreatorStatus } from '../../../../lib/creators-store';
import {
  markOrderShipped, trackingFieldsError, normalizeTracking, getOrderShipState, ORDER_CLOSED, TRACKING_EDIT_LIMIT,
} from '../../../../lib/orders-store';
import { refuseMalformedText } from '../../../../lib/field-validation';
import { addViolation } from '../../../../lib/violations-store';
import { consumeAttempt } from '../../../../lib/rate-limit';
import { trackingFormatWarning } from '../../../../lib/tracking-rules';

// Round 15 (money#1 / dashboard#0): the round-14 limit counted EVERY call --
// first shipments, refused attempts and same-value re-saves -- so a creator
// marking a 45-order drop shipped was locked out after the 30th. Now:
//   - tracking CORRECTIONS of an already-shipped order are capped per creator
//     per hour (each order also allows only MAX_TRACKING_CORRECTIONS in the
//     database), and only a correction that will actually be written counts;
//   - everything else shares a generous per-creator abuse cap far above any
//     realistic batch of first shipments.
const CORRECTION_LIMIT = 30;
const SHIP_ABUSE_LIMIT = 600;
const SHIP_WINDOW_MS = 60 * 60 * 1000;

// Own auth rather than requireCreatorOwner, for the same reason as
// orders/creator.js: a suspended creator must still be able to ship orders
// fans already paid for. Only a banned account is refused.
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  if (user.role !== 'creator' || !user.creatorId) return res.status(403).json({ error: 'Not a creator account' });
  const creator = await getCreatorById(user.creatorId);
  if (!creator) return res.status(404).json({ error: 'Creator profile not found' });
  if (effectiveCreatorStatus(creator) === 'banned') {
    return res.status(403).json({ error: 'This account has been permanently banned.' });
  }

  const abuse = consumeAttempt(`ship-order:creator:${creator.id}`, { limit: SHIP_ABUSE_LIMIT, windowMs: SHIP_WINDOW_MS });
  if (abuse.limited) {
    res.setHeader('Retry-After', String(abuse.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many shipping updates recently. Please wait a while and try again.' });
  }

  const { orderId, carrier, trackingNumber } = req.body || {};
  const idOk = (typeof orderId === 'string' && /^\d{1,18}$/.test(orderId)) || (Number.isSafeInteger(orderId) && orderId > 0);
  if (!idOk || typeof carrier !== 'string' || !carrier.trim() || typeof trackingNumber !== 'string' || !trackingNumber.trim()) {
    return res.status(400).json({ error: 'Missing order id, carrier, or tracking number' });
  }

  // Round 15 (money#0, public-pages#0, legal-journeys#1): the carrier and
  // tracking number are shown on the buyer's /orders page, so they are not
  // free text: the carrier is one of a fixed list and the tracking number is
  // 8-35 letters/digits with at least 6 digits (lib/tracking-rules.js). Round
  // 16 (money#0/#1, dashboard#0/#1) dropped the per-carrier formats, check
  // digits and phone heuristics, which refused real numbers: only what cannot
  // be a tracking number is refused, and ONLY an app name (as the carrier or
  // inside the number) is logged to the violations queue as a suspected
  // handover. A number that merely looks unusual for its carrier ships, with
  // a non-blocking `warning` in the response.
  const fieldError = trackingFieldsError({ carrier, trackingNumber });
  if (fieldError) {
    if (fieldError.suspicious) {
      await addViolation({
        userId: user.id,
        context: fieldError.field === 'carrier' ? 'order_carrier' : 'order_tracking_shape',
        reasons: [fieldError.message],
        snippet: `${carrier.trim().slice(0, 60)} ${trackingNumber.trim().slice(0, 60)}`,
      });
    }
    return res.status(400).json({ error: fieldError.message, field: fieldError.field });
  }
  const fields = normalizeTracking({ carrier, trackingNumber });

  // Only a correction that will be written counts toward the correction cap:
  // a first shipment, a same-value re-save and a correction the per-order cap
  // will refuse (409) do not.
  const state = await getOrderShipState(orderId, creator.id);
  if (state && state.status === 'shipped' && state.correctionsLeft > 0
    && (state.carrier !== fields.carrier || state.trackingNumber !== fields.trackingNumber)) {
    const { limited, retryAfterSeconds } = consumeAttempt(`ship-correction:creator:${creator.id}`, { limit: CORRECTION_LIMIT, windowMs: SHIP_WINDOW_MS });
    if (limited) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'Too many tracking corrections recently. Please wait a while and try again.' });
    }
  }

  try {
    // markOrderShipped only matches an order whose creatorId equals creator.id --
    // a creator can't mark another creator's order shipped, this isn't just a UI restriction.
    const order = await markOrderShipped(orderId, creator.id, fields);
    const warning = trackingFormatWarning(fields);
    return res.status(200).json({ ok: true, order, ...(warning ? { warning } : {}) });
  } catch (err) {
    if (err.code === ORDER_CLOSED) return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === TRACKING_EDIT_LIMIT) return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'ADDRESS_UNREADABLE') return res.status(409).json({ error: err.message, code: err.code });
    if (err.message === 'Order not found') return res.status(404).json({ error: err.message });
    if (err.message === 'Only physical orders can be marked shipped') return res.status(400).json({ error: err.message });
    console.error('[marketplace/orders/ship] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
