import { getSessionUser } from '../../../../lib/session';
import { getCreatorById, effectiveCreatorStatus } from '../../../../lib/creators-store';
import { markOrderShipped, trackingFieldsError, ORDER_CLOSED, TRACKING_EDIT_LIMIT } from '../../../../lib/orders-store';
import { refuseMalformedText } from '../../../../lib/field-validation';
import { screenPublicText } from '../../../../lib/prohibited-terms';
import { addViolation } from '../../../../lib/violations-store';
import { consumeAttempt } from '../../../../lib/rate-limit';

// Ships and tracking corrections per creator per hour (round-14
// public-pages#0: corrections are allowed now, so the route is no longer
// write-once).
const SHIP_LIMIT = 30;
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

  const { limited, retryAfterSeconds } = consumeAttempt(`ship-order:creator:${creator.id}`, { limit: SHIP_LIMIT, windowMs: SHIP_WINDOW_MS });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many shipping updates recently. Please wait a while and try again.' });
  }

  const { orderId, carrier, trackingNumber } = req.body || {};
  const idOk = (typeof orderId === 'string' && /^\d{1,18}$/.test(orderId)) || (Number.isSafeInteger(orderId) && orderId > 0);
  if (!idOk || typeof carrier !== 'string' || !carrier.trim() || typeof trackingNumber !== 'string' || !trackingNumber.trim()) {
    return res.status(400).json({ error: 'Missing order id, carrier, or tracking number' });
  }
  const fields = { carrier: carrier.trim().replace(/\s+/g, ' '), trackingNumber: trackingNumber.trim().replace(/\s+/g, ' ') };

  // Round 14 (public-pages#0): the carrier and tracking number are shown on
  // the buyer's /orders page, so they are creator-to-buyer text like a DM:
  // screened for fee-dodging and prohibited terms (and logged to the
  // violations queue on a hit) BEFORE the charset check, so an attempt is
  // recorded even when the charset alone would have refused it.
  // Each field, and the two together as the buyer reads them ("text" +
  // "617 555 1234" is a phone handover only when joined).
  const screens = [
    ['carrier', 'order_carrier', fields.carrier],
    ['trackingNumber', 'order_tracking_number', fields.trackingNumber],
    ['trackingNumber', 'order_tracking', `${fields.carrier} ${fields.trackingNumber}`],
  ];
  for (const [field, context, value] of screens) {
    const hit = screenPublicText(value);
    if (hit) {
      await addViolation({ userId: user.id, context, reasons: hit.reasons, snippet: value });
      return res.status(400).json({ error: hit.message, field });
    }
  }
  const fieldError = trackingFieldsError(fields);
  if (fieldError) return res.status(400).json({ error: fieldError.message, field: fieldError.field });

  try {
    // markOrderShipped only matches an order whose creatorId equals creator.id --
    // a creator can't mark another creator's order shipped, this isn't just a UI restriction.
    const order = await markOrderShipped(orderId, creator.id, fields);
    return res.status(200).json({ ok: true, order });
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
