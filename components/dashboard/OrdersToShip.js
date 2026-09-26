import { useEffect, useState } from 'react';
import { getJson, postJson } from './media-upload';
import { responseErrorMessage, retryAfterHint } from './helpers';
import {
  SHIPPING_CARRIERS, TRACKING_FORMAT_HINTS, normalizeCarrier, trackingFieldsError, trackingFormatWarning,
} from '../../lib/tracking-rules';

// The carrier is one of a fixed list (lib/tracking-rules.js -- the ship route
// enforces the same rules). The tracking number is refused only when it
// cannot be a tracking number at all (6-35 letters/digits, at least 2 digits,
// no "@", no contact/payment app name, round 18); a run of letters is never
// refused. A number that merely doesn't match the carrier's
// USUAL shape (wrong length, check digit, a word in it) gets a non-blocking
// note (trackingFormatWarning), shown live here and again, after the save,
// in the queue's banner in its post-save wording ({ saved: true }: no "before
// saving", plus what to do if it is wrong). The line under the input is the
// carrier's TRACKING_FORMAT_HINTS entry.
function TrackingFields({ orderId, form, disabled, onChange, borderFor, orderError, labelled }) {
  const hint = form.carrier && TRACKING_FORMAT_HINTS[form.carrier];
  const typed = typeof form.trackingNumber === 'string' ? form.trackingNumber.trim() : '';
  const liveWarning = form.carrier && typed && !trackingFieldsError(form) ? trackingFormatWarning(form) : null;
  return (
    <>
      <select
        value={form.carrier}
        disabled={disabled}
        aria-invalid={orderError?.field === 'carrier'}
        aria-label={labelled ? `Carrier for order ${orderId}` : 'Carrier'}
        onChange={(e) => onChange({ ...form, carrier: e.target.value })}
        className={`px-3 py-2 rounded-md bg-black/40 border ${borderFor('carrier')} text-white text-xs disabled:opacity-50`}
      >
        <option value="">Carrier…</option>
        {SHIPPING_CARRIERS.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <div className="flex flex-col">
        <input
          value={form.trackingNumber}
          disabled={disabled}
          aria-invalid={orderError?.field === 'trackingNumber'}
          aria-label={labelled ? `Tracking number for order ${orderId}` : 'Tracking number'}
          aria-describedby={`tracking-hint-${orderId}`}
          onChange={(e) => onChange({ ...form, trackingNumber: e.target.value })}
          placeholder="Tracking number"
          className={`px-3 py-2 rounded-md bg-black/40 border ${borderFor('trackingNumber')} text-white text-xs disabled:opacity-50`}
        />
        <span id={`tracking-hint-${orderId}`} className="text-[11px] text-gray-500 mt-1 max-w-xs">
          {hint
            ? `${form.carrier}: ${hint}.`
            : `Pick the carrier first. Not listed? Choose Other: ${TRACKING_FORMAT_HINTS.Other}.`}
        </span>
        {liveWarning && <span className="text-[11px] text-brand-gold mt-1 max-w-xs">{liveWarning}</span>}
      </div>
    </>
  );
}

/**
 * A creator's physical-order queue. Deliberately shown to suspended (and
 * pending) creators too: fans have already paid for these orders, and
 * /api/marketplace/orders/creator + /ship let a suspended creator see and
 * ship what they sold. A banned account gets the server's refusal, shown as
 * such -- a failed load must never read as "No physical orders yet".
 */
// What was bought. The order row is the only record of it (one listing =
// one item to ship), so every row names the item: the title snapshotted at
// checkout, else the listing id. Linked to the listing on the Marketplace.
function OrderItem({ o }) {
  const label = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : o.listingId != null ? `Listing #${o.listingId}` : 'Unknown item';
  if (o.listingId == null || o.creatorId == null) return <span>{label}</span>;
  const href = `/marketplace?creator=${encodeURIComponent(String(o.creatorId))}&listing=${encodeURIComponent(String(o.listingId))}`;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-brand-pink hover:underline break-words">
      {label}
    </a>
  );
}

