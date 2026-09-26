import { useEffect, useState } from 'react';
import { getJson, postJson } from './media-upload';
import { responseErrorMessage, retryAfterHint } from './helpers';

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
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  // Shipped orders whose "Edit tracking" form is open (orderId -> true). The
  // ship route accepts an order already 'shipped' as a carrier/tracking
  // correction (lib/orders-store.js markOrderShipped) -- it keeps the original
  // shippedAt and stamps trackingUpdatedAt -- and this is the only control
  // that reaches it (round-13 dashboard#0).
  const [editing, setEditing] = useState({});
  // The ship route's refusals, shown next to the order they belong to rather
  // than only in the shared banner (round 14): { orderId, field, message }.
  // `field` is 'carrier' | 'trackingNumber' when the server names one (the
  // payment/contact screen, the charset check, "not an app" for a carrier,
  // "at least one number" for a tracking number) and that input is outlined.
  const [orderError, setOrderError] = useState(null);

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
    if (!carrier?.trim() || !trackingNumber?.trim()) {
      setError('');
      setOrderError({ orderId, field: !carrier?.trim() ? 'carrier' : 'trackingNumber', message: 'Enter a carrier and tracking number first.' });
      return;
    }
    setBusyId(orderId);
    setError('');
    setOrderError(null);
    try {
      const { res, data } = await postJson('/api/marketplace/orders/ship', {
        orderId,
        carrier: carrier.trim(),
        trackingNumber: trackingNumber.trim(),
      });
      if (res.status === 409 && data?.code === 'ORDER_CLOSED') {
        // An admin closed it (the order can never be fulfilled) while it was
        // on screen: show the refusal and re-read the queue, so it moves out
        // of "waiting to ship" instead of staying there with a live button.
        setError(responseErrorMessage(res.status, data, 'This order was closed and can no longer be shipped.'));
        await load();
        return;
      }
      if (res.status === 429) {
        setOrderError({ orderId, field: '', message: responseErrorMessage(res.status, data, 'Too many shipping updates recently.') + retryAfterHint(res) });
        return;
      }
      if (res.status === 400 && (data?.field === 'carrier' || data?.field === 'trackingNumber')) {
        setOrderError({ orderId, field: data.field, message: responseErrorMessage(res.status, data, 'Check the carrier and tracking number.') });
        return;
      }
      if (res.status === 409 && data?.code === 'TRACKING_EDIT_LIMIT') {
        // Corrections are capped per order (lib/orders-store.js); the form is
        // closed so it stops offering a save the server will refuse.
        setOrderError({ orderId, field: '', message: responseErrorMessage(res.status, data, 'This order’s tracking has been corrected too many times. Contact team@onlyone1.fun to change it again.') });
        setEditing((m) => { const next = { ...m }; delete next[orderId]; return next; });
        return;
      }
      // ADDRESS_UNREADABLE (409, pending orders only) and 404 'Order not
      // found' carry their own readable message; responseErrorMessage shows it.
      if (!res.ok || !data?.order) {
        setOrderError({ orderId, field: '', message: responseErrorMessage(res.status, data, 'Failed to save the tracking details') });
        return;
      }
      setOrders((list) => list.map((o) => (o.id === orderId ? data.order : o)));
      setEditing((m) => { const next = { ...m }; delete next[orderId]; return next; });
    } catch {
      setOrderError({ orderId, field: '', message: 'Could not reach the server. Check your connection and try again.' });
    } finally {
      setBusyId(null);
    }
  };

  const pending = orders.filter((o) => o.status === 'pending_shipment');
  const shipped = orders.filter((o) => o.status === 'shipped');

  // Red outline on the input the server named for this order.
  const inputBorder = (orderId, field) => (orderError && orderError.orderId === orderId && orderError.field === field ? 'border-red-500' : 'border-brand-purple/30');
  const errorFor = (orderId) => (orderError && orderError.orderId === orderId ? (
    <p role="alert" className="text-xs text-red-400 mt-1 w-full">{orderError.message}</p>
  ) : null);

  const openEdit = (o) => {
    setError('');
    setOrderError(null);
    setShipForm((f) => ({
      ...f,
      [o.id]: {
        carrier: typeof o.carrier === 'string' ? o.carrier : '',
        trackingNumber: typeof o.trackingNumber === 'string' ? o.trackingNumber : '',
      },
    }));
    setEditing((m) => ({ ...m, [o.id]: true }));
  };
  const closeEdit = (orderId) => {
    setOrderError((e) => (e && e.orderId === orderId ? null : e));
    setEditing((m) => { const next = { ...m }; delete next[orderId]; return next; });
  };
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
          {error && <p className="text-xs text-red-400">{error}</p>}
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
                  <input
                    value={form.carrier}
                    disabled={unreadable}
                    aria-invalid={orderError?.orderId === o.id && orderError.field === 'carrier'}
                    onChange={(e) => setShipForm({ ...shipForm, [o.id]: { ...form, carrier: e.target.value } })}
                    placeholder="Carrier (e.g. USPS)"
                    className={`px-3 py-2 rounded-md bg-black/40 border ${inputBorder(o.id, 'carrier')} text-white text-xs disabled:opacity-50`}
                  />
                  <input
                    value={form.trackingNumber}
                    disabled={unreadable}
                    aria-invalid={orderError?.orderId === o.id && orderError.field === 'trackingNumber'}
                    onChange={(e) => setShipForm({ ...shipForm, [o.id]: { ...form, trackingNumber: e.target.value } })}
                    placeholder="Tracking number"
                    className={`px-3 py-2 rounded-md bg-black/40 border ${inputBorder(o.id, 'trackingNumber')} text-white text-xs disabled:opacity-50`}
                  />
                  <button
                    onClick={() => markShipped(o.id)}
                    disabled={busyId === o.id || unreadable}
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
            <details className="text-xs text-gray-500">
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
                        {!editing[o.id] && (
                          <>
                            {' '}
                            <button type="button" onClick={() => openEdit(o)} className="underline text-gray-300">Edit tracking</button>
                          </>
                        )}
                      </p>
                      {editing[o.id] && (
                        <div className="flex flex-wrap gap-2 mt-1">
                          <input
                            value={form.carrier}
                            aria-invalid={orderError?.orderId === o.id && orderError.field === 'carrier'}
                            onChange={(e) => setShipForm({ ...shipForm, [o.id]: { ...form, carrier: e.target.value } })}
                            placeholder="Carrier (e.g. USPS)"
                            aria-label={`Carrier for order ${o.id}`}
                            className={`px-3 py-2 rounded-md bg-black/40 border ${inputBorder(o.id, 'carrier')} text-white text-xs`}
                          />
                          <input
                            value={form.trackingNumber}
                            aria-invalid={orderError?.orderId === o.id && orderError.field === 'trackingNumber'}
                            onChange={(e) => setShipForm({ ...shipForm, [o.id]: { ...form, trackingNumber: e.target.value } })}
                            placeholder="Tracking number"
                            aria-label={`Tracking number for order ${o.id}`}
                            className={`px-3 py-2 rounded-md bg-black/40 border ${inputBorder(o.id, 'trackingNumber')} text-white text-xs`}
                          />
                          <button
                            type="button"
                            onClick={() => markShipped(o.id)}
                            disabled={busyId === o.id}
                            className="premium-button text-xs px-4 disabled:opacity-50"
                          >
                            Save tracking
                          </button>
                          <button
                            type="button"
                            onClick={() => closeEdit(o.id)}
                            disabled={busyId === o.id}
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
