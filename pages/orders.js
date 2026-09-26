import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import ProtectedMedia from '../components/ProtectedMedia';
import MediaLightbox from '../components/public/MediaLightbox';
import { getSessionUser } from '../lib/session';
import { publicUser } from '../lib/users-store';
import { viewerMarkFor } from '../lib/viewer-mark';

export async function getServerSideProps({ req }) {
  const sessionUser = publicUser(await getSessionUser(req));
  if (!sessionUser) {
    return { redirect: { destination: '/login?next=/orders', permanent: false } };
  }
  // Purchased files carry the buyer's own account mark, same as a creator's
  // gallery does for a signed-in viewer (lib/viewer-mark.js, server-only).
  return { props: { sessionUser, viewerMark: viewerMarkFor(sessionUser.id) } };
}

const DELIVERABLE = new Set(['fulfilled', 'delivered']);

/**
 * A paid digital order's files, fetched on demand from
 * GET /api/marketplace/orders/delivery -- the route checks the order belongs
 * to this buyer and the /api/media srcs it returns are authorized again, per
 * request, by the same order. Nothing about a purchase is in page props.
 */
function DigitalDelivery({ orderId, mark }) {
  const [state, setState] = useState({ status: 'idle', items: [], removed: false, removedReason: null, withheld: 0, error: '' });
  const [viewing, setViewing] = useState(null);
  const close = useCallback(() => setViewing(null), []);

  const load = async () => {
    setState({ status: 'loading', items: [], removed: false, removedReason: null, withheld: 0, error: '' });
    try {
      const res = await fetch(`/api/marketplace/orders/delivery?orderId=${encodeURIComponent(orderId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not load this purchase.');
      setState({
        status: 'ready',
        items: Array.isArray(data.items) ? data.items.filter((i) => i && typeof i.src === 'string') : [],
        removed: !!data.removed,
        removedReason: typeof data.removedReason === 'string' ? data.removedReason : null,
        // Files held back pending a moderation review (preserved/quarantined):
        // left out of `items`, so they are counted here and said so.
        withheld: Number.isInteger(data.withheld) && data.withheld > 0 ? data.withheld : 0,
        error: '',
      });
    } catch (err) {
      setState({ status: 'error', items: [], removed: false, removedReason: null, withheld: 0, error: err.message || 'Could not load this purchase.' });
    }
  };

  if (state.status === 'idle' || state.status === 'error') {
    return (
      <div className="mt-3 pt-3 border-t border-white/10">
        <button onClick={load} className="text-xs px-4 py-2 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold transition">
          View your purchase
        </button>
        {state.error && <p className="text-xs text-red-400 mt-2">{state.error}</p>}
      </div>
    );
  }
  if (state.status === 'loading') {
    return <p className="mt-3 pt-3 border-t border-white/10 text-xs text-gray-500">Loading…</p>;
  }
  if (state.removed) {
    // Says what actually happened (removedReason from the delivery route):
    // this always blamed moderation, even when the creator's account was
    // deleted or the listing no longer exists.
    const why =
      state.removedReason === 'creator_deleted'
        ? "The creator's account was deleted, and this item's files went with it."
        : state.removedReason === 'deleted'
          ? 'This listing no longer exists.'
          : 'This item was removed by moderation, and its files were deleted with it.';
    return (
      <p className="mt-3 pt-3 border-t border-white/10 text-xs text-gray-400">
        {why} Contact{' '}
        <a href="mailto:team@onlyone1.fun" className="underline">team@onlyone1.fun</a> if you need help.
      </p>
    );
  }
  const withheldNote = state.withheld > 0 && (
    <p className="text-[11px] text-gray-400 mt-2">
      {state.withheld === 1 ? '1 file from this purchase is' : `${state.withheld} files from this purchase are`} held back
      while our team reviews a report about it. Contact{' '}
      <a href="mailto:team@onlyone1.fun" className="underline">team@onlyone1.fun</a> if you need help.
    </p>
  );
  if (state.items.length === 0) {
    if (withheldNote) return <div className="mt-3 pt-3 border-t border-white/10">{withheldNote}</div>;
    return (
      <p className="mt-3 pt-3 border-t border-white/10 text-xs text-gray-400">
        The creator hasn&apos;t attached any files to this item. Contact{' '}
        <a href="mailto:team@onlyone1.fun" className="underline">team@onlyone1.fun</a> if you expected something.
      </p>
    );
  }
  return (
    <div className="mt-3 pt-3 border-t border-white/10">
      <MediaLightbox item={viewing} mark={mark} onClose={close} />
      <div className="grid grid-cols-3 gap-2">
        {state.items.map((item, i) => (
          <button
            key={`${item.src}-${i}`}
            type="button"
            onClick={() => setViewing(item)}
            aria-label={item.type === 'video' ? 'Play video' : 'View photo'}
            className="relative aspect-square rounded-lg overflow-hidden bg-black/40"
          >
            <ProtectedMedia src={item.src} type={item.type === 'video' ? 'video' : 'image'} mark={mark} className="w-full h-full object-cover" />
            {item.type === 'video' && (
              <span className="absolute bottom-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-white font-semibold pointer-events-none">VIDEO</span>
            )}
            {item.aiGenerated && (
              <span className="absolute top-1 left-1 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-brand-pink font-bold pointer-events-none">AI</span>
            )}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-gray-500 mt-2">These files carry a mark tied to your account. They are for you only.</p>
      {withheldNote}
    </div>
  );
}

const STATUS_LABEL = {
  fulfilled: 'Delivered',
  pending_shipment: 'Preparing to ship',
  shipped: 'Shipped',
  // An admin closed a paid physical order that can never ship (the seller
  // was banned or removed first) -- lib/orders-store.js closeUnfulfilledOrder.
  closed_unfulfilled: 'Closed — not fulfilled',
};

// The fan-facing half of order history -- the API this calls
// (GET /api/marketplace/orders/mine) already existed and worked, it just had
// no page anywhere pointing at it, so a fan had no way to see what they'd
// bought once the one-time "Payment confirmed" screen on /cart was gone.
export default function OrdersPage({ sessionUser, viewerMark }) {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/marketplace/orders/mine')
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Could not load your orders');
        setOrders(Array.isArray(d.orders) ? d.orders : []);
      })
      .catch((err) => setError(err.message || 'Could not load your orders'));
  }, []);

  return (
    <>
      <Head>
        <title>Your Orders — OnlyOne</title>
      </Head>
      <div className="min-h-screen bg-brand-ink text-white pb-24">
        <SiteNav signedIn viewerAvatar={sessionUser?.img || null} />
        <div className="max-w-2xl mx-auto px-6 py-10">
          <h1 className="text-3xl font-black mb-6">Your Orders</h1>

          {error && <p className="text-sm text-red-400">{error}</p>}

          {orders === null && !error ? (
            <p className="text-gray-500 text-sm">Loading…</p>
          ) : orders && orders.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-gray-400 mb-5">You haven't bought anything yet.</p>
              <a href="/marketplace" className="inline-block px-6 py-3 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition">
                Browse the marketplace
              </a>
            </div>
          ) : (
            <div className="space-y-3">
              {orders?.map((o) => (
                <div key={o.id} className="rounded-xl bg-white/5 border border-white/5 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-bold text-sm truncate">{o.title || `Listing #${o.listingId}`}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {o.createdAt ? new Date(o.createdAt).toLocaleDateString() : ''} · {o.kind === 'physical' ? 'Ships to you' : 'Digital'}
                      </p>
                      {/* The number support asks for -- a shipping-address
                          erasure request (Privacy §7) or any order question
                          quotes it. */}
                      {o.id != null && <p className="text-[11px] text-gray-500 mt-0.5">Order #{String(o.id)}</p>}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-bold text-sm">${(((o.priceCents || 0) + (o.shippingCents || 0)) / 100).toFixed(2)}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">{STATUS_LABEL[o.status] || o.status}</p>
                    </div>
                  </div>
                  {o.kind !== 'physical' && DELIVERABLE.has(o.status) && (
                    <DigitalDelivery orderId={o.id} mark={viewerMark} />
                  )}
                  {o.kind === 'physical' && o.status === 'closed_unfulfilled' && (
                    <p className="text-xs text-gray-400 mt-2 pt-2 border-t border-white/10">
                      {/* closeReason is the admin's internal note (the admin
                          panel says only that it is "kept on the order"), so
                          it is not shown here. */}
                      The seller couldn&apos;t fulfil this order, so it was closed and won&apos;t ship.{' '}
                      Questions? Email <a href="mailto:team@onlyone1.fun" className="underline">team@onlyone1.fun</a> with order #{String(o.id)}.
                    </p>
                  )}
                  {o.kind === 'physical' && o.status === 'shipped' && (o.carrier || o.trackingNumber) && (
                    <p className="text-xs text-gray-400 mt-2 pt-2 border-t border-white/10">
                      {o.carrier ? `${o.carrier} — ` : ''}{o.trackingNumber || 'No tracking number provided'}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