export default function OrdersToShip() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [shipForm, setShipForm] = useState({}); // orderId -> { carrier, trackingNumber }
  // Orders with a save in flight (orderId -> true). Per order, not one shared
  // id: a request that finishes must re-enable only its own order's button,
  // never another order's whose request is still running (round-18
  // dashboard#1).
  const [busy, setBusy] = useState({});
  // A refusal that moved the order out of this list (ORDER_CLOSED):
  // { orderId, message }, shown in the banner since the order is gone from
  // the queue it belonged to.
  const [error, setError] = useState(null);
  // Shipped orders whose "Edit tracking" form is open (orderId -> true). The
  // ship route accepts an order already 'shipped' as a carrier/tracking
  // correction (lib/orders-store.js markOrderShipped) -- it keeps the original
  // shippedAt and stamps trackingUpdatedAt -- and this is the only control
  // that reaches it (round-13 dashboard#0).
  const [editing, setEditing] = useState({});
  // The ship route's refusals, shown next to the order they belong to rather
  // than only in the shared banner (round 14), keyed by order id:
  // orderId -> { field, message, code? }. Keyed so that saving one order
  // clears only that order's refusal, never another's the creator has not
  // read yet (round-18 dashboard#1). `field` is 'carrier' | 'trackingNumber'
  // when the server names one (a carrier not on the list, a tracking number
  // that cannot be one) and that input is outlined.
  const [orderErrors, setOrderErrors] = useState({});
  // The non-blocking format notes after successful saves, keyed by order id:
  // orderId -> { message, next }. The number was saved but doesn't match the
  // carrier's usual format; `next` says how to fix it if it is wrong. Shown
  // in the banner above the queue, not only under the order: a first
  // shipment moves the order out of the pending list into the Shipped
  // section, which is collapsed, so a notice only there went unseen
  // (round-17 dashboard#2).
  const [orderNotices, setOrderNotices] = useState({});
  const setOrderError = (orderId, err) => setOrderErrors((m) => {
    if (!err && !(orderId in m)) return m;
    const next = { ...m };
    if (err) next[orderId] = err; else delete next[orderId];
    return next;
  });
  const clearNotice = (orderId) => setOrderNotices((m) => {
    if (!(orderId in m)) return m;
    const next = { ...m };
    delete next[orderId];
    return next;
  });
  // The Shipped <details> is controlled so a post-save notice can open it:
  // the order the notice is about, and its Edit tracking control, are there.
  const [shippedOpen, setShippedOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const { res, data } = await getJson('/api/marketplace/orders/creator');
      if (!res.ok) {
        setLoadError(responseErrorMessage(res.status, data, 'Could not load your orders.'));
        return;
      }
      setOrders(Array.isArray(data?.orders) ? data.orders : []);
    } catch {
      setLoadError('Could not load your orders. Check your connection.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Used both to ship a pending order and to correct the tracking of one
  // already shipped: same route, same body.
  const markShipped = async (orderId) => {
    const { carrier, trackingNumber } = shipForm[orderId] || {};
    if (busy[orderId]) return;
    if (!carrier || !trackingNumber?.trim()) {
      setOrderError(orderId, { field: !carrier ? 'carrier' : 'trackingNumber', message: !carrier ? 'Pick a carrier first.' : 'Enter the tracking number first.' });
      return;
    }
    setBusy((m) => ({ ...m, [orderId]: true }));
    setError((e) => (e && e.orderId === orderId ? null : e));
    setOrderError(orderId, null);
    clearNotice(orderId);
    try {
      const { res, data } = await postJson('/api/marketplace/orders/ship', {
        orderId,
        carrier,
        trackingNumber: trackingNumber.trim(),
      });
      if (res.status === 409 && data?.code === 'ORDER_CLOSED') {
        // An admin closed it (the order can never be fulfilled) while it was
        // on screen: show the refusal and re-read the queue, so it moves out
        // of "waiting to ship" instead of staying there with a live button.
        setError({ orderId, message: responseErrorMessage(res.status, data, 'This order was closed and can no longer be shipped.') });
        await load();
        return;
      }
      if (res.status === 429) {
        setOrderError(orderId, { field: '', message: responseErrorMessage(res.status, data, 'Too many shipping updates recently.') + retryAfterHint(res) });
        return;
      }
      if (res.status === 400 && (data?.field === 'carrier' || data?.field === 'trackingNumber')) {
        setOrderError(orderId, { field: data.field, message: responseErrorMessage(res.status, data, 'Check the carrier and tracking number.') });
        return;
      }
      if (res.status === 409 && data?.code === 'TRACKING_EDIT_LIMIT') {
        // Tracking can no longer be changed for this order (the correction
        // cap is used up -- the only reason: an order whose buyer's address
        // was erased still takes corrections, lib/orders-store.js
        // markOrderShipped). The form is closed so it
        // stops offering a save the server will refuse, and the order's
        // trackingCorrectionsLeft is zeroed locally so the Edit control stays
        // hidden and this explanation stays on screen.
        setOrderError(orderId, { field: '', code: 'TRACKING_EDIT_LIMIT', message: responseErrorMessage(res.status, data, 'Tracking can no longer be changed for this order. Contact team@onlyone1.fun if it needs changing.') });
        setOrders((list) => list.map((o) => (o.id === orderId ? { ...o, trackingCorrectionsLeft: 0 } : o)));
        setEditing((m) => { const next = { ...m }; delete next[orderId]; return next; });
        return;
      }
      // ADDRESS_UNREADABLE (409, pending orders only) and 404 'Order not
      // found' carry their own readable message; responseErrorMessage shows it.
      if (!res.ok || !data?.order) {
        setOrderError(orderId, { field: '', message: responseErrorMessage(res.status, data, 'Failed to save the tracking details') });
        return;
      }
      setOrders((list) => list.map((o) => (o.id === orderId ? data.order : o)));
      if (typeof data.warning === 'string' && data.warning) {
        // The route's `warning` is the pre-save wording ("Double-check it
        // before saving."); the banner uses the post-save wording for the
        // same values the server checked, falling back to the route's text.
        const message = trackingFormatWarning({ carrier, trackingNumber: trackingNumber.trim() }, { saved: true })
          || data.warning.replace(/\s*Double-check it before saving\.$/, '');
        const next = correctionsLeft(data.order) > 0
          ? 'If it\'s wrong, use Edit tracking on the order below (corrections are limited).'
          : 'If it\'s wrong, contact team@onlyone1.fun.';
        setOrderNotices((m) => ({ ...m, [orderId]: { message, next } }));
        if (data.order.status === 'shipped') setShippedOpen(true);
      }
      setEditing((m) => { const next = { ...m }; delete next[orderId]; return next; });
    } catch {
      setOrderError(orderId, { field: '', message: 'Could not reach the server. Check your connection and try again.' });
    } finally {
      setBusy((m) => { const next = { ...m }; delete next[orderId]; return next; });
    }
  };

  const pending = orders.filter((o) => o.status === 'pending_shipment');
  const shipped = orders.filter((o) => o.status === 'shipped');

  // Red outline on the input the server named for this order.
  const inputBorder = (orderId, field) => (orderErrors[orderId] && orderErrors[orderId].field === field ? 'border-red-500' : 'border-brand-purple/30');
  // A post-save notice is in the banner (see orderNotices); under the order
  // it is repeated only as a short marker so the two can be matched up.
  const errorFor = (orderId) => (orderErrors[orderId] ? (
    <p role="alert" className="text-xs text-red-400 mt-1 w-full">{orderErrors[orderId].message}</p>
  ) : orderNotices[orderId] ? (
    <p className="text-xs text-brand-gold mt-1 w-full">Saved — double-check this number (see above).</p>
  ) : null);

  const openEdit = (o) => {
    // Clear only a stale error for THIS order; a limit refusal is never
    // cleared here (the Edit control is hidden once no corrections remain).
    if (orderErrors[o.id]?.code !== 'TRACKING_EDIT_LIMIT') setOrderError(o.id, null);
    setShipForm((f) => ({
      ...f,
      [o.id]: {
        // A stored carrier is canonical since round 15; an older free-text one
        // that is not on the list starts blank so the creator must pick one.
        carrier: normalizeCarrier(o.carrier) || '',
        trackingNumber: typeof o.trackingNumber === 'string' ? o.trackingNumber : '',
      },
    }));
    setEditing((m) => ({ ...m, [o.id]: true }));
  };
  const closeEdit = (orderId) => {
    setOrderError(orderId, null);
    setEditing((m) => { const next = { ...m }; delete next[orderId]; return next; });
  };
  // Corrections remaining for a shipped order (lib/orders-store.js
  // toCreatorOrder derives it; 0 once the cap is used). The payload carries
  // no erasure stamps (round-16 legal-journeys#2). An erasure removes only
  // the buyer's name and address (round 18): carrier and trackingNumber stay,
  // the buyer and the seller see the same ones, and the count is the same as
  // for any order.
  // An older payload without the field counts as none known, not unlimited.
  const correctionsLeft = (o) => (Number.isInteger(o.trackingCorrectionsLeft) && o.trackingCorrectionsLeft > 0 ? o.trackingCorrectionsLeft : 0);
  const canCorrect = (o) => correctionsLeft(o) > 0;
  const fmtDate = (iso) => {
    const d = typeof iso === 'string' ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString() : '';
  };
  // Closed by an admin as never fulfillable (lib/orders-store.js
  // closeUnfulfilledOrder -- e.g. the seller was banned before shipping).
  // Nothing to ship, and the address is no longer shared (toCreatorOrder
  // decrypts it only while pending_shipment).
  const closed = orders.filter((o) => o.status === 'closed_unfulfilled');

  return (
    <div>
      <h3 className="font-bold text-brand-gold mb-3">Orders to Ship</h3>
      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : loadError ? (
        <div className="text-sm text-red-400">
          {loadError}{' '}
          <button onClick={load} className="underline text-gray-300">Try again</button>
        </div>
      ) : orders.length === 0 ? (
        <p className="text-sm text-gray-500">No physical orders yet.</p>
      ) : (
        <div className="space-y-3">
          {error && (
            <p className="text-xs text-red-400">
              Order #{error.orderId}: {error.message}{' '}
              <button type="button" onClick={() => setError(null)} className="underline text-gray-400">Dismiss</button>
            </p>
          )}
          {Object.entries(orderNotices).map(([id, n]) => (
            <p key={id} role="status" className="text-xs text-brand-gold">
              Order #{id} saved. {n.message} {n.next}{' '}
              <button type="button" onClick={() => clearNotice(id)} className="underline text-gray-400">Dismiss</button>
            </p>
          ))}
          {pending.length === 0 && <p className="text-sm text-gray-500">Nothing waiting to ship.</p>}
          {pending.map((o) => {
            // getOrdersForCreator returns shippingAddress: null for a row whose
            // address won't decrypt (rotated/wrong ORDERS_ENCRYPTION_KEY or a
            // corrupt row) so one bad order can't blank the whole queue. That
            // order must not look shippable: a blank address block with a live
            // Mark Shipped button sends a paid order nowhere.
            const unreadable = !o.shippingAddress || typeof o.shippingAddress !== 'object';
            const addr = o.shippingAddress || {};
            const form = shipForm[o.id] || { carrier: '', trackingNumber: '' };
            return (
              <div key={o.id} className="premium-card border border-brand-purple/20 p-4">
                <p className="text-sm text-white font-bold">Order #{o.id} — ${(o.priceCents / 100).toFixed(2)}{o.shippingCents ? ` + $${(o.shippingCents / 100).toFixed(2)} shipping` : ''}</p>
                <p className="text-sm text-gray-200 mt-0.5">Item: <OrderItem o={o} /></p>
                {o.signatureRequired && (
                  <p className="text-xs text-brand-gold mt-1">Select signature confirmation with your carrier for this one — you marked this listing as requiring it.</p>
                )}
                {unreadable ? (
                  <p className="text-xs text-red-400 mt-1">
                    This order&apos;s shipping address can&apos;t be read. Don&apos;t ship it — contact{' '}
                    <a href="mailto:team@onlyone1.fun" className="underline">team@onlyone1.fun</a> with the order number first.
                  </p>
                ) : (
                  <>
                    <p className="text-xs text-gray-400 mt-1">
                      {addr.fullName}<br />
                      {addr.line1}{addr.line2 ? `, ${addr.line2}` : ''}<br />
                      {[addr.city, addr.region].filter(Boolean).join(', ')} {addr.postalCode}<br />
                      {addr.country}{addr.phone ? ` · ${addr.phone}` : ''}
                    </p>
                    <p className="text-[11px] text-gray-500 mt-1">
                      This address was shared with you only so you can ship this order. Don&apos;t use or keep it for anything else.
                    </p>
                  </>
                )}
                <div className="flex flex-wrap gap-2 mt-3">
                  <TrackingFields
                    orderId={o.id}
                    form={form}
                    disabled={unreadable}
                    onChange={(next) => setShipForm((f) => ({ ...f, [o.id]: next }))}
                    borderFor={(field) => inputBorder(o.id, field)}
                    orderError={orderErrors[o.id]}
                  />
                  <button
                    onClick={() => markShipped(o.id)}
                    disabled={!!busy[o.id] || unreadable}
                    className="premium-button text-xs px-4 disabled:opacity-50"
                  >
                    Mark Shipped
                  </button>
                  {errorFor(o.id)}
                </div>
              </div>
            );
          })}
          {shipped.length > 0 && (
            <details
              className="text-xs text-gray-500"
              open={shippedOpen}
              onToggle={(e) => setShippedOpen(e.currentTarget.open)}
            >
              <summary className="cursor-pointer">Shipped ({shipped.length})</summary>
              <div className="mt-2 space-y-2">
                {shipped.map((o) => {
                  // No address and no unreadable-address gate here: the parcel
                  // has already gone, the address is no longer shared
                  // (toCreatorOrder), and it may have been erased on purpose.
                  const form = shipForm[o.id] || { carrier: '', trackingNumber: '' };
                  const shippedOn = fmtDate(o.shippedAt);
                  const updatedOn = fmtDate(o.trackingUpdatedAt);
                  return (
                    <div key={o.id}>
                      <p>
                        Order #{o.id} — <OrderItem o={o} /> — {o.carrier} {o.trackingNumber}
                        {shippedOn ? ` · shipped ${shippedOn}` : ''}
                        {updatedOn ? ` · tracking updated ${updatedOn}` : ''}
                        {!editing[o.id] && canCorrect(o) && (
                          <>
                            {' '}
                            <button type="button" onClick={() => openEdit(o)} className="underline text-gray-300">Edit tracking</button>
                            {' '}<span className="text-gray-600">({correctionsLeft(o)} correction{correctionsLeft(o) === 1 ? '' : 's'} left)</span>
                          </>
                        )}
                      </p>
                      {!canCorrect(o) && !orderErrors[o.id] && (
                        <p className="text-[11px] text-gray-500">
                          Tracking can no longer be changed for this order.{' '}
                          Contact <a href="mailto:team@onlyone1.fun" className="underline">team@onlyone1.fun</a> if it needs changing.
                        </p>
                      )}
                      {editing[o.id] && (
                        <div className="flex flex-wrap gap-2 mt-1">
                          <TrackingFields
                            orderId={o.id}
                            form={form}
                            disabled={false}
                            onChange={(next) => setShipForm((f) => ({ ...f, [o.id]: next }))}
                            borderFor={(field) => inputBorder(o.id, field)}
                            orderError={orderErrors[o.id]}
                            labelled
                          />
                          <button
                            type="button"
                            onClick={() => markShipped(o.id)}
                            disabled={!!busy[o.id]}
                            className="premium-button text-xs px-4 disabled:opacity-50"
                          >
                            Save tracking
                          </button>
                          <button
                            type="button"
                            onClick={() => closeEdit(o.id)}
                            disabled={!!busy[o.id]}
                            className="text-xs underline text-gray-400 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                      {errorFor(o.id)}
                    </div>
                  );
                })}
              </div>
            </details>
          )}
          {closed.length > 0 && (
            <details className="text-xs text-gray-500">
              <summary className="cursor-pointer">Closed — not fulfilled ({closed.length})</summary>
              <div className="mt-2 space-y-1">
                {closed.map((o) => (
                  <p key={o.id}>
                    {/* The admin's closeReason is an internal note, not shown. */}
                    Order #{o.id} — <OrderItem o={o} /> — closed by OnlyOne; don&apos;t ship it.
                  </p>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
