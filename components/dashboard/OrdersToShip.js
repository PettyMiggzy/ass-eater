import { useEffect, useState } from 'react';
import { getJson, postJson } from './media-upload';
import { responseErrorMessage } from './helpers';

/**
 * A creator's physical-order queue. Deliberately shown to suspended (and
 * pending) creators too: fans have already paid for these orders, and
 * /api/marketplace/orders/creator + /ship let a suspended creator see and
 * ship what they sold. A banned account gets the server's refusal, shown as
 * such -- a failed load must never read as "No physical orders yet".
 */
export default function OrdersToShip() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [shipForm, setShipForm] = useState({}); // orderId -> { carrier, trackingNumber }
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

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

  const markShipped = async (orderId) => {
    const { carrier, trackingNumber } = shipForm[orderId] || {};
    if (!carrier?.trim() || !trackingNumber?.trim()) { setError('Enter a carrier and tracking number first.'); return; }
    setBusyId(orderId);
    setError('');
    try {
      const { res, data } = await postJson('/api/marketplace/orders/ship', {
        orderId,
        carrier: carrier.trim(),
        trackingNumber: trackingNumber.trim(),
      });
      if (!res.ok || !data?.order) throw new Error(responseErrorMessage(res.status, data, 'Failed to mark shipped'));
      setOrders((list) => list.map((o) => (o.id === orderId ? data.order : o)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const pending = orders.filter((o) => o.status === 'pending_shipment');
  const shipped = orders.filter((o) => o.status === 'shipped');

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
                    maxLength={100}
                    disabled={unreadable}
                    onChange={(e) => setShipForm({ ...shipForm, [o.id]: { ...form, carrier: e.target.value } })}
                    placeholder="Carrier (e.g. USPS)"
                    className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-xs disabled:opacity-50"
                  />
                  <input
                    value={form.trackingNumber}
                    maxLength={100}
                    disabled={unreadable}
                    onChange={(e) => setShipForm({ ...shipForm, [o.id]: { ...form, trackingNumber: e.target.value } })}
                    placeholder="Tracking number"
                    className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-xs disabled:opacity-50"
                  />
                  <button
                    onClick={() => markShipped(o.id)}
                    disabled={busyId === o.id || unreadable}
                    className="premium-button text-xs px-4 disabled:opacity-50"
                  >
                    Mark Shipped
                  </button>
                </div>
              </div>
            );
          })}
          {shipped.length > 0 && (
            <details className="text-xs text-gray-500">
              <summary className="cursor-pointer">Shipped ({shipped.length})</summary>
              <div className="mt-2 space-y-1">
                {shipped.map((o) => (
                  <p key={o.id}>Order #{o.id} — {o.carrier} {o.trackingNumber}</p>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
